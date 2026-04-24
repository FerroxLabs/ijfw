#!/usr/bin/env bash
set -euo pipefail

# Scan shippable surfaces for stale platform counts. Historical files excluded.
STALE=$(grep -rn '\b8 platforms\b' \
  --include='*.md' --include='*.sh' --include='*.js' --include='*.json' \
  --exclude-dir='.planning' --exclude-dir='archive' --exclude-dir='node_modules' \
  claude/ universal/ docs/ installer/src/ mcp-server/ scripts/ 2>/dev/null \
  | grep -v '^CHANGELOG\.md:' \
  | grep -v '^installer/CHANGELOG\.md:' \
  | grep -v "preflight-stale-count\.sh:" \
  | grep -v "'8 platforms'" \
  | grep -v '"8 platforms"' \
  | grep -v 'old "8 platforms"' \
  || true)

if [ -n "$STALE" ]; then
  echo "ISSUE: stale '8 platforms' string(s) in shippable surfaces:"
  echo "$STALE"
  exit 1
fi
echo "OK: no stale platform counts."
