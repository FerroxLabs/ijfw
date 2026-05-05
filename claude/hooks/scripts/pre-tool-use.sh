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

if [ -n "$PATTERNS_JSON" ] && command -v node >/dev/null 2>&1; then
  # Read destructive_commands array from patterns.json and match against input.
  # node prints one regex per line; bash iterates and applies each with grep -Eiq.
  PATTERNS=$(node -e '
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
  ' "$PATTERNS_JSON" 2>/dev/null)

  if [ -n "$PATTERNS" ]; then
    while IFS= read -r pat; do
      [ -z "$pat" ] && continue
      if echo "$INPUT" | grep -Eiq "$pat" 2>/dev/null; then
        DETECTED="${DETECTED}- Potentially destructive command matched. Verify intent before proceeding.\n"
        break
      fi
    done <<EOF
$PATTERNS
EOF
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
