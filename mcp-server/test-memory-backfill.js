// IJFW v1.5.1 R5-1.2 -- backfill of M1/M2 indexing for memory written
// before Round-4 Fix-1 wired indexObsidianRelations + autoLink into the
// production write path.
//
// Closes Trident r5 finding 1.2 (HIGH): memory written during v1.5.0 (M1/M2
// bypassed) had empty memory_links / memory_tags / memory_meta. These tests
// simulate that v1.5.0 state (rows in memory_entries, no aux rows) and prove
// the backfill populates the aux tables for OLD entries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';
import {
  backfillObsidianIndex,
} from './src/memory/obsidian-parser.js';
import { backfillAutoLink } from './src/memory/auto-linker.js';

// Build a db at schema v8 (the v1.5.0 schema: migration 006 obsidian-graph
// tables exist, but 009 backfill has NOT run) and seed memory_entries with
// rows that have NO obsidian aux rows -- exactly the pre-fix v1.5.0 state.
async function seedV150Db() {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 8);
  const ins = db.prepare(
    'INSERT INTO memory_entries (body, source, created_at) VALUES (?,?,?)',
  );
  ins.run('Refer to [[brief]] and [[design-doc]] #project/r5 [author:: Sean].', 'a.md', Date.now());
  ins.run('Plain entry with no obsidian markup at all.', 'b.md', Date.now());
  ins.run('See [[handoff]] #ship/v151 #ship/v151/audit [status:: done].', 'c.md', Date.now());
  return db;
}

test('M1 backfill: pre-fix rows have empty aux tables before backfill', async () => {
  const db = await seedV150Db();
  // Simulate v1.5.0: 3 entries written, M1 was bypassed -> aux tables empty.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_entries').get().c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_tags').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_meta').get().c, 0);
});

test('M1 backfill: populates memory_links/_tags/_meta for OLD entries', async () => {
  const db = await seedV150Db();
  const res = backfillObsidianIndex(db);

  // Entries 1 + 3 carry obsidian markup; entry 2 is plain text.
  assert.equal(res.rows, 3, 'all 3 rows walked');
  assert.equal(res.errors, 0);

  // Links: entry 1 has [[brief]] + [[design-doc]]; entry 3 has [[handoff]].
  const links = db.prepare('SELECT * FROM memory_links ORDER BY to_target').all();
  assert.equal(links.length, 3);
  assert.deepEqual(
    links.map((l) => l.to_target).sort(),
    ['brief', 'design-doc', 'handoff'],
  );

  // Tags: entry 1 -> project/r5; entry 3 -> ship/v151 + ship/v151/audit.
  const tags = db.prepare('SELECT DISTINCT tag_path FROM memory_tags ORDER BY tag_path').all();
  assert.deepEqual(
    tags.map((t) => t.tag_path),
    ['project/r5', 'ship/v151', 'ship/v151/audit'],
  );

  // Meta: entry 1 -> author; entry 3 -> status.
  const meta = db.prepare('SELECT key, value FROM memory_meta ORDER BY key').all();
  assert.deepEqual(meta, [
    { key: 'author', value: 'Sean' },
    { key: 'status', value: 'done' },
  ]);
});

test('M1 backfill: is idempotent (re-run produces identical state)', async () => {
  const db = await seedV150Db();
  backfillObsidianIndex(db);
  const after1 = {
    links: db.prepare('SELECT COUNT(*) c FROM memory_links').get().c,
    tags: db.prepare('SELECT COUNT(*) c FROM memory_tags').get().c,
    meta: db.prepare('SELECT COUNT(*) c FROM memory_meta').get().c,
  };
  backfillObsidianIndex(db);
  const after2 = {
    links: db.prepare('SELECT COUNT(*) c FROM memory_links').get().c,
    tags: db.prepare('SELECT COUNT(*) c FROM memory_tags').get().c,
    meta: db.prepare('SELECT COUNT(*) c FROM memory_meta').get().c,
  };
  assert.deepEqual(after2, after1, 'second backfill changed nothing');
});

test('M1 backfill: tolerates a db with no memory_entries table', () => {
  const db = new Database(':memory:');
  const res = backfillObsidianIndex(db);
  assert.deepEqual(res, { rows: 0, links: 0, tags: 0, meta: 0, errors: 0 });
});

test('M1 backfill: batches across more rows than batchSize', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 8);
  const ins = db.prepare('INSERT INTO memory_entries (body, created_at) VALUES (?,?)');
  for (let i = 0; i < 25; i++) {
    ins.run(`Entry ${i} links to [[note-${i}]].`, Date.now());
  }
  const res = backfillObsidianIndex(db, { batchSize: 4 });
  assert.equal(res.rows, 25);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 25);
});

// ---------------------------------------------------------------------------
// Migration 009 -- the one-time M1 backfill as part of schema migration.
// ---------------------------------------------------------------------------

