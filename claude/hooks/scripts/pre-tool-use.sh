#!/usr/bin/env bash
# E4 -- universal disable switch.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
# IJFW PreToolUse -- scans the about-to-run command for destructive patterns
# BEFORE execution and injects a verification reminder. The agent sees it
# next turn and can abort or refine.
#
# Corrected in Phase-6 audit: semantically this is the right place for
# warnings (pre-execution) and hook input here is `tool_input` only (no
# `tool_response` yet). Output trimming moved to post-tool-use.sh.
#
# Positive framing: phrases actions as "confirm X" not "Warning: Y".
# Never blocks execution -- only augments context.
#
# Patterns source: shared/lib/patterns.json (shared with all platform adapters).
# Installs to ~/.ijfw/shared/lib/patterns.json; repo copy used as fallback.

IJFW_DIR=".ijfw"
INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

# Resolve patterns.json: installed location first, repo fallback for dev/CI.
PATTERNS_JSON=""
for _cand in \
    "$HOME/.ijfw/shared/lib/patterns.json" \
    "${IJFW_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)}/shared/lib/patterns.json"; do
  if [ -f "$_cand" ]; then PATTERNS_JSON="$_cand"; break; fi
done

DETECTED=""

# Perf: this hook runs on EVERY tool call (no matcher in hooks.json), and the
# old version paid a node cold start per call to re-parse the static
# patterns.json plus one echo|grep pipeline per pattern. Instead, extract the
# regex list ONCE into a flat cache keyed by patterns.json path+mtime, then
# match the whole catalog with a single grep -f. node only runs on a cache
# miss (first call, or patterns.json changed).
CACHE_DIR="$HOME/.ijfw/cache"
CACHE_FILE="$CACHE_DIR/destructive-patterns.txt"
CACHE_STAMP="$CACHE_DIR/destructive-patterns.stamp"
USE_CACHE=0

if [ -n "$PATTERNS_JSON" ]; then
  # mtime: BSD stat first (macOS), GNU stat fallback (Linux). Empty -> no
  # usable stamp, so the cache is treated as always-stale (old per-call cost,
  # never stale results).
  _mtime=$(stat -f %m "$PATTERNS_JSON" 2>/dev/null || stat -c %Y "$PATTERNS_JSON" 2>/dev/null || true)
  _want_stamp="$PATTERNS_JSON $_mtime"
  _have_stamp=""
  [ -f "$CACHE_STAMP" ] && _have_stamp=$(cat "$CACHE_STAMP" 2>/dev/null)
  if [ -n "$_mtime" ] && [ -f "$CACHE_FILE" ] && [ "$_have_stamp" = "$_want_stamp" ]; then
    USE_CACHE=1
  elif command -v node >/dev/null 2>&1; then
    # Cache miss: extract destructive_commands (one regex per line) from
    # patterns.json. Written via tmp+mv so a concurrent hook never reads a
    # half-written cache.
    mkdir -p "$CACHE_DIR" 2>/dev/null
    if node -e '
      const fs = require("fs");
      try {
        const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write((p.destructive_commands || []).join("\n"));
      } catch (e) {
        // 1.2.9: write a fallback sentinel so /ijfw doctor can flag that the
        // hook is running on the inline 3-pattern fallback instead of the
        // full 17-pattern catalog. Without this, a corrupted patterns.json
        // silently degraded destructive-command detection.
        try {
          const path = require("path");
          const home = process.env.HOME || "";
          if (home) {
            fs.mkdirSync(path.join(home, ".ijfw"), { recursive: true });
            fs.writeFileSync(path.join(home, ".ijfw", ".patterns-fallback-active"),
              new Date().toISOString() + " " + (e.message || String(e)).slice(0, 200) + "\n");
          }
        } catch { /* sentinel is best-effort */ }
        process.exit(0);
      }
    ' "$PATTERNS_JSON" >"$CACHE_FILE.tmp.$$" 2>/dev/null; then
      mv -f "$CACHE_FILE.tmp.$$" "$CACHE_FILE" 2>/dev/null && USE_CACHE=1
      # Only stamp when mtime is known; an empty stamp would pin a cache we
      # can never invalidate.
      if [ "$USE_CACHE" = "1" ] && [ -n "$_mtime" ]; then
        printf '%s' "$_want_stamp" >"$CACHE_STAMP" 2>/dev/null
      fi
    fi
    rm -f "$CACHE_FILE.tmp.$$" 2>/dev/null
  fi
fi

if [ "$USE_CACHE" = "1" ]; then
  # Single grep applies the whole catalog. An empty cache (extraction failed,
  # sentinel written above) matches nothing -- same as the old behavior.
  if [ -s "$CACHE_FILE" ] && printf '%s' "$INPUT" | grep -Eiq -f "$CACHE_FILE" 2>/dev/null; then
    DETECTED="${DETECTED}- Potentially destructive command matched. Verify intent before proceeding.\n"
  fi
else
  # Fallback: inline patterns when patterns.json or node is unavailable.
  if echo "$INPUT" | grep -Eiq '\brm[[:space:]]+(-[rRf]+[[:space:]]+)+(/|\$|~)' 2>/dev/null; then
    DETECTED="${DETECTED}- Recursive delete at a top-level path. Verify target before confirming.\n"
  fi
  if echo "$INPUT" | grep -Eiq '\bgit[[:space:]]+push[[:space:]]+(-[a-zA-Z]*f|--force|-f[[:space:]])' 2>/dev/null; then
    DETECTED="${DETECTED}- Force push detected. Confirm branch and remote before proceeding.\n"
  fi
  if echo "$INPUT" | grep -Eiq '\bnpm[[:space:]]+publish\b' 2>/dev/null; then
    DETECTED="${DETECTED}- npm publish goes to the registry. Confirm version bump + scope.\n"
  fi
fi

if [ -n "$DETECTED" ]; then
  cat <<EOF
<ijfw-verify>
Before proceeding, confirm:
$(printf '%b' "$DETECTED")
Proceed only if all lines above are intended.
</ijfw-verify>
EOF
fi

exit 0
