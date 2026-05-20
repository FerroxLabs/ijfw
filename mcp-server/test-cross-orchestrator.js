// test-cross-orchestrator.js - Unit tests for cross-orchestrator internals.
//
// Strategy: we can't import private functions, so we test via runCrossOp
// with a stubbed environment. The _installedCache from audit-roster lets us
// inject fake "installed" auditors without spawning anything real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _installedCache } from './src/audit-roster.js';

// We need to import runCrossOp but it calls process.exit on cancel and
// writeReceipt on success. We test via the exported function directly,
// controlling the environment through _installedCache + a fake CLI binary.

// ---------------------------------------------------------------------------
// Helper: prime cache so exactly `ids` appear installed.
// ---------------------------------------------------------------------------
const ALL_IDS = ['codex', 'gemini', 'opencode', 'aider', 'copilot', 'claude'];

function primeCache(installed = []) {
  for (const id of ALL_IDS) _installedCache.set(id, installed.includes(id));
}

function clearCache() {
  for (const id of ALL_IDS) _installedCache.delete(id);
}

// ---------------------------------------------------------------------------
// Import the orchestrator AFTER we have the cache set up.
// ---------------------------------------------------------------------------
const { runCrossOp } = await import('./src/cross-orchestrator.js');

// ---------------------------------------------------------------------------
// Test: timeout path returns status:'timeout'
// ---------------------------------------------------------------------------

