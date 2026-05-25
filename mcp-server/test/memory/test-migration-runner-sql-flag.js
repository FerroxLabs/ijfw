// v1.5.2.1 F1 regression test: migration-runner must skip files that
// export `SQL = false`. fs-layout migrations (e.g. 010-visible-layer.js)
// live in the same migrations/ directory as SQL migrations but expect a
// repoRoot string rather than a Database handle. Without the SQL=false
// filter, the runner would call up(db) on them and crash with
// 'TypeError: Path must be a string. Received <Database>' the first time
// any memory db opened on an install with user_version < 10.
//
// This test asserts that:
//   1. loadMigrations() does NOT return 010-visible-layer.js (the only
//      SQL=false file in the directory at v1.5.2.1).
//   2. highestKnownVersion() does NOT include 010's VERSION=10 — the
//      reported version reflects only SQL migrations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, highestKnownVersion } from '../../src/memory/migration-runner.js';

test('loadMigrations skips files that export SQL = false (010-visible-layer)', async () => {
  const migrations = await loadMigrations();
  const files = migrations.map((m) => m.file);
  assert.ok(
    !files.includes('010-visible-layer.js'),
    `010-visible-layer.js (SQL=false) must NOT appear in loadMigrations() result; got: ${JSON.stringify(files)}`,
  );
});

test('highestKnownVersion does not advance to 10 because of the fs-layout migration', async () => {
  const v = await highestKnownVersion();
  // 010 is SQL=false; the highest SQL migration is whatever the last
  // numbered SQL migration before 010 is. The exact number can change as
  // new SQL migrations land — what matters is that v is NEVER 10. If it
  // ever equals 10, the SQL=false skip stopped working and every memory
  // db open on a v1.5.1 install will crash.
  assert.notEqual(v, 10, 'highestKnownVersion() must not equal 10; 010 is fs-layout, not SQL');
});

test('loadMigrations returns at least the v1.5.0-era SQL migrations', async () => {
  // Sanity check: SQL migrations DO get loaded — the SQL=false filter is
  // not throwing the baby out with the bathwater. If this test ever
  // returns an empty list, the filter logic in the runner regressed.
  const migrations = await loadMigrations();
  assert.ok(migrations.length > 0, 'expected at least one SQL migration; got empty list');
  for (const m of migrations) {
    assert.equal(typeof m.version, 'number', `migration ${m.file} version must be a number`);
    assert.equal(typeof m.up, 'function', `migration ${m.file} up must be a function`);
  }
});
