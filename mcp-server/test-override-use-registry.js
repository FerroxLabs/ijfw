/**
 * test-override-use-registry.js
 *
 * IJFW v1.4.0 Wave 4 / t20 — Test suite for the cross-project override-use
 * registry (src/override-use-registry.js).
 *
 * Coverage:
 *   1. recordOverrideUse + readback round-trip
 *   2. removeOverrideUse keeps the project entry alive (analytics)
 *   3. findProjectsWithOverride enumerates every project with preset X
 *   4. findProjectsWithSimilarOverrideSet — intersection above threshold
 *   5. findProjectsWithSimilarOverrideSet — below threshold filters out
 *   6. getPromoteSuggestion fires at >= minMatches
 *   7. getPromoteSuggestion returns null below threshold
 *   8. getPromoteSuggestion returns null on empty currentOverrides
 *   9. recordOverrideUse idempotent on (project, preset) repeat
 *
 * Isolation: each test installs a fresh tmp HOME via process.env.HOME swap,
 * so the registry file at $HOME/.ijfw/state/override-use.json starts empty.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  recordOverrideUse,
  removeOverrideUse,
  findProjectsWithOverride,
  findProjectsWithSimilarOverrideSet,
  getPromoteSuggestion,
} from './src/override-use-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withFreshHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-reg-home-'));
  // Windows: os.homedir() reads USERPROFILE, not HOME. Swap both for true isolation.
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
  }
}

async function readRegistryFile(home) {
  const p = path.join(home, '.ijfw', 'state', 'override-use.json');
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('recordOverrideUse writes structured registry entry readable from disk', async () => {
  await withFreshHome(async (home) => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    const state = await readRegistryFile(home);
    assert.equal(state.schema_version, '1.0');
    assert.ok(state.projects['/a'], 'project entry exists');
    assert.equal(state.projects['/a'].project_type, 'book');
    assert.equal(state.projects['/a'].active_overrides.length, 1);
    const entry = state.projects['/a'].active_overrides[0];
    assert.equal(entry.preset, 'book');
    assert.equal(entry.scope, 'project');
    assert.match(entry.applied_at, /^\d{4}-\d{2}-\d{2}T/, 'ISO-8601 applied_at');
  });
});

test('removeOverrideUse preserves project entry for analytics', async () => {
  await withFreshHome(async (home) => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    await removeOverrideUse('/a', 'book');
    const state = await readRegistryFile(home);
    // Per t14 jsdoc / spec: project entry persists with empty active_overrides
    // array so project_type and other analytic fields stick around.
    assert.ok(state.projects['/a'], 'project entry NOT deleted');
    assert.deepEqual(state.projects['/a'].active_overrides, []);
    assert.equal(state.projects['/a'].project_type, 'book');
  });
});

test('findProjectsWithOverride enumerates every matching project', async () => {
  await withFreshHome(async () => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    await recordOverrideUse('/b', 'book', 'project', 'book');
    await recordOverrideUse('/c', 'book', 'project', 'book');
    await recordOverrideUse('/d', 'campaign', 'project', 'business');

    const hits = await findProjectsWithOverride('book');
    assert.equal(hits.length, 3);
    const projects = hits.map((h) => h.project).sort();
    assert.deepEqual(projects, ['/a', '/b', '/c']);
    for (const h of hits) {
      assert.equal(h.project_type, 'book');
      assert.match(h.applied_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

test('findProjectsWithSimilarOverrideSet returns matches at/above threshold', async () => {
  await withFreshHome(async () => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    await recordOverrideUse('/b', 'book', 'project', 'book');
    await recordOverrideUse('/b', 'academic', 'project', 'book');
    await recordOverrideUse('/c', 'book', 'project', 'book');
    await recordOverrideUse('/c', 'academic', 'project', 'book');

    // Query with [book, academic] excluding /a, threshold 0.5.
    // /b and /c each match [book, academic] -> Jaccard = 1.0.
    // /a has only [book] -> Jaccard 1/2 = 0.5 (but excluded).
    const matches = await findProjectsWithSimilarOverrideSet(
      ['book', 'academic'],
      0.5,
      { excludeProject: '/a' },
    );
    const projects = matches.map((m) => m.project).sort();
    assert.deepEqual(projects, ['/b', '/c']);
    for (const m of matches) {
      assert.equal(m.similarity, 1, 'full-set match Jaccard = 1.0');
      assert.equal(m.project_type, 'book');
      assert.deepEqual(m.overrides.sort(), ['academic', 'book']);
    }
  });
});

test('findProjectsWithSimilarOverrideSet filters below threshold', async () => {
  await withFreshHome(async () => {
    await recordOverrideUse('/d', 'campaign', 'project', 'business');

    // [book, academic] vs [campaign] -> intersection 0, union 3 -> 0.0.
    const matches = await findProjectsWithSimilarOverrideSet(
      ['book', 'academic'],
      0.5,
    );
    assert.equal(matches.length, 0, '/d below threshold, not returned');
  });
});

test('getPromoteSuggestion fires when >= minMatches share the set', async () => {
  await withFreshHome(async () => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    await recordOverrideUse('/b', 'book', 'project', 'book');
    await recordOverrideUse('/c', 'book', 'project', 'book');
    await recordOverrideUse('/d', 'book', 'project', 'book');

    // Default minMatches=3. Excluding /a means 3 others (/b, /c, /d) match
    // with similarity 1.0, hitting the threshold.
    const sug = await getPromoteSuggestion('/a', ['book']);
    assert.ok(sug, 'suggestion should fire');
    assert.equal(typeof sug.message, 'string');
    assert.ok(sug.message.length > 0);
    assert.ok(Array.isArray(sug.projects));
    assert.ok(sug.projects.length >= 2, 'projects array surfaces matches');
    assert.match(sug.suggestion, /ijfw override promote --scope user book/);
  });
});

test('getPromoteSuggestion returns null below minMatches', async () => {
  await withFreshHome(async () => {
    // Need at least 2 project entries before getPromoteSuggestion will even
    // run findProjectsWithSimilarOverrideSet (it short-circuits when
    // projectCount < 2). Two projects with [book] -> excluding one leaves
    // a single match, under default minMatches=3 -> null.
    await recordOverrideUse('/a', 'book', 'project', 'book');
    await recordOverrideUse('/b', 'book', 'project', 'book');

    const sug = await getPromoteSuggestion('/a', ['book']);
    assert.equal(sug, null);
  });
});

test('getPromoteSuggestion returns null on empty currentOverrides', async () => {
  await withFreshHome(async () => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    await recordOverrideUse('/b', 'book', 'project', 'book');
    await recordOverrideUse('/c', 'book', 'project', 'book');

    assert.equal(await getPromoteSuggestion('/a', []), null);
    assert.equal(await getPromoteSuggestion('/a', null), null);
    assert.equal(await getPromoteSuggestion('/a', undefined), null);
  });
});

test('recordOverrideUse is idempotent on repeat (project, preset)', async () => {
  await withFreshHome(async (home) => {
    await recordOverrideUse('/a', 'book', 'project', 'book');
    // Tiny delay so applied_at can advance — but the entry must not duplicate.
    await new Promise((r) => setTimeout(r, 5));
    await recordOverrideUse('/a', 'book', 'project', 'book');

    const state = await readRegistryFile(home);
    assert.equal(
      state.projects['/a'].active_overrides.length,
      1,
      'one entry, not two — re-record updates applied_at in place',
    );
    assert.equal(state.projects['/a'].active_overrides[0].preset, 'book');
  });
});

test('recordOverrideUse validates inputs', async () => {
  await withFreshHome(async () => {
    await assert.rejects(
      () => recordOverrideUse('', 'book', 'project', 'book'),
      /projectRoot/,
    );
    await assert.rejects(
      () => recordOverrideUse('/a', '', 'project', 'book'),
      /preset/,
    );
    await assert.rejects(
      () => recordOverrideUse('/a', 'book', '', 'book'),
      /scope/,
    );
  });
});
