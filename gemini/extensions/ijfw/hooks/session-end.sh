#!/usr/bin/env bash
# IJFW SessionEnd (Gemini) -- save session state, write metrics, emit savings receipt.
# Gemini hook JSON in/out:
#   stdin:  { "event": "SessionEnd", "session_id": "...", "cwd": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }
#
# No set -e -- hooks must never crash Gemini CLI.

[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null || true

IJFW_DIR=".ijfw"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
ISO_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || TZ=UTC date +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$IJFW_DIR/sessions" "$IJFW_DIR/memory" "$IJFW_DIR/metrics" 2>/dev/null

METRICS_FILE="$IJFW_DIR/metrics/sessions.jsonl"
MODE="${IJFW_MODE:-smart}"

MEMORY_STORES=0
if [ -f "$IJFW_DIR/memory/project-journal.md" ]; then
  MEMORY_STORES=$(grep -c '^- \[' "$IJFW_DIR/memory/project-journal.md" 2>/dev/null || true)
  [ -z "$MEMORY_STORES" ] && MEMORY_STORES=0
fi

LOCK="$IJFW_DIR/.session-counter.lock"
COUNTER="$IJFW_DIR/.session-counter"
SESSION_NUM=""
for i in 1 2 3 4 5; do
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
    CURRENT=$(cat "$COUNTER" 2>/dev/null || echo 0)
    SESSION_NUM=$((CURRENT + 1))
    echo "$SESSION_NUM" > "$COUNTER"
    rmdir "$LOCK" 2>/dev/null
    trap - EXIT
    break
  fi
  sleep 0.1
done
SESSION_NUM="${SESSION_NUM:-$(date +%s%N 2>/dev/null | tail -c 8 || date +%s)}"

HAS_HANDOFF="false"
[ -f "$IJFW_DIR/memory/handoff.md" ] && HAS_HANDOFF="true"

HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi

# Write metrics record.
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const rec = {
      v: 1,
      ts: process.argv[1],
      session_num: parseInt(process.argv[2], 10),
      mode: process.argv[3],
      memory_stores: parseInt(process.argv[4], 10),
      has_handoff: process.argv[5] === "true",
      platform: "gemini"
    };
    try {
      fs.mkdirSync(".ijfw/metrics", { recursive: true });
      fs.appendFileSync(".ijfw/metrics/sessions.jsonl", JSON.stringify(rec) + "\n");
    } catch {}
  ' "$ISO_TIMESTAMP" "$SESSION_NUM" "$MODE" "$MEMORY_STORES" "$HAS_HANDOFF" 2>>"$HOME/.ijfw/logs/gemini-session-end.log"
fi

# Write session file.
SESSION_FILE="$IJFW_DIR/sessions/session_$TIMESTAMP.md"
{
  printf '# Session %s\n' "$SESSION_NUM"
  printf 'timestamp: %s\n' "$ISO_TIMESTAMP"
  printf 'mode: %s\n' "$MODE"
  printf 'platform: gemini\n'
  printf 'memory_stores: %s\n' "$MEMORY_STORES"
} > "$SESSION_FILE" 2>>"$HOME/.ijfw/logs/gemini-session-end.log"

# Clean up turn counter and banner-dedup flag for this session.
rm -f "$IJFW_DIR/.turn-count" 2>/dev/null
SESSION_ID_END=""
if command -v node >/dev/null 2>&1 && [ -n "$HOOK_STDIN" ]; then
  SESSION_ID_END=$(printf '%s' "$HOOK_STDIN" | node -e '
    let buf = "";
    process.stdin.on("data", c => buf += c);
    process.stdin.on("end", () => {
      try { const j = JSON.parse(buf); process.stdout.write(j.session_id || ""); } catch {}
    });
  ' 2>>"$HOME/.ijfw/logs/gemini-session-end.log" || true)
fi
[ -n "$SESSION_ID_END" ] && rmdir "$IJFW_DIR/.banner-shown.${SESSION_ID_END}.lock" 2>/dev/null || true

# --- Profile bus P1: flush the per-session style accumulator ---
# Mirrors claude/hooks/scripts/session-end.sh: turns the per-message metadata
# accumulated by gemini before-agent.sh into ONE .ijfw/.session-style.jsonl
# contract record (METADATA ONLY), applying the hardening gates (quarantine /
# PII / identity / influence-cap). Best-effort + isolated: a flush failure never
# crashes Gemini.
#
# Why here (and not after-agent.sh): AfterAgent fires after EVERY subagent turn,
# so flushing there would clear the accumulator mid-session. SessionEnd is the
# true end-of-session boundary -- the correct single flush site, matching Claude.
# It runs BEFORE the dream-trigger spawn so this session's style row is durably
# on disk before the dream consumer (which reads the style stream) launches.
#
# Host: export the canonical 'gemini' so capture.js resolveHost() stamps the SAME
# provenance string before-agent.sh + the dream-trigger ("gemini" arg) use.
export IJFW_HOST="${IJFW_HOST:-gemini}"
CAPTURE_FLUSH=""
for base in \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/capture.js" ]; then CAPTURE_FLUSH="$base/profile/capture.js"; break; fi
done
if [ -n "$CAPTURE_FLUSH" ] && command -v node >/dev/null 2>&1; then
  SID_FLUSH="${IJFW_SESSION_ID:-${SESSION_ID_END:-}}"
  [ -z "$SID_FLUSH" ] && SID_FLUSH="$SESSION_NUM"
  node --input-type=module -e "
    const { flushSession } = await import('file://' + process.argv[1]);
    try {
      flushSession({
        sessionId: process.argv[2] || null,
        ts: Date.now(),
        cwd: process.cwd(),
        env: process.env,
      });
    } catch {}
  " "$CAPTURE_FLUSH" "$SID_FLUSH" 2>>"$HOME/.ijfw/logs/gemini-session-end.log" || true
fi

# Dream cycle trigger (D3 -- inline detached spawn at SessionEnd).
# Replaces the legacy `SESSION_NUM % 5 == 0` startup-flag deferral with
# a fire-and-forget spawn that returns within ~50ms. Cooldown enforced
# by runner.mjs via .ijfw/.dream-state.json (4h). Set
# IJFW_DREAM_LEGACY=1 to revert to the old startup-flag path.
DREAM_TRIGGER=""
for cand in \
    "$HOME/.ijfw/claude/skills/ijfw-summarize/scripts/dream-trigger.sh" \
    "${IJFW_HOME:-}/claude/skills/ijfw-summarize/scripts/dream-trigger.sh" \
    "$(pwd)/claude/skills/ijfw-summarize/scripts/dream-trigger.sh" \
    "$(dirname "$0")/../../../../claude/skills/ijfw-summarize/scripts/dream-trigger.sh"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { DREAM_TRIGGER="$cand"; break; }
done
if [ -n "$DREAM_TRIGGER" ]; then
  bash "$DREAM_TRIGGER" "$(pwd)" "gemini" "${IJFW_SESSION_ID:-${SESSION_ID_END:-}}" 2>/dev/null || true
fi

# Emit receipt.
RECEIPT="[ijfw] Session $SESSION_NUM complete ($MEMORY_STORES memory entries)."
command -v node >/dev/null 2>&1 || { printf '{"decision":"allow"}\n'; exit 0; }
node -e '
  const receipt = process.argv[1] || "";
  const out = { decision: "allow" };
  if (receipt) out.systemMessage = receipt;
  process.stdout.write(JSON.stringify(out) + "\n");
' "$RECEIPT" 2>>"$HOME/.ijfw/logs/gemini-session-end.log" || printf '{"decision":"allow"}\n'

exit 0
