#!/usr/bin/env bash
# profile-bus-codex-smoke.sh — LIVE smoke of IJFW's profile-bus CAPTURE on the
# CODEX platform, exercising the REAL SHIPPED CODEX HOOK SCRIPTS (codex
# pre-prompt.sh per-message capture + codex session-end.sh flush) — NOT unit
# tests. Sibling to profile-bus-live-smoke.sh (which proves the CLAUDE path).
#
# Answers: does the codex hook wiring actually accumulate per-message metadata
# and flush ONE .ijfw/.session-style.jsonl row stamped host:"codex" in a live,
# installed-style run?
#
# Also includes a GEMINI leg: parse-proof of the gemini before-agent.sh +
# session-end.sh hooks, and a live flush proof that the gemini session-end flush
# writes a host:"gemini" row from a per-message accumulator built by the gemini
# before-agent capture call.
#
# ISOLATION (load-bearing): every hook runs under a SCRATCH HOME so the profile's
# default homedir paths resolve INTO the scratch dir. We do NOT set NODE_ENV /
# NODE_TEST_CONTEXT (those trip the fail-closed guard) and we do NOT set
# IJFW_PROFILE_DIR (the point is to exercise the REAL default homedir path, just
# rooted at a scratch HOME). The REAL ~/.ijfw/profile must stay untouched.
#
# Installed-layout trick: the codex/gemini hooks resolve capture.js via
#   "$HOME/.ijfw/mcp-server/src"  then  "$(pwd)/mcp-server/src"
# We symlink the REAL mcp-server into $SCRATCH_HOME/.ijfw/mcp-server so the FIRST
# (HOME-rooted) candidate hits the REAL shipped capture.js, while CWD stays the
# scratch repo so all .ijfw/ capture state lands in scratch (never the real repo).
#
# Usage:  bash mcp-server/scripts/profile-bus-codex-smoke.sh
# Exit 0 = all gates green. Non-zero = a gate failed (real CI-grade gate).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"   # mcp-server/scripts -> repo root

CODEX_PRE="$REPO/codex/.codex/hooks/pre-prompt.sh"
CODEX_END="$REPO/codex/.codex/hooks/session-end.sh"
GEMINI_BEFORE="$REPO/gemini/extensions/ijfw/hooks/before-agent.sh"
GEMINI_END="$REPO/gemini/extensions/ijfw/hooks/session-end.sh"
CAPTURE_JS="$REPO/mcp-server/src/profile/capture.js"

for f in "$CODEX_PRE" "$CODEX_END" "$GEMINI_BEFORE" "$GEMINI_END" "$CAPTURE_JS"; do
  [ -f "$f" ] || { echo "FATAL: missing shipped file: $f" >&2; exit 2; }
done

# Record the REAL home profile baseline for the isolation assertion at the end.
REAL_HOME="${HOME}"
REAL_PROFILE="$REAL_HOME/.ijfw/profile/user-profile.md"
REAL_BEFORE="ABSENT"
[ -f "$REAL_PROFILE" ] && REAL_BEFORE="$(shasum "$REAL_PROFILE" 2>/dev/null | awk '{print $1}')"

SCRATCH_HOME="$(mktemp -d 2>/dev/null || mktemp -d -t ijfw-codex-smoke)"
SCRATCH_REPO="$(mktemp -d 2>/dev/null || mktemp -d -t ijfw-codex-smoke-repo)"
mkdir -p "$SCRATCH_REPO/.ijfw"
mkdir -p "$SCRATCH_HOME/.ijfw"
# Installed-layout symlink: HOME-rooted mcp-server -> the REAL shipped one.
ln -s "$REPO/mcp-server" "$SCRATCH_HOME/.ijfw/mcp-server" 2>/dev/null || true

export HOME="$SCRATCH_HOME"
export USERPROFILE="$SCRATCH_HOME"   # Windows-safety parity
# Stable, non-ambiguous identity so the flushed style rows are global_eligible.
export USER="${USER:-ijfwcodexsmoke}"
# Belt + braces: ensure NO test-context / profile-dir overrides leak in.
unset NODE_ENV NODE_TEST_CONTEXT IJFW_PROFILE_DIR IJFW_PROFILE_STATE_DIR IJFW_HOST 2>/dev/null || true

