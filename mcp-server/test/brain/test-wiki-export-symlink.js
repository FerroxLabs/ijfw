// IJFW v1.5.2.1 F5.2 regression: wiki.export must reject outFile that
// traverses an intra-repo symlink pointing OUTSIDE the repo.
//
// Pre-fix, path.resolve never followed the symlink, so the lexical
// check (no '..', not absolute) passed and the write landed at the
// symlink target — outside the sandbox. Post-fix, realpathSync on
// the parent unmasks the symlink BEFORE the containment check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { handleIjfwBrain } from '../../src/handlers/brain-handler.js';

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-sym-'));
  mkdirSync(join(root, 'ijfw', 'wiki', 'entities'), { recursive: true });
  return root;
}

function seedPage(root, kind, slug, body) {
  writeFileSync(join(root, 'ijfw', 'wiki', kind, `${slug}.md`), body);
}

function freshDb() {
  return new Database(':memory:');
}

test('wiki.export rejects outFile that traverses a symlink to outside repo', async () => {
  // Skip on Windows — symlinkSync requires admin or developer-mode there.
  if (process.platform === 'win32') return;
  const root = freshRoot();
  const outsideTarget = mkdtempSync(join(tmpdir(), 'sym-target-'));
  // Inside the repo, create a symlink pointing to a directory OUTSIDE the repo.
  symlinkSync(outsideTarget, join(root, 'evil-link'));
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: join(root, 'evil-link', 'leak.md') },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, false, 'must reject symlink-traversal outFile');
    assert.equal(r.error, 'outFile-escapes-repo');
  } finally {
    rmSync(outsideTarget, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// F-LENS2-09: paired positive test. The earlier file only proved the guard
// REJECTS escape paths. This proves the guard does not over-reject — a
// legitimate non-symlinked outFile inside the repo must still succeed.
// Without this, a regression that hardened the guard into a deny-all would
// pass the negative suite while silently breaking every legitimate export.
//
// Note: seedPage writes under `ijfw/wiki/` (visible-layer path), which only
// matches contentDir when layoutVersion >= 2. Write the .layout-version
// sentinel before seeding so findPage actually locates the page and the
// request reaches the path-guard under test (not short-circuited by
// page-not-found upstream).
test('wiki.export succeeds for legitimate non-symlinked outFile inside repo', async () => {
  const root = freshRoot();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(join(root, '.ijfw', '.layout-version'), '2\n');
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const out = join(root, 'ijfw', 'export-out.md');
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: out },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, true, `expected ok:true for legit outFile, got ${JSON.stringify(r)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
