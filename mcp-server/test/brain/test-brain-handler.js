import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIjfwBrain, IJFW_BRAIN_VERBS } from '../../src/handlers/brain-handler.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'brain-handler-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  writeLayoutVersion(r, 2);
  return r;
}

function freshDb() {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, body TEXT, path TEXT, kind TEXT)').run();
  db.prepare('CREATE TABLE memory_links (id INTEGER PRIMARY KEY, memory_id INTEGER, to_target TEXT)').run();
  db.prepare('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)').run();
  return db;
}

function seedPage(root, type, slug, body) {
  const dir = join(root, 'ijfw', 'wiki', type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body);
}

test('handleIjfwBrain: missing verb -> error', async () => {
  const r = await handleIjfwBrain({ args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing-verb');
});

test('handleIjfwBrain: unknown verb -> error', async () => {
  const r = await handleIjfwBrain({ verb: 'mystery' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown-verb');
});

test('IJFW_BRAIN_VERBS lists all 12 verbs', () => {
  // v1.6.0 P4 folded the cross-system profile-bus read path into ijfw_brain as
  // two read verbs (profile.get / profile.brief). The serving-security audit
  // (M2) added two more — profile.forget (right-to-be-forgotten) and
  // profile.audit (list inferences with provenance) — giving the user a real
  // invocation surface for the audit module. Still NO new top-level tool, so the
  // MCP cap stays 13/13. The original 8 brain verbs plus the 4 profile verbs.
  assert.equal(IJFW_BRAIN_VERBS.length, 12);
  for (const v of [
    'think', 'links', 'wiki.get', 'wiki.compile', 'wiki.promote', 'wiki.export', 'wiki.shareReadme', 'conflict.resolve',
    'profile.get', 'profile.brief', 'profile.forget', 'profile.audit',
  ]) {
    assert.ok(IJFW_BRAIN_VERBS.includes(v), `missing ${v}`);
  }
});

test('verb think: missing query -> error', async () => {
  const db = freshDb();
  try {
    const r = await handleIjfwBrain({ verb: 'think', args: {}, db, repoRoot: freshRoot() });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing-query');
  } finally { db.close(); }
});

test('verb think: stubbed LLM returns answer + cites + resolution', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    db.prepare('INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)').run(5, 'sean is founder', '/n.md', 'markdown');
    db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)').run(11, 'sean', 'role', 'founder', '2024-01-01T00:00:00Z', 5);
    seedPage(root, 'entities', 'sean', '# sean\n\nfounder of foundry [fact:11]');
    const opts = {
      _callLLM: async () => ({ text: '{"answer":"sean is the founder","citations":[{"kind":"fact","id":11}]}' }),
    };
    const r = await handleIjfwBrain({ verb: 'think', args: { query: 'who is sean' }, db, repoRoot: root, opts });
    assert.equal(r.ok, true);
    assert.ok(r.answer.includes('founder'));
    assert.equal(r.citations.length, 1);
    assert.equal(r.citationsResolved, true);
    assert.equal(r.unresolved.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('verb links: missing of -> error', async () => {
  const db = freshDb();
  try {
    const r = await handleIjfwBrain({ verb: 'links', args: {}, db, repoRoot: freshRoot() });
    assert.equal(r.ok, false);
  } finally { db.close(); }
});

test('verb links: counts incoming references', async () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO memory_links (memory_id, to_target) VALUES (?, ?)');
  for (let i = 0; i < 4; i++) ins.run(i, 'sean');
  try {
    const r = await handleIjfwBrain({ verb: 'links', args: { of: 'sean' }, db, repoRoot: freshRoot() });
    assert.equal(r.ok, true);
    assert.equal(r.of, 'sean');
    assert.equal(r.incomingCount, 4);
  } finally { db.close(); }
});

test('verb wiki.get / wiki.compile / wiki.promote happy paths', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    // Seed a fact + memory so compile passes citation gate
    db.prepare('INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)').run(5, 'x', '/p.md', 'markdown');
    db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)').run(11, 'alice', 'role', 'r', '2024-01-01T00:00:00Z', 5);
    // compile
    const compileRes = await handleIjfwBrain({ verb: 'wiki.compile', args: { subject: 'alice', type: 'entity' }, db, repoRoot: root });
    assert.equal(compileRes.ok, true);
    // get
    const getRes = await handleIjfwBrain({ verb: 'wiki.get', args: { slug: 'alice' }, db, repoRoot: root });
    assert.equal(getRes.ok, true);
    assert.ok(getRes.markdown.includes('[fact:11]'));
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('verb wiki.export / wiki.shareReadme', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'sean', '# sean\n\nlinks to [[foundry]]');
    seedPage(root, 'concepts', 'foundry', '# foundry');
    const exp = await handleIjfwBrain({ verb: 'wiki.export', args: { slug: 'sean', outFile: join(root, 'out.md') }, db, repoRoot: root });
    assert.equal(exp.ok, true);
    assert.deepEqual(exp.linkedPagesIncluded, ['foundry']);
    const readme = await handleIjfwBrain({ verb: 'wiki.shareReadme', db, repoRoot: root });
    assert.equal(readme.ok, true);
    assert.ok(existsSync(readme.outFile));
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('verb conflict.resolve closes other open facts via valid_to=now', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    const ins = db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,NULL)');
    ins.run(1, 'sean', 'role', 'founder', '2024-01-01T00:00:00Z');
    ins.run(2, 'sean', 'role', 'old-role-1', '2023-01-01T00:00:00Z');
    ins.run(3, 'sean', 'role', 'old-role-2', '2022-01-01T00:00:00Z');
    const r = await handleIjfwBrain({ verb: 'conflict.resolve', args: { subject: 'sean', predicate: 'role', winnerId: 1 }, db, repoRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.resolved, true);
    assert.deepEqual(r.supersededIds.sort(), [2, 3]);
    // Verify db state
    const closed = db.prepare('SELECT id, valid_to FROM facts WHERE id IN (2, 3)').all();
    for (const f of closed) assert.ok(f.valid_to, `fact ${f.id} should have valid_to`);
    const winner = db.prepare('SELECT valid_to FROM facts WHERE id = 1').get();
    assert.equal(winner.valid_to, null, 'winner stays open');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

// F2 — monotonic valid_to.

test('verb conflict.resolve: monotonic valid_to beats wall-clock when clock would tie', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    const ins = db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,?)');
    ins.run(1, 'sean', 'role', 'founder', '2024-01-01T00:00:00Z', null);
    ins.run(2, 'sean', 'role', 'cto', '2023-06-01T00:00:00Z', null);
    // Pre-existing valid_to in the FUTURE (e.g. clock skew or another process
    // already committed forward). chosenValidTo must be > this.
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,?)')
      .run(3, 'sean', 'role', 'old', '2022-01-01T00:00:00Z', farFuture);
    const r = await handleIjfwBrain({ verb: 'conflict.resolve', args: { subject: 'sean', predicate: 'role', winnerId: 1 }, db, repoRoot: root });
    assert.equal(r.ok, true);
    assert.ok(r.validTo, 'returns chosen validTo');
    assert.ok(r.validTo > farFuture, `chosenValidTo (${r.validTo}) must exceed pre-existing future valid_to (${farFuture})`);
    // The loser (id=2) should have validTo === r.validTo
    const loser = db.prepare('SELECT valid_to FROM facts WHERE id = 2').get();
    assert.equal(loser.valid_to, r.validTo);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

// v1.5.2.1 FLAG-1 cross-platform — verify wiki.export rejects outFile paths
// that escape repoRoot. Original guard used `startsWith(resolvedRoot + '/')`
// which broke on Windows (separator is `\`) and would silently fail-open if
// "fixed" naively to `startsWith(resolvedRoot)` (prefix-collision bypass).
// New guard uses path.relative + isAbsolute + '..' checks.

test('verb wiki.export rejects outFile traversal via ..', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'sean', '# sean\n\nfounder');
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: join(root, '..', 'escape.md') },
      db, repoRoot: root,
    });
    assert.equal(r.ok, false, 'must reject .. traversal');
    assert.equal(r.error, 'outFile-escapes-repo');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('verb wiki.export rejects outFile in prefix-collision sibling dir', async () => {
  const db = freshDb();
  const root = freshRoot();
  // Construct a sibling directory whose path starts with root + a suffix.
  // The OLD `startsWith(resolvedRoot + '/')` guard correctly caught this on
  // POSIX (by accident of the trailing '/'); the NEW path.relative guard
  // catches it on every platform.
  const sibling = `${root}-evil`;
  try {
    mkdirSync(sibling, { recursive: true });
    seedPage(root, 'entities', 'sean', '# sean');
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: join(sibling, 'leak.md') },
      db, repoRoot: root,
    });
    assert.equal(r.ok, false, 'must reject prefix-collision sibling dir');
    assert.equal(r.error, 'outFile-escapes-repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
    db.close();
  }
});

