#!/usr/bin/env bash
# IJFW Stop/SessionEnd (Codex) -- save session state, write metrics, manage journal.
# Also implements PreCompact workaround: checks context utilization estimate and
# emits a compress hint when the session token count exceeds threshold.
#
# Codex hook JSON in/out: reads JSON payload on stdin, writes JSON response on stdout.
# Payload: { "event": "Stop", "session_id": "...", "stopReason": "...", "cwd": "..." }
# Response: { "continue": true, "systemMessage": "..." }
#
# PreCompact workaround (locked decision #3):
#   Codex has no native PreCompact event. This Stop hook reads the session JSONL
#   transcript (if transcript_path is in the payload) and estimates output token
#   count. When output_tokens > IJFW_COMPRESS_THRESHOLD (default 40000), it emits
#   a compress-hint systemMessage so the next session starts with the preserve
#   instructions in context. Best-effort: works when transcript_path is present.
#
# No set -e -- hooks must never crash Codex.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

IJFW_DIR=".ijfw"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
ISO_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || TZ=UTC date +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$IJFW_DIR/sessions" "$IJFW_DIR/memory" "$IJFW_DIR/metrics" 2>/dev/null

METRICS_FILE="$IJFW_DIR/metrics/sessions.jsonl"
MODE="${IJFW_MODE:-smart}"
ROUTING="native"
case "${OPENROUTER_API_KEY:-}" in ?*) ROUTING="OpenRouter" ;; esac

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

# Read hook payload from stdin.
HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi

# Write metrics JSONL + check for PreCompact threshold.
COMPRESS_HINT=""
if command -v node >/dev/null 2>&1; then
  COMPRESS_THRESHOLD="${IJFW_COMPRESS_THRESHOLD:-40000}"
  RESULT=$(node -e '
    const fs = require("fs");
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let model = null;

    // Parse Stop hook stdin for transcript_path; sum usage across turns.
    try {
      const stdin = process.argv[8] || "";
      if (stdin.trim()) {
        const payload = JSON.parse(stdin);
        const tp = payload && (payload.transcript_path || (payload.session && payload.session.transcript_path));
        if (tp && fs.existsSync(tp)) {
          const lines = fs.readFileSync(tp, "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const m = JSON.parse(line);
              const u = m && m.message && m.message.usage;
              if (u) {
                usage.input_tokens += u.input_tokens || 0;
                usage.output_tokens += u.output_tokens || 0;
                usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
                usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
              }
              if (m && m.message && m.message.model && !model) model = m.message.model;
            } catch {}
          }
        }
      }
    } catch {}

    const baseFactor = Number(process.env.IJFW_BASELINE_FACTOR) || 1.25;
    const baselineOut = Math.round(usage.output_tokens * baseFactor);
    const compression = usage.output_tokens > 0
      ? Math.round((usage.output_tokens / baselineOut) * 10000) / 10000
      : null;

    const o = {
      v: 1,
      platform: "codex",
      timestamp: process.argv[1],
      session: Number(process.argv[2]),
      mode: process.argv[3],
      routing: process.argv[4],
      memory_stores: Number(process.argv[5]),
      handoff: process.argv[6] === "true",
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens,
      cache_creation_tokens: usage.cache_creation_input_tokens,
      model: model,
      baseline_tokens_estimate: baselineOut,
      compression_ratio: compression,
      baseline_factor: baseFactor
    };

    // PreCompact workaround: emit compress hint if output tokens > threshold.
    const threshold = Number(process.argv[7]) || 40000;
    const needsCompress = usage.output_tokens > threshold;

    const out = { metrics: o, needs_compress: needsCompress };
    process.stdout.write(JSON.stringify(out));
  ' "$ISO_TIMESTAMP" "$SESSION_NUM" "$MODE" "$ROUTING" "$MEMORY_STORES" "$HAS_HANDOFF" "$COMPRESS_THRESHOLD" "$HOOK_STDIN" 2>/dev/null)

  if [ -n "$RESULT" ]; then
    METRICS=$(node -e 'try{const r=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(r.metrics)||"")}catch{}' "$RESULT" 2>/dev/null)
    NEEDS_COMPRESS=$(node -e 'try{const r=JSON.parse(process.argv[1]);process.stdout.write(r.needs_compress?"1":"0")}catch{process.stdout.write("0")}' "$RESULT" 2>/dev/null)
    if [ -n "$METRICS" ]; then
      printf '%s\n' "$METRICS" >> "$METRICS_FILE" 2>/dev/null
    fi
    if [ "${NEEDS_COMPRESS:-0}" = "1" ]; then
      COMPRESS_HINT=" | Context large -- run: ijfw compress"
    fi
  fi
