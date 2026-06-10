// profile-exemplar-store.test.mjs — V1 voice-exemplar transient store.
//
// Asserts the SHARED contract V2/V4 code against:
//   - path isolation (test context → under os.tmpdir(), NEVER the real homedir),
//   - append + dedup-by-id,
//   - bound + oldest-by-ts eviction,
//   - listExemplars newest-first,
//   - forget (by id and by pattern) + clear wipe,
//   - symlink-guarded read/write (fail-soft).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  exemplarStorePath,
  exemplarId,
  appendExemplar,
  listExemplars,
  forgetExemplars,
  clearExemplars,
  MAX_EXEMPLARS,
} from '../src/profile/exemplar-store.js';

function withTmpProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-exemplar-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal valid exemplar with a stable id derived from text. */
function mk(text, { register = 'casual', source = 'prompt', ts } = {}) {
  return {
    id: exemplarId(text),
    text,
    register,
    source,
    ts: ts || new Date().toISOString(),
  };
}

// --- PATH ISOLATION (critical) ---

test('exemplarStorePath resolves under os.tmpdir() in test context, NEVER the real homedir', () => {
  // Reproduce a forgetful test: NO override set. Under a test runner the path
  // policy auto-isolates to an os.tmpdir() scratch dir.
  const prev = process.env.IJFW_PROFILE_DIR;
  delete process.env.IJFW_PROFILE_DIR;
  try {
    const p = exemplarStorePath();
    assert.ok(
      !p.startsWith(join(homedir(), '.ijfw')),
      `exemplarStorePath() must NOT resolve under the real ~/.ijfw — got ${p}`,
    );
    assert.ok(p.startsWith(tmpdir()), `expected an os.tmpdir() scratch path, got ${p}`);
    assert.ok(p.endsWith('exemplars.jsonl'), `expected the JSONL store filename, got ${p}`);
  } finally {
    if (prev !== undefined) process.env.IJFW_PROFILE_DIR = prev;
  }
});

test('exemplarStorePath honors IJFW_PROFILE_DIR override (lives beside the profile)', () => {
  withTmpProfileDir((dir) => {
    assert.equal(exemplarStorePath(), join(dir, 'exemplars.jsonl'));
  });
});

// --- APPEND + DEDUP ---

test('appendExemplar persists a record, listExemplars reads it back', () => {
  withTmpProfileDir(() => {
    const ex = mk('ship it when the tests are green');
    const r = appendExemplar(ex);
    assert.equal(r.ok, true, JSON.stringify(r));
    const list = listExemplars();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, ex.id);
    assert.equal(list[0].text, ex.text);
  });
});

test('appendExemplar dedups by id — same text never grows the store', () => {
  withTmpProfileDir(() => {
    const a = mk('same exact snippet', { ts: '2026-01-01T00:00:00.000Z' });
    const b = mk('same exact snippet', { ts: '2026-02-01T00:00:00.000Z' });
    assert.equal(a.id, b.id, 'same text → same id');
    appendExemplar(a);
    const r = appendExemplar(b);
    assert.equal(r.ok, true);
    const list = listExemplars();
    assert.equal(list.length, 1, 'dedup keeps exactly one copy');
    // The refreshed ts is the one retained (record replaced).
    assert.equal(list[0].ts, b.ts);
  });
});

