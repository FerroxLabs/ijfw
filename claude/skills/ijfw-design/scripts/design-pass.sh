#!/usr/bin/env bash
# ijfw-design/scripts/design-pass.sh
# Called by ijfw-workflow at Plan phase for UI-touching tasks.
# Logs a "design-pass" observation to the IJFW ledger.
#
# Usage:
#   bash design-pass.sh "<query>" "<style_picked>" "<palette_hash>" "<source>"
#   bash design-pass.sh "developer dashboard" "data-dense" "slate-pro" "internal"
#
# Writes: .ijfw/design-pass.json (sentinel for preflight gate)
# Appends: .ijfw/ledger.ndjson (observation trail)

set -euo pipefail

QUERY="${1:-unknown}"
STYLE="${2:-unknown}"
PALETTE="${3:-unknown}"
SOURCE="${4:-internal}"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")

# Determine project root: walk up until .ijfw/ found or cwd
find_project_root() {
  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.ijfw" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo "$(pwd)"
}

ROOT=$(find_project_root)
IJFW_DIR="$ROOT/.ijfw"

mkdir -p "$IJFW_DIR"

# Write sentinel file (checked by preflight gate)
cat > "$IJFW_DIR/design-pass.json" <<EOF
{
  "ts": "$TS",
  "query": "$QUERY",
  "style": "$STYLE",
  "palette": "$PALETTE",
  "source": "$SOURCE",
  "skill": "ijfw-design"
}
EOF

# Append to ledger (ndjson)
LEDGER="$IJFW_DIR/ledger.ndjson"
ENTRY="{\"ts\":\"$TS\",\"type\":\"design-pass\",\"query\":\"$QUERY\",\"style\":\"$STYLE\",\"palette\":\"$PALETTE\",\"source\":\"$SOURCE\",\"skill\":\"ijfw-design\"}"
echo "$ENTRY" >> "$LEDGER"

echo "Design pass logged."
echo "  Sentinel: $IJFW_DIR/design-pass.json"
echo "  Ledger:   $LEDGER"
echo "  Style: $STYLE | Palette: $PALETTE | Source: $SOURCE"
