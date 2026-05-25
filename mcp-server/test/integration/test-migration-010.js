import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up } from '../../src/memory/migrations/010-visible-layer.js';
import { readLayoutVersion, writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'brain-mig010-'));
}
function ageFile(p, secondsAgo = 60) {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(p, t, t);
}

test('happy path: copies and scaffolds, flips sentinel', async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, '.ijfw', 'memory'), { recursive: true });
    mkdirSync(join(root, '.ijfw', 'sessions'), { recursive: true });
    const memFile = join(root, '.ijfw', 'memory', 'foo.md');
    const sessFile = join(root, '.ijfw', 'sessions', '2026-05-25.md');
    writeFileSync(memFile, '# foo\n');
    writeFileSync(sessFile, '# sess\n');
    ageFile(memFile); ageFile(sessFile);

    const result = await up(root);

    assert.equal(result.skipped, false);
    assert.equal(result.version, 2);
    assert.equal(result.copiedFiles, 2);
    assert.equal(result.scaffoldedDirs, 6);
    assert.equal(readLayoutVersion(root), 2);
    assert.equal(readFileSync(join(root, 'ijfw', 'memory', 'foo.md'), 'utf8'), '# foo\n');
    assert.ok(existsSync(join(root, 'ijfw', 'sessions', '2026-05-25.md')));
    assert.ok(existsSync(memFile), 'original .ijfw/memory/foo.md must remain (copy not move)');
    for (const dir of ['ijfw/dump/inbox','ijfw/dump/processed','ijfw/wiki/concepts','ijfw/wiki/entities','ijfw/wiki/decisions','ijfw/wiki/milestones']) {
      assert.ok(existsSync(join(root, dir)), `scaffolded ${dir} must exist`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses on fresh mtime (concurrent writer protection)', async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, '.ijfw', 'memory'), { recursive: true });
    const p = join(root, '.ijfw', 'memory', 'bar.md');
    writeFileSync(p, '# bar (just written)\n');
    // do NOT ageFile — mtime is RIGHT NOW

    const result = await up(root);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'fresh-writes-detected');
    assert.ok(Array.isArray(result.freshFiles));
    assert.ok(result.freshFiles.some((f) => f.endsWith('bar.md')));
    assert.equal(readLayoutVersion(root), 1, 'sentinel must stay at 1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('idempotent: re-running at v2 short-circuits', async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    writeLayoutVersion(root, 2);
    // intentionally do NOT create .ijfw/memory/ — if the function tried to walk it, behavior would diverge

    const r1 = await up(root);
    const r2 = await up(root);

    assert.deepEqual(r1, { skipped: true, reason: 'already-migrated' });
    assert.deepEqual(r2, { skipped: true, reason: 'already-migrated' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bonus: empty source still scaffolds + flips', async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    const result = await up(root);
    assert.equal(result.skipped, false);
    assert.equal(result.copiedFiles, 0);
    assert.equal(result.scaffoldedDirs, 6);
    assert.equal(readLayoutVersion(root), 2);
    assert.ok(existsSync(join(root, 'ijfw', 'dump', 'inbox')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
