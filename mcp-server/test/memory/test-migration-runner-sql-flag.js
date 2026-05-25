// v1.5.2.1 F3 regression test: migrations/ directory holds SQL migrations
// ONLY. fs-layout migrations live in ../layout-migrations/ (own namespace,
// own sequence, own registry). The runner rejects SQL=false and asserts the
// filename's numeric prefix matches the exported VERSION.
//
// History: at v1.5.2 this file tested the *opposite* invariant — that the
// runner silently skipped SQL=false files in the SAME directory. That
// escape hatch was the F3 root cause: a copy-paste mistake on a future SQL
// migration would brick the schema. v1.5.2.1 moves fs-layout to its own
// directory and turns the skip into a loud reject.
//
// This test asserts that:
//   1. Every file in migrations/ matches the SQL contract (VERSION + up).
//   2. No file declares SQL=false (those belong in layout-migrations/).
//   3. Filename numeric prefix equals the exported VERSION.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'memory', 'migrations'
);

test('migrations/: every file matches VERSION+up contract; no SQL=false files', async () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => /^\d+-.+\.js$/.test(f));
  assert.ok(files.length > 0, 'at least one SQL migration must exist');
  for (const f of files) {
    const mod = await import(pathToFileURL(join(MIGRATIONS_DIR, f)).href);
    assert.equal(mod.SQL, undefined, `${f}: SQL property forbidden in SQL migrations dir`);
    assert.equal(typeof mod.VERSION, 'number', `${f}: must export VERSION (number)`);
    assert.equal(typeof mod.up, 'function', `${f}: must export up()`);
    const prefix = parseInt(f.match(/^(\d+)/)[1], 10);
    assert.equal(prefix, mod.VERSION,
      `${f}: filename prefix ${prefix} must match exported VERSION ${mod.VERSION}`);
  }
});