fi

# Session marker.
{
  echo "<!-- ijfw schema:1 -->"
  echo "# Session: $TIMESTAMP"
  echo "Session #$SESSION_NUM"
  echo "Memory updates this session: $MEMORY_STORES"
  echo "Handoff present: $HAS_HANDOFF"
  echo "Platform: codex"
} > "$IJFW_DIR/sessions/session_$TIMESTAMP.md" 2>/dev/null

# Journal entry.
JOURNAL="$IJFW_DIR/memory/project-journal.md"
if [ ! -f "$JOURNAL" ]; then
  {
    echo "<!-- ijfw schema:1 -->"
    echo "# IJFW Project Journal"
  } > "$JOURNAL" 2>/dev/null
fi
printf -- '- [%s] codex-session-end: #%s\n' "$ISO_TIMESTAMP" "$SESSION_NUM" >> "$JOURNAL" 2>/dev/null

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
    "$(dirname "$0")/../../../claude/skills/ijfw-summarize/scripts/dream-trigger.sh"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { DREAM_TRIGGER="$cand"; break; }
done
if [ -n "$DREAM_TRIGGER" ]; then
  bash "$DREAM_TRIGGER" "$(pwd)" "codex" "${IJFW_SESSION_ID:-}" 2>/dev/null || true
fi

# Session-dir pruning: keep newest 30.
if [ -d "$IJFW_DIR/sessions" ]; then
  PRUNE_COUNT=$(ls -1 "$IJFW_DIR/sessions" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${PRUNE_COUNT:-0}" -gt 30 ]; then
    mkdir -p "$IJFW_DIR/archive/sessions" 2>/dev/null
    ls -1t "$IJFW_DIR/sessions" 2>/dev/null | tail -n +31 | while IFS= read -r f; do
      src="$IJFW_DIR/sessions/$f"
      if command -v gzip >/dev/null 2>&1; then
        gzip -c "$src" > "$IJFW_DIR/archive/sessions/$f.gz" 2>/dev/null && rm -f "$src"
      else
        mv "$src" "$IJFW_DIR/archive/sessions/$f" 2>/dev/null
      fi
    done
  fi
fi

RECEIPT="[ijfw] Session #$SESSION_NUM saved$COMPRESS_HINT"

# 1.1.6 cross-platform status card -- one-line context+update nudge.
# Pulls from the same composer Claude's statusLine + Gemini AfterAgent use.
# Best-effort: silent on any failure; never breaks the response.
STATUS_CARD=""
if command -v node >/dev/null 2>&1; then
  STATUS_CARD_JS="$HOME/.ijfw/mcp-server/src/lib/status-card.js"
  if [ -f "$STATUS_CARD_JS" ] && [ -n "${METRICS:-}" ]; then
    STATUS_CARD=$(node -e '
      try {
        const { composeStatusCard } = await import(process.argv[1]);
        const m = JSON.parse(process.argv[2] || "{}");
        const inT = m.input_tokens || 0, outT = m.output_tokens || 0;
        const win = Number(process.env.IJFW_CTX_WINDOW_TOKENS || 200000);
        const pct = win > 0 ? ((inT + outT) / win) * 100 : null;
        const card = composeStatusCard({ contextPct: pct });
        if (card) process.stdout.write(card);
      } catch {}
    ' "$STATUS_CARD_JS" "$METRICS" 2>/dev/null)
  fi
fi
if [ -n "$STATUS_CARD" ]; then
  RECEIPT="$RECEIPT"$'\n'"$STATUS_CARD"
fi

# Emit Codex-format JSON response.
if command -v node >/dev/null 2>&1; then
  node -e '
    const receipt = process.argv[1] || "[ijfw] Session saved";
    process.stdout.write(JSON.stringify({ "continue": true, "systemMessage": receipt }) + "\n");
  ' "$RECEIPT" 2>/dev/null
else
  printf '{"continue":true,"systemMessage":"%s"}\n' "$RECEIPT"
fi

exit 0
