#!/usr/bin/env bash
# IJFW SessionEnd (Stop hook) -- save session state, write metrics, manage journal.
# NOTE: no `set -e` -- hooks must NEVER crash Claude Code.
#
# IMPORTANT -- Stop fires after EVERY assistant turn, not once per session.
# Metrics row contract (.ijfw/metrics/sessions.jsonl, schema v5):
#   - One row is appended per turn. Each row carries the CUMULATIVE usage
#     totals for the whole session so far, plus "session_id" (from the Stop
#     payload) and a monotonically increasing "turn" counter.
#   - Aggregators MUST dedupe by session_id and take the LATEST row per
#     session (last-row-wins; order by turn, falling back to timestamp).
#     Summing all rows for a session overcounts quadratically.
#   - Transcript usage is read INCREMENTALLY via a byte-offset cursor in
#     .ijfw/metrics/.transcript-cursor.json -- only the appended tail is
#     parsed each turn, never the whole transcript.

# E4 -- universal disable switch. Any hook respects IJFW_DISABLE=1.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
#
# Hardened against:
#   - JSONL corruption from unescaped env vars (uses node -e to encode JSON)
#   - local-time timestamps masquerading as UTC (TZ=UTC fallback)
#   - clobbering session-start's startup flags (always >>)
#   - schema drift (every record carries "v":1)

IJFW_DIR=".ijfw"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
# UTC ISO timestamp with TZ=UTC fallback for hardened containers where `date -u` fails.
ISO_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || TZ=UTC date +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$IJFW_DIR/sessions" "$IJFW_DIR/memory" "$IJFW_DIR/metrics" 2>/dev/null

METRICS_FILE="$IJFW_DIR/metrics/sessions.jsonl"

MODE="${IJFW_MODE:-smart}"
EFFORT="${CLAUDE_CODE_EFFORT_LEVEL:-high}"

ROUTING="native"
case "${OPENROUTER_API_KEY:-}" in ?*) ROUTING="OpenRouter" ;; esac
[ -f "$HOME/.claude-code-router/config.json" ] && ROUTING="smart-routing"

# Billing mode detection. ANTHROPIC_API_KEY in env is the unambiguous
# paid-API signal. Without it, Claude Code is using OAuth (Max/Pro/Team
# subscription) -- the OAuth token may live in ~/.claude/.credentials.json
# (Linux/Windows) or in the macOS Keychain, both of which Claude Code
# manages itself. Override with IJFW_BILLING_MODE=max|api.
BILLING_MODE="${IJFW_BILLING_MODE:-}"
if [ -z "$BILLING_MODE" ]; then
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    BILLING_MODE="api"
  else
    BILLING_MODE="max"
  fi
fi

MEMORY_STORES=0
if [ -f "$IJFW_DIR/memory/project-journal.md" ]; then
  MEMORY_STORES=$(grep -c '^- \[' "$IJFW_DIR/memory/project-journal.md" 2>/dev/null)
  [ -z "$MEMORY_STORES" ] && MEMORY_STORES=0
fi

# Read Claude Code Stop hook payload from stdin (best-effort).
# Payload includes transcript_path; we parse the transcript for usage tokens.
HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi

# Extract session_id from the payload without spawning node (best-effort;
# session ids are UUIDs so a simple sed is safe). Used to keep SESSION_NUM
# stable across the many Stop firings of one session.
PAYLOAD_SESSION_ID=""
if [ -n "$HOOK_STDIN" ]; then
  PAYLOAD_SESSION_ID=$(printf '%s' "$HOOK_STDIN" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi

LOCK="$IJFW_DIR/.session-counter.lock"
COUNTER="$IJFW_DIR/.session-counter"
COUNTER_ID="$IJFW_DIR/.session-counter-id"
MARKER_TS_FILE="$IJFW_DIR/.session-marker-ts"
SESSION_NUM=""
SAME_SESSION="false"
for i in 1 2 3 4 5; do
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
    CURRENT=$(cat "$COUNTER" 2>/dev/null || echo 0)
    # Stop fires every turn: only advance the counter on the FIRST Stop of a
    # session (new session_id); later turns reuse the same number so journal
    # entries / markers / metrics rows do not inflate per turn.
    if [ -n "$PAYLOAD_SESSION_ID" ] && [ "$(cat "$COUNTER_ID" 2>/dev/null)" = "$PAYLOAD_SESSION_ID" ] && [ "${CURRENT:-0}" -gt 0 ] 2>/dev/null; then
      SESSION_NUM="$CURRENT"
      SAME_SESSION="true"
    else
      SESSION_NUM=$((CURRENT + 1))
      echo "$SESSION_NUM" > "$COUNTER"
      if [ -n "$PAYLOAD_SESSION_ID" ]; then
        echo "$PAYLOAD_SESSION_ID" > "$COUNTER_ID" 2>/dev/null
      else
        rm -f "$COUNTER_ID" 2>/dev/null
      fi
      echo "$TIMESTAMP" > "$MARKER_TS_FILE" 2>/dev/null
    fi
    rmdir "$LOCK" 2>/dev/null
    trap - EXIT
    break
  fi
  sleep 0.1
done
SESSION_NUM="${SESSION_NUM:-$(date +%s%N 2>/dev/null | tail -c 8 || date +%s)}"

HAS_HANDOFF="false"
[ -f "$IJFW_DIR/memory/handoff.md" ] && HAS_HANDOFF="true"

# Schema v2 (Phase 3 #6 + #2): adds input/output/cache tokens, cost_usd, model,
# and reserved prompt_check_* fields. v1 readers tolerate missing fields; v2
# readers tolerate v1 lines (token fields default to 0). Single bump avoids
# the coordination bug flagged in AUDIT.md.
# Schema v5: adds session_id + turn. Rows stay CUMULATIVE per session (one row
# per Stop/turn); aggregators dedupe by session_id, last-row-wins (see header).
if command -v node >/dev/null 2>&1; then
  JSONLINE=$(node -e '
    const fs = require("fs");
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let model = null;
    let sessionId = null;
    let turn = 1;

    // Parse Stop hook stdin (JSON) for transcript_path. Stop fires every turn,
    // so usage is summed INCREMENTALLY: a byte-offset cursor persisted in
    // .ijfw/metrics/.transcript-cursor.json records how far into the transcript
    // we already counted; each turn reads only the appended tail. The running
    // totals live in the cursor, so the emitted row is still cumulative.
    try {
      const stdin = process.argv[8] || "";
      if (stdin.trim()) {
        const payload = JSON.parse(stdin);
        const tp = payload && payload.transcript_path;
        sessionId = (payload && typeof payload.session_id === "string" && payload.session_id) || null;
        const cursorFile = ".ijfw/metrics/.transcript-cursor.json";
        let cur = null;
        try { cur = JSON.parse(fs.readFileSync(cursorFile, "utf8")); } catch {}
        // Reuse the cursor only for the SAME session; without a session id we
        // cannot tell sessions apart, so fall back to a full re-read.
        if (!sessionId || !cur || typeof cur !== "object" || cur.session_id !== sessionId) {
          cur = { v: 1, session_id: sessionId, transcript_path: null, offset: 0, turn: 0, usage: null, model: null };
        }
        turn = (Number(cur.turn) || 0) + 1;
        cur.turn = turn;
        const maxBytes = Number(process.env.IJFW_TRANSCRIPT_MAX_BYTES || 100 * 1024 * 1024);
        let st = null;
        try { st = tp && fs.statSync(tp); } catch {}
        if (st && st.isFile()) {
          // Resume from the cursor only if it points inside the same file.
          // Offsets always land on a line boundary, so utf8 decode is safe.
          let start = 0;
          if (cur.transcript_path === tp && Number.isFinite(cur.offset)
              && cur.offset > 0 && cur.offset <= st.size && cur.usage) {
            start = cur.offset;
            usage.input_tokens = Number(cur.usage.input_tokens) || 0;
            usage.output_tokens = Number(cur.usage.output_tokens) || 0;
            usage.cache_read_input_tokens = Number(cur.usage.cache_read_input_tokens) || 0;
            usage.cache_creation_input_tokens = Number(cur.usage.cache_creation_input_tokens) || 0;
            model = cur.model || null;
          }
          const toRead = st.size - start;
          if (toRead > 0 && toRead <= maxBytes) {
            const fd = fs.openSync(tp, "r");
            const buf = Buffer.alloc(toRead);
            const got = fs.readSync(fd, buf, 0, toRead, start);
            fs.closeSync(fd);
            const text = buf.toString("utf8", 0, got);
            const lines = text.split("\n");
            // A trailing partial line (no newline yet) is left for next turn.
            let pendingBytes = 0;
            if (lines.length && lines[lines.length - 1] !== "") {
              pendingBytes = Buffer.byteLength(lines.pop(), "utf8");
            }
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
            cur.transcript_path = tp;
            cur.offset = start + got - pendingBytes;
            cur.usage = usage;
            cur.model = model;
          } else if (toRead === 0 && start > 0) {
            // Nothing appended since last turn; totals carry over unchanged.
          }
        }
        try { fs.writeFileSync(cursorFile, JSON.stringify(cur)); } catch {}
      }
    } catch {}

    // Pricing table (USD per million tokens). Conservative -- unknown family = 0.
    // Hardcoded (no proxy/no network rule). Y3 -- match by FAMILY prefix so a
    // minor bump (4-6 → 4-7) still resolves and we never silently render $0.
    const FAMILIES = [
      { prefix: "claude-opus-",   p: { in: 15.0, out: 75.0, cr: 1.50, cc: 18.75 } },
      { prefix: "claude-sonnet-", p: { in:  3.0, out: 15.0, cr: 0.30, cc:  3.75 } },
      { prefix: "claude-haiku-",  p: { in:  0.8, out:  4.0, cr: 0.08, cc:  1.00 } }
    ];
    function theoreticalCost() {
      if (!model) return 0;
      const normalized = String(model).replace(/-\d{8}.*$/, "").replace(/\[.*?\]$/, "");
      const fam = FAMILIES.find(f => normalized.startsWith(f.prefix));
      if (!fam) return 0;
      const p = fam.p;
      const c = (usage.input_tokens * p.in + usage.output_tokens * p.out
              + usage.cache_read_input_tokens * p.cr + usage.cache_creation_input_tokens * p.cc) / 1e6;
      return Math.round(c * 10000) / 10000;
    }

    // Billing mode determines whether theoretical cost is what the user pays.
    // Max-subscription sessions: cost_usd is 0 paid; theoretical_cost_usd
    // captures the value covered by the subscription. Lowercased to tolerate
    // IJFW_BILLING_MODE=MAX as well as max.
    const billingMode = (process.argv[9] || "api").toLowerCase();
    const theoretical = theoreticalCost();
    const realCost = billingMode === "max" ? 0 : theoretical;

    // Baseline factor: average ratio of unconstrained-output tokens to
    // IJFW-constrained-output tokens. Starts at 1.65 (conservative estimate
    // from early benchmarks); W1.2 replaces this with measured value. User
    // can override via IJFW_BASELINE_FACTOR. Readers MUST tolerate absent.
    // Baseline factor calibrated against REPORT-001.md: 1.25 is the
    // measured output-token ratio (Arm A / Arm C on 01-bug-paginator,
    // sonnet-4-5). Cost savings run higher (~1.7) due to cache-creation
    // reduction; set IJFW_BASELINE_FACTOR=1.7 for cost-based framing.
    const baseFactor = Number(process.env.IJFW_BASELINE_FACTOR) || 1.25;
    const baselineOut = Math.round(usage.output_tokens * baseFactor);
    const compression = usage.output_tokens > 0
      ? Math.round((usage.output_tokens / baselineOut) * 10000) / 10000
      : null;

    const o = {
      // v5: + session_id and turn. One CUMULATIVE row per turn; aggregators
      // must take the latest row per session_id (last-row-wins), not sum rows.
      v: 5,
      timestamp: process.argv[1],
      session: Number(process.argv[2]),
      session_id: sessionId,
      turn: turn,
      mode: process.argv[3],
      effort: process.argv[4],
      routing: process.argv[5],
      memory_stores: Number(process.argv[6]),
      handoff: process.argv[7] === "true",
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens,
      cache_creation_tokens: usage.cache_creation_input_tokens,
      // v4: explicit billing-mode split. cost_usd is what the user paid;
      // theoretical_cost_usd is what equivalent paid-API usage would cost.
      // For Max sessions cost_usd is 0 and theoretical_cost_usd shows the
      // value captured by the subscription. v3 readers tolerate the new
      // fields (cost_usd retained as primary).
      billing_mode: billingMode,
      cost_usd: realCost,
      theoretical_cost_usd: theoretical,
      model: model,
      // Phase 4 W1.3 -- schema v3.
      baseline_tokens_estimate: baselineOut,
      compression_ratio: compression,
      baseline_factor: baseFactor,
      // Phase 3 #2 -- populated by pre-prompt hook.
      prompt_check_fired: false,
      prompt_check_signals: []
    };

    // Merge prompt-check state file if present (set by #2 pre-prompt hook).
    try {
      const pcs = ".ijfw/.prompt-check-state";
      if (fs.existsSync(pcs)) {
        const st = JSON.parse(fs.readFileSync(pcs, "utf8"));
        if (st && typeof st === "object") {
          o.prompt_check_fired = !!st.fired;
          o.prompt_check_signals = Array.isArray(st.signals) ? st.signals : [];
        }
        try { fs.unlinkSync(pcs); } catch {}
      }
    } catch {}

    process.stdout.write(JSON.stringify(o));
  ' "$ISO_TIMESTAMP" "$SESSION_NUM" "$MODE" "$EFFORT" "$ROUTING" "$MEMORY_STORES" "$HAS_HANDOFF" "$HOOK_STDIN" "$BILLING_MODE" 2>/dev/null)
  if [ -n "$JSONLINE" ]; then
    printf '%s\n' "$JSONLINE" >> "$METRICS_FILE" 2>/dev/null
  fi
fi

# Session marker -- fixed-format, no user input interpolated. Stop fires per
# turn: reuse the session's first-seen timestamp so later turns overwrite the
# SAME marker file instead of creating one file per turn (prune-loop churn).
MARKER_TS="$TIMESTAMP"
if [ "$SAME_SESSION" = "true" ]; then
  MARKER_TS=$(cat "$MARKER_TS_FILE" 2>/dev/null)
  [ -z "$MARKER_TS" ] && MARKER_TS="$TIMESTAMP"
fi
{
  echo "<!-- ijfw schema:1 -->"
  echo "# Session: $MARKER_TS"
  echo "Session #$SESSION_NUM"
  echo "Memory updates this session: $MEMORY_STORES"
  echo "Handoff present: $HAS_HANDOFF"
} > "$IJFW_DIR/sessions/session_$MARKER_TS.md" 2>/dev/null

# Append schema-versioned journal entry -- once per session, not per turn.
if [ "$SAME_SESSION" != "true" ]; then
  JOURNAL="$IJFW_DIR/memory/project-journal.md"
  if [ ! -f "$JOURNAL" ]; then
    {
      echo "<!-- ijfw schema:1 -->"
      echo "# IJFW Project Journal"
    } > "$JOURNAL" 2>/dev/null
  fi
  printf -- '- [%s] session-end: #%s\n' "$ISO_TIMESTAMP" "$SESSION_NUM" >> "$JOURNAL" 2>/dev/null
fi

# --- Profile bus P1: flush the per-session style accumulator ---
# Turns the per-message metadata accumulated by pre-prompt.sh into ONE
# .ijfw/.session-style.jsonl contract record (METADATA ONLY), applying the
# hardening gates (quarantine / PII / identity / influence-cap). Best-effort +
# isolated: a flush failure never crashes Claude Code.
#
# H1 lifecycle ordering (audit fix): this flush MUST run BEFORE the dream-trigger
# spawn (deferred to end-of-file). flushSession is synchronous + fast, and it
# writes THIS session's style row into .ijfw/.session-style.jsonl. The dream
# cycle that this same session spawns reads that style stream, so the row must
# be durably on disk before the detached consumer launches -- otherwise the
# freshest session never informs the run it triggered.
#
# H3 lifecycle ordering (audit fix): export the canonical IJFW_HOST so
# capture.js resolveHost() stamps the SAME provenance string the dream-trigger
# spawn passes (--host claude-code). 'claude-code' is capture.js's resolveHost
# default + its KNOWN_HOSTS trust-table key; keeping them identical makes
# per-host trust + provenance consistent end-to-end.
export IJFW_HOST="${IJFW_HOST:-claude-code}"
CAPTURE_FLUSH=""
for base in \
    "$CLAUDE_PLUGIN_ROOT/../mcp-server/src" \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/capture.js" ]; then CAPTURE_FLUSH="$base/profile/capture.js"; break; fi
done
if [ -n "$CAPTURE_FLUSH" ] && command -v node >/dev/null 2>&1; then
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
  " "$CAPTURE_FLUSH" "${IJFW_SESSION_ID:-$SESSION_NUM}" 2>>"$HOME/.ijfw/logs/memorize.log" || true
fi

# Dream cycle trigger (D3 -- inline detached spawn at SessionEnd).
# Replaces the legacy `SESSION_NUM % 5 == 0` startup-flag deferral with
# a fire-and-forget spawn that returns within ~50ms (hook latency
# budget). Cooldown enforced by runner.mjs via .ijfw/.dream-state.json
# (4h). Set IJFW_DREAM_LEGACY=1 to revert to the old startup-flag path.
#
# H1/H2 lifecycle ordering (audit fix): RESOLUTION happens here, but the
# detached SPAWN is deferred to AFTER (a) flushSession writes this session's
# style row and (b) memorize truncates .session-feedback.jsonl. See the
# "Dream cycle spawn (deferred)" block near end-of-file for the invocation and
# the full ordering rationale. We only resolve the path here so the spawn
# block stays a single guarded line.
DREAM_TRIGGER=""
for cand in \
    "$HOME/.ijfw/claude/skills/ijfw-summarize/scripts/dream-trigger.sh" \
    "${IJFW_HOME:-}/claude/skills/ijfw-summarize/scripts/dream-trigger.sh" \
    "$(pwd)/claude/skills/ijfw-summarize/scripts/dream-trigger.sh" \
    "$(dirname "$0")/../../skills/ijfw-summarize/scripts/dream-trigger.sh"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { DREAM_TRIGGER="$cand"; break; }
done

# W4.6 / R6 -- session-dir pruning. Keep newest 30 markers; archive older
# to .ijfw/archive/sessions/ as gzip if gzip is available, else rm.
if [ -d "$IJFW_DIR/sessions" ]; then
  PRUNE_COUNT=$(ls -1 "$IJFW_DIR/sessions" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${PRUNE_COUNT:-0}" -gt 30 ]; then
    mkdir -p "$IJFW_DIR/archive/sessions" 2>/dev/null
    # shellcheck disable=SC2012
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

# W4.6 / R3 -- memory archival for journal entries >90 days old. Line-based
# journal entries have ISO timestamps in [YYYY-MM-DD...] prefix; we keep the
# newest window and archive the rest monthly.
if [ -f "$IJFW_DIR/memory/project-journal.md" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const path = ".ijfw/memory/project-journal.md";
    const archDir = ".ijfw/archive";
    try {
      const raw = fs.readFileSync(path, "utf8");
      const lines = raw.split("\n");
      const cutoff = Date.now() - 90 * 24 * 3600e3;
      const keep = [];
      const archiveByMonth = new Map();
      let header = "";
      for (const line of lines) {
        if (!header && line.startsWith("<!--")) { header = line; continue; }
        if (!header && line.startsWith("#"))    { header = header ? header + "\n" + line : line; continue; }
        const m = line.match(/^- \[(\d{4})-(\d{2})-\d{2}T[\d:.Z]+\]/);
        if (!m) { keep.push(line); continue; }
        const ts = Date.parse(line.match(/\[([^\]]+)\]/)[1]);
        if (!Number.isFinite(ts) || ts >= cutoff) { keep.push(line); continue; }
        const key = m[1] + "-" + m[2];
        if (!archiveByMonth.has(key)) archiveByMonth.set(key, []);
        archiveByMonth.get(key).push(line);
      }
      if (archiveByMonth.size === 0) return;
      fs.mkdirSync(archDir, { recursive: true });
      for (const [k, ls] of archiveByMonth) {
        const aPath = `${archDir}/journal-${k}.md`;
        const prior = fs.existsSync(aPath) ? fs.readFileSync(aPath, "utf8") : `<!-- ijfw-schema: v1 -->\n# Journal archive ${k}\n`;
        fs.writeFileSync(aPath, prior + ls.join("\n") + "\n");
      }
      fs.writeFileSync(path, (header ? header + "\n" : "") + keep.filter(l => l !== "").join("\n") + "\n");
    } catch {}
  ' 2>/dev/null
fi

# W4.6 / ST3 -- hook error log. Any captured stderr from this session is
# appended here so /doctor can surface it next startup. Per-hook hooks
# redirect their stderr to this file if they choose; this block just
# ensures the file exists and is rotated weekly.
# P5.2 / H1 -- invoke auto-memorize synthesizer. Silent if consent not set.
# Resolve the binary: plugin cache first, HOME-installed second, dev repo third.
MEMORIZE=""
for candidate in \
    "$CLAUDE_PLUGIN_ROOT/../mcp-server/bin/ijfw-memorize" \
    "$HOME/.ijfw/mcp-server/bin/ijfw-memorize" \
    "$(pwd)/mcp-server/bin/ijfw-memorize"; do
  if [ -x "$candidate" ]; then MEMORIZE="$candidate"; break; fi
done
if [ -n "$MEMORIZE" ]; then
  # Capture stderr so a memorize crash leaves a diagnostic trail; previously
  # 2>/dev/null swallowed it, so signal files got cleared anyway and the
  # captured signals/feedback were lost forever (1.2.9 audit H7 -- data loss).
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  MEMO_OUT=$("$MEMORIZE" 2>>"$HOME/.ijfw/logs/memorize.log")
  MEMO_RC=$?
  if [ -n "$MEMO_OUT" ]; then
    echo "$MEMO_OUT"
  fi
  # Only clear signal files when the synthesizer actually succeeded. On
  # failure, leave them in place so the next session retries.
  if [ "$MEMO_RC" -eq 0 ]; then
    [ -f "$IJFW_DIR/.session-signals.jsonl" ]  && : > "$IJFW_DIR/.session-signals.jsonl"
    [ -f "$IJFW_DIR/.session-feedback.jsonl" ] && : > "$IJFW_DIR/.session-feedback.jsonl"
  fi
fi

# Dream cycle spawn (deferred) -- H1/H2 lifecycle ordering (audit fix).
#
# Deterministic order enforced across this script:
#   1. flushSession (above, pre-resolution): writes THIS session's style row to
#      .ijfw/.session-style.jsonl BEFORE any dream consumer launches (H1).
#   2. memorize + its .session-feedback.jsonl truncation (the block directly
#      above): runs to completion synchronously.
#   3. dream-trigger spawn (HERE): launched only AFTER (1) and (2) have settled.
#
# Why spawn last (H2 feedback-race rationale): memorize truncates
# .session-feedback.jsonl on success, while the detached runner.mjs reads that
# same file. Spawning the dream consumer AFTER the truncation has already
# completed eliminates the concurrent read-vs-truncate window entirely -- the
# runner can never observe the file mid-truncation. The tradeoff is that this
# session's feedback rows are consumed by memorize (which IS the feedback->
# preference synthesizer) rather than by the dream cycle; the dream cycle's job
# here is style/pattern consolidation over the .session-style.jsonl stream that
# step (1) just populated, so it still receives this session's freshest signal.
# (A parallel change adds a cursor to the dream stage for idempotent feedback
# consumption, but correctness here does NOT depend on it -- the ordering alone
# closes the race window.)
#
# H3: pass the canonical 'claude-code' host (matches capture.js resolveHost
# default + the IJFW_HOST exported before flushSession) so provenance + per-host
# trust stay consistent end-to-end. Replaces the old literal "claude".
if [ -n "$DREAM_TRIGGER" ]; then
  bash "$DREAM_TRIGGER" "$(pwd)" "claude-code" "${IJFW_SESSION_ID:-}" 2>/dev/null || true
fi

HOOK_LOG="$HOME/.ijfw/logs/hooks.log"
mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
touch "$HOOK_LOG" 2>/dev/null
# Rotate if >256KB
if [ -f "$HOOK_LOG" ]; then
  size=$(wc -c < "$HOOK_LOG" 2>/dev/null | tr -d ' ')
  if [ "${size:-0}" -gt 262144 ]; then
    mv "$HOOK_LOG" "$HOOK_LOG.$(date -u +%Y%m%d 2>/dev/null || echo old)" 2>/dev/null
    : > "$HOOK_LOG"
  fi
fi

# Observation ledger summary -- fires when >= 2 observations exist for session.
_OBS_SUMMARIZE="${IJFW_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)}/scripts/observation/summarize.js"
_SESSION_ID=""
[ -f "$HOME/.ijfw/.current-session" ] && _SESSION_ID=$(cat "$HOME/.ijfw/.current-session" 2>/dev/null)
if command -v node >/dev/null 2>&1 && [ -f "$_OBS_SUMMARIZE" ] && [ -n "$_SESSION_ID" ]; then
  _SUMMARY=$(node -e '
    import("file://" + process.argv[1]).then(m => {
      const s = m.summarize(process.argv[2]);
      if (s) process.stdout.write(s + "\n");
    }).catch(() => {});
  ' "$_OBS_SUMMARIZE" "$_SESSION_ID" 2>/dev/null)
  if [ -n "$_SUMMARY" ]; then
    mkdir -p "$IJFW_DIR/memory" 2>/dev/null
    {
      echo ""
      echo "$_SUMMARY"
    } >> "$IJFW_DIR/memory/handoff.md" 2>/dev/null
  fi
fi

# Recap line -- stats + dashboard URL + savings. One compact block.
# Builds parts, then emits. Always positive-framed.

# Dashboard URL (if server is running).
DASH_PORT_FILE="$HOME/.ijfw/dashboard.port"
DASH_URL=""
if [ -f "$DASH_PORT_FILE" ]; then
  DASH_PORT=$(cat "$DASH_PORT_FILE" 2>/dev/null)
  [ -n "$DASH_PORT" ] && DASH_URL="http://localhost:$DASH_PORT"
fi

# Savings reframe (W1.3 / C1). Reads the JSONL line we just appended.
SAVINGS_LINE=""
if command -v node >/dev/null 2>&1 && [ -f "$METRICS_FILE" ]; then
  SAVINGS_LINE=$(node -e '
    const fs = require("fs");
    try {
      const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
      if (!lines.length) return;
      const last = JSON.parse(lines[lines.length - 1]);
      const out = last.output_tokens || 0;
      if (out <= 0) return;
      const baseline = last.baseline_tokens_estimate || Math.round(out * 1.25);
      const saved = Math.max(0, baseline - out);
      const cost = last.cost_usd || 0;
      const baseFactor = last.baseline_factor || 1.25;
      const costSaved = cost > 0 && out > 0 ? (cost * (baseFactor - 1) / baseFactor) : 0;
      const fmt = n => n >= 1000 ? (n/1000).toFixed(1) + "k" : String(n);
      process.stdout.write(`~${fmt(saved)} tokens saved (~$${costSaved.toFixed(3)})`);
    } catch {}
  ' "$METRICS_FILE" 2>/dev/null)
fi

# Emit recap. Format: "[ijfw] Session #N saved. ~Xk tokens saved (~$0.XXX). Dashboard: URL"
if [ -n "$SAVINGS_LINE" ] && [ -n "$DASH_URL" ]; then
  printf '[ijfw] Session #%s saved. %s. Dashboard: %s\n' "$SESSION_NUM" "$SAVINGS_LINE" "$DASH_URL"
elif [ -n "$SAVINGS_LINE" ]; then
  printf '[ijfw] Session #%s saved. %s.\n' "$SESSION_NUM" "$SAVINGS_LINE"
elif [ -n "$DASH_URL" ]; then
  printf '[ijfw] Session #%s saved. Dashboard: %s\n' "$SESSION_NUM" "$DASH_URL"
else
  printf '[ijfw] Session #%s saved.\n' "$SESSION_NUM"
fi

# Memory + next-step receipt (polish 13). Silent on error -- hooks never crash.
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    try {
      // Writer is mcp-server/src/receipts.js (receipts/ subdir); keep in sync
      // with session-start.sh RECEIPTS_FILE.
      const tridentFile = ".ijfw/receipts/cross-runs.jsonl";
      const knowledgeFile = ".ijfw/memory/knowledge.md";
      const handoffFile = ".ijfw/memory/handoff.md";

      let tridentRuns = 0;
      if (fs.existsSync(tridentFile)) {
        tridentRuns = fs.readFileSync(tridentFile, "utf8").split("\n").filter(Boolean).length;
      }
      let decisions = 0;
      if (fs.existsSync(knowledgeFile)) {
        decisions = (fs.readFileSync(knowledgeFile, "utf8").match(/^---$/gm) || []).length / 2 | 0;
      }
      const bits = [];
      if (decisions > 0) bits.push(`${decisions} decisions stored`);
      if (tridentRuns > 0) bits.push(`${tridentRuns} Trident runs on record`);
      if (bits.length > 0) process.stdout.write(`[ijfw] Memory: ${bits.join(" -- ")}.\n`);

      if (fs.existsSync(handoffFile)) {
        const body = fs.readFileSync(handoffFile, "utf8");
        const m = body.match(/^(?:###\s*)?Next Steps?[\s\S]*?\n[-\d.]\s*([^\n]+)/mi);
        if (m) process.stdout.write(`[ijfw] Next: ${m[1].trim().slice(0, 90)}\n`);
      }
    } catch {}
  ' 2>/dev/null
fi

# First-time discovery hint -- shown once, then never again.
# Sutherland discovery pattern: user finds observability when in reflection mode.
DISCOVERY_FLAG="$HOME/.ijfw/.discovery-shown"
if [ ! -f "$DISCOVERY_FLAG" ]; then
  printf '[ijfw] Run /ijfw status anytime for full observability.\n'
  mkdir -p "$HOME/.ijfw" 2>/dev/null
  touch "$DISCOVERY_FLAG" 2>/dev/null
fi

exit 0