test('verb wiki.export rejects outFile equal to repoRoot itself', async () => {
  // The relative path would be '' (empty) — never a valid outFile because
  // root is a directory, and exportPageBundle expects a file path.
  const db = freshDb();
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'sean', '# sean');
    const r = await handleIjfwBrain({
      verb: 'wiki.export',
      args: { slug: 'sean', outFile: root },
      db, repoRoot: root,
    });
    assert.equal(r.ok, false, 'must reject outFile === repoRoot');
    assert.equal(r.error, 'outFile-escapes-repo');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

// v1.5.2.1 conflict.resolve atomic-verify — regression guard for the
// cross-connection race where the winner could be closed between the
// auto-commit verify and the lock-acquired update. The verify now runs
// INSIDE the BEGIN IMMEDIATE transaction so verify + close-losers operate
// on the same locked snapshot.

test('verb conflict.resolve: stale winnerId (already closed) returns winner-not-found-or-already-closed', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    const ins = db.prepare(
      'INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,?)'
    );
    ins.run(1, 'sean', 'role', 'A', '2024-01-01T00:00:00Z', null);
    ins.run(2, 'sean', 'role', 'B', '2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z');
    // Try to use the already-closed fact (id=2) as the winner. The
    // FLAG-6 + valid_to IS NULL check (now inside the transaction) must
    // reject — anything less leaves the system with zero open rows.
    const r = await handleIjfwBrain({
      verb: 'conflict.resolve',
      args: { subject: 'sean', predicate: 'role', winnerId: 2 },
      db, repoRoot: root,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'winner-not-found-or-already-closed');
    // And the still-open row (id=1) must remain open — no UPDATE leaked
    // out of a partial transaction.
    const open = db.prepare("SELECT id FROM facts WHERE valid_to IS NULL").all().map((r) => r.id);
    assert.deepEqual(open, [1], 'open rows must be untouched after rejected resolve');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('verb conflict.resolve: supersede=false short-circuits with the same verify guard', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    db.prepare(
      'INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,?)'
    ).run(99, 'sean', 'role', 'old', '2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z');
    const r = await handleIjfwBrain({
      verb: 'conflict.resolve',
      args: { subject: 'sean', predicate: 'role', winnerId: 99, supersede: false },
      db, repoRoot: root,
    });
    assert.equal(r.ok, false, 'closed winner must fail even on supersede=false');
    assert.equal(r.error, 'winner-not-found-or-already-closed');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

// FLAG-11 — verify the think verb's prompt embeds the untrusted-content delimiters.

test('verb think: prompt embeds <<<REFERENCE_START>>>/<<<REFERENCE_END>>> delimiters', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    db.prepare('INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)').run(7, 'sean is founder', '/p.md', 'markdown');
    db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)').run(13, 'sean', 'role', 'founder', '2024-01-01T00:00:00Z', 7);
    let capturedPrompt = null;
    const opts = {
      _callLLM: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { text: '{"answer":"sean is the founder","citations":[{"kind":"fact","id":13}]}' };
      },
    };
    await handleIjfwBrain({ verb: 'think', args: { query: 'who is sean' }, db, repoRoot: root, opts });
    assert.ok(capturedPrompt, 'callLLM was called');
    assert.ok(capturedPrompt.includes('<<<REFERENCE_START>>>'), 'prompt embeds REFERENCE_START delimiter');
    assert.ok(capturedPrompt.includes('<<<REFERENCE_END>>>'), 'prompt embeds REFERENCE_END delimiter');
    assert.ok(/IGNORE\s+those instructions/i.test(capturedPrompt), 'prompt instructs LLM to ignore embedded directives');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});
