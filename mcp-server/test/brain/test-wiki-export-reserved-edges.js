// IJFW v1.5.2.1 F-LENS2-06 regression: Windows reserved-name edge variants.
//
// Windows trims trailing whitespace and trailing dots before opening a
// file, AND treats `name:stream` as the bare `name` device — so naive
// reserved-name regexes that test the literal basename miss:
//   "CON "     (trailing space stripped -> CON)
//   "CON."     (trailing dot stripped   -> CON)
//   "CON:S"    (NTFS alternate-data-stream -> CON)
//
// Each variant collapses to a device on Windows. The path-guard normaliser
// must collapse them BEFORE the reserved-name regex; otherwise the brain
// payload `{slug:..., outFile:"CON."}` would land at the kernel device on
// any Windows operator. Reject cross-platform so the same payload is portable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { handleIjfwBrain } from '../../src/handlers/brain-handler.js';

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-edges-'));
  mkdirSync(join(root, 'ijfw', 'wiki', 'entities'), { recursive: true });
  return root;
}
function seedPage(root, kind, slug, body) {
  writeFileSync(join(root, 'ijfw', 'wiki', kind, `${slug}.md`), body);
}
function freshDb() { return new Database(':memory:'); }

test('wiki.export rejects reserved-name with trailing space (Windows trim)', async () => {
  const root = freshRoot();
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: join(root, 'CON ') },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'outFile-reserved-name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wiki.export rejects reserved-name with trailing dot (Windows trim)', async () => {
  const root = freshRoot();
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: join(root, 'CON.') },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'outFile-reserved-name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wiki.export rejects NTFS alternate data stream', async () => {
  // POSIX path.join treats ':' as a regular char; this exercises the
  // normaliser's split(':')[0] path even on linux/macos.
  const root = freshRoot();
  seedPage(root, 'entities', 'sean', '# sean');
  try {
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: join(root, 'CON:Stream1') },
      db: freshDb(),
      repoRoot: root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'outFile-reserved-name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
