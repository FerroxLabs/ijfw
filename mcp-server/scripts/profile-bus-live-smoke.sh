#!/usr/bin/env bash
# profile-bus-live-smoke.sh — LIVE end-to-end smoke of IJFW's profile-bus
# learning loop, exercising the REAL SHIPPED CODE PATHS (the actual hook scripts
# + the real MCP server over JSON-RPC) — NOT unit tests.
#
# Answers: does capture -> derive -> serve actually work in a live, installed-
# style run, or only in unit tests?
#
# ISOLATION (load-bearing): every command runs under a SCRATCH HOME so the
# profile's default `~/.ijfw/profile` resolves INTO the scratch dir. We do NOT
# set NODE_ENV=test / NODE_TEST_CONTEXT (those trip the fail-closed guard) and
# we do NOT set IJFW_PROFILE_DIR (the whole point is to exercise the REAL
# default homedir path, just rooted at a scratch HOME).
#
# Usage:  bash mcp-server/scripts/profile-bus-live-smoke.sh
#         (run from the repo root; resolves REPO from its own location otherwise)
#
# Exit 0 = smoke completed (verdicts printed). Non-zero = harness/isolation fault.

set -u

# ---------------------------------------------------------------------------
# Resolve the real repo (where the shipped hooks + mcp-server live).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"   # mcp-server/scripts -> repo root
PRE_PROMPT="$REPO/claude/hooks/scripts/pre-prompt.sh"
SESSION_END="$REPO/claude/hooks/scripts/session-end.sh"
RUNNER="$REPO/mcp-server/src/dream/runner.mjs"
SERVER="$REPO/mcp-server/src/server.js"
CAPTURE_JS="$REPO/mcp-server/src/profile/capture.js"

for f in "$PRE_PROMPT" "$SESSION_END" "$RUNNER" "$SERVER" "$CAPTURE_JS"; do
  [ -f "$f" ] || { echo "FATAL: missing shipped file: $f" >&2; exit 2; }
done

# Record the REAL home profile baseline for the isolation assertion at the end.
REAL_HOME="${HOME}"
REAL_PROFILE="$REAL_HOME/.ijfw/profile/user-profile.md"
REAL_BEFORE="ABSENT"
[ -f "$REAL_PROFILE" ] && REAL_BEFORE="$(shasum "$REAL_PROFILE" 2>/dev/null | awk '{print $1}')"

# ---------------------------------------------------------------------------
# Scratch HOME + scratch "repo" CWD. The scratch repo gets a .ijfw/ dir. The
# hooks resolve mcp-server modules via $CLAUDE_PLUGIN_ROOT/../mcp-server/src, so
# we point CLAUDE_PLUGIN_ROOT at the REAL repo's claude/ dir — exactly the
# installed sibling layout (claude/ next to mcp-server/). That makes the hooks
# load the REAL shipped capture.js while CWD stays the scratch repo.
# ---------------------------------------------------------------------------
SCRATCH_HOME="$(mktemp -d 2>/dev/null || mktemp -d -t ijfw-smoke)"
SCRATCH_REPO="$(mktemp -d 2>/dev/null || mktemp -d -t ijfw-smoke-repo)"
COLD_HOME="$(mktemp -d 2>/dev/null || mktemp -d -t ijfw-smoke-cold)"
mkdir -p "$SCRATCH_REPO/.ijfw"

cleanup() { :; }   # keep scratch dirs for forensic inspection; printed below.
trap cleanup EXIT

