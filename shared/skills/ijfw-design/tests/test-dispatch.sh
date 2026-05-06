#!/usr/bin/env bash
# tests/test-dispatch.sh -- bash tests for dispatch.sh routing logic
# Run: bash shared/skills/ijfw-design/tests/test-dispatch.sh

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH_SH="$SCRIPT_DIR/../scripts/dispatch.sh"
PASS=0
FAIL=0

ok()   { echo "  [ok] $1"; PASS=$((PASS+1)); }
fail() { echo "  [fail] $1" >&2; FAIL=$((FAIL+1)); }

# ---------------------------------------------------------------------------
# Test: dispatch.sh exists and is executable
# ---------------------------------------------------------------------------
if [ -f "$DISPATCH_SH" ]; then
  ok "dispatch.sh exists"
else
  fail "dispatch.sh not found at $DISPATCH_SH"
fi

# ---------------------------------------------------------------------------
# Test: IJFW_PREFER_INTERNAL=1 forces internal route
# ---------------------------------------------------------------------------
OUTPUT=$(IJFW_PREFER_INTERNAL=1 bash "$DISPATCH_SH" "test dashboard query" --design-system 2>/dev/null || true)
if echo "$OUTPUT" | grep -q "route=internal"; then
  ok "IJFW_PREFER_INTERNAL=1 routes to internal"
else
  fail "IJFW_PREFER_INTERNAL=1 did not route to internal. Output: $OUTPUT"
fi

# ---------------------------------------------------------------------------
# Test: internal route runs search.js and returns output
# ---------------------------------------------------------------------------
if echo "$OUTPUT" | grep -q "IJFW INVARIANTS\|Design Recommendation\|route="; then
  ok "internal route produces design output"
else
  fail "internal route did not produce expected output"
fi

# ---------------------------------------------------------------------------
# Test: IJFW layer always appended
# ---------------------------------------------------------------------------
OUTPUT2=$(IJFW_PREFER_INTERNAL=1 bash "$DISPATCH_SH" "saas landing" --design-system 2>/dev/null || true)
if echo "$OUTPUT2" | grep -q "IJFW LAYER"; then
  ok "IJFW layer always appended"
else
  fail "IJFW layer not appended to output"
fi

# ---------------------------------------------------------------------------
# Test: IJFW layer mentions zero runtime deps
# ---------------------------------------------------------------------------
if echo "$OUTPUT2" | grep -qi "zero runtime"; then
  ok "IJFW layer mentions zero runtime deps"
else
  fail "IJFW layer missing zero runtime deps mention"
fi

# ---------------------------------------------------------------------------
# Test: missing query exits non-zero
# ---------------------------------------------------------------------------
EXIT_CODE=0
bash "$DISPATCH_SH" 2>/dev/null || EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  ok "missing query exits non-zero"
else
  fail "missing query should exit non-zero"
fi

# ---------------------------------------------------------------------------
# Test: output has no banned unicode
# ---------------------------------------------------------------------------
BANNED_CHARS=$(echo "$OUTPUT" | LC_ALL=C grep -P '[\x{2014}\x{00A7}\x{2501}\x{2713}\x{2714}]' 2>/dev/null || true)
if [ -z "$BANNED_CHARS" ]; then
  ok "output contains no banned unicode characters"
else
  fail "output contains banned unicode: $BANNED_CHARS"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "dispatch.sh tests: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
