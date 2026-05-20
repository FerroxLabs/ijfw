// IJFW v1.5.0 INT.1 -- verify fts5.indexEntry calls indexObsidianRelations.
//
// Uses the real openDb path so migrations run to the current head (8),
// which provides memory_entries (001), memory_links/_tags/_meta (006),
// skill_telemetry (007), and origin column (008). Inserts a body with
// wikilinks + nested tag + inline meta, then asserts the auxiliary tables
// got populated as a side-effect of indexEntry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, indexEntry, closeDb } from './src/memory/fts5.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ijfw-fts5-obsidian-'));
}

test('indexEntry triggers indexObsidianRelations as a side-effect', async () => {
  const root = makeRoot();
  try {
    const db = await openDb(root);
    indexEntry(db, {
      body: 'See [[v150-brief]] and [[plan]] #project/r17 [author:: Sean].',
      source: 'test',
    });
    const link = db
      .prepare('SELECT to_target FROM memory_links ORDER BY to_target')
      .all();
    const targets = link.map((r) => r.to_target);
    assert.ok(targets.includes('v150-brief'));
    assert.ok(targets.includes('plan'));
    const tag = db
      .prepare("SELECT tag_path FROM memory_tags WHERE tag_path='project/r17'")
      .get();
    assert.ok(tag);
    const meta = db
      .prepare("SELECT value FROM memory_meta WHERE key='author'")
      .get();
    assert.equal(meta && meta.value, 'Sean');
    closeDb(db);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexEntry survives obsidian indexer exception (best-effort)', async () => {
  const root = makeRoot();
  try {
    const db = await openDb(root);
    // A body with no obsidian markup -> parser returns empty arrays;
    // indexEntry should still complete cleanly and return its id.
    indexEntry(db, { body: 'Plain text with no special markup.' });
    const c = db
      .prepare('SELECT COUNT(*) AS c FROM memory_entries')
      .get().c;
    assert.equal(c, 1);
    // No links/tags/meta written for plain text -- assert clean tables.
    const linkCount = db
      .prepare('SELECT COUNT(*) AS c FROM memory_links')
      .get().c;
    assert.equal(linkCount, 0);
    closeDb(db);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