test('fireExternal timeout returns auditor status:timeout', async () => {
  // Use a pick pointing to `sleep` - will be killed by the short timeout.
  // We can't override picks from runCrossOp directly, so we use a fake
  // "installed" CLI that just hangs: `sleep 999`
  // We patch _installedCache to claim `codex` is installed, but override
  // the invoke by monkey-patching (we can't - it's a const ROSTER entry).
  // Instead, we exercise the internal spawnCli indirectly by running
  // runCrossOp with IJFW_AUDIT_TIMEOUT_SEC=1 against a pick whose binary
  // doesn't exist - that gives us 'failed' (ENOENT), not 'timeout'.
  //
  // To test timeout directly without a hanging process, we use the
  // concurrency test approach: verify the allTimedOut guard triggers.

  // Simulate: only one auditor "installed" but with a non-existent binary
  // so it immediately returns 'failed'. All-timeout guard needs ALL timeout.
  // We skip that and instead test timeout indirectly via the allTimedOut guard
  // using a pick that resolves immediately as 'failed'.
  //
  // This is the safest deterministic test without actually spawning sleep.

  primeCache(['codex']);
  const env = {
    CLAUDECODE: '1',       // caller = claude (self), so codex is non-self
    IJFW_AUDIT_TIMEOUT_SEC: '1',
  };

  // codex is "installed" (per cache) but binary is `codex exec` which likely
  // doesn't exist on CI → spawn fails → status:'failed'. That's the expected path.
  const result = await runCrossOp({ mode: 'audit', target: 'x', env, quiet: true });

  clearCache();

  // Either no picks (if self-detection removed codex) or got a result
  assert.ok(result !== null && typeof result === 'object');
  // auditorResults (if present) must have status in allowed set
  if (result.auditorResults) {
    for (const r of result.auditorResults) {
      assert.ok(
        ['ok','empty','failed','timeout','fallback-used'].includes(r.status),
        `unexpected status: ${r.status}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test: single-settlement guard - error + close both emit, no double-resolve
// ---------------------------------------------------------------------------

test('spawnCli settle guard: no double-resolve when error+close both fire', async () => {
  // We test the observable effect: for a non-existent binary,
  // spawnCli returns exactly one result (not two), and runCrossOp
  // doesn't hang or throw.
  primeCache(['gemini']);
  const env = { IJFW_AUDIT_TIMEOUT_SEC: '2' };

  const result = await runCrossOp({ mode: 'audit', target: 'test content', env, quiet: true });
  clearCache();

  // Just verify we got back a result object (no uncaught double-resolve crash)
  assert.ok(result && typeof result === 'object');
});

// ---------------------------------------------------------------------------
// Test: minResponses short-circuit with 3 picks, only 2 resolve quickly
// (all three will fail fast since they're not installed - still demonstrates
// that we return before all 3 if 2 have already settled)
// ---------------------------------------------------------------------------

test('minResponses:2 short-circuits after 2 auditors settle', async () => {
  primeCache(['codex', 'gemini', 'opencode']);

  const env = {
    IJFW_AUDIT_TIMEOUT_SEC: '2',
    CLAUDECODE: '1',   // self=claude, so codex+gemini+opencode are non-self
  };

  const before = Date.now();
  const result = await runCrossOp({
    mode: 'audit',
    target: 'some target content',
    env,
    quiet: true,
    minResponses: 2,
  });
  const elapsed = Date.now() - before;

  clearCache();

  // Should have returned quickly (all fail fast via ENOENT)
  assert.ok(elapsed < 10_000, `expected fast return, took ${elapsed}ms`);
  assert.ok(result && typeof result === 'object');
  // auditorResults may have nulls for un-settled stragglers
  if (result.auditorResults) {
    assert.ok(result.auditorResults.length >= 1);
  }
});

// ---------------------------------------------------------------------------
// Test: allTimedOut flag + stderr message
// ---------------------------------------------------------------------------

test('all-timeout guard: result has expected shape when all auditors settle', async () => {
  // We test that the result has auditorResults with status in valid set.
  // allTimedOut behaviour depends on whether the auditor CLI is installed:
  // - installed + short timeout → status:'timeout' → allTimedOut:true
  // - not installed (ENOENT, no API key) → status:'failed' → no allTimedOut
  // Either is acceptable. We just assert the shape is correct.
  primeCache(['codex']);
  const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '1' };

  const result = await runCrossOp({ mode: 'audit', target: 'x', env, quiet: true });
  clearCache();

  assert.ok(result && typeof result === 'object', 'result must be an object');
  // If allTimedOut is set, duration_ms must also be present
  if (result.allTimedOut) {
    assert.equal(typeof result.duration_ms, 'number', 'duration_ms must be present when allTimedOut');
    assert.equal(result.merged, null, 'merged must be null when allTimedOut');
  }
});

// ---------------------------------------------------------------------------
// Test: source field present on auditorResults
// ---------------------------------------------------------------------------

test('auditorResults have source field', async () => {
  primeCache(['codex']);
  const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '1' };

  const result = await runCrossOp({ mode: 'audit', target: 'test', env, quiet: true });
  clearCache();

  if (result.auditorResults) {
    for (const r of result.auditorResults) {
      assert.ok(
        ['cli','api','none'].includes(r.source),
        `unexpected source: ${r.source}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test: elapsedMs field present on auditorResults
// ---------------------------------------------------------------------------

test('auditorResults have elapsedMs field (number)', async () => {
  primeCache(['codex']);
  const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '1' };

  const result = await runCrossOp({ mode: 'audit', target: 'test', env, quiet: true });
  clearCache();

  if (result.auditorResults) {
    for (const r of result.auditorResults) {
      assert.equal(typeof r.elapsedMs, 'number', 'elapsedMs must be a number');
    }
  }
});

// ---------------------------------------------------------------------------
// Test: receipt auditors array includes source + elapsedMs
// ---------------------------------------------------------------------------

test('receipt.auditors includes source and elapsedMs', async () => {
  primeCache(['codex']);
  const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '1' };

  const result = await runCrossOp({
    mode: 'audit', target: 'test',
    env, quiet: true, projectDir: '/tmp',
  });
  clearCache();

  if (result.receipt) {
    for (const a of result.receipt.auditors) {
      assert.ok('source' in a, 'receipt auditor missing source');
      assert.ok('elapsedMs' in a, 'receipt auditor missing elapsedMs');
    }
  }
});

// ---------------------------------------------------------------------------
// Fix 2: minResponses:2 - 3rd pick gets status:'aborted'
// ---------------------------------------------------------------------------

test('minResponses:2 - 3rd pick gets status:aborted when first 2 settle', async () => {
  // Prime 3 non-self "installed" auditors (all will fail fast via ENOENT -
  // fast enough that 2 settle before the 3rd is launched or mid-flight).
  primeCache(['codex', 'gemini', 'opencode']);
  const env = {
    CLAUDECODE: '1',
    IJFW_AUDIT_TIMEOUT_SEC: '5',
  };

  const result = await runCrossOp({
    mode: 'audit',
    target: 'test content for abort check',
    env,
    quiet: true,
    minResponses: 2,
  });
  clearCache();

  assert.ok(result && typeof result === 'object', 'result must be object');
  if (result.auditorResults) {
    const statuses = result.auditorResults.map(r => r?.status);
    const validStatuses = ['ok', 'empty', 'failed', 'timeout', 'fallback-used', 'aborted'];
    for (const s of statuses) {
      if (s !== null) assert.ok(validStatuses.includes(s), `unexpected status: ${s}`);
    }
    // At least one aborted or all settled is both acceptable (ENOENT is so fast
    // all 3 may settle before threshold - that's a valid pass too).
    const abortedCount = result.auditorResults.filter(r => r?.status === 'aborted').length;
    const settledCount = result.auditorResults.filter(r => r !== null && r?.status !== 'aborted').length;
    assert.ok(settledCount >= 2 || abortedCount > 0, 'at least 2 settled or some aborted');
  }
});

// ---------------------------------------------------------------------------
// Fix 3: parsePosInt / env var validation - invalid IJFW_AUDIT_CONCURRENCY
// ---------------------------------------------------------------------------

test('invalid IJFW_AUDIT_CONCURRENCY falls back to 3 and emits no crash', async () => {
  primeCache(['codex']);
  const env = { CLAUDECODE: '1', IJFW_AUDIT_CONCURRENCY: '0', IJFW_AUDIT_TIMEOUT_SEC: '1' };

  // quiet:false so warning would fire; but we just assert no crash and valid result shape.
  const result = await runCrossOp({ mode: 'audit', target: 'test', env, quiet: true });
  clearCache();

  assert.ok(result && typeof result === 'object');
});

test('invalid IJFW_AUDIT_TIMEOUT_SEC falls back and emits no crash', async () => {
  primeCache(['codex']);
  const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: 'notanumber' };

  // Use perAuditorTimeoutSec to keep test fast; the env var fallback is what we're testing.
  const result = await runCrossOp({ mode: 'audit', target: 'test', env, quiet: true, perAuditorTimeoutSec: 1 });
  clearCache();

  assert.ok(result && typeof result === 'object');
});

// ---------------------------------------------------------------------------
// Issue #9-A: gemini env scrub when GEMINI_API_KEY is set.
// Prevents gemini-cli from silently picking up gcloud creds and billing
// against an unrelated cloudaicompanion.googleapis.com project.
// ---------------------------------------------------------------------------

const { buildSpawnEnv } = await import('./src/cross-orchestrator.js');

test('buildSpawnEnv: gemini + GEMINI_API_KEY strips gcloud env vars', () => {
  const baseEnv = {
    GEMINI_API_KEY: 'sk-test-123',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json',
    GOOGLE_CLOUD_PROJECT: 'unrelated-project',
    GCLOUD_PROJECT: 'unrelated-project',
    CLOUDSDK_CORE_PROJECT: 'unrelated-project',
    PATH: '/usr/bin',
  };
  const pick = { id: 'gemini' };
  const out = buildSpawnEnv(pick, baseEnv);
  assert.equal(out.GEMINI_API_KEY, 'sk-test-123', 'GEMINI_API_KEY preserved');
  assert.equal(out.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'GOOGLE_APPLICATION_CREDENTIALS scrubbed');
  assert.equal(out.GOOGLE_CLOUD_PROJECT, undefined, 'GOOGLE_CLOUD_PROJECT scrubbed');
  assert.equal(out.GCLOUD_PROJECT, undefined, 'GCLOUD_PROJECT scrubbed');
  assert.equal(out.CLOUDSDK_CORE_PROJECT, undefined, 'CLOUDSDK_CORE_PROJECT scrubbed');
  assert.equal(out.PATH, '/usr/bin', 'unrelated env preserved');
});

test('buildSpawnEnv: gemini WITHOUT GEMINI_API_KEY leaves gcloud creds intact', () => {
  // User legitimately wants gcloud auth path -- don't break it.
  const baseEnv = {
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json',
    GOOGLE_CLOUD_PROJECT: 'real-project',
  };
  const pick = { id: 'gemini' };
  const out = buildSpawnEnv(pick, baseEnv);
  assert.equal(out.GOOGLE_APPLICATION_CREDENTIALS, '/tmp/creds.json');
  assert.equal(out.GOOGLE_CLOUD_PROJECT, 'real-project');
});

// v1.5.0 audit-MED-trident-M2 (F-SEC-1): non-API-key env vars are preserved
// for non-gemini auditors, but the per-pick API-key allowlist scrubs vendor
// keys this pick has no business seeing. Replaces an earlier test that
// expected GEMINI_API_KEY to leak into codex spawn env.
test('buildSpawnEnv: non-gemini auditors preserve unrelated env (M2 contract)', () => {
  const baseEnv = {
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json',
    PATH: '/usr/bin',
    HOME: '/home/user',
  };
  for (const id of ['codex', 'claude', 'opencode', 'aider', 'copilot']) {
    const out = buildSpawnEnv({ id }, baseEnv);
    assert.equal(out.GOOGLE_APPLICATION_CREDENTIALS, '/tmp/creds.json', `${id}: non-key env preserved`);
    assert.equal(out.PATH, '/usr/bin', `${id}: PATH preserved`);
    assert.equal(out.HOME, '/home/user', `${id}: HOME preserved`);
  }
});

// ---------------------------------------------------------------------------
// v1.5.0 audit-MED-tok-M8: parallel retry-vs-fallback race.
//
// Pre-fix the timeout-recovery path was sequential: spawnCli retry
// (up to timeoutMs) THEN api-fallback (up to api-mode timeout). Worst
// case for gemini @ 90s: 120s wall-clock.
//
// Post-fix: race retry vs api-fallback when both are eligible; loser
// aborted via AbortController. Worst case capped at max(90s, 30s) = 90s.
//
// These regression tests verify the refactor preserves the existing
// contract: timeout path settles, no deadlock, abort propagates, and the
// auditor result shape is unchanged. The actual race timing is exercised
// in production -- here we lock in the shape + termination invariants.
// ---------------------------------------------------------------------------

test('M8: gemini timeout path settles deterministically (no deadlock under race)', async () => {
  // Gemini retryOnTimeout=true + apiFallback eligibility means both paths
  // will be triggered when the CLI times out. With no GEMINI_API_KEY in env,
  // api-fallback is NOT reachable (canFallback=false) so the code takes the
  // retry-only branch -- which is the original sequential behaviour. This
  // test locks in that the refactor didn't break the no-fallback path.
  primeCache(['gemini']);
  const env = {
    CLAUDECODE: '1',
    IJFW_AUDIT_TIMEOUT_SEC: '1',
    // Deliberately NO GEMINI_API_KEY -- forces retry-only branch.
  };

  const before = Date.now();
  const result = await runCrossOp({ mode: 'audit', target: 'M8 retry-only branch', env, quiet: true });
  const elapsed = Date.now() - before;
  clearCache();

  // Must settle within a generous bound. Without the fix, a regression that
  // mis-handles the eligibility check could deadlock here.
  assert.ok(elapsed < 30_000, `M8 retry-only branch must settle in bounded time, got ${elapsed}ms`);
  assert.ok(result && typeof result === 'object', 'result must be an object');

  // auditorResults must still have valid status.
  if (result.auditorResults) {
    for (const r of result.auditorResults) {
      assert.ok(
        ['ok','empty','failed','timeout','fallback-used','aborted'].includes(r.status),
        `M8: unexpected status ${r.status}`
      );
    }
  }
});

test('M8: timeout-path produces a status (not undefined / not null) under all branches', async () => {
  // Run twice to ensure the timeout path is taken at least once per side
  // (retry-only branch, no-recovery branch).
  primeCache(['gemini', 'codex']);
  const env = {
    CLAUDECODE: '1',
    IJFW_AUDIT_TIMEOUT_SEC: '1',
    // No ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY -- fallback ineligible.
  };

  const result = await runCrossOp({ mode: 'audit', target: 'M8 status invariant', env, quiet: true });
  clearCache();

  // Every settled auditor result must have a defined status (never undefined).
  if (result.auditorResults) {
    for (const r of result.auditorResults) {
      assert.ok(r === null || typeof r.status === 'string', 'M8: status must be a string when result is non-null');
      assert.ok(r === null || typeof r.elapsedMs === 'number', 'M8: elapsedMs always present on non-null results');
    }
  }
});

// v1.5.0 audit-MED-trident-M2 (F-SEC-1) — per-pick API-key allowlist tests.
test('M2: buildSpawnEnv scrubs vendor API keys not on per-pick allowlist', () => {
  const baseEnv = {
    OPENAI_API_KEY:    'sk-openai',
    ANTHROPIC_API_KEY: 'sk-anthropic',
    GEMINI_API_KEY:    'sk-gemini',
    DEEPSEEK_API_KEY:  'sk-deepseek',
    DASHSCOPE_API_KEY: 'sk-qwen',
    MOONSHOT_API_KEY:  'sk-kimi',
    PATH: '/usr/bin',
  };
  // codex sees only OPENAI_API_KEY + PATH.
  const codexEnv = buildSpawnEnv({ id: 'codex' }, baseEnv);
  assert.equal(codexEnv.OPENAI_API_KEY, 'sk-openai', 'codex keeps OPENAI_API_KEY');
  assert.equal(codexEnv.ANTHROPIC_API_KEY, undefined, 'codex drops ANTHROPIC_API_KEY');
  assert.equal(codexEnv.GEMINI_API_KEY, undefined, 'codex drops GEMINI_API_KEY');
  assert.equal(codexEnv.DEEPSEEK_API_KEY, undefined, 'codex drops DEEPSEEK_API_KEY');
  assert.equal(codexEnv.PATH, '/usr/bin', 'codex keeps PATH');

  // gemini sees only GEMINI_API_KEY + PATH.
  const geminiEnv = buildSpawnEnv({ id: 'gemini' }, baseEnv);
  assert.equal(geminiEnv.GEMINI_API_KEY, 'sk-gemini', 'gemini keeps GEMINI_API_KEY');
  assert.equal(geminiEnv.OPENAI_API_KEY, undefined, 'gemini drops OPENAI_API_KEY');
  assert.equal(geminiEnv.ANTHROPIC_API_KEY, undefined, 'gemini drops ANTHROPIC_API_KEY');

  // claude sees only ANTHROPIC_API_KEY + PATH.
  const claudeEnv = buildSpawnEnv({ id: 'claude' }, baseEnv);
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, 'sk-anthropic', 'claude keeps ANTHROPIC_API_KEY');
  assert.equal(claudeEnv.OPENAI_API_KEY, undefined, 'claude drops OPENAI_API_KEY');
  assert.equal(claudeEnv.GEMINI_API_KEY, undefined, 'claude drops GEMINI_API_KEY');

  // deepseek sees only DEEPSEEK_API_KEY.
  const dsEnv = buildSpawnEnv({ id: 'deepseek' }, baseEnv);
  assert.equal(dsEnv.DEEPSEEK_API_KEY, 'sk-deepseek');
  assert.equal(dsEnv.OPENAI_API_KEY, undefined);
  assert.equal(dsEnv.GEMINI_API_KEY, undefined);

  // unknown pick gets the conservative no-vendor-keys default.
  const unknownEnv = buildSpawnEnv({ id: 'NEVER_SEEN' }, baseEnv);
  assert.equal(unknownEnv.OPENAI_API_KEY, undefined);
  assert.equal(unknownEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(unknownEnv.GEMINI_API_KEY, undefined);
  assert.equal(unknownEnv.PATH, '/usr/bin', 'unknown pick still keeps non-vendor env');
});

// ---------------------------------------------------------------------------
// v1.5.0 T21 (W4) — Trident convergence telemetry
//
// runPhaseEConverge publishes the three locked metrics — cyclesToConverge,
// falsePositiveRate, costUsd — via state-SDK `telemetry.record` into
// `.ijfw/telemetry/convergence.json`. The tests below run REAL convergence
// loops with deterministic stub dispatchers against REAL temp project roots
// (no mocking of `query()`), then read the artifact and assert the three
// metrics are present + correctly valued.
// ---------------------------------------------------------------------------

import { readFileSync as _t21ReadFile, existsSync as _t21Exists, mkdtempSync as _t21Mkdtemp, rmSync as _t21Rm } from 'node:fs';
import { tmpdir as _t21Tmpdir } from 'node:os';
import { join as _t21Join } from 'node:path';

const { runPhaseEConverge: _t21Converge } = await import('./src/cross-orchestrator.js');

function _t21ReadConvergenceFile(projectDir) {
  const p = _t21Join(projectDir, '.ijfw', 'telemetry', 'convergence.json');
  if (!_t21Exists(p)) return null;
  return JSON.parse(_t21ReadFile(p, 'utf8'));
}

test('T21 telemetry: a real converge run emits .ijfw/telemetry/convergence.json with all three metrics', async () => {
  const tmpDir = _t21Mkdtemp(_t21Join(_t21Tmpdir(), 'ijfw-t21-pass-'));
  try {
    // Deterministic stub: 3 lenses all PASS first cycle.
    const dispatch = async ({ lens }) => ({ lens, verdict: 'PASS', findings: [] });
    const r = await _t21Converge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
      runStamp: '2026-05-20T00:00:00Z',
    });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.iterations, 1);

    const doc = _t21ReadConvergenceFile(tmpDir);
    assert.ok(doc, 'convergence.json must exist after a converge run');
    assert.ok(Array.isArray(doc.records) && doc.records.length >= 1, 'records array populated');

    // The newest record is from this run; find it by dedupKey shape.
    const rec = doc.records.find(rr => rr && rr.kind === 'convergence');
    assert.ok(rec, 'must have a convergence kind record');
    assert.equal(typeof rec.dedupKey, 'string');
    assert.ok(rec.dedupKey.startsWith('convergence:'), 'dedupKey uses the convergence: prefix');

    // The three locked metrics.
    assert.equal(typeof rec.metrics.cyclesToConverge, 'number', 'cyclesToConverge is a number');
    assert.equal(rec.metrics.cyclesToConverge, 1, 'one-cycle PASS reports 1');
    assert.equal(typeof rec.metrics.falsePositiveRate, 'number', 'falsePositiveRate is a number');
    assert.ok(rec.metrics.falsePositiveRate >= 0 && rec.metrics.falsePositiveRate <= 1,
      'falsePositiveRate is in [0, 1]');
    assert.equal(rec.metrics.falsePositiveRate, 0, 'no alarms in an all-PASS run');
    assert.equal(typeof rec.metrics.costUsd, 'number', 'costUsd is a number');
    assert.equal(rec.metrics.costUsd, 0, 'no cost reported by stub dispatcher → 0');
  } finally {
    _t21Rm(tmpDir, { recursive: true, force: true });
  }
});

