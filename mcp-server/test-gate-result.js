/**
 * test-gate-result.js
 *
 * IJFW v1.4.0 Wave 4 / t17 — Test suite for the gate-result module.
 *
 * Covers:
 *   - gate-result-schema.js: SCHEMA_VERSION, pattern, validator, makeGateId,
 *     formatter.
 *   - gate-result.js: emitGateResult (happy path, defaults, FLAG roundtrip,
 *     namespaced gates, invalid input rejection, multi-lens, project_type
 *     auto-detect), makeReceipt (write + error swallow).
 *   - gate-result-formatter.js: appendGateResult idempotence, template
 *     substitution.
 *   - trident/dispatch.js: gate_result_block attached when runTrident
 *     succeeds (executor stub + lens-health cache stub).
 *
 * Node built-in test runner only; no new prod deps.
 *
 * Run:  node --test mcp-server/test-gate-result.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_NAME_PATTERN,
  SCHEMA_VERSION,
  VALID_ARTIFACT_TYPES,
  VALID_PROJECT_TYPES,
  VALID_STATUSES,
  formatGateResult,
  makeGateId,
  validateGateResult,
} from './src/gate-result-schema.js';
import { emitGateResult, makeReceipt } from './src/gate-result.js';
import {
  appendGateResult,
  gateResultBlockOnly,
  gateResultTemplate,
} from './src/gate-result-formatter.js';

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** Extract the JSON body from a fenced ```gate-result\n...\n``` block. */
function parseGateResultBlock(block) {
  const m = block.match(/```gate-result\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error('test helper: no gate-result fence found in block');
  return JSON.parse(m[1]);
}

/** Build a fully-formed gate-result object using makeGateId. */
function buildValidGateResult(overrides = {}) {
  const gate = overrides.gate || 'trident';
  return {
    schema_version: SCHEMA_VERSION,
    gate_id: overrides.gate_id || makeGateId(gate),
    gate,
    status: 'PASS',
    project_type: 'software',
    lenses: [],
    affected_artifacts: [],
    accounting: { duration_ms: 1, lenses_invoked: 0, cost_usd: null },
    remediation: [],
    receipts_ref: null,
    supersedes: null,
    emitted_at: new Date().toISOString(),
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// 1. schema: FLAG status accepted
// --------------------------------------------------------------------------
test('schema: FLAG status accepted', () => {
  assert.equal(VALID_STATUSES.includes('FLAG'), true);
  const obj = buildValidGateResult({ status: 'FLAG' });
  const { valid, errors } = validateGateResult(obj);
  assert.equal(valid, true, `expected FLAG to validate; errors: ${errors.join('; ')}`);
  assert.deepEqual(errors, []);
});

// --------------------------------------------------------------------------
// 2. schema: gate-name pattern
// --------------------------------------------------------------------------
test('schema: gate-name pattern accepts/rejects expected forms', () => {
  const accepts = ['trident', 'preflight:audit-ci', 'plan-check'];
  for (const g of accepts) {
    assert.equal(GATE_NAME_PATTERN.test(g), true, `expected accept: ${g}`);
  }
  const rejects = ['BadGate', 'foo:bar:baz', '1bad', 'Foo-Bar'];
  for (const g of rejects) {
    assert.equal(GATE_NAME_PATTERN.test(g), false, `expected reject: ${g}`);
  }
});

// --------------------------------------------------------------------------
// 3. schema: validateGateResult rejects empty
// --------------------------------------------------------------------------
test('schema: validateGateResult rejects empty object', () => {
  const { valid, errors } = validateGateResult({});
  assert.equal(valid, false);
  assert.ok(Array.isArray(errors));
  assert.ok(errors.length > 0, 'expected non-empty errors array');
});

// --------------------------------------------------------------------------
// 4. schema: passes a fully-formed object
// --------------------------------------------------------------------------
test('schema: validateGateResult passes a fully-formed object', () => {
  const obj = buildValidGateResult({
    lenses: [
      { model: 'claude', verdict: 'PASS', confidence: 0.95, summary: 'ok' },
    ],
    affected_artifacts: [
      { type: 'file', ref: 'src/foo.js', role: 'subject' },
    ],
    remediation: [
      {
        action: 'fix',
        target: 'src/foo.js',
        agent_recommended: 'codex',
        confidence: 0.7,
      },
    ],
  });
  const { valid, errors } = validateGateResult(obj);
  assert.equal(valid, true, `expected valid; errors: ${errors.join('; ')}`);
  assert.deepEqual(errors, []);
});

// --------------------------------------------------------------------------
// 5. schema: makeGateId collapses colons
// --------------------------------------------------------------------------
test('schema: makeGateId collapses colons and appends 4-hex suffix', () => {
  const id = makeGateId('preflight:audit-ci');
  assert.equal(
    id.startsWith('preflight-audit-ci-'),
    true,
    `expected colon-collapsed prefix; got ${id}`,
  );
  // shape: preflight-audit-ci-<ts>-<rand4>
  const m = id.match(/^preflight-audit-ci-\d+-([0-9a-f]{4})$/);
  assert.ok(m, `expected <prefix>-<ts>-<4hex>; got ${id}`);
});

// --------------------------------------------------------------------------
// 6. schema: makeGateId throws on bad input
// --------------------------------------------------------------------------
test('schema: makeGateId throws on bad input', () => {
  assert.throws(() => makeGateId('Bad'), /invalid gate name/);
  assert.throws(() => makeGateId(''), /invalid gate name/);
  assert.throws(() => makeGateId(42), /invalid gate name/);
});

// --------------------------------------------------------------------------
// 7. format: fenced block parses as JSON
// --------------------------------------------------------------------------
test('format: formatGateResult emits a fenced block that JSON.parse round-trips', () => {
  const obj = buildValidGateResult({ gate: 'trident' });
  const block = formatGateResult(obj);
  assert.match(block, /^```gate-result\n/);
  assert.match(block, /\n```$/);
  const parsed = parseGateResultBlock(block);
  assert.equal(parsed.gate, 'trident');
  assert.equal(parsed.schema_version, SCHEMA_VERSION);

  // gateResultBlockOnly is a thin re-export — assert it agrees.
  const blockOnly = gateResultBlockOnly(obj);
  assert.equal(blockOnly, block);
});

// --------------------------------------------------------------------------
// 8. emitter: happy path
// --------------------------------------------------------------------------
test('emitter: emitGateResult happy path produces a trident PASS block', async () => {
  const block = await emitGateResult(
    {
      gate: 'trident',
      status: 'PASS',
      accounting: { duration_ms: 1, lenses_invoked: 0, cost_usd: null },
    },
    { project_type: 'software' },
  );
  assert.match(block, /```gate-result/);
  assert.match(block, /"gate":\s*"trident"/);
  assert.match(block, /"status":\s*"PASS"/);
});