export HOME="$SCRATCH_HOME"
export USERPROFILE="$SCRATCH_HOME"   # Windows-safety parity
export CLAUDE_PLUGIN_ROOT="$REPO/claude"
export IJFW_HOST="claude-code"
# Disable the 4h dream cooldown so we can drive >=5 derive cycles back-to-back.
# This is the documented test-fixture knob in cooldown.js (NOT a profile-source
# or test-context override) — it does not change the code path, only timing.
export IJFW_DREAM_COOLDOWN_MS=0
# Disable the NEW idle gate too (runner.mjs shouldRunNow, default 30 min). The
# legacy cooldown knob above does NOT cover it; without this, only the FIRST
# back-to-back derive cycle runs and the other five skip the idle gate, so
# evidence_count never accrues past 1. A timing knob only — same code path.
export IJFW_DREAM_MIN_IDLE_MIN=0
# Make identity stable + non-ambiguous so style rows are global_eligible and the
# runner's identity-bound gate accepts them (USER is set in the real env, but be
# explicit for reproducibility).
export USER="${USER:-ijfwsmoke}"
unset NODE_ENV NODE_TEST_CONTEXT IJFW_PROFILE_DIR IJFW_PROFILE_STATE_DIR 2>/dev/null || true

echo "=== IJFW PROFILE-BUS LIVE SMOKE ==="
echo "repo:          $REPO"
echo "scratch HOME:  $SCRATCH_HOME"
echo "scratch repo:  $SCRATCH_REPO"
echo "cold HOME:     $COLD_HOME"
echo "real profile baseline: $REAL_BEFORE ($REAL_PROFILE)"
echo

# ---------------------------------------------------------------------------
# Helper: invoke the REAL pre-prompt.sh hook with a Claude-Code-shaped payload.
# Contract (from the hook header): stdin JSON { session_id, prompt }; runs from
# the project CWD. We cd into the scratch repo for each call.
# ---------------------------------------------------------------------------
pre_prompt() {  # $1=session_id  $2=prompt
  local sid="$1" prompt="$2" payload
  payload="$(SID="$sid" PROMPT="$prompt" node -e '
    process.stdout.write(JSON.stringify({ session_id: process.env.SID, prompt: process.env.PROMPT }));
  ')"
  ( cd "$SCRATCH_REPO" && printf '%s' "$payload" | bash "$PRE_PROMPT" >/dev/null 2>&1 )
}

# Helper: invoke the REAL session-end.sh hook (Stop). Stdin is a Stop payload;
# we pass an empty-ish JSON (no transcript) — the profile flush does not need a
# transcript, and the metrics block tolerates a missing transcript_path.
session_end() {  # $1=session_id
  local sid="$1"
  ( cd "$SCRATCH_REPO" \
      && IJFW_SESSION_ID="$sid" \
      && export IJFW_SESSION_ID \
      && printf '{}' | bash "$SESSION_END" >/dev/null 2>&1 )
}