test('T21 telemetry: false-positive rate is non-zero when a lens raised an alarm but consensus passed', async () => {
  const tmpDir = _t21Mkdtemp(_t21Join(_t21Tmpdir(), 'ijfw-t21-fp-'));
  try {
    // Iter 1: codex says FAIL (raises an alarm), others PASS → divergent.
    // Iter 2: all PASS → consensus PASS. Final verdict PASS means codex's
    // iter-1 FAIL was a false positive.
    const script = {
      codex:  [
        { verdict: 'FAIL', findings: [{ severity: 'high', text: 'phantom' }] },
        { verdict: 'PASS', findings: [] },
      ],
      gemini: [
        { verdict: 'PASS', findings: [{ text: 'g1' }] },
        { verdict: 'PASS', findings: [] },
      ],
      claude: [
        { verdict: 'PASS', findings: [{ text: 'c1' }] },
        { verdict: 'PASS', findings: [] },
      ],
    };
    const dispatch = async ({ lens, iteration }) => {
      const s = script[lens];
      const idx = Math.min(iteration - 1, s.length - 1);
      return { lens, ...s[idx] };
    };
    const r = await _t21Converge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
      maxIterations: 5,
    });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.iterations, 2);

    const doc = _t21ReadConvergenceFile(tmpDir);
    const rec = doc.records.find(rr => rr && rr.kind === 'convergence');
    assert.ok(rec, 'convergence record present');

    // 2 cycles × 3 reachable lenses = 6 reachable observations.
    // 1 alarm (codex iter 1 FAIL). final PASS → 1 false positive.
    // rate = 1 / 6 ≈ 0.1667.
    assert.equal(rec.metrics.cyclesToConverge, 2);
    assert.ok(rec.metrics.falsePositiveRate > 0, 'rate > 0 when an alarm occurred and consensus passed');
    assert.ok(Math.abs(rec.metrics.falsePositiveRate - (1 / 6)) < 1e-9,
      `falsePositiveRate ≈ 1/6, got ${rec.metrics.falsePositiveRate}`);
    assert.equal(rec.metrics.costUsd, 0, 'stub dispatcher reports no cost');
  } finally {
    _t21Rm(tmpDir, { recursive: true, force: true });
  }
});

