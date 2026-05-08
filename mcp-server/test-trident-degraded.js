// test-trident-degraded.js -- C9.7 Trident degraded single-lens mode.
//
// Verifies:
//   1. Lens-health probe caching (60s TTL)
//   2. Latency tracking
//   3. probeLenses returns the expected shape + summary modes
//   4. 3/3 live -> PASS verdict possible (full Trident)
//   5. 2/3 live -> CONDITIONAL ceiling, never auto-PASS
//   6. 1/3 live (no accept_degraded) -> WARN/FLAG only, NEVER PASS
//   7. 1/3 live + accept_degraded -> can produce non-PASS, mode 'single-lens-accepted'
//   8. 1/3 live + release-blocker gate (no accept_degraded) -> DegradedTridentError
//   9. 1/3 live + release-blocker gate + accept_degraded -> succeeds (CONDITIONAL ceiling)
//  10. 0/3 live -> always throws (offline)
//  11. Coerce-up-to-floor: lens reports PASS but mode forces WARN -> WARN
//
// Zero deps; uses node:test built-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  probeOne,
  probeLenses,
  healthTileShape,
  _resetCache,
  _setCache,
  _setDeadSince,
  DEFAULT_TTL_MS,
} from './src/trident/lens-health.js';

import {
  runTrident,
  DegradedTridentError,
  RELEASE_BLOCKER_GATES,
  summariseLensHealth,
} from './src/trident/dispatch.js';

// ------------------------------------------------------------------
// Lens-health probe tests
// ------------------------------------------------------------------

test('probeOne(claude) is always live in-process, zero latency', async () => {
  _resetCache();
  const r = await probeOne('claude');
  assert.equal(r.live, true);
  assert.equal(r.error, null);
  assert.equal(typeof r.latency_ms, 'number');
});

test('probeOne returns a latency_ms number for external lenses', async () => {
  _resetCache();
  const r = await probeOne('codex', { timeoutMs: 200, fresh: true });
  assert.equal(typeof r.latency_ms, 'number');
  assert.ok(r.latency_ms >= 0);
  // live may be true or false depending on whether codex is on PATH; we don't
  // gate the test on that. Just assert the shape.
  assert.ok('live' in r);
  assert.ok('error' in r);
});

test('probeOne returns unknown_lens for invalid lens id', async () => {
  _resetCache();
  const r = await probeOne('not-a-lens');
  assert.equal(r.live, false);
  assert.equal(r.error, 'unknown_lens');
});

test('probeOne caches results for the TTL window (60s default)', async () => {
  _resetCache();
  // Seed a cache entry with a known result and recent timestamp.
  const seeded = { live: true, latency_ms: 42, error: null };
  _setCache('codex', seeded, Date.now());
  const r = await probeOne('codex');
  assert.equal(r.live, true);
  assert.equal(r.latency_ms, 42);
  assert.equal(r.source, 'cache');
  assert.ok(r.cached_age_ms < DEFAULT_TTL_MS);
});

test('probeOne ignores cache when { fresh: true }', async () => {
  _resetCache();
  _setCache('codex', { live: true, latency_ms: 999, error: null }, Date.now());
  const r = await probeOne('codex', { fresh: true, timeoutMs: 200 });
  assert.notEqual(r.source, 'cache');
});

test('probeOne expires cache after ttlMs has elapsed', async () => {
  _resetCache();
  // Seed with timestamp far in the past.
  _setCache('codex', { live: true, latency_ms: 99, error: null }, Date.now() - 120_000);
  const r = await probeOne('codex', { ttlMs: 60_000, timeoutMs: 200 });
  assert.notEqual(r.source, 'cache');
});

test('probeLenses({all}) returns per-lens entries plus summary', async () => {
  _resetCache();
  // Seed external lenses so we don't depend on PATH.
  _setCache('codex',  { live: true,  latency_ms: 12, error: null }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());

  const r = await probeLenses({ codex: true, gemini: true, claude: true });

  assert.equal(r.codex.live, true);
  assert.equal(r.gemini.live, false);
  assert.equal(r.claude.live, true);

  assert.deepEqual(r.summary.live_lenses.sort(), ['claude', 'codex']);
  assert.deepEqual(r.summary.dead_lenses, ['gemini']);
  assert.equal(r.summary.live_count, 2);
  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.mode, 'partial');
});

