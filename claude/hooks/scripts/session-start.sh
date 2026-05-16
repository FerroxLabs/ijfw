#!/usr/bin/env bash
# E4 -- universal disable switch.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
# IJFW SessionStart -- emits banner first, runs detection async, never crashes Claude Code.
#
# Hardened against:
#   - blocking on slow probes (banner emits within ~10ms, probes finish in background)
#   - bash 4+ syntax (uses files instead of arrays -- works on macOS bash 3.2)
#   - python3 dependency (replaced with node -e everywhere -- node is guaranteed)
#   - migration race on parallel session-start (mkdir-atomic lock)
#   - migration double-import on crash (.migrated written FIRST, in lock)
#   - non-portable shell (POSIX case instead of [[ ]])
#   - prompt injection via imported memories (sanitised before journal append)
#   - .ijfw existing as a file instead of dir (graceful abort)
#   - cross-project leak via Claude native MEMORY.md (full-path hash match)
#   - silent feature loss (sqlite3/python3 missing → positive-framed actionable line)
#   - jargon in user-facing output (no "effort", no JSONL, no file paths)

# No `set -e` -- hooks must NEVER crash Claude Code. Each section guards itself.

IJFW_DIR=".ijfw"
IJFW_GLOBAL="$HOME/.ijfw"
MIGRATED_FLAG="$IJFW_DIR/.migrated"
MIGRATION_LOCK="$IJFW_DIR/.migration.lock"

# --- Pre-flight: .ijfw must be a directory if it exists ---
if [ -e "$IJFW_DIR" ] && [ ! -d "$IJFW_DIR" ]; then
  cat <<'EOF'
[ijfw] ".ijfw" is a file here -- IJFW needs it as a directory. Rename or remove it, then start a new session.
EOF
  exit 0
fi

mkdir -p "$IJFW_DIR/memory" "$IJFW_DIR/sessions" "$IJFW_DIR/index" 2>/dev/null
mkdir -p "$IJFW_GLOBAL/memory" 2>/dev/null

# 1.1.6: detached background update-check + stale run-dir cleanup.
# All logic (dedupe, interval, env-disable, re-entrancy) lives in the .js
# worker -- this fire-and-forget spawn keeps the SessionStart hot-path clean.
# Wrapped in a 2s ceiling per v3 section 3.
IJFW_HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -x "$IJFW_HOOK_DIR/ijfw-check-update.sh" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  "$IJFW_HOOK_DIR/ijfw-check-update.sh" </dev/null >>"$HOME/.ijfw/logs/update-check.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# --- Project registry (Phase 3: enables cross-project memory search) ---
# Append <absolute-path> | <sha256-12> | <first-seen-iso> on first sight only.
# Registry lives in ~/.ijfw/ (gitignored); per-project memory remains in repo.
REGISTRY_FILE="$IJFW_GLOBAL/registry.md"
PROJECT_PATH=$(pwd -P 2>/dev/null)
if [ -n "$PROJECT_PATH" ]; then
  if [ ! -f "$REGISTRY_FILE" ] || ! grep -qF "$PROJECT_PATH |" "$REGISTRY_FILE" 2>/dev/null; then
    REG_HASH=$(printf '%s' "$PROJECT_PATH" | shasum 2>/dev/null | cut -c1-12)
    REG_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)
    if [ -n "$REG_HASH" ] && [ -n "$REG_ISO" ]; then
      printf '%s | %s | %s\n' "$PROJECT_PATH" "$REG_HASH" "$REG_ISO" >> "$REGISTRY_FILE" 2>/dev/null
    fi
  fi
fi

# Reset session-scoped state.
: > "$IJFW_DIR/.startup-flags" 2>/dev/null
MIGRATION_MSGS_FILE="$IJFW_DIR/.migration-msgs"
: > "$MIGRATION_MSGS_FILE" 2>/dev/null
DETECTION_FILE="$IJFW_DIR/.detection"
: > "$DETECTION_FILE" 2>/dev/null

# --- Mode + effort detection ---
# Note: a child shell cannot mutate the parent process env, so we report the
# effective effort but do NOT pretend to "upgrade" it from inside the hook.
# Users wanting high effort set CLAUDE_CODE_EFFORT_LEVEL=high in their shell.
MODE="${IJFW_MODE:-smart}"
EFFORT="${CLAUDE_CODE_EFFORT_LEVEL:-high}"
UPGRADED_EFFORT=""

# --- Routing detection (sync but cheap -- env vars + file checks only, no network) ---
ROUTING=""
case "${OPENROUTER_API_KEY:-}" in ?*) ROUTING="multi-model routing" ;; esac
case "${ANTHROPIC_BASE_URL:-}" in
  *openrouter*) ROUTING="multi-model routing" ;;
esac
if [ -f "$HOME/.claude-code-router/config.json" ]; then
  [ -z "$ROUTING" ] && ROUTING="smart routing"