echo "=== IJFW PROFILE-BUS CODEX/GEMINI CAPTURE LIVE SMOKE ==="
echo "repo:          $REPO"
echo "scratch HOME:  $SCRATCH_HOME"
echo "scratch repo:  $SCRATCH_REPO"
echo "real profile baseline: $REAL_BEFORE ($REAL_PROFILE)"
echo

STYLE_FILE="$SCRATCH_REPO/.ijfw/.session-style.jsonl"

# ---------------------------------------------------------------------------
# CODEX leg. Drive the REAL codex pre-prompt.sh with a codex-shaped payload
# ({ event, prompt, session_id }) several times to accumulate, then drive the
# REAL codex session-end.sh ({ event, session_id }) to flush ONE row.
# ---------------------------------------------------------------------------
codex_pre() {  # $1=session_id  $2=prompt
  local sid="$1" prompt="$2" payload
  payload="$(SID="$sid" PROMPT="$prompt" node -e '
    process.stdout.write(JSON.stringify({ event:"UserPromptSubmit", session_id: process.env.SID, prompt: process.env.PROMPT }));
  ')"
  ( cd "$SCRATCH_REPO" && printf '%s' "$payload" | bash "$CODEX_PRE" >/dev/null 2>&1 )
}
codex_end() {  # $1=session_id
  local sid="$1" payload
  payload="$(SID="$sid" node -e '
    process.stdout.write(JSON.stringify({ event:"Stop", session_id: process.env.SID }));
  ')"
  ( cd "$SCRATCH_REPO" && printf '%s' "$payload" | bash "$CODEX_END" >/dev/null 2>&1 )
}

echo "--- CODEX leg: drive real hooks ---"
CODEX_SID="codex-smoke-sess-1"
# Clear, specific, code-bearing messages (NON-vague => no prompt-check injection
# => profile_influenced:false => eligible rows). Tab-indented fenced block.
codex_pre "$CODEX_SID" "$(printf 'Refactor the paginate function in src/list.js to return early on an empty input array:\n```js\n\tif (!items.length) {\n\t\treturn [];\n\t}\n```')"
codex_pre "$CODEX_SID" "Add a unit test in test/list.test.js for paginate() covering the empty-input and single-page cases."
codex_pre "$CODEX_SID" "Update the JSDoc on paginate() in src/list.js to document the early-return behavior."
ACC_AFTER="$SCRATCH_REPO/.ijfw/.session-style-acc.json"
if [ -f "$ACC_AFTER" ]; then
  echo "accumulator after 3 codex messages:"
  cat "$ACC_AFTER"; echo
else
  echo "(no accumulator written by codex pre-prompt capture — CAPTURE BROKEN)"
fi
codex_end "$CODEX_SID"
echo
echo "--- CODEX style rows after flush ---"
if [ -s "$STYLE_FILE" ]; then
  cat "$STYLE_FILE"
else
  echo "NO style rows written (CODEX FLUSH BROKEN)"
fi
echo

# ---------------------------------------------------------------------------
# GEMINI leg. Parse-proof both hooks, then drive the REAL gemini before-agent.sh
# (per-message capture) + session-end.sh (flush) and assert a host:"gemini" row.
# ---------------------------------------------------------------------------
echo "--- GEMINI leg: parse proof ---"
GEM_PARSE_OK=1
for f in "$GEMINI_BEFORE" "$GEMINI_END"; do
  if bash -n "$f"; then echo "  bash -n OK   $f"; else echo "  bash -n FAIL $f"; GEM_PARSE_OK=0; fi
done
echo
gemini_before() {  # $1=session_id  $2=prompt
  local sid="$1" prompt="$2" payload
  payload="$(SID="$sid" PROMPT="$prompt" node -e '
    process.stdout.write(JSON.stringify({ event:"BeforeAgent", session_id: process.env.SID, prompt: process.env.PROMPT, cwd: process.cwd() }));
  ')"
  ( cd "$SCRATCH_REPO" && printf '%s' "$payload" | bash "$GEMINI_BEFORE" >/dev/null 2>&1 )
}
gemini_end() {  # $1=session_id
  local sid="$1" payload
  payload="$(SID="$sid" node -e '
    process.stdout.write(JSON.stringify({ event:"SessionEnd", session_id: process.env.SID, cwd: process.cwd() }));
  ')"
  ( cd "$SCRATCH_REPO" && printf '%s' "$payload" | bash "$GEMINI_END" >/dev/null 2>&1 )
}