# Helper: flush THIS session's per-message style accumulator into the
# .ijfw/.session-style.jsonl wire file via the REAL flushSession export — the
# exact call session-end.sh makes (same module, same args). We use this directly
# (instead of the full session_end hook) inside the capture loop because
# session-end.sh ALSO runs ijfw-memorize, which TRUNCATES .session-feedback.jsonl
# on success (by design: in production the feedback->preference synthesis is
# memorize's job, and the dream spawn is deferred until AFTER that truncation to
# close a read-vs-truncate race). For a SINGLE-PROCESS smoke that must prove the
# derive path also folds feedback into the global profile, we flush the style row
# and then let derive consume BOTH streams BEFORE any truncation — the same
# read->derive->merge code, just without memorize stealing the feedback first.
flush_style() {  # $1=session_id
  ( cd "$SCRATCH_REPO" && SID="$1" node --input-type=module -e "
    const { flushSession } = await import('file://' + process.argv[1]);
    try { flushSession({ sessionId: process.env.SID || null, ts: Date.now(), cwd: process.cwd(), env: process.env }); } catch {}
  " "$CAPTURE_JS" >/dev/null 2>&1 )
}

# NOTE (DEFECT 3 — fixed): there is intentionally NO hand-authored feedback-row
# helper here anymore. The preference MUST flow through the REAL path —
#   user message -> pre-prompt.sh -> feedback-detector.js -> .session-feedback.jsonl
# -> derive -> brief. The earlier version of this smoke injected a content-bearing
# row ({kind:'correction', phrase:'use tabs not spaces', ...}) because the live
# detector sets `phrase` to the TRIGGER token only ("No,", "always use") and the
# profile side slugged that trigger — so a real correction keyed the inference on
# "no", and the brief could never surface "tabs". The fix moved content extraction
# to the profile side (derive-heuristic.js `preferenceContent`): it recovers the
# preference OBJECT from the detector's `context` field. So the smoke now proves
# the WHOLE real path end-to-end with no injected crutch.

# Helper: run the REAL dream derive stage the way the trigger fires it. We call
# runner.mjs directly with the same flags dream-trigger.sh passes, plus the
# cooldown knob (already exported). This is the real non-test code path.
run_derive() {  # $1=session_id
  local sid="$1"
  node "$RUNNER" --project-root "$SCRATCH_REPO" --host claude-code \
       --reason session_end --session-id "$sid" >/dev/null 2>&1
  # Clear the dream-state so the next back-to-back cycle is not skipped even if
  # IJFW_DREAM_COOLDOWN_MS were ignored. (Belt + braces; cooldown=0 already.)
  rm -f "$SCRATCH_REPO/.ijfw/.dream-state.json" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 2+3 driver: drive >=5 DISTINCT sessions of realistic messages through
# the REAL capture hook, flush each, and run derive per session so the heuristic
# floor accrues evidence_count >= 5 (the STYLE_CONFIRM_MIN_SESSIONS gate) — what
# a brief needs to be non-empty.
#
# CRITICAL (live-path correctness, learned from the original RED run): every
# message MUST be a CLEAR, specific prompt that does NOT trip the vague-prompt
# detector. A vague prompt makes pre-prompt.sh emit an additionalContext nudge,
# which the hook treats as a profile-brief injection (PROFILE_INJECTED=true) and
# flags the WHOLE session profile_influenced:true. The derive stage then
# (correctly) excludes every profile_influenced row from the global merge — so a
# vague-prompt corpus can NEVER train the global profile. Real specific prompts
# do not inject, so the rows stay eligible. We carry the 'tabs not spaces'
# preference through CLEAR, file-scoped messages the feedback detector still
# classifies as correction/preference, so the brief learns it honestly.
# ---------------------------------------------------------------------------
N_SESSIONS=6
for i in $(seq 1 "$N_SESSIONS"); do
  SID="smoke-sess-$i"
  # Clear, specific, code-bearing messages (each names a file + an action) ->
  # NON-vague => no injection => profile_influenced:false => eligible rows. They
  # carry a fenced TABS code block so the style fingerprint is stable + tabs-led.
  pre_prompt "$SID" "$(printf 'Refactor the paginate function in src/list.js to return early on an empty input array, like:\n```js\n\tif (!items.length) {\n\t\treturn [];\n\t}\n```')"
  pre_prompt "$SID" "Add a unit test in test/list.test.js for paginate() covering the empty-input and single-page cases."
  # A CLEAR correction the feedback detector classifies as 'correction' but the
  # vague detector passes as specific (it names src/list.js + paginate()). The
  # REAL pre-prompt.sh hook runs feedback-detector.js on this message and writes
  # a {ts,kind:'correction',phrase:'No,',context:'<full message>'} row to
  # .ijfw/.session-feedback.jsonl — the trigger token is `phrase`, the preference
  # CONTENT ("use tabs not spaces ...") is `context`. DEFECT-3 fix: the profile
  # side extracts the content from `context`, so the derived subject is keyed on
  # "use tabs not spaces", not on the bare trigger "no".
  pre_prompt "$SID" "No, use tabs not spaces in src/list.js when you indent the paginate function."
  # A CLEAR preference the feedback detector classifies as 'preference' (trigger
  # "always use" appears mid-message; the content follows it in `context`).
  pre_prompt "$SID" "Going forward, always use tabs not spaces for indentation in this repo (src/list.js included)."
  # NO injected feedback row. The 'tabs' preference reaches the profile ONLY via
  # the REAL detector path driven by the two pre_prompt calls above — this is the
  # whole point of the DEFECT-3 re-prove: message -> detector -> jsonl -> derive
  # -> brief, with no hand-authored content-bearing crutch. Because every session
  # sends the identical messages, the SAME content-keyed subject recurs across
  # all sessions and cross-session corroboration carries it over the brief floor.
  #
  # Flush THIS session's style row, then run derive so it folds BOTH the style
  # row AND the still-present feedback rows into the global profile (one fold per
  # row, cursor-guarded) BEFORE any memorize truncation could steal the feedback.
  flush_style "$SID"
  run_derive "$SID"
done

echo "--- STAGE 2 (CAPTURE) evidence ---"
STYLE_FILE="$SCRATCH_REPO/.ijfw/.session-style.jsonl"
FEEDBACK_FILE="$SCRATCH_REPO/.ijfw/.session-feedback.jsonl"
if [ -s "$STYLE_FILE" ]; then
  echo "STYLE rows ($(wc -l < "$STYLE_FILE" | tr -d ' ')):"
  cat "$STYLE_FILE"
else
  echo "NO style rows written (CAPTURE BROKEN)"
fi
echo
if [ -s "$FEEDBACK_FILE" ]; then
  echo "FEEDBACK rows ($(wc -l < "$FEEDBACK_FILE" | tr -d ' ')):"
  cat "$FEEDBACK_FILE"
else
  echo "(no feedback rows — note: session-end memorize truncates this file on success)"
fi
echo

echo "--- STAGE 3 (DERIVE) evidence ---"
DERIVED="$SCRATCH_HOME/.ijfw/profile/user-profile.md"
if [ -f "$DERIVED" ]; then
  echo "DERIVED profile at: $DERIVED"
  echo "evidence_count per style axis:"
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    // user-profile.md is markdown with an embedded JSON block; parse leniently.
    let json = null;
    const m = raw.match(/```json\s*([\s\S]*?)```/);
    try { json = JSON.parse(m ? m[1] : raw); } catch {}
    if (!json) { console.log("(could not parse profile JSON; raw head below)"); console.log(raw.slice(0,400)); process.exit(0); }
    const style = (json.global && json.global.style) || {};
    for (const [axis,a] of Object.entries(style)) {
      console.log(`  ${axis}: ema=${a.ema} evidence_count=${a.evidence_count}`);
    }
  ' "$DERIVED" 2>/dev/null || { echo "(parse helper failed; raw head:)"; head -c 600 "$DERIVED"; echo; }
else
  echo "NO derived profile at $DERIVED (DERIVE BROKEN)"
  # ROOT-CAUSE PROBE (HISTORICAL — DEFECT 1, now FIXED): the runner's
  # profileDeriveStage gated each style row on computeIdentity({env: params.env}).
  # The production dream entry did NOT thread `env`, so the self-identity was
  # computed over an EMPTY env (USER unresolved -> the ambiguous 'UNKNOWN' basis),
  # which could never equal the identity capture stamped with the REAL env -> every
  # row was rejected as identity-mismatch and the profile was never written. The
  # fix defaults `env` to process.env inside the stage AND passes it at the call
  # site. This probe stays as a regression tripwire: if DERIVE breaks again, the
  # two identities below show whether an identity mismatch is the cause.
  echo "  ROOT-CAUSE PROBE (capture identity vs runner self-identity):"
  node -e '
    import("file://" + process.argv[1]).then(m => {
      const capture = m.computeIdentity({ env: process.env });        // flushSession path (real env)
      const runner  = m.computeIdentity({ env: undefined });          // runner CLI path (env not threaded)
      console.log("    USER=" + JSON.stringify(process.env.USER));
      console.log("    capture(flush) identity = " + capture.identity + "  ambiguous=" + capture.ambiguous);
      console.log("    runner(CLI)    identity = " + runner.identity  + "  ambiguous=" + runner.ambiguous);
      console.log("    MATCH = " + (capture.identity === runner.identity)
        + "   => " + (capture.identity === runner.identity ? "rows would pass"
                     : "rows REJECTED as identity-mismatch (this is the live-path break)"));
    }).catch(() => {});
  ' "$CAPTURE_JS" 2>/dev/null || echo "    (probe helper failed)"
fi
echo

# ---------------------------------------------------------------------------
# STAGE 4 (SERVE): spawn the REAL MCP server over stdio with the scratch HOME
# and drive real JSON-RPC: initialize -> tools/call ijfw_brain {profile.brief},
# {profile.get}, {profile.audit}. The server reads the global profile via
# readProfile(), which is homedir-rooted -> resolves into the scratch HOME.
#
# The learned 'tabs' preference is sensitivity:med, so the DEFAULT brief (no
# opt-in) correctly WITHHOLDS it (id:2 below). To prove the brief CAN surface it
# on the trusted-host path, we (a) allowlist a host in share-hosts.txt and (b)
# call profile.brief with shareSensitive:true + that host (id:5 below). This is
# the same MED-2 host-allowlist contract the e2e integration test exercises.
# ---------------------------------------------------------------------------
# Allowlist the trusted host so the med-tier preference can egress on the opt-in
# brief call (id:5). profileDir() is homedir-rooted -> resolves into scratch HOME.
PROFILE_DIR="$SCRATCH_HOME/.ijfw/profile"
mkdir -p "$PROFILE_DIR" 2>/dev/null
printf 'trusted-cli\n' > "$PROFILE_DIR/share-hosts.txt"

echo "--- STAGE 4 (SERVE) — real MCP server over JSON-RPC ---"
jsonrpc_smoke() {  # reads scratch HOME; prints raw responses
  node -e '
    const { spawn } = require("child_process");
    const server = process.argv[1];
    const child = spawn(process.execPath, [server], {
      stdio: ["pipe","pipe","pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", d => { out += d.toString(); });
    let err = "";
    child.stderr.on("data", d => { err += d.toString(); });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    // 1. initialize
    send({ jsonrpc:"2.0", id:1, method:"initialize", params:{
      protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"smoke",version:"0"} } });
    // 2. tools/call ijfw_brain profile.brief
    send({ jsonrpc:"2.0", id:2, method:"tools/call", params:{
      name:"ijfw_brain", arguments:{ verb:"profile.brief", args:{} } } });
    // 3. tools/call ijfw_brain profile.get
    send({ jsonrpc:"2.0", id:3, method:"tools/call", params:{
      name:"ijfw_brain", arguments:{ verb:"profile.get", args:{} } } });
    // 4. tools/call ijfw_brain profile.audit
    send({ jsonrpc:"2.0", id:4, method:"tools/call", params:{
      name:"ijfw_brain", arguments:{ verb:"profile.audit", args:{} } } });
    // 5. tools/call ijfw_brain profile.brief WITH the per-host opt-in (trusted
    //    host on the share-hosts allowlist) so the med-tier 'tabs' preference
    //    surfaces in the served brief (MED-2 contract).
    send({ jsonrpc:"2.0", id:5, method:"tools/call", params:{
      name:"ijfw_brain", arguments:{ verb:"profile.brief",
        args:{ shareSensitive:true, context:{ host:"trusted-cli" } } } } });

    setTimeout(() => {
      child.stdin.end();
      child.kill("SIGTERM");
      // Print each JSON-RPC line on its own.
      const lines = out.split("\n").filter(Boolean);
      for (const l of lines) {
        try { const o = JSON.parse(l); console.log(JSON.stringify(o)); } catch { /* non-json banner */ }
      }
      if (err.trim()) { console.error("---server stderr---"); console.error(err.trim().slice(0,800)); }
    }, 2500);
  ' "$SERVER"
}

RPC_OUT="$(jsonrpc_smoke 2>/tmp/ijfw-smoke-server-stderr.txt)"
# Persist the served opt-in brief (id:5) so the final verdict can assert it
# contains BOTH the learned style AND the 'tabs' preference.
SERVED_BRIEF_FILE="/tmp/ijfw-smoke-served-brief.txt"
: > "$SERVED_BRIEF_FILE"
echo "$RPC_OUT" | SERVED_BRIEF_FILE="$SERVED_BRIEF_FILE" node -e '
  const fs = require("fs");
  const data = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const line of data) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.id === 1) console.log("initialize: ok=" + (!!o.result));
    if (o.id === 2 || o.id === 3 || o.id === 4 || o.id === 5) {
      const label = o.id===2?"profile.brief (default — med withheld)"
        : o.id===3?"profile.get"
        : o.id===4?"profile.audit"
        : "profile.brief (opt-in: trusted host — med surfaced)";
      let inner = null;
      try { inner = JSON.parse(o.result && o.result.content && o.result.content[0] && o.result.content[0].text); }
      catch { inner = o.result; }
      console.log("\n["+label+"] isError=" + (o.result && o.result.isError));
      console.log(JSON.stringify(inner, null, 2));
      if (o.id === 5 && inner && typeof inner.brief === "string") {
        try { fs.writeFileSync(process.env.SERVED_BRIEF_FILE, inner.brief); } catch {}
      }
    }
  }