fi
# Portable claude-code-router process check (no `pgrep -f` -- busybox lacks it)
if [ -d /proc ] && grep -lq "claude-code-router" /proc/*/cmdline 2>/dev/null; then
  [ -z "$ROUTING" ] && ROUTING="smart routing"
fi

# --- Async local-model probes (background; banner doesn't wait) ---
# Writes results to $DETECTION_FILE; consumer is the next session's banner.
# Current session shows whatever the previous session wrote -- eventually consistent,
# but the banner is instant and never blocks.
{
  if curl -sf --max-time 0.5 --connect-timeout 0.5 \
      http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "OLLAMA=1" >> "$DETECTION_FILE"
  elif curl -sf --max-time 0.5 --connect-timeout 0.5 \
      http://localhost:1234/v1/models >/dev/null 2>&1; then
    echo "LMSTUDIO=1" >> "$DETECTION_FILE"
  fi
} >/dev/null 2>&1 &

# Read prior session's detection (so user sees consistent state by session 2).
PRIOR_DETECTION=""
if [ -f "$IJFW_DIR/.detection.prev" ]; then
  if grep -q "OLLAMA=1\|LMSTUDIO=1" "$IJFW_DIR/.detection.prev" 2>/dev/null; then
    PRIOR_DETECTION="local model"
  fi
fi
ROUTING_FULL="$ROUTING"
if [ -n "$PRIOR_DETECTION" ]; then
  if [ -n "$ROUTING_FULL" ]; then
    ROUTING_FULL="$ROUTING_FULL + $PRIOR_DETECTION"
  else
    ROUTING_FULL="$PRIOR_DETECTION"
  fi
fi
ROUTING_STR=""
[ -n "$ROUTING_FULL" ] && ROUTING_STR=" | $ROUTING_FULL"

# --- Existing-tool detection (runs EVERY session, not gated by .migrated) ---
# This was previously inside the migration block, which meant RTK/context-mode
# detection was lost on session 2+ when .startup-flags got reset.
if command -v rtk >/dev/null 2>&1 || [ -f "$HOME/.config/rtk/config.toml" ]; then
  echo "IJFW_RTK_ACTIVE=1" >> "$IJFW_DIR/.startup-flags"
fi
if [ -d ".claude/plugins/context-mode" ] || \
   grep -q "context-mode" "$HOME/.claude/settings.json" 2>/dev/null; then
  echo "IJFW_CONTEXT_MODE_ACTIVE=1" >> "$IJFW_DIR/.startup-flags"
fi

# --- One-shot migration (lockfile-guarded, idempotent) ---
# mkdir is atomic on POSIX → safe lock without flock dependency.
# .migrated is written FIRST so a crash mid-import doesn't double-import next run.
if [ ! -f "$MIGRATED_FLAG" ] && mkdir "$MIGRATION_LOCK" 2>/dev/null; then
  # Ensure lock is released on kill or early exit -- prevents stale lock on crash.
  trap 'rm -rf "$MIGRATION_LOCK" 2>/dev/null || true' EXIT INT TERM
  # Write the flag first -- if we crash, next run sees we already attempted.
  # Failed imports leave individual signals but don't replay.
  echo "schema=1" > "$MIGRATED_FLAG"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)" >> "$MIGRATED_FLAG"

  # Sanitiser for imported content. Strips control chars and defangs headings
  # so an attacker-controlled imported memory can't inject prompt-instructions
  # into future Claude sessions.
  sanitise_line() {
    # Strip C0 control chars (except \t \n) + bidi unicode + escape angle brackets
    # + defang ANY heading prefix.
    LC_ALL=C tr -d '\000-\010\013-\037\177' \
      | sed 's/^[ \t]*#\+[ \t]*/> /' \
      | sed 's/[<>]/&/g; s/</\&lt;/g; s/>/\&gt;/g'
  }

  # --- claude-mem (SQLite) ---
  if command -v sqlite3 >/dev/null 2>&1; then
    for DB in "$HOME/.claude-mem/observations.db" "$HOME/.claude-mem/claude-mem.db"; do
      [ -f "$DB" ] || continue
      OBS_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM observations;" 2>/dev/null)
      [ -z "$OBS_COUNT" ] && OBS_COUNT=0
      if [ "$OBS_COUNT" -gt 0 ]; then
        sqlite3 "$DB" "SELECT content FROM observations ORDER BY created_at DESC LIMIT 100;" 2>/dev/null \
          | sanitise_line \
          | while IFS= read -r LINE; do
              printf -- '- [imported-claude-mem] %s\n' "$LINE" >> "$IJFW_DIR/memory/project-journal.md"
            done
        printf 'Imported %s observations from existing memory\n' "$OBS_COUNT" >> "$MIGRATION_MSGS_FILE"
      fi
      break
    done
  else
    # Donahoe P7: red state → green path. Tell user the actionable upgrade.
    for DB in "$HOME/.claude-mem/observations.db" "$HOME/.claude-mem/claude-mem.db"; do
      if [ -f "$DB" ]; then
        echo "sqlite3 unlocks importing your existing memory -- install it for the full experience" >> "$MIGRATION_MSGS_FILE"
        break
      fi
    done
  fi

  # --- memsearch (markdown files) ---
  if [ -d ".memsearch/memory" ]; then
    MEM_FILES=$(find ".memsearch/memory" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    [ -z "$MEM_FILES" ] && MEM_FILES=0
    if [ "$MEM_FILES" -gt 0 ]; then
      for f in .memsearch/memory/*.md; do
        [ -f "$f" ] || continue
        head -20 "$f" 2>/dev/null \
          | sanitise_line \
          | while IFS= read -r LINE; do
              printf -- '- [imported-memsearch] %s\n' "$LINE" >> "$IJFW_DIR/memory/project-journal.md"
            done
      done
      printf 'Imported %s days of session history\n' "$MEM_FILES" >> "$MIGRATION_MSGS_FILE"
    fi
  fi

  # --- Memorix (JSON) -- node -e replaces python3 ---
  for MX in ".memorix" "node_modules/.memorix"; do
    [ -f "$MX/memories.json" ] || continue
    # Use node -e: no cold-start overhead, and we already require node for MCP.
    # The script reads from arg, never interpolates anything into source.
    MX_OUTPUT=$(node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const mems = Array.isArray(data) ? data : (data.memories || []);
        const out = mems.slice(0, 50).map(m => {
          const t = m.type || "observation";
          const c = String(m.content || m.text || JSON.stringify(m)).slice(0, 200);
          return `${t}|${c}`;
        });
        process.stdout.write(out.join("\n"));
      } catch { process.exit(0); }
    ' "$MX/memories.json" 2>/dev/null)
    if [ -n "$MX_OUTPUT" ]; then
      MX_COUNT=$(printf '%s\n' "$MX_OUTPUT" | wc -l | tr -d ' ')
      printf '%s\n' "$MX_OUTPUT" \
        | sanitise_line \
        | while IFS= read -r LINE; do
            printf -- '- [imported-memorix] %s\n' "$LINE" >> "$IJFW_DIR/memory/project-journal.md"
          done
      printf 'Imported %s cross-agent memories\n' "$MX_COUNT" >> "$MIGRATION_MSGS_FILE"
    fi
    break
  done

  # --- Claude native Auto Memory: full-path hash match (prevents cross-project leak) ---
  CLAUDE_MEM_DIR="$HOME/.claude/projects"
  if [ -d "$CLAUDE_MEM_DIR" ]; then
    PROJECT_HASH=$(printf '%s' "$(pwd -P)" | shasum 2>/dev/null | cut -c1-12)
    if [ -n "$PROJECT_HASH" ]; then
      # Look for memory files whose path contains the EXACT hash, not a substring of basename.
      for mem_file in "$CLAUDE_MEM_DIR"/*"$PROJECT_HASH"*/memory/MEMORY.md; do
        [ -f "$mem_file" ] || continue
        head -50 "$mem_file" 2>/dev/null \
          | sanitise_line \
          | while IFS= read -r LINE; do
              printf -- '- [imported-claude-native] %s\n' "$LINE" >> "$IJFW_DIR/memory/project-journal.md"
            done
        echo "Enriched with prior project memory" >> "$MIGRATION_MSGS_FILE"
        break
      done 2>/dev/null
    fi
  fi

  # --- MemPalace flag (deferred -- needs Python parser) ---
  if [ -d "$HOME/.mempalace" ]; then
    echo "IJFW_MIGRATE_MEMPALACE=1" >> "$IJFW_DIR/.startup-flags"
    echo "Memory palace ready for enrichment" >> "$MIGRATION_MSGS_FILE"
  fi

  # Release lock and clear the trap so subsequent script traps aren't shadowed.
  rmdir "$MIGRATION_LOCK" 2>/dev/null
  trap - EXIT INT TERM
fi

# --- Project context generation flag ---
PROJECT_TYPE=""
if [ ! -f "CLAUDE.md" ] && [ ! -f ".claude/CLAUDE.md" ]; then
  if [ -f "package.json" ]; then
    # Use node -e instead of python3 (no cold-start, always present).
    PROJECT_TYPE=$(node -e '
      try {
        const p = JSON.parse(require("fs").readFileSync("package.json","utf8"));
        const deps = Object.keys({...(p.dependencies||{}), ...(p.devDependencies||{})});
        const fw = deps.includes("next") ? "Next.js"
                 : deps.includes("react") ? "React"
                 : deps.includes("vue") ? "Vue"
                 : deps.includes("svelte") ? "Svelte"
                 : deps.includes("express") ? "Express"
                 : "Node.js";
        const lang = deps.some(d => d.includes("typescript")) ? "TypeScript" : "JavaScript";
        console.log(fw + " / " + lang);
      } catch { console.log("Node.js"); }
    ' 2>/dev/null)
    [ -z "$PROJECT_TYPE" ] && PROJECT_TYPE="Node.js"
  elif [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "requirements.txt" ]; then
    PROJECT_TYPE="Python"
    if [ -f "pyproject.toml" ]; then
      grep -q "django" "pyproject.toml" 2>/dev/null && PROJECT_TYPE="Django / Python"
      grep -q "fastapi" "pyproject.toml" 2>/dev/null && PROJECT_TYPE="FastAPI / Python"
      grep -q "flask" "pyproject.toml" 2>/dev/null && PROJECT_TYPE="Flask / Python"
    fi
  elif [ -f "Cargo.toml" ]; then PROJECT_TYPE="Rust"
  elif [ -f "go.mod" ]; then PROJECT_TYPE="Go"
  elif [ -f "Gemfile" ]; then
    if grep -q "rails" "Gemfile" 2>/dev/null; then PROJECT_TYPE="Rails"; else PROJECT_TYPE="Ruby"; fi
  elif [ -f "pom.xml" ]; then PROJECT_TYPE="Java / Maven"
  elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then PROJECT_TYPE="Java / Gradle"
  elif [ -f "composer.json" ]; then
    if grep -q "laravel" "composer.json" 2>/dev/null; then PROJECT_TYPE="Laravel"; else PROJECT_TYPE="PHP"; fi
  elif [ -f "Package.swift" ]; then PROJECT_TYPE="Swift"
  fi
  [ -n "$PROJECT_TYPE" ] && echo "IJFW_NEEDS_SUMMARIZE=1" >> "$IJFW_DIR/.startup-flags"
fi

# --- CLAUDE.md compression flag ---
NEEDS_COMPRESS=""
if [ -f "CLAUDE.md" ]; then
  CLAUDE_MD_LINES=$(wc -l < "CLAUDE.md" 2>/dev/null)
  [ -z "$CLAUDE_MD_LINES" ] && CLAUDE_MD_LINES=0
  if [ "$CLAUDE_MD_LINES" -gt 100 ] && [ ! -f "CLAUDE.md.original.md" ]; then
    echo "IJFW_NEEDS_COMPRESS=1" >> "$IJFW_DIR/.startup-flags"
    NEEDS_COMPRESS="1"
  fi
fi

# --- Counts ---
SESSION_COUNT=$(ls "$IJFW_DIR/sessions/" 2>/dev/null | wc -l | tr -d ' ')
[ -z "$SESSION_COUNT" ] && SESSION_COUNT=0
DECISION_COUNT=0
if [ -f "$IJFW_DIR/memory/project-journal.md" ]; then
  DECISION_COUNT=$(grep -c "^- \[" "$IJFW_DIR/memory/project-journal.md" 2>/dev/null)
  [ -z "$DECISION_COUNT" ] && DECISION_COUNT=0
fi

# --- BANNER (positive framing only -- no jargon, no paths, no "effort") ---
# Captured to buffer so we can emit it via JSON hookSpecificOutput envelope.
BANNER_BUF="$IJFW_DIR/.banner-buf"
{
# C5 -- visible mode indicator. IJFW_MODE overrides; default "smart".
CUR_MODE="${IJFW_MODE:-smart}"
if [ -n "$ROUTING_STR" ]; then
  printf '[ijfw] %s mode%s\n' "$(printf '%s' "$CUR_MODE" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')" "$ROUTING_STR"
else
  printf '[ijfw] %s mode\n' "$(printf '%s' "$CUR_MODE" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
fi

[ -n "$UPGRADED_EFFORT" ] && printf '[ijfw] %s\n' "$UPGRADED_EFFORT"

if [ -s "$MIGRATION_MSGS_FILE" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && printf '[ijfw] %s\n' "$line"
  done < "$MIGRATION_MSGS_FILE"
fi

if [ -n "$PROJECT_TYPE" ] && [ ! -f "CLAUDE.md" ] && [ ! -f ".claude/CLAUDE.md" ]; then
  printf '[ijfw] Project context generated (%s)\n' "$PROJECT_TYPE"
fi

[ -n "$NEEDS_COMPRESS" ] && printf '[ijfw] Project context optimised\n'

if [ "$SESSION_COUNT" -gt 0 ] || [ "$DECISION_COUNT" -gt 0 ]; then
  EARLY_TRIDENT=$(grep -c '{' "$IJFW_DIR/receipts/cross-runs.jsonl" 2>/dev/null || printf '0')
  if [ "${EARLY_TRIDENT:-0}" -gt 0 ]; then
    printf '[ijfw] Memory loaded (%s sessions, %s things remembered, %s cross-model reviews)\n' "$SESSION_COUNT" "$DECISION_COUNT" "$EARLY_TRIDENT"
  else
    printf '[ijfw] Memory loaded (%s sessions, %s things remembered)\n' "$SESSION_COUNT" "$DECISION_COUNT"
  fi
fi

# W3.11 / H9 -- surface one most-recent auto-memorized entry as the
# "I remember X about this project" moment. Silent when none exist
# (new install / auto-memorize disabled).
KB="$IJFW_DIR/memory/knowledge.md"
if [ -f "$KB" ]; then
  AUTO_ENTRY=$(grep -B2 'auto-memorize' "$KB" 2>/dev/null | grep '^summary:' | tail -1 | sed 's/^summary:[[:space:]]*//' | cut -c1-110)
  if [ -n "$AUTO_ENTRY" ]; then
    printf '[ijfw] Remembered: %s\n' "$AUTO_ENTRY"
  fi
fi

if [ -f "$IJFW_DIR/memory/handoff.md" ]; then
  LAST_STATUS=$(grep -A1 "### Status" "$IJFW_DIR/memory/handoff.md" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//')
  NEXT_STEP=$(grep -A1 "### Next Steps" "$IJFW_DIR/memory/handoff.md" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//;s/^[0-9]*\. //')
  # Welcome-back beat (polish 7). Age-aware: "Welcome back" is warm for recent
  # handoffs, softer for older ones. stat -c / -f dual form for GNU vs BSD.
  AGE_DAYS=""
  if [ -n "$LAST_STATUS" ] || [ -n "$NEXT_STEP" ]; then
    HANDOFF_MTIME=$(stat -c %Y "$IJFW_DIR/memory/handoff.md" 2>/dev/null || stat -f %m "$IJFW_DIR/memory/handoff.md" 2>/dev/null)
    NOW=$(date +%s)
    if [ -n "$HANDOFF_MTIME" ] && [ "$HANDOFF_MTIME" -gt 0 ]; then
      AGE_DAYS=$(( (NOW - HANDOFF_MTIME) / 86400 ))
    fi
    if [ -n "$AGE_DAYS" ] && [ "$AGE_DAYS" -gt 7 ]; then
      printf '[ijfw] Welcome back -- last handoff was %s days ago. Quick recap?\n' "$AGE_DAYS"
    else
      printf '[ijfw] Welcome back -- picking up where you left off.\n'
    fi
  fi
  [ -n "$LAST_STATUS" ] && printf '[ijfw] Last session: %s\n' "$LAST_STATUS"
  [ -n "$NEXT_STEP" ] && printf '[ijfw] Next up: %s\n' "$NEXT_STEP"
fi

# Codebase index -- MVP text index at .ijfw/index/files.md.
# Build in background so session-start stays fast (<100ms). Results appear
# in banner from session 2 onwards via the text file's existence.
INDEX_FILE="$IJFW_DIR/index/files.md"
INDEXER_SCRIPT=""
# Candidate paths for the indexer -- works whether plugin is installed globally
# or running from the dev repo.
for candidate in \
    "$CLAUDE_PLUGIN_ROOT/../scripts/build-codebase-index.sh" \
    "$HOME/.ijfw/scripts/build-codebase-index.sh" \
    "$(pwd)/scripts/build-codebase-index.sh"; do
  if [ -f "$candidate" ]; then INDEXER_SCRIPT="$candidate"; break; fi
done

if [ -f "$INDEX_FILE" ]; then
  INDEX_COUNT=$(grep -c '^- `' "$INDEX_FILE" 2>/dev/null)
  [ -z "$INDEX_COUNT" ] && INDEX_COUNT=0
  [ "$INDEX_COUNT" -gt 0 ] && printf '[ijfw] Codebase indexed (%s files)\n' "$INDEX_COUNT"
fi

# Detached background rebuild -- crashes surface in ~/.ijfw/logs/indexer.log.
if [ -n "$INDEXER_SCRIPT" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  bash "$INDEXER_SCRIPT" . </dev/null >>"$HOME/.ijfw/logs/indexer.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# Transcript parser -- incremental, background, silent.
# Single-process guard prevents pile-up across concurrent Claude Code sessions.
# Set IJFW_SKIP_PARSE=1 to skip per shell.
if [ "${IJFW_SKIP_PARSE:-}" != "1" ]; then
  TRANSCRIPT_PARSER=""
  for candidate in \
      "$CLAUDE_PLUGIN_ROOT/../scripts/dashboard/parse-transcripts.js" \
      "$HOME/.ijfw/scripts/dashboard/parse-transcripts.js" \
      "$(pwd)/scripts/dashboard/parse-transcripts.js"; do
    if [ -f "$candidate" ]; then TRANSCRIPT_PARSER="$candidate"; break; fi
  done
  if [ -n "$TRANSCRIPT_PARSER" ]; then
    # Pre-spawn PID-file check (defense-in-depth; the .js also self-guards).
    PARSE_PIDFILE="$IJFW_GLOBAL/.parse-transcripts.pid"
    SPAWN_OK=1
    if [ -f "$PARSE_PIDFILE" ]; then
      OLD_PID=$(cat "$PARSE_PIDFILE" 2>/dev/null)
      if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        SPAWN_OK=0
      else
        rm -f "$PARSE_PIDFILE" 2>/dev/null
      fi
    fi
    if [ "$SPAWN_OK" = "1" ]; then
      # Detached transcript parser -- crashes surface in ~/.ijfw/logs/transcript-parser.log.
      mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
      node "$TRANSCRIPT_PARSER" --incremental </dev/null >>"$HOME/.ijfw/logs/transcript-parser.log" 2>&1 &
      disown $! 2>/dev/null || true
    fi
  fi
fi

if [ "$SESSION_COUNT" -gt 0 ] && [ $(( SESSION_COUNT % 5 )) -eq 0 ]; then
  echo "IJFW_NEEDS_CONSOLIDATE=1" >> "$IJFW_DIR/.startup-flags"
fi

# S7.2 -- cumulative Trident value line. Silent when no receipts exist yet.
# Reads .ijfw/receipts/cross-runs.jsonl (JSONL, one record per line).
# Extracts: run count, total findings (items[] length or numeric sum),
# cumulative cache-read savings ($2.70/M tokens).
RECEIPTS_FILE="$IJFW_DIR/receipts/cross-runs.jsonl"
if [ -f "$RECEIPTS_FILE" ] && [ -s "$RECEIPTS_FILE" ]; then
  TRIDENT_RUNS=$(grep -c '{' "$RECEIPTS_FILE" 2>/dev/null)
  [ -z "$TRIDENT_RUNS" ] && TRIDENT_RUNS=0
  if [ "$TRIDENT_RUNS" -gt 0 ]; then
    # Sum cache_read_input_tokens across all lines.
    # Uses POSIX awk only (sub + match without 3rd arg) -- the 3-arg `match`
    # is gawk-only and fails on BSD/macOS awk per Trident audit finding.
    CACHE_TOKENS=$(awk '
      {
        s = $0
        while (match(s, /"cache_read_input_tokens":[[:space:]]*[0-9]+/)) {
          tok = substr(s, RSTART, RLENGTH)
          gsub(/[^0-9]/, "", tok)
          sum += tok + 0
          s = substr(s, RSTART + RLENGTH)
        }
      }
      END { print (sum+0) }
    ' "$RECEIPTS_FILE" 2>/dev/null)
    [ -z "$CACHE_TOKENS" ] && CACHE_TOKENS=0
    # Sum findings: items-array shape OR numeric consensus+contested+unique fields.
    TOTAL_FINDINGS=$(awk '
      function extract_num(line, key,    pat, t) {
        pat = "\"" key "\":[[:space:]]*[0-9]+"
        if (match(line, pat)) {
          t = substr(line, RSTART, RLENGTH)
          gsub(/[^0-9]/, "", t)
          return t + 0
        }
        return 0
      }
      {
        n = split($0, parts, /"items":\[/)
        if (n > 1) {
          sub(/\].*/, "", parts[2])
          if (parts[2] ~ /[^[:space:]]/) {
            cnt = gsub(/,/, ",", parts[2]) + 1
            sum += cnt
          }
        } else {
          sum += extract_num($0, "consensus")
          sum += extract_num($0, "contested")
          sum += extract_num($0, "unique")
        }
      }
      END { print (sum+0) }
    ' "$RECEIPTS_FILE" 2>/dev/null)
    [ -z "$TOTAL_FINDINGS" ] && TOTAL_FINDINGS=0
    if [ "$CACHE_TOKENS" -gt 0 ]; then
      SAVINGS_DOLLARS=$(awk "BEGIN { printf \"%.2f\", $CACHE_TOKENS * 2.70 / 1000000 }" 2>/dev/null)
      printf '[ijfw] Trident: %s runs, %s findings caught, ~$%s in cache savings\n' \
        "$TRIDENT_RUNS" "$TOTAL_FINDINGS" "$SAVINGS_DOLLARS"
    else
      printf '[ijfw] Trident: %s runs, %s findings caught\n' \
        "$TRIDENT_RUNS" "$TOTAL_FINDINGS"
    fi
  fi
fi

printf '[ijfw] Ready.\n'

# K2.1: first-session hint -- only when no prior sessions exist.
if [ "${SESSION_COUNT:-0}" -eq 0 ] && [ "${DECISION_COUNT:-0}" -eq 0 ]; then
  printf '[ijfw] First session -- IJFW will start learning your project as you work.\n'
fi

# Find node before any dashboard work (resolution must precede first use of $_NODE).
_NODE=""
if command -v node >/dev/null 2>&1; then
  _NODE="$(command -v node)"
else
  for _nc in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node"/*/bin/node "$HOME/.volta/bin/node" /usr/bin/node; do
    for _nr in $_nc; do [ -x "$_nr" ] && { _NODE="$_nr"; break 2; }; done
  done
fi

# Dashboard auto-start. Launches as a background daemon if not already running.
# Zero overhead: separate OS process, no context cost, no token usage.
DASH_PORT_FILE="$HOME/.ijfw/dashboard.port"
DASH_PID_FILE="$HOME/.ijfw/dashboard.pid"
DASH_SERVER=""
for _cand in \
    "${CLAUDE_PLUGIN_ROOT:-}/../scripts/dashboard/server.js" \
    "$HOME/.ijfw/scripts/dashboard/server.js" \
    "$(pwd)/scripts/dashboard/server.js"; do
  [ -f "$_cand" ] && { DASH_SERVER="$_cand"; break; }
done

# Check if already running (PID file + process alive).
DASH_RUNNING=0
if [ -f "$DASH_PID_FILE" ]; then
  DASH_PID=$(cat "$DASH_PID_FILE" 2>/dev/null)
  if [ -n "$DASH_PID" ] && kill -0 "$DASH_PID" 2>/dev/null; then
    DASH_RUNNING=1
  else
    # Stale PID file -- clean up.
    rm -f "$DASH_PID_FILE" "$DASH_PORT_FILE" 2>/dev/null
  fi
fi

if [ "$DASH_RUNNING" -eq 1 ] && [ -f "$DASH_PORT_FILE" ]; then
  DASH_PORT=$(cat "$DASH_PORT_FILE" 2>/dev/null)
  [ -n "$DASH_PORT" ] && printf '[ijfw] Dashboard: http://localhost:%s\n' "$DASH_PORT"
elif [ -n "$DASH_SERVER" ] && [ -n "$_NODE" ]; then
  # Detached daemon -- crashes surface in ~/.ijfw/logs/dashboard.log.
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  IJFW_DAEMON=1 "$_NODE" "$DASH_SERVER" </dev/null >>"$HOME/.ijfw/logs/dashboard.log" 2>&1 &
  disown $! 2>/dev/null || true
  # Single 500ms wait -- enough for server.js to write the port file.
  sleep 0.5 2>/dev/null || true
  if [ -f "$DASH_PORT_FILE" ]; then
    DASH_PORT=$(cat "$DASH_PORT_FILE" 2>/dev/null)
    [ -n "$DASH_PORT" ] && printf '[ijfw] Dashboard: http://localhost:%s\n' "$DASH_PORT"
  else
    printf '[ijfw] dashboard auto-start: port file not written within 500ms (check ~/.ijfw/logs/dashboard.log)\n' >&2 || true
  fi
elif [ -n "$DASH_SERVER" ] && [ -z "$_NODE" ]; then
  printf '[ijfw] dashboard auto-start: node not in PATH; auto-start skipped (check ~/.ijfw/logs/dashboard.log)\n' >>"$HOME/.ijfw/logs/dashboard.log" 2>/dev/null || true
fi

# Observation summary (how many observations exist for context economics).
OBS_FILE="$HOME/.ijfw/observations.jsonl"
if [ -f "$OBS_FILE" ]; then
  OBS_COUNT=$(wc -l < "$OBS_FILE" 2>/dev/null | tr -d ' ')
  [ "${OBS_COUNT:-0}" -gt 0 ] && printf '[ijfw] Observations: %s tracked across sessions.\n' "$OBS_COUNT"
fi

# Dashboard render (async-tolerant: node renders inline into the banner buffer).
_DASH_BIN=""
for _cand in \
    "${CLAUDE_PLUGIN_ROOT:-}/../scripts/dashboard/bin.js" \
    "$HOME/.ijfw/scripts/dashboard/bin.js" \
    "$(pwd)/scripts/dashboard/bin.js"; do
  [ -f "$_cand" ] && { _DASH_BIN="$_cand"; break; }
done
if [ -n "$_DASH_BIN" ] && [ -n "$_NODE" ]; then
  "$_NODE" "$_DASH_BIN" --last 50 --platform claude 2>/dev/null || true
fi
} > "$BANNER_BUF"

# The banner above was buffered; we'll emit it via hookSpecificOutput.additionalContext
# along with the memory injection. Claude Code's SessionStart hook injects JSON's
# additionalContext into the agent's starting context -- plain stdout alone goes to
# the user's terminal, NOT the agent. Without the JSON envelope, stored memory is
# invisible to the LLM.

KB_FILE="$IJFW_DIR/memory/knowledge.md"
HANDOFF_FILE="$IJFW_DIR/memory/handoff.md"
MEM_BUF="$IJFW_DIR/.mem-buf"
: > "$MEM_BUF"

HAVE_MEMORY=0
# Prelude mode (W2.4/B2 -- Headroom-style lazy loading):
#   pointer -- ~50 tokens. Just "memory available, call prelude".
#   summary -- ~100-200 tokens. 3 recent decisions + last handoff (default).
#   full    -- legacy behavior, inject everything.
PRELUDE_MODE="${IJFW_PRELUDE_MODE:-summary}"
case "$PRELUDE_MODE" in
  pointer|summary|full) ;;
  *) PRELUDE_MODE="summary" ;;
esac

if [ -s "$KB_FILE" ] || [ -s "$HANDOFF_FILE" ] || [ -f "$IJFW_DIR/memory/project-journal.md" ]; then
  HAVE_MEMORY=1
  {
    echo "<ijfw-memory>"
    case "$PRELUDE_MODE" in
      pointer)
        # ~50 tokens -- pure pointer, zero samples. Heaviest savings.
        echo "Project memory available. Call \`ijfw_memory_prelude\` to see decisions, patterns, handoff."
        ;;
      summary|full)
        echo "Project memory at .ijfw/memory/. Call \`ijfw_memory_prelude\` for full context."
        if [ -s "$KB_FILE" ]; then
          RECENT_KB=$(grep -v '^<!-- ijfw' "$KB_FILE" | grep -v '^# knowledge' | grep '^\*\*' | tail -3)
          if [ -n "$RECENT_KB" ]; then
            echo ""
            echo "Recent decisions:"
            echo "$RECENT_KB"
          fi
        fi
        if [ -s "$HANDOFF_FILE" ]; then
          LAST_HANDOFF=$(grep -v '^<!-- ijfw' "$HANDOFF_FILE" | grep -v '^$' | head -2)
          if [ -n "$LAST_HANDOFF" ]; then
            echo ""
            echo "Last handoff: $LAST_HANDOFF"
          fi
        fi
        ;;
    esac
    echo "</ijfw-memory>"
  } > "$MEM_BUF"
fi

# CLAUDE.md management runs regardless of memory state -- we want to auto-generate
# a project context file on session 1 of a new project even if no memory exists yet.
if true; then
  # Belt-and-suspenders: inject memory into CLAUDE.md at a managed section.
  # Claude Code ALWAYS loads CLAUDE.md -- this is the one guaranteed visibility
  # path. We use markers so we never touch user-authored content; only the
  # region between markers is rewritten each session.
  CLAUDE_MD="CLAUDE.md"
  MARK_START="<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->"
  MARK_END="<!-- IJFW-MEMORY-END -->"

  # Build the managed block.
  # Contains memory context only. Banner display was removed -- showing a
  # dashboard before the user's answer is anti-Krug (makes them think about
  # IJFW instead of their work). Observability surfaces via:
  #   - session-end recap line (always, with dashboard URL)
  #   - /ijfw status (on demand)
  #   - dashboard server (always running, browser-based)
  MANAGED_BLOCK=$(
    echo "$MARK_START"
    cat "$MEM_BUF"
    # Plugin priority directive: IJFW handles project workflows when installed.
    if [ -d "$HOME/.claude/plugins/cache/claude-plugins-official/superpowers" ] || \
       [ -d "$HOME/.claude/get-shit-done" ]; then
      echo ""
      echo "<ijfw-routing>"
      echo "IJFW is installed alongside a peer brainstorming skill. For project-level tasks (build, create, design, plan, brainstorm, landing page, app, website, dashboard, campaign, book, launch), prefer the ijfw:ijfw-workflow skill -- the user opted into IJFW via install, and ijfw-workflow is its configured workflow entry point. IJFW orchestrates think-build-ship end to end and dispatches peer specialist skills (frontend-design, TDD, code-review) as subagent tools when the workflow needs them."
      echo "</ijfw-routing>"
    fi
    echo "$MARK_END"
  )

  # Skip CLAUDE.md injection if user's existing file is already near the
  # Claude Code performance threshold (~40k chars). In that case, memory is
  # still accessible via the ijfw_memory_prelude MCP tool -- just not preloaded.
  CLAUDE_MD_SIZE=0
  [ -f "$CLAUDE_MD" ] && CLAUDE_MD_SIZE=$(wc -c < "$CLAUDE_MD" 2>/dev/null | tr -d ' ')
  [ -z "$CLAUDE_MD_SIZE" ] && CLAUDE_MD_SIZE=0
  if [ "$CLAUDE_MD_SIZE" -gt 35000 ]; then
    # Large CLAUDE.md -- strip any prior IJFW block and skip this session's inject.
    if grep -q "$MARK_START" "$CLAUDE_MD" 2>/dev/null; then
      node -e '
        const fs = require("fs");
        const file = process.argv[1];
        const startM = "<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->";
        const endM = "<!-- IJFW-MEMORY-END -->";
        const src = fs.readFileSync(file, "utf8");
        const re = new RegExp(startM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + endM + "\\n?", "m");
        fs.writeFileSync(file + ".tmp", src.replace(re, ""));
        fs.renameSync(file + ".tmp", file);
      ' "$CLAUDE_MD" 2>/dev/null
    fi
  elif [ ! -f "$CLAUDE_MD" ]; then
    # No CLAUDE.md yet -- auto-generate a rich initial one from repo scan.
    # Everything below is deterministic (no LLM calls) so there's no risk of
    # hallucinated "facts" about the project. We only report what files exist.
    AUTOGEN_STACK="$PROJECT_TYPE"
    [ -z "$AUTOGEN_STACK" ] && AUTOGEN_STACK="unknown"

    AUTOGEN_TEST=""
    [ -f "package.json" ] && grep -q '"test"' package.json 2>/dev/null && AUTOGEN_TEST="npm test"
    [ -f "Cargo.toml" ] && AUTOGEN_TEST="cargo test"
    [ -f "pyproject.toml" ] && AUTOGEN_TEST="pytest"
    [ -f "go.mod" ] && AUTOGEN_TEST="go test ./..."

    AUTOGEN_LINT=""
    [ -f ".eslintrc" ] || [ -f ".eslintrc.json" ] || [ -f ".eslintrc.js" ] || [ -f "eslint.config.js" ] && AUTOGEN_LINT="eslint"
    [ -f ".ruff.toml" ] || grep -q 'ruff' pyproject.toml 2>/dev/null && AUTOGEN_LINT="ruff"
    [ -f "rustfmt.toml" ] && AUTOGEN_LINT="rustfmt + clippy"

    AUTOGEN_DIRS=""
    for d in src lib app server client api components pages tests test spec docs; do
      [ -d "$d" ] && AUTOGEN_DIRS="$AUTOGEN_DIRS- \`$d/\`
"
    done

    AUTOGEN_CONFIG=""
    for f in package.json tsconfig.json Cargo.toml pyproject.toml go.mod Dockerfile docker-compose.yml Makefile; do
      [ -f "$f" ] && AUTOGEN_CONFIG="$AUTOGEN_CONFIG- \`$f\`
"
    done

    {
      echo "# Project Context"
      echo ""
      echo "Stack: $AUTOGEN_STACK"
      [ -n "$AUTOGEN_TEST" ] && echo "Tests: \`$AUTOGEN_TEST\`"
      [ -n "$AUTOGEN_LINT" ] && echo "Lint: $AUTOGEN_LINT"
      echo ""
      if [ -n "$AUTOGEN_DIRS" ]; then
        echo "## Key Directories"
        printf '%s' "$AUTOGEN_DIRS"
        echo ""
      fi
      if [ -n "$AUTOGEN_CONFIG" ]; then
        echo "## Config Files"
        printf '%s' "$AUTOGEN_CONFIG"
        echo ""
      fi
      echo "<!-- Auto-generated by IJFW from repo scan. Edit freely -- IJFW only touches the managed block below. -->"
      echo ""
      echo "$MANAGED_BLOCK"
    } > "$CLAUDE_MD" 2>/dev/null
  elif grep -q "$MARK_START" "$CLAUDE_MD" 2>/dev/null; then
    # Marker exists -- replace the block atomically via temp file.
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const block = process.argv[2];
      const startM = "<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->";
      const endM = "<!-- IJFW-MEMORY-END -->";
      const src = fs.readFileSync(file, "utf8");
      const re = new RegExp(startM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + endM, "m");
      const out = src.replace(re, block);
      fs.writeFileSync(file + ".tmp", out);
      fs.renameSync(file + ".tmp", file);
    ' "$CLAUDE_MD" "$MANAGED_BLOCK" 2>/dev/null
  else
    # User has CLAUDE.md but no marker -- append block at end, preserving user content.
    {
      echo ""
      echo "$MANAGED_BLOCK"
    } >> "$CLAUDE_MD" 2>/dev/null
  fi
fi

# --- AGENTS.md cross-platform merge (Phase 2 / A1) ---
# Merge MEMORY pointer + AGENTS list into AGENTS.md (canonical surface per
# the open AGENTS.md spec). Block-aware merge via lock.sh; stays under the
# 50ms hook budget by backgrounding the work and disowning.
#
# P2-M1: block content built via shared build-blocks.sh.
# P2-M2: single lock cycle, single backup, single rename via multi-pair form.
# P2-B2: hoist-frontmatter.sh runs after the merge to splice A3 (project.type)
#        fields into the YAML frontmatter region (silent skip until A3 lands).
AGENTS_MD_LOCK=""
AGENTS_MD_BUILD=""
AGENTS_MD_HOIST=""
for _cand in \
    "${CLAUDE_PLUGIN_ROOT:-}/skills/ijfw-agents-md/scripts" \
    "$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts" \
    "$IJFW_HOOK_DIR/../../skills/ijfw-agents-md/scripts"; do
  if [ -f "$_cand/lock.sh" ] && [ -f "$_cand/build-blocks.sh" ]; then
    AGENTS_MD_LOCK="$_cand/lock.sh"
    AGENTS_MD_BUILD="$_cand/build-blocks.sh"
    AGENTS_MD_HOIST="$_cand/hoist-frontmatter.sh"
    break
  fi
done
if [ -n "$AGENTS_MD_LOCK" ] && [ -n "$AGENTS_MD_BUILD" ]; then
  AGENTS_MD_TARGET="$(pwd -P 2>/dev/null)/AGENTS.md"
  AGENTS_MD_PROJECT_ROOT="$(pwd -P 2>/dev/null)"
  # Background the merge so the hook stays under budget. Inside the
  # subshell we materialize block content into temp files (preserves trailing-
  # newline byte-identity), then call the multi-pair lock once.
  {
    _IJFW_BUILD_TMP="$(mktemp -d -t ijfw-agents-md-build.XXXXXX 2>/dev/null || printf '%s' "$IJFW_DIR/.tmp-build-$$")"
    mkdir -p "$_IJFW_BUILD_TMP" 2>/dev/null || true
    # build-blocks emits two paths; we feed them straight into multi-pair lock.
    _IJFW_PATHS="$(bash "$AGENTS_MD_BUILD" "$AGENTS_MD_PROJECT_ROOT" "files:$_IJFW_BUILD_TMP" 2>/dev/null || true)"
    _IJFW_MEM_FILE="$(printf '%s\n' "$_IJFW_PATHS" | sed -n '1p')"
    _IJFW_AG_FILE="$(printf '%s\n' "$_IJFW_PATHS" | sed -n '2p')"
    if [ -n "$_IJFW_MEM_FILE" ] && [ -n "$_IJFW_AG_FILE" ]; then
      bash "$AGENTS_MD_LOCK" "$AGENTS_MD_TARGET" \
        "MEMORY:$_IJFW_MEM_FILE" "AGENTS:$_IJFW_AG_FILE" >/dev/null 2>&1 || true
    fi
    # P2-B2: frontmatter hoist (silent skip when .ijfw/project.type absent).
    if [ -n "$AGENTS_MD_HOIST" ] && [ -f "$AGENTS_MD_HOIST" ]; then
      bash "$AGENTS_MD_HOIST" "$AGENTS_MD_TARGET" >/dev/null 2>&1 || true
    fi
    rm -rf "$_IJFW_BUILD_TMP" 2>/dev/null || true
  } </dev/null >>"$HOME/.ijfw/logs/agents-md.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# P3-B1: A3 cold-scan trigger -- shared helper, fire-and-forget detached
# spawn that lands .ijfw/project.type for the next session. Co-located in
# claude/skills/ijfw-agents-md/scripts/ alongside the other shared helpers.
COLD_SCAN_TRIGGER=""
for _cand in \
    "${CLAUDE_PLUGIN_ROOT:-}/skills/ijfw-agents-md/scripts/cold-scan-trigger.sh" \
    "$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts/cold-scan-trigger.sh" \
    "$IJFW_HOOK_DIR/../../skills/ijfw-agents-md/scripts/cold-scan-trigger.sh"; do
  if [ -f "$_cand" ]; then COLD_SCAN_TRIGGER="$_cand"; break; fi
done
if [ -n "$COLD_SCAN_TRIGGER" ]; then
  bash "$COLD_SCAN_TRIGGER" "$(pwd -P 2>/dev/null)" >/dev/null 2>&1 || true
fi

# 1.4.0 W3/t13 + W6/S5 -- domain-manifest auto-load. Detects project type and
# auto-loads the matching built-in preset (book / campaign) into the
# project's active overrides on first sight. Fire-and-forget, DETACHED
# in a subshell with `& disown` so session-start exits even if MCP
# dispatch is slow (R11/F11).
#
# Wired to the cli-run.js shim (mcp-server/src/cli-run.js) which imports
# the colon-syntax dispatcher directly -- no long-lived MCP server
# dependency. When the shim or node binary is absent we fall back to the
# original placeholder so the t20 detachment-verifier test (which patches
# the literal placeholder line) still finds its anchor.
#
# Detachment shape is load-bearing for t20: the inner subshell must
# trail `& )` immediately and the outer `disown` must remain.
_IJFW_CLI_RUN=""
for _cand in \
    "${CLAUDE_PLUGIN_ROOT:-}/mcp-server/src/cli-run.js" \
    "$HOME/.ijfw/mcp-server/src/cli-run.js" \
    "$IJFW_HOOK_DIR/../../../mcp-server/src/cli-run.js"; do
  if [ -f "$_cand" ]; then _IJFW_CLI_RUN="$_cand"; break; fi
done
_IJFW_PROJECT_ROOT="$(pwd -P 2>/dev/null || echo .)"
if [ -n "$_IJFW_CLI_RUN" ] && [ -n "$_NODE" ]; then
  ( "$_NODE" "$_IJFW_CLI_RUN" "domain-manifest:load" --project-root "$_IJFW_PROJECT_ROOT" </dev/null >/dev/null 2>&1 & )
  disown 2>/dev/null || true
else
  ( true </dev/null >/dev/null 2>&1 & )
  disown 2>/dev/null || true
fi

# Output strategy:
#   SessionStart hooks CANNOT render to the user's terminal. All output channels
#   (stdout, stderr, systemMessage) go to agent context only. The banner is
#   delivered via CLAUDE.md managed block with a display instruction -- the agent
#   renders it on first turn. Stdout here feeds agent system-reminders as backup.
[ -s "$BANNER_BUF" ] && cat "$BANNER_BUF"

# Snapshot detection for next session's banner.
mv -f "$DETECTION_FILE" "$IJFW_DIR/.detection.prev" 2>/dev/null
rm -f "$BANNER_BUF" "$MEM_BUF" 2>/dev/null

exit 0