test('migration 009: backfills M1 indexing on upgrade from v8 to v9', async () => {
  // Start at v8 (v1.5.0 schema), seed pre-fix rows, then migrate to v9.
  const db = await seedV150Db();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);

  await runMigrations(db, 8, 9);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  // The migration ran the M1 backfill -- aux tables are now populated for the
  // OLD entries that were written before the fix.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 3);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM memory_tags').get().c >= 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_meta').get().c, 2);
});

test('migration 009: is a clean no-op on a fresh db (no pre-fix rows)', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 9);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_entries').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
});

test('migration 009: re-running the migration pipeline is idempotent', async () => {
  const db = await seedV150Db();
  await runMigrations(db, 8, 9);
  const before = db.prepare('SELECT COUNT(*) c FROM memory_links').get().c;
  const final = await runMigrations(db, 9, 9);
  assert.equal(final, 9);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, before);
});

// ---------------------------------------------------------------------------
// M2 (autoLink) backfill -- budget-gated, opt-in. The acceptance criterion is
// that backfilling autoLink does NOT blow past the budget cap.
// ---------------------------------------------------------------------------

const SAVED_ENV = {};
function setEnv(k, v) {
  if (!(k in SAVED_ENV)) SAVED_ENV[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('M2 backfill: is a no-op unless explicitly opted into', async () => {
  const db = await seedV150Db();
  setEnv('IJFW_AUTOLINK_BACKFILL', undefined);
  setEnv('IJFW_AUTOLINK_OFF', undefined);
  try {
    const res = await backfillAutoLink(db);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'backfill_not_enabled');
    assert.equal(res.rows, 0);
    // No LLM calls -> no new links beyond whatever M1 wrote (none here).
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  } finally {
    restoreEnv();
  }
});

test('M2 backfill: respects the IJFW_AUTOLINK_OFF kill switch', async () => {
  const db = await seedV150Db();
  setEnv('IJFW_AUTOLINK_BACKFILL', '1');
  setEnv('IJFW_AUTOLINK_OFF', '1');
  try {
    const res = await backfillAutoLink(db);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'autolink_off');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  } finally {
    restoreEnv();
  }
});

test('M2 backfill: does NOT blow past a zero budget cap', async () => {
  const db = await seedV150Db();
  setEnv('IJFW_AUTOLINK_BACKFILL', '1');
  setEnv('IJFW_AUTOLINK_OFF', undefined);
  setEnv('IJFW_AUTOLINK_BUDGET_USD', '0');
  setEnv('ANTHROPIC_API_KEY', 'sk-test-not-used-budget-is-zero');
  setEnv('IJFW_AUTOLINK_API_KEY', undefined);
  try {
    const res = await backfillAutoLink(db);
    // Budget is exhausted -> backfill must skip BEFORE any paid LLM call.
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'budget_exhausted');
    // No links written -> zero spend.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  } finally {
    restoreEnv();
  }
});

test('M2 backfill: --m2/force path still honours the budget cap', async () => {
  // The CLI passes { force: true } so --m2 IS the opt-in. force must NOT
  // bypass the budget cap -- only the IJFW_AUTOLINK_BACKFILL opt-in gate.
  const db = await seedV150Db();
  setEnv('IJFW_AUTOLINK_BACKFILL', undefined);
  setEnv('IJFW_AUTOLINK_OFF', undefined);
  setEnv('IJFW_AUTOLINK_BUDGET_USD', '0');
  setEnv('ANTHROPIC_API_KEY', 'sk-test-not-used-budget-is-zero');
  try {
    const res = await backfillAutoLink(db, { force: true });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'budget_exhausted',
      'force must still stop at the budget cap');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  } finally {
    restoreEnv();
  }
});

test('M2 backfill: skips cleanly when no API key is configured', async () => {
  const db = await seedV150Db();
  setEnv('IJFW_AUTOLINK_BACKFILL', '1');
  setEnv('IJFW_AUTOLINK_OFF', undefined);
  // Budget IS set to a positive cap so the run reaches the key check.
  setEnv('IJFW_AUTOLINK_BUDGET_USD', '5');
  setEnv('ANTHROPIC_API_KEY', undefined);
  setEnv('IJFW_AUTOLINK_API_KEY', undefined);
  try {
    const res = await backfillAutoLink(db);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no_key');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  } finally {
    restoreEnv();
  }
});

test('M2 backfill: refuses to run when no budget cap is configured', async () => {
  // Acceptance guard: M2 backfill must NOT spend uncapped. An unset budget
  // (which llm-call.js treats as "uncapped") is rejected for the bulk path.
  const db = await seedV150Db();
  setEnv('IJFW_AUTOLINK_BACKFILL', '1');
  setEnv('IJFW_AUTOLINK_OFF', undefined);
  setEnv('IJFW_AUTOLINK_BUDGET_USD', undefined);
  setEnv('ANTHROPIC_API_KEY', 'sk-test-must-not-be-used-no-budget');
  try {
    const res = await backfillAutoLink(db, { force: true });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'budget_not_set');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_links').get().c, 0);
  } finally {
    restoreEnv();
  }
});