' 2>/dev/null || { echo "(could not parse RPC output; raw below)"; echo "$RPC_OUT"; }
echo
echo "(server stderr saved to /tmp/ijfw-smoke-server-stderr.txt)"
echo

# ---------------------------------------------------------------------------
# STAGE 5 (COLD START): a SECOND fresh scratch HOME with no sessions. Confirm
# profile.brief returns an empty brief (ok:true), NOT an error.
# ---------------------------------------------------------------------------
echo "--- STAGE 5 (COLD START) — fresh HOME, no profile ---"
COLD_OUT="$(HOME="$COLD_HOME" USERPROFILE="$COLD_HOME" node -e '
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [process.argv[1]], { stdio:["pipe","pipe","pipe"], env: process.env });
  let out=""; child.stdout.on("data",d=>out+=d.toString());
  const send=o=>child.stdin.write(JSON.stringify(o)+"\n");
  send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"cold",version:"0"}}});
  send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"ijfw_brain",arguments:{verb:"profile.brief",args:{}}}});
  setTimeout(()=>{ child.stdin.end(); child.kill("SIGTERM");
    for (const l of out.split("\n").filter(Boolean)) {
      try { const o=JSON.parse(l); if (o.id===2) {
        let inner; try { inner=JSON.parse(o.result.content[0].text); } catch { inner=o.result; }
        console.log("cold profile.brief isError=" + (o.result&&o.result.isError));
        console.log(JSON.stringify(inner));
      } } catch {}
    }
  }, 2000);
