// IJFW v1.5.0 M2.2 + M2.3 -- A-Mem auto-linker tests.
//
// Uses production memory_entries schema (migration 001): id INTEGER PK,
// body, source, session_id, created_at. memory_links/_tags from migration
// 006. No LLM calls in CI -- all paths exercised via { neighborsOnly: true }
// or { dryProposal: <obj> } injection plus env-gate short-circuits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';
import { autoLink } from './src/memory/auto-linker.js';

async function seed() {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 6);
  const ins = db.prepare(
    'INSERT INTO memory_entries (id, body, source, created_at) VALUES (?,?,?,?)',
  );
  ins.run(
    1,
    'A-Mem auto-linking — Zettelkasten-style memory evolution.',
    'note',
    1,
  );
  ins.run(
    2,
    'Letta sleep-time — background memory consolidation agent.',
    'note',
    2,
  );
  return db;
}

test('autoLink returns skipped when IJFW_AUTOLINK_OFF=1', async () => {
  const orig = process.env.IJFW_AUTOLINK_OFF;
  process.env.IJFW_AUTOLINK_OFF = '1';
  try {
    const db = await seed();
    const out = await autoLink(db, {
      id: 3,
      body: 'See A-Mem auto-linking for context.',
    });
    assert.equal(out.skipped, true);
  } finally {
    if (orig === undefined) delete process.env.IJFW_AUTOLINK_OFF;
    else process.env.IJFW_AUTOLINK_OFF = orig;
  }
});

test('autoLink finds top-k neighbors via tokenized body LIKE', async () => {
  const db = await seed();
  const out = await autoLink(
    db,
    { id: 99, body: 'A-Mem write-time evolution: auto-linking on store' },
    { neighborsOnly: true },
  );
  assert.ok(Array.isArray(out.neighbors));
  assert.ok(out.neighbors.length >= 1);
  // m1 ("A-Mem auto-linking ... evolution") matches via "evolution".
  // m2 ("Letta sleep-time ...") also matches via "time".
  // Membership matters, not order — ordering is created_at DESC.
  const ids = out.neighbors.map((n) => n.id);
  assert.ok(ids.includes('1'));
});

test('autoLink skips self via CAST id != entry.id', async () => {
  const db = await seed();
  const out = await autoLink(
    db,
    { id: 1, body: 'A-Mem auto-linking — Zettelkasten-style memory evolution.' },
    { neighborsOnly: true },
  );
  // Should NOT match itself (id=1 filtered out).
  assert.ok(!out.neighbors.some((n) => n.id === '1'));
});

test('autoLink applyProposal writes links + neighbor tags', async () => {
  const db = await seed();
  const fakeProposal = {
    classification: 'ADD',
    links: [{ target: 'a-mem-auto-linking' }],
    neighbor_edits: [{ id: '1', add_tags: ['evolution'] }],
  };
  const out = await autoLink(
    db,
    { id: 4, body: 'Auto-link proposal trial' },
    { dryProposal: fakeProposal },
  );
  assert.equal(out.applied.links_added, 1);
  assert.equal(out.applied.neighbor_tags_added, 1);
  const link = db
    .prepare('SELECT to_target FROM memory_links WHERE from_id=?')
    .get('4');
  assert.equal(link.to_target, 'a-mem-auto-linking');
  const tag = db
    .prepare(
      "SELECT tag_path FROM memory_tags WHERE memory_id='1' AND tag_path='evolution'",
    )
    .get();
  assert.ok(tag);
});

test('autoLink caps links at 3 and neighbor tags at 3 total', async () => {
  const db = await seed();
  const greedy = {
    classification: 'ADD',
    links: [
      { target: 'a' }, { target: 'b' }, { target: 'c' }, { target: 'd' },
    ],
    neighbor_edits: [
      { id: '1', add_tags: ['t1', 't2', 't3'] },
      { id: '2', add_tags: ['t4', 't5'] },
    ],
  };
  const out = await autoLink(
    db,
    { id: 5, body: 'cap test' },
    { dryProposal: greedy },
  );
  assert.equal(out.applied.links_added, 3); // 4th dropped by .slice(0, 3)
  assert.equal(out.applied.neighbor_tags_added, 3); // capped
});

test('autoLink respects budget exhaustion (IJFW_AUTOLINK_BUDGET_USD=0)', async () => {
  const orig = process.env.IJFW_AUTOLINK_BUDGET_USD;
  process.env.IJFW_AUTOLINK_BUDGET_USD = '0';
  try {
    const db = await seed();
    const out = await autoLink(db, {
      id: 6,
      body: 'should skip due to budget',
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'budget_exhausted');
    const c = db
      .prepare('SELECT COUNT(*) AS c FROM memory_links WHERE from_id=?')
      .get('6').c;
    assert.equal(c, 0);
  } finally {
    if (orig === undefined) delete process.env.IJFW_AUTOLINK_BUDGET_USD;
    else process.env.IJFW_AUTOLINK_BUDGET_USD = orig;
  }
});

test('autoLink ignores neighbor_edit when id missing or non-string', async () => {
  const db = await seed();
  const proposal = {
    classification: 'ADD',
    links: [],
    neighbor_edits: [
      { add_tags: ['orphan'] }, // missing id
      { id: 42, add_tags: ['numeric-id'] }, // wrong type
      { id: '1', add_tags: ['valid'] },
    ],
  };
  const out = await autoLink(
    db,
    { id: 7, body: 'orphan-id test' },
    { dryProposal: proposal },
  );
  assert.equal(out.applied.neighbor_tags_added, 1); // only the valid one
});