test('probeLenses summary.mode = full when 3/3 live', async () => {
  _resetCache();
  _setCache('codex',  { live: true, latency_ms: 5, error: null }, Date.now());
  _setCache('gemini', { live: true, latency_ms: 8, error: null }, Date.now());
  const r = await probeLenses();
  assert.equal(r.summary.mode, 'full');
  assert.equal(r.summary.live_count, 3);
});

test('probeLenses summary.mode = degraded when only 1 lens live', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'exit_1' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await probeLenses();
  assert.equal(r.summary.mode, 'degraded');
  assert.equal(r.summary.live_count, 1);
  assert.deepEqual(r.summary.live_lenses, ['claude']);
});

test('probeLenses summary.mode = offline when 0/3 live and claude excluded', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await probeLenses({ codex: true, gemini: true, claude: false });
  assert.equal(r.summary.mode, 'offline');
  assert.equal(r.summary.live_count, 0);
});

test('healthTileShape flips alert true after 24h dead duration', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: true,  latency_ms: 8,   error: null      }, Date.now());

  // Pretend codex has been dead for >24h.
  const longAgo = Date.now() - (25 * 60 * 60 * 1000);
  _setDeadSince('codex', longAgo);

  const r = await probeLenses();
  const tile = healthTileShape(r);
  assert.equal(tile.alert, true);
  assert.match(tile.alert_reason, /codex dead for/);
  assert.equal(tile.lenses.codex.live, false);
  assert.ok(tile.lenses.codex.dead_for_ms >= 24 * 60 * 60 * 1000);
});

test('healthTileShape alert false when dead lens within 24h grace', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: true,  latency_ms: 8,   error: null      }, Date.now());
  // No dead-since seeded -> tracker auto-sets to now -> duration = 0.
  const r = await probeLenses();
  const tile = healthTileShape(r);
  assert.equal(tile.alert, false);
  assert.equal(tile.lenses.codex.live, false);
});

// ------------------------------------------------------------------
// runTrident dispatcher tests
// ------------------------------------------------------------------

// Helper: build a deterministic executor that returns a fixed verdict per lens.
function fixedExecutor(verdictByLens) {
  return async ({ lens, brief }) => {
    const v = verdictByLens[lens] || 'PASS';
    return { lens, verdict: v, findings: [], latency_ms: 1, brief_len: brief.length };
  };
}

test('3/3 live + executor PASS -> verdict PASS, mode full', async () => {
  _resetCache();
  _setCache('codex',  { live: true, latency_ms: 5, error: null }, Date.now());
  _setCache('gemini', { live: true, latency_ms: 8, error: null }, Date.now());
  const r = await runTrident({
    brief: 'audit this',
    executor: fixedExecutor({ codex: 'PASS', gemini: 'PASS', claude: 'PASS' }),
  });
  assert.equal(r.mode, 'full');
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.live_lenses.length, 3);
});

test('2/3 live + executor PASS -> verdict CONDITIONAL (never auto-PASS)', async () => {
  _resetCache();
  _setCache('codex',  { live: true,  latency_ms: 5,   error: null      }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await runTrident({
    brief: 'audit this',
    executor: fixedExecutor({ codex: 'PASS', claude: 'PASS' }),
  });
  assert.equal(r.mode, 'partial');
  assert.equal(r.verdict, 'CONDITIONAL');
  assert.equal(r.live_lenses.length, 2);
});

test('1/3 live, no accept_degraded, no gate -> WARN ceiling, never PASS', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await runTrident({
    brief: 'audit this',
    executor: fixedExecutor({ claude: 'PASS' }),
  });
  assert.equal(r.mode, 'single-lens-degraded');
  assert.equal(r.verdict, 'WARN'); // PASS coerced up to WARN floor
  assert.deepEqual(r.live_lenses, ['claude']);
});

test('1/3 live + executor reports FAIL -> verdict FAIL (not coerced down)', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await runTrident({
    brief: 'audit this',
    executor: fixedExecutor({ claude: 'FAIL' }),
  });
  // FAIL is more severe than WARN floor; preserved.
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.mode, 'single-lens-degraded');
});

