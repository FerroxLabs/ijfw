// IJFW v1.5.2.1 F-LENS2-05 regression: wiki.compile must reject when the
// compile target resolves outside the repo via an intra-repo symlink.
//
// Bug shape: prior to F-LENS2-05, wiki.export was guarded but wiki.compile
// wasn't. A symlinked `ijfw/` (or `ijfw/wiki/`) pointing outside the repo
// would let the atomic-write rename land kernel-managed bytes at an
// attacker-chosen location — same blast radius as the wiki.export bug.
//
// This test creates an intra-repo `ijfw` symlink pointing to a tmpdir
// OUTSIDE the repo, seeds a fact, then calls wiki.compile. With the shared
// validateSafeRepoPath guard now wired into compileWikiPage, the result
// must be ok:false with the same `outFile-escapes-repo` error shape used
// by wiki.export — symmetric policy across writers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { handleIjfwBrain } from '../../src/handlers/brain-handler.js';

function freshDb() {
  const db = new Database(':memory:');
  db.prepare(
    'CREATE TABLE IF NOT EXISTS memory_entries (id INTEGER PRIMARY KEY, body TEXT, path TEXT, kind TEXT, source TEXT, session_id TEXT, created_at TEXT)'
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)'
  ).run();
  db.prepare('INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)').run(1, 'x', '/p.md', 'markdown');
  db.prepare(
    'INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)'
  ).run(1, 'evil', 'role', 'r', '2024-01-01T00:00:00Z', 1);
  return db;
}

test('wiki.compile rejects when ijfw/ resolves outside the repo via a symlink', async () => {
  // Skip on Windows — symlinkSync requires admin or developer-mode there.
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'compile-sym-'));
  const outsideTarget = mkdtempSync(join(tmpdir(), 'compile-sym-out-'));
  // Pre-create the wiki tree at the OUTSIDE target so resolveBrainPaths /
  // mkdirSync would otherwise happily write there if the guard didn't fire.
  mkdirSync(join(outsideTarget, 'wiki', 'entities'), { recursive: true });
  // The brain handler chooses contentDir based on .ijfw/.layout-version:
  // layoutVersion=1 → contentDir = root/.ijfw (the ijfw/ symlink is then
  // never touched, and the test trivially "passes" with ok:true). Pin the
  // sentinel to v2 so contentDir = root/ijfw — the symlinked path — which
  // is exactly what the guard must canonicalize and reject.
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(join(root, '.ijfw', '.layout-version'), '2\n');
  // Now redirect the repo's ijfw/ dir to the outside target.
  symlinkSync(outsideTarget, join(root, 'ijfw'));
  const db = freshDb();
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.compile',
      args: { subject: 'evil', type: 'entity' },
      db,
      repoRoot: root,
    });
    assert.equal(r.ok, false, `compile must reject symlinked target, got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'outFile-escapes-repo');
    // Sanity: nothing landed at the outside target.
    assert.equal(existsSync(join(outsideTarget, 'wiki', 'entities', 'evil.md')), false,
      'no bytes may land at the outside symlink target');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideTarget, { recursive: true, force: true });
  }
});