' "$SERVER")"
echo "$COLD_OUT"
echo

# ---------------------------------------------------------------------------
# ISOLATION ASSERTION: confirm the REAL ~/.ijfw/profile was NOT created/modified.
# ---------------------------------------------------------------------------
echo "--- ISOLATION ASSERTION ---"
REAL_AFTER="ABSENT"
[ -f "$REAL_PROFILE" ] && REAL_AFTER="$(shasum "$REAL_PROFILE" 2>/dev/null | awk '{print $1}')"
echo "real profile before: $REAL_BEFORE"
echo "real profile after:  $REAL_AFTER"
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  echo "ISOLATION HELD: $REAL_PROFILE unchanged by this smoke."
else
  echo "ISOLATION VIOLATED: $REAL_PROFILE changed! ($REAL_BEFORE -> $REAL_AFTER)"
fi
echo
echo "Scratch dirs kept for inspection:"
echo "  HOME profile: $SCRATCH_HOME/.ijfw/profile/"
echo "  capture:      $SCRATCH_REPO/.ijfw/"

# ---------------------------------------------------------------------------
# VERDICT: hard per-stage assertions so this smoke is a real GATE, not just a
# transcript. Any failed gate => non-zero exit (so CI / a caller can trust it).
# ---------------------------------------------------------------------------
echo
echo "=== VERDICT ==="
FAILS=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }

# Gate 1 — capture(style): >=5 eligible, NON-influenced style rows on disk.
# (Count via grep over the whole file; `grep -c` exits 1 on zero matches, so we
#  normalize to a single integer rather than letting a `|| echo` concatenate.)
STYLE_N=0; [ -s "$STYLE_FILE" ] && STYLE_N=$(grep -c '' "$STYLE_FILE" 2>/dev/null)
STYLE_INFLUENCED=0
[ -s "$STYLE_FILE" ] && STYLE_INFLUENCED=$(grep -c '"profile_influenced":true' "$STYLE_FILE" 2>/dev/null)
[ -z "$STYLE_INFLUENCED" ] && STYLE_INFLUENCED=0
if [ "$STYLE_N" -ge 5 ] && [ "$STYLE_INFLUENCED" -eq 0 ]; then
  pass "capture(style): $STYLE_N eligible rows, 0 profile_influenced"
else
  fail "capture(style): rows=$STYLE_N influenced=$STYLE_INFLUENCED (need >=5 rows, 0 influenced)"
fi

# Gate 2 — capture(feedback): a 'tabs' correction/preference row was written.
if [ -s "$FEEDBACK_FILE" ] && grep -q 'tabs' "$FEEDBACK_FILE" 2>/dev/null; then
  FB_N=$(wc -l < "$FEEDBACK_FILE" | tr -d ' ')
  pass "capture(feedback): $FB_N rows incl. a 'tabs' correction"