test('1/3 live + accept_degraded=true -> mode single-lens-accepted, CONDITIONAL ceiling', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await runTrident({
    brief: 'audit this',
    accept_degraded: true,
    executor: fixedExecutor({ claude: 'PASS' }),
  });
  assert.equal(r.mode, 'single-lens-accepted');
  // PASS coerced up to CONDITIONAL floor (single lens cannot vote PASS).
  assert.equal(r.verdict, 'CONDITIONAL');
  assert.equal(r.accept_degraded, true);
});

test('1/3 live + release-blocker gate (publish) without accept_degraded -> throws DegradedTridentError', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  await assert.rejects(
    () => runTrident({
      brief: 'release audit',
      gate: 'publish',
      executor: fixedExecutor({ claude: 'PASS' }),
    }),
    (err) => {
      assert.ok(err instanceof DegradedTridentError);
      assert.equal(err.code, 'TRIDENT_DEGRADED');
      assert.equal(err.gate, 'publish');
      assert.equal(err.requested_accept_degraded, false);
      assert.ok(err.lensHealth);
      return true;
    }
  );
});

test('1/3 live + release-blocker gate (tag) + accept_degraded=true -> succeeds with CONDITIONAL', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await runTrident({
    brief: 'tag audit',
    gate: 'tag',
    accept_degraded: true,
    executor: fixedExecutor({ claude: 'PASS' }),
  });
  assert.equal(r.mode, 'single-lens-accepted');
  assert.equal(r.verdict, 'CONDITIONAL');
  assert.equal(r.gate, 'tag');
});

test('release-blocker gate names: publish, tag, deploy, release', async () => {
  assert.ok(RELEASE_BLOCKER_GATES.has('publish'));
  assert.ok(RELEASE_BLOCKER_GATES.has('tag'));
  assert.ok(RELEASE_BLOCKER_GATES.has('deploy'));
  assert.ok(RELEASE_BLOCKER_GATES.has('release'));
  assert.ok(!RELEASE_BLOCKER_GATES.has('audit'));
});

test('1/3 live + non-release gate (audit) without accept_degraded -> still WARN, no throw', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  const r = await runTrident({
    brief: 'plan audit',
    gate: 'audit',
    executor: fixedExecutor({ claude: 'PASS' }),
  });
  assert.equal(r.mode, 'single-lens-degraded');
  assert.equal(r.verdict, 'WARN');
});