// --------------------------------------------------------------------------
// 9. emitter: fills defaults
// --------------------------------------------------------------------------
test('emitter: emitGateResult fills lenses/affected_artifacts/remediation defaults', async () => {
  const block = await emitGateResult(
    {
      gate: 'trident',
      status: 'PASS',
      accounting: { duration_ms: 1, lenses_invoked: 0, cost_usd: null },
    },
    { project_type: 'software' },
  );
  const parsed = parseGateResultBlock(block);
  assert.deepEqual(parsed.lenses, []);
  assert.deepEqual(parsed.affected_artifacts, []);
  assert.deepEqual(parsed.remediation, []);
  assert.equal(parsed.receipts_ref, null);
  assert.equal(parsed.supersedes, null);
});

// --------------------------------------------------------------------------
// 10. emitter: FLAG verdict end-to-end
// --------------------------------------------------------------------------
test('emitter: FLAG verdict round-trips through emit -> parse', async () => {
  const block = await emitGateResult(
    {
      gate: 'trident',
      status: 'FLAG',
      accounting: { duration_ms: 5, lenses_invoked: 1, cost_usd: null },
    },
    { project_type: 'software' },
  );
  const parsed = parseGateResultBlock(block);
  assert.equal(parsed.status, 'FLAG');
});

// --------------------------------------------------------------------------
// 11. emitter: namespaced gate end-to-end
// --------------------------------------------------------------------------
test('emitter: namespaced gate -> colon collapsed in gate_id', async () => {
  const block = await emitGateResult(
    {
      gate: 'preflight:audit-ci',
      status: 'PASS',
      accounting: { duration_ms: 1, lenses_invoked: 0, cost_usd: null },
    },
    { project_type: 'software' },
  );
  const parsed = parseGateResultBlock(block);
  assert.equal(parsed.gate, 'preflight:audit-ci');
  assert.equal(
    parsed.gate_id.startsWith('preflight-audit-ci-'),
    true,
    `expected colon-collapsed gate_id; got ${parsed.gate_id}`,
  );
  // The colon must NEVER appear in gate_id.
  assert.equal(parsed.gate_id.includes(':'), false);
});