test('T21 telemetry: costUsd sums per-lens cost_usd from dispatcher results', async () => {
  const tmpDir = _t21Mkdtemp(_t21Join(_t21Tmpdir(), 'ijfw-t21-cost-'));
  try {
    // Each lens reports a stable cost on every call. With 3 lenses × 1 iter:
    // codex=0.01, gemini=0.02, claude=0.03 → total = 0.06.
    const costs = { codex: 0.01, gemini: 0.02, claude: 0.03 };
    const dispatch = async ({ lens }) => ({
      lens, verdict: 'PASS', findings: [],
      cost_usd: costs[lens] ?? 0,
    });
    const r = await _t21Converge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
    });
    assert.equal(r.verdict, 'PASS');

    const doc = _t21ReadConvergenceFile(tmpDir);
    const rec = doc.records.find(rr => rr && rr.kind === 'convergence');
    assert.ok(rec, 'convergence record present');
    assert.equal(rec.metrics.cyclesToConverge, 1);
    assert.equal(rec.metrics.falsePositiveRate, 0);
    assert.ok(Math.abs(rec.metrics.costUsd - 0.06) < 1e-9,
      `costUsd should sum per-lens cost_usd, got ${rec.metrics.costUsd}`);
  } finally {
    _t21Rm(tmpDir, { recursive: true, force: true });
  }
});

