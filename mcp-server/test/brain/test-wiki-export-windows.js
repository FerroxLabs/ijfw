// IJFW v1.5.2.1 F5.5 + F5.8 regression: wiki.export must reject
//   - Windows reserved device names (cross-platform: same payload portability)
//   - UNC paths on Windows (\\server\share — different volume, no sandbox)
//   - Cross-drive outFile on Windows (D:\... when root is on C:)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { handleIjfwBrain } from '../../src/handlers/brain-handler.js';

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-win-'));
  mkdirSync(join(root, 'ijfw', 'wiki', 'entities'), { recursive: true });
  return root;
}

function seedPage(root, kind, slug, body) {
  writeFileSync(join(root, 'ijfw', 'wiki', kind, `${slug}.md`), body);
}

function freshDb() {
  return new Database(':memory:');
}

test('wiki.export rejects Windows reserved device names (cross-platform)', async () => {
  const root = freshRoot();
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    for (const name of ['CON', 'NUL', 'PRN', 'COM1', 'LPT1', 'AUX', 'con.md']) {
      const r = await handleIjfwBrain({
        verb: 'wiki.export',
        args: { slug: 'sean', outFile: join(root, name) },
        db: freshDb(),
        repoRoot: root,
      });
      assert.equal(r.ok, false, `must reject ${name}`);
      assert.equal(r.error, 'outFile-reserved-name', `must surface reserved-name error for ${name}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wiki.export rejects UNC outFile on Windows', async () => {
  // Skip on non-Windows — UNC paths don't carry the same semantics on POSIX.
  if (process.platform !== 'win32') return;
  const root = freshRoot();
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: '\\\\evil-server\\share\\loot.md' },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'outFile-escapes-repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wiki.export rejects cross-drive outFile on Windows', async () => {
  // Skip on non-Windows — drive letters don't exist on POSIX.
  if (process.platform !== 'win32') return;
  const root = freshRoot();
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: 'D:\\evil\\loot.md' },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'outFile-escapes-repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