test('appendExemplar rejects a record that violates the contract', () => {
  withTmpProfileDir(() => {
    const r = appendExemplar({ text: 'no id here', register: 'casual', source: 'prompt', ts: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EINVALID');
    assert.equal(listExemplars().length, 0);
  });
});

// --- BOUND + EVICTION ---

test('over-cap append evicts the OLDEST by ts', () => {
  withTmpProfileDir(() => {
    const cap = 3;
    // Insert oldest→newest; the oldest must be evicted once over cap.
    const recs = [
      mk('oldest snippet here', { ts: '2026-01-01T00:00:00.000Z' }),
      mk('second snippet here', { ts: '2026-01-02T00:00:00.000Z' }),
      mk('third snippet here', { ts: '2026-01-03T00:00:00.000Z' }),
      mk('fourth snippet here', { ts: '2026-01-04T00:00:00.000Z' }),
    ];
    for (const r of recs) appendExemplar(r, { max: cap });
    const list = listExemplars();
    assert.equal(list.length, cap, 'store stays at cap');
    const texts = list.map((e) => e.text);
    assert.ok(!texts.includes('oldest snippet here'), 'oldest evicted');
    assert.ok(texts.includes('fourth snippet here'), 'newest retained');
    // The append that crossed the cap reports removed:1.
    const over = appendExemplar(mk('fifth snippet here', { ts: '2026-01-05T00:00:00.000Z' }), { max: cap });
    assert.equal(over.removed, 1);
  });
});

test('MAX_EXEMPLARS is the default cap and is a sane transient bound', () => {
  assert.equal(MAX_EXEMPLARS, 200);
});

// --- LIST ORDER ---

test('listExemplars returns NEWEST-first', () => {
  withTmpProfileDir(() => {
    appendExemplar(mk('alpha one snippet', { ts: '2026-01-01T00:00:00.000Z' }));
    appendExemplar(mk('beta two snippet', { ts: '2026-03-01T00:00:00.000Z' }));
    appendExemplar(mk('gamma three snippet', { ts: '2026-02-01T00:00:00.000Z' }));
    const list = listExemplars();
    assert.deepEqual(
      list.map((e) => e.text),
      ['beta two snippet', 'gamma three snippet', 'alpha one snippet'],
    );
  });
});

// --- FORGET + CLEAR ---

test('forgetExemplars removes by exact id', () => {
  withTmpProfileDir(() => {
    const keep = mk('keep this voice sample');
    const drop = mk('forget this voice sample');
    appendExemplar(keep);
    appendExemplar(drop);
    const r = forgetExemplars(drop.id);
    assert.equal(r.ok, true);
    assert.equal(r.removed, 1);
    const list = listExemplars();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, keep.id);
  });
});

test('forgetExemplars removes by substring pattern across text', () => {
  withTmpProfileDir(() => {
    appendExemplar(mk('deploy the staging server now'));
    appendExemplar(mk('deploy the production server now'));
    appendExemplar(mk('write the changelog entry'));
    const r = forgetExemplars('deploy');
    assert.equal(r.ok, true);
    assert.equal(r.removed, 2);
    assert.equal(listExemplars().length, 1);
  });
});

test('forgetExemplars on a non-match removes nothing', () => {
  withTmpProfileDir(() => {
    appendExemplar(mk('only record here present'));
    const r = forgetExemplars('nonexistent-token-zzz');
    assert.equal(r.ok, true);
    assert.equal(r.removed, 0);
    assert.equal(listExemplars().length, 1);
  });
});

test('clearExemplars wipes the whole store', () => {
  withTmpProfileDir(() => {
    appendExemplar(mk('first sample text here'));
    appendExemplar(mk('second sample text here'));
    const r = clearExemplars();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 2);
    assert.equal(listExemplars().length, 0);
  });
});

test('clearExemplars on an empty store is a no-op', () => {
  withTmpProfileDir(() => {
    const r = clearExemplars();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 0);
  });
});

// --- SYMLINK GUARD (fail-soft) ---

test('a symlinked store is refused on write and read (fail-soft, no follow)', () => {
  withTmpProfileDir((dir) => {
    const outside = join(dir, 'outside-sentinel.txt');
    writeFileSync(outside, 'do not clobber me', 'utf8');
    const storePath = exemplarStorePath();
    symlinkSync(outside, storePath);

    // Write must refuse the symlinked target.
    const w = appendExemplar(mk('attempted voice write here'));
    assert.equal(w.ok, false);
    assert.match(String(w.code || ''), /SYMLINK|ELOOP|EEXIST/i);

    // Read returns [] (fail-soft) rather than following the link.
    assert.deepEqual(listExemplars(), []);

    // The outside sentinel is untouched.
    assert.equal(readFileSync(outside, 'utf8'), 'do not clobber me');
  });
});

test('a corrupt/garbage store reads as [] (fail-soft), and a fresh append recovers', () => {
  withTmpProfileDir(() => {
    const p = exemplarStorePath();
    writeFileSync(p, 'NOT JSONL {{{ garbage\n}}}\n', 'utf8');
    assert.deepEqual(listExemplars(), [], 'garbage lines skipped');
    const r = appendExemplar(mk('recovered voice snippet here'));
    assert.equal(r.ok, true);
    assert.equal(listExemplars().length, 1);
  });
});
