/**
 * test-plan-checker.js — v1.5.0-major W12-D C14.
 *
 * Pure-function tests for the pre-dispatch plan-checker gate. No I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from './src/orchestrator/plan-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findingsOfCode(result, code) {
  return result.findings.filter((f) => f.code === code);
}

function severities(result) {
  return result.findings.map((f) => f.severity);
}

// ---------------------------------------------------------------------------
// 1. Clean plan
// ---------------------------------------------------------------------------

test('clean plan with one well-formed task → ok=true, 0 findings', () => {
  const plan = `
## Task t1: implement login endpoint

- Write failing test for POST /login that returns a JWT on valid creds
- Implement the handler in src/auth/login.js with bcrypt verification
- Wire route into src/server.js and update OpenAPI spec

Acceptance: integration test passes; logs show no plaintext password
`;
  const result = validatePlan(plan);
  assert.equal(result.ok, true, 'should be ok');
  assert.deepEqual(result.findings, [], `expected 0 findings, got: ${JSON.stringify(result.findings, null, 2)}`);
});

// ---------------------------------------------------------------------------
// 2. Placeholder tokens
// ---------------------------------------------------------------------------

test('plan with TBD → WARN in default mode, BLOCK in strict', () => {
  const plan = `
## Task t1: build the dashboard

- Render the chart panel (data source: TBD)
- Acceptance: chart renders for the example fixture
`;
  const loose = validatePlan(plan);
  const placeholderFindings = findingsOfCode(loose, 'PC-PLACEHOLDER');
  assert.equal(placeholderFindings.length, 1, 'one placeholder finding expected');
  assert.equal(placeholderFindings[0].severity, 'WARN', 'WARN in loose mode');
  assert.equal(loose.ok, true, 'loose-mode WARN should not block');

  const strict = validatePlan(plan, { strict: true });
  const strictPlaceholder = findingsOfCode(strict, 'PC-PLACEHOLDER');
  assert.equal(strictPlaceholder[0].severity, 'BLOCK', 'BLOCK in strict mode');
  assert.equal(strict.ok, false, 'strict-mode BLOCK should set ok=false');
});

// ---------------------------------------------------------------------------
// 3. No tasks
// ---------------------------------------------------------------------------

test('plan with 0 tasks → BLOCK (PC-NO-TASKS)', () => {
  const plan = `
# Roadmap

Lots of context here but no actual task blocks defined.

Goals:
- Ship feature X
- Make users happy
`;
  const result = validatePlan(plan);
  const noTaskFindings = findingsOfCode(result, 'PC-NO-TASKS');
  assert.equal(noTaskFindings.length, 1);
  assert.equal(noTaskFindings[0].severity, 'BLOCK');
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 4. Task missing acceptance criteria
// ---------------------------------------------------------------------------

test('task with no acceptance criteria → WARN (PC-NO-ACCEPTANCE)', () => {
  const plan = `
## Task t1: refactor the cache layer

- Move TTL constants into config.js
- Rename CacheStore to MemoryCacheStore in src/cache.js
- Update three importers in src/api/*.js
`;
  const result = validatePlan(plan);
  const accFindings = findingsOfCode(result, 'PC-NO-ACCEPTANCE');
  assert.equal(accFindings.length, 1, 'one missing-acceptance warning');
  assert.equal(accFindings[0].severity, 'WARN');
  // WARN-only → ok stays true
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// 5. Dangling dependency
// ---------------------------------------------------------------------------

test('dangling `depends: t99` → BLOCK (PC-DANGLING-DEP)', () => {
  const plan = `
## Task t1: create the schema

- Write migration SQL in db/migrations/001_init.sql
- Acceptance: \`npm run migrate\` succeeds on a fresh db
task_id: t1

## Task t2: load seed data
depends: t99

- Wire seeder into bin/seed.js
- Acceptance: seed run inserts 100 fixture rows
task_id: t2
`;
  const result = validatePlan(plan);
  const dangling = findingsOfCode(result, 'PC-DANGLING-DEP');
  assert.equal(dangling.length, 1, 'one dangling-dep finding');
  assert.equal(dangling[0].severity, 'BLOCK');
  assert.match(dangling[0].message, /t99/);
  assert.equal(result.ok, false, 'BLOCK should fail ok');
});

// ---------------------------------------------------------------------------
// 6. Test-skip contradiction
// ---------------------------------------------------------------------------

test('task with add-tests + skip-tests in same block → BLOCK (PC-TEST-SKIP-CONTRADICTION)', () => {
  const plan = `
## Task t1: add tests for the auth flow

- Write tests for login, logout, and session refresh
- For now skip the tests in CI to unblock the release
- Acceptance: test files exist in test/auth/
`;
  const result = validatePlan(plan);
  const contradiction = findingsOfCode(result, 'PC-TEST-SKIP-CONTRADICTION');
  assert.equal(contradiction.length, 1);
  assert.equal(contradiction[0].severity, 'BLOCK');
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 7. Empty / vague step
// ---------------------------------------------------------------------------

test('task with "implement the thing" empty step → WARN (PC-EMPTY-STEP)', () => {
  const plan = `
## Task t1: ship the new export feature

- Implement the thing
- Wire the exporter into src/exports/csv.js with column ordering preserved
- Acceptance: \`npm test -- export\` is green
`;
  const result = validatePlan(plan);
  const empties = findingsOfCode(result, 'PC-EMPTY-STEP');
  assert(empties.length >= 1, `expected at least 1 empty-step finding, got ${empties.length}`);
  assert.equal(empties[0].severity, 'WARN');
  // WARN-only → ok stays true
  assert(!severities(result).includes('BLOCK'), 'no BLOCK severities expected');
  assert.equal(result.ok, true);
});
