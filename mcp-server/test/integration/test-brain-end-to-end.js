import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// v1.5.2.1 F3.4: visible-layer fs-migration relocated to layout-migrations/.
// Alias `migrate010` kept for symbol-stability of existing test bodies.
import { up as migrate010 } from '../../src/memory/layout-migrations/001-visible-layer.js';
import { readLayoutVersion } from '../../src/brain/layout-sentinel.js';
import { resolveBrainPaths } from '../../src/brain/paths.js';
import { runDreamCycle } from '../../src/brain/dream-pipeline.js';
import { isProcessed, readManifest } from '../../src/brain/dump-ingest.js';
import { handleIjfwBrain } from '../../src/handlers/brain-handler.js';

function ageMtime(path, secondsAgo = 60) {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(path, t, t);
}

function freshDb() {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, body TEXT, path TEXT, kind TEXT)').run();
  db.prepare('CREATE TABLE memory_links (id INTEGER PRIMARY KEY, memory_id INTEGER, to_target TEXT)').run();
  db.prepare('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)').run();
  return db;
}

test('E2E: migration 010 -> dump ingest -> wiki compile -> MCP query', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-e2e-'));
  const db = freshDb();
  try {
    // === 1. Scaffold legacy .ijfw/memory/ + seed a knowledge file ===
    mkdirSync(join(root, '.ijfw', 'memory'), { recursive: true });
    // Bless as a real project so the dream-pipeline seed gate runs (the E2E
    // exercises dump ingest -> wiki compile, which materializes visible ijfw/).
    writeFileSync(join(root, '.ijfw', 'project'), '# test fixture: blessed project');
    const legacyKnowledge = join(root, '.ijfw', 'memory', 'knowledge.md');
    writeFileSync(legacyKnowledge, '# Legacy knowledge\n\nseen by v1 readers.\n');
    ageMtime(legacyKnowledge, 60); // ensure freshness gate passes

    // === 2. Run migration 010 ===
    const migrationResult = await migrate010(root);
    assert.equal(migrationResult.skipped, false);
    assert.equal(migrationResult.version, 2);
    assert.equal(readLayoutVersion(root), 2, 'sentinel flipped to v2');

    // Visible layer exists + scaffolded dirs present
    const paths = resolveBrainPaths(root);
    assert.equal(existsSync(join(root, 'ijfw', 'memory', 'knowledge.md')), true, 'memory copied to visible layer');
    assert.equal(existsSync(legacyKnowledge), true, 'legacy file preserved for back-compat fallback');
    for (const sub of ['dump/inbox', 'dump/processed', 'wiki/concepts', 'wiki/entities', 'wiki/decisions', 'wiki/milestones']) {
      assert.ok(existsSync(join(root, 'ijfw', sub)), `scaffold ${sub}`);
    }

    // === 3. Seed a dump file (depth-0, .md kind) ===
    const inboxFile = join(paths.dumpInbox, 'sean-notes.md');
    writeFileSync(inboxFile, '# sean notes\n\nSean is the founder of foundry.\n');

    // === 4. Run dream cycle with a stub extractor that produces facts ===
    const extractFacts = async ({ file }) => {
      if (file.name !== 'sean-notes.md') return [];
      // Pretend the LLM extracted these two facts.
      return [
        { subject: 'sean', predicate: 'role', object: 'founder', confidence: 0.9 },
        { subject: 'sean', predicate: 'works-at', object: 'foundry', confidence: 0.85 },
      ];
    };
    const cycle = await runDreamCycle({ db, repoRoot: root, extractFacts });
    assert.equal(cycle.processed, 1, 'one file processed');
    assert.equal(cycle.factsInserted, 2, 'two facts persisted');
    assert.ok(cycle.pagesCompiled >= 1, 'at least one wiki page compiled');

    // === 5. Receipt invariants ===
    assert.equal(isProcessed(paths.dumpProcessed, 'sean-notes.md'), true);
    const manifest = readManifest(paths.dumpProcessed, 'sean-notes.md');
    assert.equal(manifest.factsInserted, 2);
    assert.equal(existsSync(join(paths.dumpProcessed, 'sean-notes.md')), true, 'file moved to processed/');
    assert.equal(existsSync(inboxFile), false, 'file removed from inbox/');

    // === 6. Wiki page exists with both citations ===
    const seanPage = join(root, 'ijfw', 'wiki', 'entities', 'sean.md');
    assert.ok(existsSync(seanPage), 'sean.md compiled');
    const pageBody = readFileSync(seanPage, 'utf8');
    // sentinel uses <!-- ijfw:auto:begin section="current-state" --> format
    assert.ok(pageBody.includes('section="current-state"'), 'auto sentinel present');
    assert.ok(pageBody.includes('[fact:1]') || pageBody.includes('[fact:2]'), 'at least one fact citation');

    // === 7. Wiki log appended ===
    const log = readFileSync(join(root, 'ijfw', 'wiki', 'log.md'), 'utf8');
    assert.ok(log.includes('ingest sean-notes.md'), 'log contains ingest line');
    assert.ok(log.includes('compile entity sean'), 'log contains compile line');

    // === 8. MCP verb: wiki.get fetches the compiled page ===
    const getResult = await handleIjfwBrain({ verb: 'wiki.get', args: { slug: 'sean' }, db, repoRoot: root });
    assert.equal(getResult.ok, true);
    assert.equal(getResult.slug, 'sean');
    assert.ok(getResult.markdown.includes('section="current-state"'));

    // === 9. MCP verb: conflict.resolve closes a superseded fact ===
    // Add an older role fact, then resolve to the newer one (id=1)
    db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from) VALUES (99, ?, ?, ?, ?)').run('sean', 'role', 'old-role', '2023-01-01T00:00:00Z');
    const resolveResult = await handleIjfwBrain({ verb: 'conflict.resolve', args: { subject: 'sean', predicate: 'role', winnerId: 1 }, db, repoRoot: root });
    assert.equal(resolveResult.ok, true);
    assert.ok(resolveResult.supersededIds.includes(99), 'old fact id=99 superseded');

    // Verify the loser row now has valid_to set
    const loser = db.prepare('SELECT valid_to FROM facts WHERE id = 99').get();
    assert.ok(loser.valid_to != null, 'loser fact closed with valid_to timestamp');

    // === 10. Migration 010 is idempotent ===
    const second = await migrate010(root);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already-migrated');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