echo "--- GEMINI leg: drive real hooks ---"
# Fresh accumulator for the gemini session (the codex flush already cleared it).
GEM_SID="gemini-smoke-sess-1"
gemini_before "$GEM_SID" "Add input validation to the parseConfig function in src/config.js and return a typed error."
gemini_before "$GEM_SID" "Write a test in test/config.test.js asserting parseConfig rejects a missing required key."
gemini_end "$GEM_SID"
echo "--- combined style rows after gemini flush ---"
[ -s "$STYLE_FILE" ] && cat "$STYLE_FILE" || echo "NO style rows"
echo

# ---------------------------------------------------------------------------
# ISOLATION ASSERTION.
# ---------------------------------------------------------------------------
echo "--- ISOLATION ASSERTION ---"
REAL_AFTER="ABSENT"
[ -f "$REAL_PROFILE" ] && REAL_AFTER="$(shasum "$REAL_PROFILE" 2>/dev/null | awk '{print $1}')"
echo "real profile before: $REAL_BEFORE"
echo "real profile after:  $REAL_AFTER"
echo

# ---------------------------------------------------------------------------
# VERDICT — hard per-gate assertions.
# ---------------------------------------------------------------------------
echo "=== VERDICT ==="
FAILS=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }

# Gate 1 — codex capture+flush: at least one row stamped host:"codex" on disk.
if [ -s "$STYLE_FILE" ] && grep -q '"host":"codex"' "$STYLE_FILE" 2>/dev/null; then
  CODEX_N=$(grep -c '"host":"codex"' "$STYLE_FILE" 2>/dev/null)
  pass "codex capture: $CODEX_N row(s) with host:\"codex\" written by the real codex hooks"
else
  fail "codex capture: no host:\"codex\" row in $STYLE_FILE"
fi

# Gate 2 — codex row is eligible (NON-influenced, trust 0.9): clear prompts must
# not have tripped the vague-prompt injection, and the host trust must be stamped.
if grep '"host":"codex"' "$STYLE_FILE" 2>/dev/null | grep -q '"profile_influenced":false' \
   && grep '"host":"codex"' "$STYLE_FILE" 2>/dev/null | grep -q '"trust_weight":0.9'; then
  pass "codex row: profile_influenced=false, trust_weight=0.9 (eligible + correct provenance)"
else
  fail "codex row: expected profile_influenced=false AND trust_weight=0.9"
fi

# Gate 3 — gemini hooks parse clean (bash -n above).
if [ "$GEM_PARSE_OK" -eq 1 ]; then
  pass "gemini hooks: before-agent.sh + session-end.sh parse clean (bash -n)"
else
  fail "gemini hooks: a bash -n parse failed"
fi

# Gate 4 — gemini capture+flush: at least one row stamped host:"gemini" on disk.
if [ -s "$STYLE_FILE" ] && grep -q '"host":"gemini"' "$STYLE_FILE" 2>/dev/null; then
  GEM_N=$(grep -c '"host":"gemini"' "$STYLE_FILE" 2>/dev/null)
  pass "gemini capture: $GEM_N row(s) with host:\"gemini\" written by the real gemini hooks"
else
  fail "gemini capture: no host:\"gemini\" row in $STYLE_FILE"
fi

# Gate 5 — isolation: the REAL ~/.ijfw/profile is unchanged by this smoke.
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  pass "isolation: real $REAL_PROFILE unchanged ($REAL_BEFORE)"
else
  fail "isolation: real profile changed! ($REAL_BEFORE -> $REAL_AFTER)"
fi

echo
echo "Scratch dirs kept for inspection:"
echo "  HOME:   $SCRATCH_HOME"
echo "  repo:   $SCRATCH_REPO/.ijfw/"
echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== CODEX/GEMINI CAPTURE SMOKE — ALL GATES GREEN ==="
  exit 0
else
  echo "=== CODEX/GEMINI CAPTURE SMOKE — $FAILS GATE(S) FAILED ==="
  exit 1
fi