else
  fail "capture(feedback): no 'tabs' feedback row found in $FEEDBACK_FILE"
fi

# Gate 3 — derive: profile written with style evidence_count > 0.
if [ -f "$DERIVED" ]; then
  MAX_EVID=$(node -e '
    const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8");
    const m=raw.match(/```json\s*([\s\S]*?)```/); let j=null; try{j=JSON.parse(m?m[1]:raw);}catch{}
    const style=(j&&j.global&&j.global.style)||{};
    let max=0; for (const a of Object.values(style)) max=Math.max(max,a.evidence_count||0);
    process.stdout.write(String(max));
  ' "$DERIVED" 2>/dev/null || echo 0)
  if [ "${MAX_EVID:-0}" -gt 0 ]; then
    pass "derive: profile written, max style evidence_count=$MAX_EVID (>0)"
  else
    fail "derive: profile present but evidence_count=0 (rows excluded?)"
  fi
else
  fail "derive: NO derived profile written (DERIVE BROKEN)"
fi

# Gate 4 — serve(brief): opt-in brief returns the derived STYLE *and* the tabs pref.
if [ -s "$SERVED_BRIEF_FILE" ] \
   && grep -qi 'Communication style' "$SERVED_BRIEF_FILE" 2>/dev/null \
   && grep -qi 'tabs' "$SERVED_BRIEF_FILE" 2>/dev/null; then
  pass "serve(brief): returns learned style AND the tabs preference"
else
  fail "serve(brief): missing style and/or tabs preference (see $SERVED_BRIEF_FILE)"
fi

# Gate 5 — cold start: a fresh HOME returns an EMPTY brief, ok:true (not an error).
if printf '%s' "$COLD_OUT" | grep -q 'cold profile.brief isError=false' \
   && printf '%s' "$COLD_OUT" | grep -q '"brief":""'; then
  pass "cold-start: empty brief, ok:true (no error on a fresh HOME)"
else
  fail "cold-start: expected empty brief ok:true; got: $COLD_OUT"
fi

# Gate 6 — isolation: the REAL ~/.ijfw/profile is unchanged by this smoke.
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  pass "isolation: real $REAL_PROFILE unchanged ($REAL_BEFORE)"
else
  fail "isolation: real profile changed! ($REAL_BEFORE -> $REAL_AFTER)"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== SMOKE COMPLETE — ALL GATES GREEN ==="
  exit 0
else
  echo "=== SMOKE COMPLETE — $FAILS GATE(S) FAILED ==="
  exit 1
fi