// --------------------------------------------------------------------------
// 12. emitter: throws on invalid input
// --------------------------------------------------------------------------
test('emitter: throws on invalid gate name', async () => {
  await assert.rejects(
    () =>
      emitGateResult(
        {
          gate: 'BAD',
          status: 'PASS',
          accounting: { duration_ms: 1, lenses_invoked: 0, cost_usd: null },
        },
        {},
      ),
    /invalid gate name|gate-result/i,
  );
});

// --------------------------------------------------------------------------
// 13. emitter: multi-lens serialization
// --------------------------------------------------------------------------
test('emitter: multi-lens serialization preserves all lens entries', async () => {
  const lenses = [
    { model: 'claude', verdict: 'PASS', confidence: 0.9, summary: 'ok' },
    { model: 'codex', verdict: 'CONDITIONAL', confidence: 0.7, summary: 'noted' },
  ];
  const block = await emitGateResult(
    {
      gate: 'trident',
      status: 'CONDITIONAL',
      lenses,
      accounting: { duration_ms: 10, lenses_invoked: 2, cost_usd: null },
    },
    { project_type: 'software' },
  );
  const parsed = parseGateResultBlock(block);
  assert.equal(Array.isArray(parsed.lenses), true);
  assert.equal(parsed.lenses.length, 2);
  assert.equal(parsed.lenses[0].verdict, 'PASS');
  assert.equal(parsed.lenses[1].verdict, 'CONDITIONAL');
  assert.equal(parsed.lenses[0].model, 'claude');
  assert.equal(parsed.lenses[1].model, 'codex');
});

// --------------------------------------------------------------------------
// 14. emitter: project_type auto-detect fallback
// --------------------------------------------------------------------------
test('emitter: project_type auto-detect returns a valid string when not supplied', async () => {
  const block = await emitGateResult(
    {
      gate: 'trident',
      status: 'PASS',
      accounting: { duration_ms: 1, lenses_invoked: 0, cost_usd: null },
    },
    { projectRoot: '/tmp/ijfw-t17-nonexistent-' + Date.now() },
  );
  const parsed = parseGateResultBlock(block);
  assert.equal(typeof parsed.project_type, 'string');
  assert.ok(
    VALID_PROJECT_TYPES.includes(parsed.project_type),
    `expected one of ${VALID_PROJECT_TYPES.join('|')}; got ${parsed.project_type}`,
  );
});

