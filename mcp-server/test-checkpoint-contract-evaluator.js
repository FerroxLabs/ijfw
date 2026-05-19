/**
 * test-checkpoint-contract-evaluator.js -- v1.5.0 N4.obs M3.
 *
 * Validates the first shipped pre-built evaluator: scores a subagent's final
 * status block against the four required sections (Status / SHAs / Files /
 * Tests). Zero deps, Node built-ins only.
 */

import {
  evaluator,
  evaluators,
  evaluateCheckpointContract,
  REQUIRED_SECTIONS,
  ID,
} from './src/observability/evaluator-checkpoint-contract.js';

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log('  ok ' + label);
    pass++;
  } else {
    console.error('  FAIL ' + label + (detail !== undefined ? ' -- ' + detail : ''));
    fail++;
  }
}

// ---------------------------------------------------------------------------
// 1. Registry metadata
// ---------------------------------------------------------------------------

console.log('\n-- 1. Registry metadata --');
ok('ID is stable string', ID === 'checkpoint-contract');
ok('REQUIRED_SECTIONS lists 4 sections', REQUIRED_SECTIONS.length === 4);
ok('evaluator is in evaluators[]', evaluators.includes(evaluator));
ok('evaluator.run is the function', evaluator.run === evaluateCheckpointContract);

// ---------------------------------------------------------------------------
// 2. Empty / nonsense input
// ---------------------------------------------------------------------------

console.log('\n-- 2. Empty / nonsense input --');
{
  const r = evaluateCheckpointContract('');
  ok('empty string invalid', !r.valid);
  ok('empty string reports all missing', r.missing.length === 4);
}
{
  const r = evaluateCheckpointContract(undefined);
  ok('undefined invalid', !r.valid);
  ok('undefined missing all', r.missing.length === 4);
}
{
  const r = evaluateCheckpointContract(12345);
  ok('non-string invalid', !r.valid);
}

// ---------------------------------------------------------------------------
// 3. Happy path -- full status block
// ---------------------------------------------------------------------------

console.log('\n-- 3. Happy path -- full status block --');
{
  const block = `
Status: DONE
SHAs: abc1234 def5678
Files: src/foo.js test/foo.test.js
Tests: 12/12
NOTES: clean run
`;
  const r = evaluateCheckpointContract(block);
  ok('full block valid', r.valid, JSON.stringify(r.missing));
  ok('full block missing[] is empty', r.missing.length === 0);
  ok('all sections present in details',
    Object.values(r.details).every((v) => v === 'present'));
  ok('reason omitted when valid', r.reason === undefined);
}

// ---------------------------------------------------------------------------
// 4. Each of the 4 statuses is accepted
// ---------------------------------------------------------------------------

console.log('\n-- 4. Each of the 4 statuses is accepted --');
for (const status of ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']) {
  const block = `Status: ${status}\nSHAs: (none)\nFiles: (none)\nTests: (none)`;
  const r = evaluateCheckpointContract(block);
  ok(`status=${status} valid`, r.valid, JSON.stringify(r.missing));
}

// ---------------------------------------------------------------------------
// 5. Missing each section in turn -- detection precision
// ---------------------------------------------------------------------------

console.log('\n-- 5. Missing each section in turn --');
{
  // Missing Status:
  const r = evaluateCheckpointContract('SHAs: x\nFiles: y\nTests: 1/1');
  ok('missing Status flagged', r.missing.includes('STATUS'));
  ok('missing Status valid=false', !r.valid);
  ok('reason mentions missing sections', /missing/.test(r.reason || ''));
}
{
  // Missing SHAs:
  const r = evaluateCheckpointContract('Status: DONE\nFiles: y\nTests: 1/1');
  ok('missing SHAs flagged', r.missing.includes('SHAS'));
}
{
  // Missing Files:
  const r = evaluateCheckpointContract('Status: DONE\nSHAs: x\nTests: 1/1');
  ok('missing Files flagged', r.missing.includes('FILES'));
}
{
  // Missing Tests:
  const r = evaluateCheckpointContract('Status: DONE\nSHAs: x\nFiles: y');
  ok('missing Tests flagged', r.missing.includes('TESTS'));
}

// ---------------------------------------------------------------------------
// 6. Synonym tolerance -- "SHA(s):", "File:", "Test:"
// ---------------------------------------------------------------------------

console.log('\n-- 6. Synonym tolerance --');
{
  const block = `Status: DONE
SHA(s): abc
File: src/foo.js
Test: 1/1`;
  const r = evaluateCheckpointContract(block);
  ok('SHA(s): tolerated', r.valid, JSON.stringify(r.missing));
}

// ---------------------------------------------------------------------------
// 7. Invalid Status value (e.g. "Status: PARTIAL")
// ---------------------------------------------------------------------------

console.log('\n-- 7. Invalid Status value --');
{
  const block = `Status: PARTIAL\nSHAs: x\nFiles: y\nTests: 1/1`;
  const r = evaluateCheckpointContract(block);
  ok('Status: PARTIAL flagged as absent', r.missing.includes('STATUS'));
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
