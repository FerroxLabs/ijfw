// H5.6 — semantic dedup tests.
//
// Coverage: exact match dedups, near-dup dedups at threshold, below-threshold
// passes, env override OFF respected, env override threshold respected, empty
// corpus passes through, tokenize + jaccard primitives behave.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  jaccard,
  findNearDuplicate,
  readDedupConfig,
} from './src/memory/dedup.js';

// Helper: capture-and-restore env so individual tests can scribble freely
// without leaking state to siblings (node:test is parallel-safe per file but
// not within a file by default; explicit save/restore is bullet-proof).
function withEnv(overrides, fn) {
  const keys = ['IJFW_DEDUP_OFF', 'IJFW_DEDUP_THRESHOLD', 'IJFW_DEDUP_WINDOW'];
  const prior = {};
  for (const k of keys) prior[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of keys) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test('tokenize: lowercases, splits on non-word, drops short tokens', () => {
  const s = tokenize('IJFW uses SQLite for the warm tier!');
  assert.ok(s.has('ijfw'));
  assert.ok(s.has('uses'));
  assert.ok(s.has('sqlite'));
  assert.ok(s.has('warm'));
  assert.ok(s.has('tier'));
  // "for", "the" are 3 chars → kept; but "a", "to" would be dropped.
  // Short-token floor MIN_TOKEN_LEN=3 — assert nothing under length 3 leaks in.
  for (const t of s) assert.ok(t.length >= 3, `token "${t}" too short`);
});

test('jaccard: identical sets return 1, disjoint return 0', () => {
  assert.equal(jaccard('alpha beta gamma', 'alpha beta gamma'), 1);
  assert.equal(jaccard('alpha beta gamma', 'delta epsilon zeta'), 0);
});

test('jaccard: partial overlap returns ratio', () => {
  // {alpha, beta, gamma} vs {alpha, beta, delta}: inter=2, uni=4 → 0.5
  const s = jaccard('alpha beta gamma', 'alpha beta delta');
  assert.ok(s > 0.4 && s < 0.6, `expected ~0.5, got ${s}`);
});

test('findNearDuplicate: exact match returns the existing memory', () => {
  withEnv({}, () => {
    const recents = [
      { id: 'm1', content: 'use Postgres for the warm tier storage' },
    ];
    const hit = findNearDuplicate('use Postgres for the warm tier storage', recents);
    assert.ok(hit, 'expected a dedup hit');
    assert.equal(hit.match.id, 'm1');
    assert.equal(hit.similarity, 1);
  });
});

test('findNearDuplicate: near-dup at default threshold (0.85) dedups', () => {
  withEnv({}, () => {
    const recents = [
      { id: 'm1', content: 'decided to use Postgres for warm tier storage backing' },
    ];
    // Same words, reshuffled, one swapped — high Jaccard.
    const hit = findNearDuplicate(
      'decided to use Postgres for warm tier storage backing today',
      recents
    );
    assert.ok(hit, 'expected near-dup hit');
    assert.equal(hit.match.id, 'm1');
    assert.ok(hit.similarity >= 0.85);
  });
});

test('findNearDuplicate: below-threshold passes through (returns null)', () => {
  withEnv({}, () => {
    const recents = [
      { id: 'm1', content: 'decided to use Postgres for warm tier' },
    ];
    // Totally unrelated content.
    const hit = findNearDuplicate(
      'frontend redesign with shadcn and tailwind components',
      recents
    );
    assert.equal(hit, null);
  });
});

test('findNearDuplicate: IJFW_DEDUP_OFF=1 disables (always returns null)', () => {
  withEnv({ IJFW_DEDUP_OFF: '1' }, () => {
    const recents = [
      { id: 'm1', content: 'use Postgres for warm tier storage' },
    ];
    const hit = findNearDuplicate('use Postgres for warm tier storage', recents);
    assert.equal(hit, null, 'OFF must short-circuit even exact match');
  });
});

test('findNearDuplicate: IJFW_DEDUP_THRESHOLD=0.99 makes near-dup pass through', () => {
  withEnv({ IJFW_DEDUP_THRESHOLD: '0.99' }, () => {
    const recents = [
      { id: 'm1', content: 'use Postgres for warm tier' },
    ];
    // ~0.83 Jaccard against m1 — below 0.99 threshold so it should NOT dedup.
    const hit = findNearDuplicate('use Postgres for warm tier database', recents);
    assert.equal(hit, null, 'higher threshold must let near-dup pass');
  });
});

test('findNearDuplicate: empty corpus returns null', () => {
  withEnv({}, () => {
    assert.equal(findNearDuplicate('anything at all', []), null);
    assert.equal(findNearDuplicate('anything at all', null), null);
    assert.equal(findNearDuplicate('anything at all', undefined), null);
  });
});

test('findNearDuplicate: empty content returns null (no signal)', () => {
  withEnv({}, () => {
    const recents = [{ id: 'm1', content: 'use Postgres for warm tier' }];
    assert.equal(findNearDuplicate('', recents), null);
    assert.equal(findNearDuplicate('   ', recents), null);
    assert.equal(findNearDuplicate(null, recents), null);
  });
});

test('readDedupConfig: env knobs honored and clamped', () => {
  withEnv({ IJFW_DEDUP_THRESHOLD: '0.5', IJFW_DEDUP_WINDOW: '10' }, () => {
    const cfg = readDedupConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.threshold, 0.5);
    assert.equal(cfg.windowSize, 10);
  });
  withEnv({ IJFW_DEDUP_THRESHOLD: '5', IJFW_DEDUP_WINDOW: '99999' }, () => {
    const cfg = readDedupConfig();
    assert.equal(cfg.threshold, 1, 'threshold clamps to 1');
    assert.equal(cfg.windowSize, 500, 'window clamps to 500');
  });
  withEnv({ IJFW_DEDUP_OFF: '1' }, () => {
    const cfg = readDedupConfig();
    assert.equal(cfg.enabled, false);
  });
});
