// IJFW v1.5.2.1 F2.test — cross-connection race regression for conflict.resolve.
//
// The bug shape this guards against:
//
//   Connection A opens dbA, sees fact id=1 (winner) is open. Connection B,
//   on the SAME DB FILE but a SEPARATE handle, closes id=1 (sets valid_to).
//   A now calls conflict.resolve(winnerId=1). Before c21cc57+F2.7, A's
//   pre-flight verify ran auto-commit (BEGIN DEFERRED arrives later) — and
//   succeeded against A's own SHARED snapshot, missing B's commit. The
//   close-the-losers UPDATE then nuked every OTHER open row for (subject,
//   predicate), leaving ZERO open facts.
//
// Post-fix: the winner-verify is INSIDE the IMMEDIATE transaction, so it
// runs against the same locked snapshot as the UPDATE. Cross-connection
// writers serialise via busy_timeout. A's verify must now see B's commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIjfwBrain } from '../../src/handlers/brain-handler.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'race-cross-'));
}

function setupDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare(
    'CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)'
  ).run();
  return db;
}

test('conflict.resolve: cross-connection winner-closed race is caught atomically', async () => {
  const root = freshRoot();
  const dbPath = join(root, 'race.db');
  const dbA = setupDb(dbPath);
  const dbB = setupDb(dbPath);
  try {
    // Seed: two open facts for (sean, role).
    dbA.prepare(
      'INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,?)'
    ).run(1, 'sean', 'role', 'founder', '2024-01-01T00:00:00Z', null);
    dbA.prepare(
      'INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to) VALUES (?,?,?,?,?,?)'
    ).run(2, 'sean', 'role', 'cto', '2023-01-01T00:00:00Z', null);

    // Simulate the race: B closes the winner BEFORE A calls resolve.
    dbB.prepare("UPDATE facts SET valid_to = '2024-06-01T00:00:00Z' WHERE id = 1").run();

    const r = await handleIjfwBrain({
      verb: 'conflict.resolve',
      args: { subject: 'sean', predicate: 'role', winnerId: 1 },
      db: dbA,
      repoRoot: root,
    });
    assert.equal(r.ok, false, 'must reject when winner closed cross-connection');
    assert.equal(r.error, 'winner-not-found-or-already-closed');

    // The loser (id=2) must be untouched — the atomic verify must have
    // aborted BEFORE the close-the-losers UPDATE.
    const stillOpen = dbA.prepare("SELECT id FROM facts WHERE valid_to IS NULL").all().map(r => r.id);
    assert.deepEqual(stillOpen, [2], 'losers untouched after rejected resolve');
  } finally {
    dbA.close();
    dbB.close();
    rmSync(root, { recursive: true, force: true });
  }
});