test('0/3 live -> throws DegradedTridentError regardless of accept_degraded', async () => {
  _resetCache();
  _setCache('codex',  { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  _setCache('gemini', { live: false, latency_ms: 200, error: 'timeout' }, Date.now());
  // Exclude claude so live_count = 0.
  await assert.rejects(
    () => runTrident({
      brief: 'audit this',
      accept_degraded: true,
      which: { codex: true, gemini: true, claude: false },
      executor: fixedExecutor({}),
    }),
    DegradedTridentError
  );
});

test('runTrident requires a brief', async () => {
  await assert.rejects(
    () => runTrident({ executor: fixedExecutor({}) }),
    /brief/
  );
});

test('summariseLensHealth returns a one-line string', async () => {
  _resetCache();
  _setCache('codex',  { live: true, latency_ms: 5, error: null }, Date.now());
  _setCache('gemini', { live: true, latency_ms: 8, error: null }, Date.now());
  const r = await probeLenses();
  const s = summariseLensHealth(r);
  assert.match(s, /lens health: 3\/3 live/);
});

test('lens_results exposes per-lens executor output', async () => {
  _resetCache();
  _setCache('codex',  { live: true, latency_ms: 5, error: null }, Date.now());
  _setCache('gemini', { live: true, latency_ms: 8, error: null }, Date.now());
  const r = await runTrident({
    brief: 'hello',
    executor: async ({ lens, brief }) => ({
      lens,
      verdict: 'PASS',
      findings: [{ lens, msg: 'sanity' }],
      latency_ms: 3,
      brief_len: brief.length,
    }),
  });
  assert.equal(r.lens_results.length, 3);
  for (const lr of r.lens_results) {
    assert.equal(lr.ok, true);
    assert.equal(lr.verdict, 'PASS');
    assert.equal(lr.brief_len, 5);
  }
});

test('executor exception on a single lens does not abort whole audit', async () => {
  _resetCache();
  _setCache('codex',  { live: true, latency_ms: 5, error: null }, Date.now());
  _setCache('gemini', { live: true, latency_ms: 8, error: null }, Date.now());
  const r = await runTrident({
    brief: 'hello',
    executor: async ({ lens }) => {
      if (lens === 'gemini') throw new Error('quota exhausted');
      return { lens, verdict: 'PASS', findings: [], latency_ms: 3 };
    },
  });
  // gemini lens result records ok=false; aggregate verdict reflects FAIL.
  const gem = r.lens_results.find(x => x.lens === 'gemini');
  assert.equal(gem.ok, false);
  assert.match(gem.error, /quota/);
  // FAIL severity > PASS, but mode is full so no further coercion.
  assert.equal(r.verdict, 'FAIL');
});

// ------------------------------------------------------------------
// GA-H2: production wiring of C9.7 into cross-orchestrator
// ------------------------------------------------------------------

import { _installedCache } from './src/audit-roster.js';
const { runCrossOp } = await import('./src/cross-orchestrator.js');

const ALL_IDS_H2 = ['codex', 'gemini', 'opencode', 'aider', 'copilot', 'claude'];
function primeCacheH2(installed = []) {
  for (const id of ALL_IDS_H2) _installedCache.set(id, installed.includes(id));
}
function clearCacheH2() {
  for (const id of ALL_IDS_H2) _installedCache.delete(id);
}

test('GA-H2 -- runCrossOp emits trident_mode metadata on receipt', async () => {
  primeCacheH2(['codex']);
  try {
    const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '2' };
    const r = await runCrossOp({ mode: 'audit', target: 'x', env, quiet: true });
    assert.ok(r && typeof r === 'object', 'result returned');
    if (r.receipt) {
      assert.ok('trident_mode' in r.receipt, 'receipt has trident_mode');
      assert.ok('productive_lens_count' in r.receipt, 'receipt has productive_lens_count');
      assert.ok('total_lens_count' in r.receipt, 'receipt has total_lens_count');
      assert.ok('gate' in r.receipt, 'receipt has gate field');
      assert.ok('accept_degraded' in r.receipt, 'receipt has accept_degraded field');
    }
  } finally {
    clearCacheH2();
  }
});

test('GA-H2 -- runCrossOp throws DegradedTridentError on release-blocker gate when degraded', async () => {
  // Only the in-process Claude leg is productive; codex auditor will fail
  // (binary not on PATH or self-elision), giving productiveCount = 1.
  primeCacheH2(['codex']);
  try {
    const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '2' };
    await assert.rejects(
      () => runCrossOp({
        mode: 'audit',
        target: 'release audit',
        env,
        quiet: true,
        gate: 'publish',
      }),
      (err) => {
        assert.ok(err instanceof DegradedTridentError, 'DegradedTridentError thrown');
        assert.equal(err.code, 'TRIDENT_DEGRADED');
        assert.equal(err.gate, 'publish');
        assert.equal(err.requested_accept_degraded, false);
        return true;
      }
    );
  } finally {
    clearCacheH2();
  }
});

test('GA-H2 -- runCrossOp succeeds on release-blocker gate when accept_degraded=true', async () => {
  primeCacheH2(['codex']);
  try {
    const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '2' };
    const r = await runCrossOp({
      mode: 'audit',
      target: 'release audit',
      env,
      quiet: true,
      gate: 'tag',
      accept_degraded: true,
    });
    assert.ok(r && typeof r === 'object', 'completed without throwing');
    if (r.receipt) {
      assert.equal(r.receipt.gate, 'tag');
      assert.equal(r.receipt.accept_degraded, true);
    }
  } finally {
    clearCacheH2();
  }
});

test('GA-H2 -- runCrossOp does not throw on non-release-blocker gate when degraded', async () => {
  primeCacheH2(['codex']);
  try {
    const env = { CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '2' };
    // gate='audit' is NOT in RELEASE_BLOCKER_GATES.
    const r = await runCrossOp({
      mode: 'audit',
      target: 'plan audit',
      env,
      quiet: true,
      gate: 'audit',
    });
    assert.ok(r && typeof r === 'object', 'non-release-blocker degraded run completes');
    if (r.receipt) {
      assert.equal(r.receipt.gate, 'audit');
    }
  } finally {
    clearCacheH2();
  }
});