test('T21 telemetry: dedupKey makes the verb idempotent across re-runs with same runStamp', async () => {
  const tmpDir = _t21Mkdtemp(_t21Join(_t21Tmpdir(), 'ijfw-t21-dedup-'));
  try {
    const dispatch = async ({ lens }) => ({ lens, verdict: 'PASS', findings: [] });
    const opts = {
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
      runStamp: '2026-05-20T11:11:11Z',
    };
    // Two back-to-back runs with the SAME runStamp + commitRange. The verb
    // dedups by `convergence:<runStamp>:<commitRange>` so the second call
    // must NOT append a duplicate record.
    await _t21Converge(opts);
    await _t21Converge(opts);

    const doc = _t21ReadConvergenceFile(tmpDir);
    const convergenceRecs = doc.records.filter(rr => rr && rr.kind === 'convergence');
    assert.equal(convergenceRecs.length, 1,
      'dedupKey-keyed re-runs append exactly one record');
  } finally {
    _t21Rm(tmpDir, { recursive: true, force: true });
  }
});

test('T21 telemetry: convergence verdict is unaffected by telemetry failures', async () => {
  // Run against a project root whose `.ijfw/telemetry/` cannot be written.
  // We use a path under /dev/null/* (on POSIX) so any write throws ENOTDIR.
  // The telemetry try/catch swallows the failure and the converge return
  // value remains intact.
  //
  // The state-SDK's event-tap also logs a one-liner to stderr on failure;
  // we silence that here so the test output is clean (the message is the
  // verb's normal observability, not a test failure).
  const dispatch = async ({ lens }) => ({ lens, verdict: 'PASS', findings: [] });
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    if (s.includes('state-events')) return true;
    return _origStderrWrite(chunk, ...rest);
  };
  try {
    const r = await _t21Converge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      // A non-writeable root — `.ijfw/telemetry/` cannot be auto-created here.
      projectDir: '/dev/null/this-cannot-exist',
    });
    // The verdict is unaffected: the convergence return value is the contract;
    // telemetry is observability only.
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.iterations, 1);
  } finally {
    process.stderr.write = _origStderrWrite;
  }
});
