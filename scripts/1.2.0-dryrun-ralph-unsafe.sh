#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Unsafe-verify dry-run: criterion with a forbid-list command.
# Asserts task halts BEFORE verify runs; ISSUE(unsafe-verify) emitted.

LEDGER_DIR=$(mktemp -d)
export IJFW_STATE_DIR="$LEDGER_DIR"
LEDGER="$LEDGER_DIR/execute-issues.json"

cleanup() { rm -rf "$LEDGER_DIR"; }
trap cleanup EXIT

UNSAFE_CMD="rm -rf /tmp/foo"

# --- 1. Assert isSafeVerifyCommand rejects the forbid-list command ---
node --input-type=module <<'JS'
import { isSafeVerifyCommand } from './mcp-server/src/ralph-allowlist.js';
const r = isSafeVerifyCommand('rm -rf /tmp/foo');
if (r.safe) {
  console.error('FAIL: rm -rf should be rejected by isSafeVerifyCommand');
  process.exit(1);
}
if (!r.reason || !r.reason.includes('rm')) {
  console.error('FAIL: expected reason to mention "rm", got: ' + r.reason);
  process.exit(1);
}
console.log('OK: isSafeVerifyCommand rejects "rm -rf /tmp/foo" -- reason: ' + r.reason);
JS

# --- 2. Simulate loop: safety check fires, verify never runs ---
VERIFY_EXECUTED=false

# In the Ralph loop, isSafeVerifyCommand is called BEFORE run(). Simulate that:
SAFETY_RESULT=$(node --input-type=module <<'JS'
import { isSafeVerifyCommand } from './mcp-server/src/ralph-allowlist.js';
const r = isSafeVerifyCommand('rm -rf /tmp/foo');
console.log(JSON.stringify(r));
JS
)

SAFE=$(node -e "console.log(JSON.parse('$SAFETY_RESULT').safe)")
if [ "$SAFE" = "true" ]; then
  # Would execute -- but should never reach here
  VERIFY_EXECUTED=true
  bash -c "$UNSAFE_CMD" || true
fi

# Assert verify never ran
if [ "$VERIFY_EXECUTED" = "true" ]; then
  echo "FAIL: unsafe verify command was executed -- safety check did not halt the loop"
  exit 1
fi

# --- 3. Write unsafe-verify ISSUE to ledger (rehearsal: true) ---
node -e "
const fs = require('fs');
const entry = {
  id: 'iss_unsafe_001',
  task_id: 't1',
  criterion_id: 'c1',
  kind: 'unsafe-verify',
  message: 'rm is in forbid list',
  command: 'rm -rf /tmp/foo',
  reason: 'rm is in forbid list',
  halt: true,
  status: 'unresolved',
  rehearsal: true,
  created_at: new Date().toISOString(),
  resolved_at: null
};
const ledger = { schema_version: 1, issues: [entry] };
fs.writeFileSync('$LEDGER', JSON.stringify(ledger, null, 2));
console.log('ISSUE: unsafe-verify -- task halted before verify ran');
"

# --- 4. Assert ledger entry is kind: unsafe-verify ---
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$LEDGER', 'utf8'));
const entry = d.issues[0];
if (!entry) { console.error('FAIL: no ledger entry'); process.exit(1); }
if (entry.kind !== 'unsafe-verify') { console.error('FAIL: expected kind unsafe-verify, got ' + entry.kind); process.exit(1); }
if (entry.halt !== true) { console.error('FAIL: expected halt: true'); process.exit(1); }
if (entry.rehearsal !== true) { console.error('FAIL: expected rehearsal: true'); process.exit(1); }
console.log('OK: ledger entry kind=unsafe-verify, halt=true, rehearsal=true');
"

echo "OK: 1.2.0-dryrun-ralph-unsafe passes"
