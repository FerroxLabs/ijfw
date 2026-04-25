#!/usr/bin/env bash
# post-publish-smoke.sh -- live install-from-registry verification.
#
# Runs after a successful npm publish to assert the published @ijfw/install
# tarball actually works end-to-end on a clean machine. Catches regressions
# the local check-all.sh + e2e-smoke.sh cannot (e.g. missing files in the
# tarball, version mismatches, registry propagation, MCP server startup).
#
# Designed to run inside a fresh container or a mktemp-isolated user. Does
# NOT touch the calling shell's $HOME or npm prefix.
#
# Usage:
#   bash scripts/post-publish-smoke.sh <version>
#   bash scripts/post-publish-smoke.sh 1.2.0
#   bash scripts/post-publish-smoke.sh v1.2.0     # leading 'v' tolerated
#
# Env overrides:
#   IJFW_SMOKE_HOME   default $(mktemp -d)/home    -- isolated HOME
#   IJFW_SMOKE_NPM    default $(mktemp -d)/npm     -- isolated npm prefix
#   IJFW_SMOKE_RETRY  default 5                    -- npm propagation retries
#   IJFW_SMOKE_DELAY  default 30                   -- seconds between retries
#
# Exit codes:
#   0 -- all gates passed
#   1 -- npm registry never showed the version (propagation timeout)
#   2 -- ijfw --version did not match expected
#   3 -- ijfw-install failed
#   4 -- 12-template count assertion failed
#   5 -- MCP design_template catalog assertion failed
#   6 -- MCP design_template:swiss-minimal body assertion failed
#   7 -- MCP prelude design picker block assertion failed
#   8 -- npm install of the published @ijfw/install tarball failed

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>" >&2
  exit 64
fi
VERSION="${VERSION#v}"

echo "== Post-publish smoke: @ijfw/install@$VERSION =="

# Isolation roots.
TMPROOT=$(mktemp -d /tmp/ijfw-smoke-XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
export HOME="${IJFW_SMOKE_HOME:-$TMPROOT/home}"
export NPM_CONFIG_PREFIX="${IJFW_SMOKE_NPM:-$TMPROOT/npm}"
export IJFW_HOME="$TMPROOT/ijfw-home"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$HOME" "$NPM_CONFIG_PREFIX" "$IJFW_HOME"
unset IJFW_PROJECT_DIR CLAUDE_PROJECT_DIR

# Gate 1: npm registry propagation.
RETRY="${IJFW_SMOKE_RETRY:-5}"
DELAY="${IJFW_SMOKE_DELAY:-30}"
i=0
while [ "$i" -lt "$RETRY" ]; do
  if npm view "@ijfw/install@$VERSION" version >/dev/null 2>&1; then
    echo "  [ok] registry: @ijfw/install@$VERSION visible"
    break
  fi
  i=$((i + 1))
  if [ "$i" -ge "$RETRY" ]; then
    echo "  [fail] registry: @ijfw/install@$VERSION never appeared after ${RETRY} attempts (${DELAY}s each)" >&2
    exit 1
  fi
  echo "  ... not yet visible (attempt $i/$RETRY), sleeping ${DELAY}s"
  sleep "$DELAY"
done

# Gate 2: install succeeds. Wrapped in explicit if-fail with exit code 8 so
# pipefail aborts surface a gate-named failure instead of a generic stderr
# trace. Round-5 codex audit close (NOTE on smoke-script diagnosability).
echo "== Installing @ijfw/install@$VERSION globally into $NPM_CONFIG_PREFIX =="
if ! npm install -g "@ijfw/install@$VERSION" 2>&1 | tail -10; then
  echo "  [fail] gate 2: npm install -g @ijfw/install@$VERSION failed" >&2
  exit 8
fi

# Gate 3: version matches.
ACTUAL=$(ijfw --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ "$ACTUAL" != "$VERSION" ]; then
  echo "  [fail] ijfw --version reports '$ACTUAL', expected '$VERSION'" >&2
  exit 2
fi
echo "  [ok] ijfw --version: $ACTUAL"

# Gate 4: ijfw-install clones the repo at the tag.
echo "== Running ijfw-install --yes =="
mkdir -p "$TMPROOT/proj" && cd "$TMPROOT/proj"
if ! ijfw-install --yes 2>&1 | tail -10; then
  echo "  [fail] ijfw-install exited non-zero" >&2
  exit 3
fi

# Gate 5: 12 templates ship.
TPL_DIR="$IJFW_HOME/mcp-server/templates/design"
COUNT=$(find "$TPL_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" != "12" ]; then
  echo "  [fail] expected 12 templates in $TPL_DIR, got $COUNT" >&2
  find "$TPL_DIR" -maxdepth 1 -name '*.md' -type f 2>&1 || true
  exit 4
fi
echo "  [ok] 12 templates present"

# Gate 6: MCP server -> design_template catalog returns 12 unique names.
SERVER="$IJFW_HOME/mcp-server/src/server.js"
mkdir -p "$TMPROOT/mcp-proj"
export IJFW_PROJECT_DIR="$TMPROOT/mcp-proj"
NAMES="bento-grid|brutalist-luxe|cinematic-dark|data-dense-dashboard|editorial-warm|glassmorphic|magazine-editorial|maximalist-vibrant|neo-swiss-tech|swiss-minimal|terminal-native|warm-organic"
CAT_OUT=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
    sleep 0.3
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ijfw_memory_recall","arguments":{"context_hint":"design_template"}}}'
    sleep 0.8
  ) | node "$SERVER" 2>/dev/null
)
CAT_COUNT=$(echo "$CAT_OUT" | grep -oE "$NAMES" | sort -u | wc -l | tr -d ' ')
if [ "$CAT_COUNT" != "12" ]; then
  echo "  [fail] design_template catalog returned $CAT_COUNT/12 unique names" >&2
  echo "$CAT_OUT" | head -50 >&2
  exit 5
fi
echo "  [ok] design_template catalog returns 12 names"

# Gate 7: design_template:swiss-minimal body returns the template body.
BODY_OUT=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
    sleep 0.3
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ijfw_memory_recall","arguments":{"context_hint":"design_template:swiss-minimal"}}}'
    sleep 0.8
  ) | node "$SERVER" 2>/dev/null
)
if ! echo "$BODY_OUT" | grep -q "Swiss Minimal"; then
  echo "  [fail] design_template:swiss-minimal body missing 'Swiss Minimal' marker" >&2
  exit 6
fi
echo "  [ok] design_template:swiss-minimal body returned"

# Gate 8: prelude includes Design picker block when no DESIGN.md in PROJECT_DIR.
PRELUDE_OUT=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
    sleep 0.3
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ijfw_memory_prelude","arguments":{}}}'
    sleep 0.8
  ) | node "$SERVER" 2>/dev/null
)
if ! echo "$PRELUDE_OUT" | grep -q "Design picker"; then
  echo "  [fail] prelude missing 'Design picker' block (expected when no DESIGN.md in PROJECT_DIR)" >&2
  exit 7
fi
echo "  [ok] prelude includes Design picker block"

echo ""
echo "== ALL POST-PUBLISH GATES PASSED for @ijfw/install@$VERSION =="
