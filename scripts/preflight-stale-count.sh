#!/usr/bin/env bash
set -euo pipefail

# Preflight gate: catch stale platform-count claims across shippable surfaces.
#
# Canonical platform count is derived from platform-capabilities.json (every
# entry whose `tier` is not the "shared" pseudo-entry). This makes the gate
# self-updating: add a platform to platform-capabilities.json and the gate
# re-targets automatically instead of grepping a single hard-coded literal.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caps="$repo_root/platform-capabilities.json"

if [ ! -f "$caps" ]; then
  echo "ISSUE: platform-capabilities.json not found at $caps"
  exit 1
fi

# Canonical count = number of platform entries minus the "shared" pseudo-entry.
CANON=$(node -e '
  const caps = require(process.argv[1]);
  const platforms = Object.entries(caps.platforms || {})
    .filter(([, cfg]) => cfg && cfg.tier !== "shared");
  process.stdout.write(String(platforms.length));
' "$caps")

if ! [[ "$CANON" =~ ^[0-9]+$ ]] || [ "$CANON" -lt 1 ]; then
  echo "ISSUE: could not derive canonical platform count from platform-capabilities.json (got '$CANON')"
  exit 1
fi

echo "Canonical platform count: $CANON"

# Surfaces that SHIP and make platform-count claims. Historical changelogs and
# planning notes are excluded — they are dated records, not live claims.
SCAN_PATHS=(
  "$repo_root/README.md"
  "$repo_root/CLAUDE.md"
  "$repo_root/universal"
  "$repo_root/docs"
  "$repo_root/installer/README.md"
  "$repo_root/installer/docs"
  "$repo_root/codex/.codex-plugin/plugin.json"
  "$repo_root/gemini/extensions/ijfw/gemini-extension.json"
  "$repo_root/claude/commands"
)

# Phrases that assert a TOTAL platform count. Any number here that is not the
# canonical count is drift. The MCP-platform count (canonical minus Aider) is
# allowed where the claim is explicitly scoped to MCP.
# Patterns capture: "<N> platforms", "<N> AI coding agents/platforms",
# "across <N> ... platforms", "all <N> ... platforms", "one of <N> platforms".
PATTERNS='([0-9]+) (AI coding (agents|platforms)|platforms)|(across|all|of) ([0-9]+) ([A-Za-z -]*)?platforms?|targets ([0-9]+) platforms'

STALE=""
for path in "${SCAN_PATHS[@]}"; do
  [ -e "$path" ] || continue
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # line format: file:lineno:content
    content="${line#*:*:}"
    # Extract every "<N> ... platform(s)" / "<N> AI coding agent(s)" number.
    nums=$(printf '%s\n' "$content" \
      | grep -oE '[0-9]+ (AI coding (agents|platforms)|platforms?)|(across|all|of|targets) [0-9]+ ([A-Za-z -]*)?platforms?' \
      | grep -oE '[0-9]+' || true)
    # Skip category-scoped counts: "8 structural platforms", "4 MCP-only
    # platforms", etc. are subset tallies, not total-platform claims.
    if printf '%s' "$content" \
      | grep -qiE '[0-9]+ (structural|best-effort|second-tier|MCP-only|tier-[0-9]) platforms?'; then
      continue
    fi
    for n in $nums; do
      # Accept the canonical count, and the MCP-platform count (canon-1)
      # only when the claim is explicitly MCP-scoped.
      if [ "$n" = "$CANON" ]; then
        continue
      fi
      mcp_canon=$((CANON - 1))
      if [ "$n" = "$mcp_canon" ] && printf '%s' "$content" | grep -qiE 'MCP'; then
        continue
      fi
      STALE="${STALE}${line}\n"
    done
  done < <(grep -rnE "$PATTERNS" \
    --include='*.md' --include='*.json' --include='*.html' \
    --exclude-dir='node_modules' --exclude-dir='.planning' --exclude-dir='archive' \
    "$path" 2>/dev/null || true)
done

if [ -n "$STALE" ]; then
  echo "ISSUE: stale platform-count claim(s) (expected $CANON, or $((CANON - 1)) for MCP-scoped claims):"
  printf '%b' "$STALE"
  exit 1
fi

echo "OK: all platform-count claims match canonical count ($CANON)."