// --------------------------------------------------------------------------
// 15. receipt: makeReceipt writes to gate-receipts dir
// --------------------------------------------------------------------------
test('receipt: makeReceipt writes <projectRoot>/.ijfw/memory/gate-receipts/<gate_id>.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ijfw-t17-'));
  try {
    const gateResult = buildValidGateResult({ gate: 'trident' });
    await makeReceipt(gateResult, { projectRoot: root });

    const receiptPath = join(
      root,
      '.ijfw',
      'memory',
      'gate-receipts',
      `${gateResult.gate_id}.json`,
    );
    const st = await stat(receiptPath);
    assert.equal(st.isFile(), true);

    const body = await readFile(receiptPath, 'utf8');
    const parsed = JSON.parse(body);
    assert.equal(parsed.gate_id, gateResult.gate_id);
    assert.equal(parsed.gate, 'trident');
    assert.equal(parsed.schema_version, SCHEMA_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// 16. receipt: makeReceipt swallows disk errors
// --------------------------------------------------------------------------
test('receipt: makeReceipt swallows errors and never throws', async () => {
  // Force a write into a path that cannot exist on a sandboxed mkdir:
  // pass a non-string gate_id so the early-return guard kicks in, then also
  // try a "../../" gate_id which mkdir/writeFile should still tolerate
  // because makeReceipt joins under projectRoot. Either way, no throw.
  const badResult1 = { schema_version: SCHEMA_VERSION, gate_id: 12345 };
  await assert.doesNotReject(() => makeReceipt(badResult1, {}));

  const badResult2 = { schema_version: SCHEMA_VERSION, gate_id: null };
  await assert.doesNotReject(() => makeReceipt(badResult2, {}));

  // gate_id with path traversal: makeReceipt joins under projectRoot, so the
  // resulting path may be unusual but writeFile shouldn't throw because the
  // parent directory is created with recursive:true. Even if it did throw,
  // makeReceipt's catch must swallow it.
  const root = await mkdtemp(join(tmpdir(), 'ijfw-t17-bad-'));
  try {
    const badResult3 = buildValidGateResult({
      gate_id: '../../../tmp/should-never-escape',
    });
    await assert.doesNotReject(() =>
      makeReceipt(badResult3, { projectRoot: root }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// 17. formatter: appendGateResult idempotent
// --------------------------------------------------------------------------
test('formatter: appendGateResult is idempotent across repeated calls', () => {
  const obj = buildValidGateResult({ gate: 'trident' });
  let out = 'some prior output\n';
  out = appendGateResult(out, obj);
  out = appendGateResult(out, obj);
  const fences = out.match(/```gate-result/g) || [];
  assert.equal(fences.length, 1, `expected exactly 1 gate-result fence; got ${fences.length}`);

  // Sanity: appending to empty string also yields exactly one fence.
  const empty = appendGateResult('', obj);
  const fences2 = empty.match(/```gate-result/g) || [];
  assert.equal(fences2.length, 1);
});

// --------------------------------------------------------------------------
// 18. formatter: gateResultTemplate substitutes gate name
// --------------------------------------------------------------------------
test('formatter: gateResultTemplate substitutes gate name in narration and JSON', () => {
  const snippet = gateResultTemplate('cross-audit');
  assert.match(snippet, /gate="cross-audit"/);
  assert.match(snippet, /"gate":\s*"cross-audit"/);
  // Colon-namespaced gates too.
  const ns = gateResultTemplate('preflight:audit-ci');
  assert.match(ns, /gate="preflight:audit-ci"/);
  // gate_id template should collapse the colon for filesystem safety.
  assert.match(ns, /"gate_id":\s*"preflight-audit-ci-/);
});

// --------------------------------------------------------------------------
// 19. Trident gate_result_block attached
// --------------------------------------------------------------------------
test('trident: runTrident attaches a gate_result_block when audit succeeds', async () => {
  // Stub lens-health cache so probeLenses sees codex+gemini "live" without
  // spawning real binaries. Claude lens is always live in-process.
  const lensHealth = await import('./src/trident/lens-health.js');
  const trident = await import('./src/trident/dispatch.js');

  lensHealth._resetCache();
  lensHealth._setCache('codex', { live: true, latency_ms: 1, error: null });
  lensHealth._setCache('gemini', { live: true, latency_ms: 1, error: null });

  try {
    const result = await trident.runTrident({
      brief: 'unit-test brief — confirm gate_result_block is emitted',
      // 60s TTL covers test duration; cache hit short-circuits real probes.
      probeOpts: { ttlMs: 60_000 },
      executor: async ({ lens }) => ({
        lens,
        verdict: 'PASS',
        findings: [],
        latency_ms: 0,
        confidence: 0.9,
        summary: `${lens} stub PASS`,
      }),
    });

    assert.equal(typeof result.gate_result_block, 'string');
    assert.match(result.gate_result_block, /```gate-result/);
    assert.match(result.gate_result_block, /"gate":\s*"trident"/);

    const parsed = parseGateResultBlock(result.gate_result_block);
    assert.equal(parsed.gate, 'trident');
    assert.equal(VALID_STATUSES.includes(parsed.status), true);
    // Multi-lens audit: lenses array should have at least one entry.
    assert.ok(parsed.lenses.length >= 1);
  } finally {
    lensHealth._resetCache();
  }
});

// --------------------------------------------------------------------------
// 20. preflight gate emits namespaced block
// --------------------------------------------------------------------------
test.skip('preflight: audit-ci gate emits a "preflight:audit-ci" gate-result block (no runner present yet)', async () => {
  // SKIP: at the time of t17, no preflight runner module in mcp-server/src
  // imports and emits a namespaced `preflight:audit-ci` gate-result block.
  // The schema (gate-result-schema.js) is the only consumer of that gate
  // name today. Once a preflight runner is wired (post-t17), unskip and
  // assert the runner output contains both "```gate-result" and
  // "preflight:audit-ci" via the same parseGateResultBlock helper above.
});

// --------------------------------------------------------------------------
// sanity: ARTIFACT_TYPES surface is exported (used by R-series consumers)
// --------------------------------------------------------------------------
test('schema: VALID_ARTIFACT_TYPES is a frozen list including domain-neutral types', () => {
  assert.equal(Object.isFrozen(VALID_ARTIFACT_TYPES), true);
  assert.ok(VALID_ARTIFACT_TYPES.includes('file'));
  assert.ok(VALID_ARTIFACT_TYPES.includes('chapter'));
  assert.ok(VALID_ARTIFACT_TYPES.includes('decision'));
});
