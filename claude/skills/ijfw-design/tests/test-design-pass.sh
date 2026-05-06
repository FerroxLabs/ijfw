#!/usr/bin/env bash
# tests/test-design-pass.sh -- bash tests for design-pass.sh
# Run: bash shared/skills/ijfw-design/tests/test-design-pass.sh

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESIGN_PASS_SH="$SCRIPT_DIR/../scripts/design-pass.sh"
TMP_DIR=$(mktemp -d)
PASS=0
FAIL=0

ok()   { echo "  [ok] $1"; PASS=$((PASS+1)); }
fail() { echo "  [fail] $1" >&2; FAIL=$((FAIL+1)); }

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Test: design-pass.sh writes sentinel file
# ---------------------------------------------------------------------------
cd "$TMP_DIR"
mkdir -p .ijfw

bash "$DESIGN_PASS_SH" "test query" "data-dense" "slate-pro" "internal" > /dev/null 2>&1

if [ -f ".ijfw/design-pass.json" ]; then
  ok "design-pass.json created"
else
  fail "design-pass.json not created"
fi

# ---------------------------------------------------------------------------
# Test: sentinel file contains expected fields
# ---------------------------------------------------------------------------
if grep -q '"query"' ".ijfw/design-pass.json" 2>/dev/null; then
  ok "sentinel has query field"
else
  fail "sentinel missing query field"
fi

if grep -q '"style"' ".ijfw/design-pass.json" 2>/dev/null; then
  ok "sentinel has style field"
else
  fail "sentinel missing style field"
fi

if grep -q '"skill"' ".ijfw/design-pass.json" 2>/dev/null; then
  ok "sentinel has skill field"
else
  fail "sentinel missing skill field"
fi

if grep -q '"ts"' ".ijfw/design-pass.json" 2>/dev/null; then
  ok "sentinel has ts (timestamp) field"
else
  fail "sentinel missing ts field"
fi

# ---------------------------------------------------------------------------
# Test: ledger.ndjson appended
# ---------------------------------------------------------------------------
if [ -f ".ijfw/ledger.ndjson" ]; then
  ok "ledger.ndjson created"
else
  fail "ledger.ndjson not created"
fi

if grep -q '"type":"design-pass"' ".ijfw/ledger.ndjson" 2>/dev/null; then
  ok "ledger entry has type=design-pass"
else
  fail "ledger entry missing type=design-pass"
fi

# ---------------------------------------------------------------------------
# Test: second run appends not overwrites ledger
# ---------------------------------------------------------------------------
bash "$DESIGN_PASS_SH" "second pass" "bento-grid" "ijfw-dark" "internal" > /dev/null 2>&1
LINE_COUNT=$(wc -l < ".ijfw/ledger.ndjson")
if [ "$LINE_COUNT" -ge 2 ]; then
  ok "ledger appends on second run (lines: $LINE_COUNT)"
else
  fail "ledger should have 2+ lines after two runs; got $LINE_COUNT"
fi

# ---------------------------------------------------------------------------
# Test: zero-arg invocation still writes sentinel (forgiving defaults)
# ---------------------------------------------------------------------------
TMP2=$(mktemp -d)
cd "$TMP2"
mkdir -p .ijfw
bash "$DESIGN_PASS_SH" > /dev/null 2>&1 || true
if [ -f ".ijfw/design-pass.json" ]; then
  ok "zero-arg invocation still writes sentinel with defaults"
else
  fail "zero-arg invocation should write sentinel with defaults"
fi
rm -rf "$TMP2"
cd "$TMP_DIR"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "design-pass.sh tests: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
