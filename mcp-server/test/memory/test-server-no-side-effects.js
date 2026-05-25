// v1.5.2.1 L-3 (Lens 1): regression test for the H-1 fix.
//
// Importing server.js MUST create zero filesystem artifacts in the
// importer's cwd. Prior to H-1, isWritable() write-probed cwd with
// `.ijfw-probe-<pid>-<ts>` and unlinked it — visible under inotify
// even when the importer's own readdir() returned []. After H-1 the
// probe is replaced with accessSync(W_OK), so this test asserts the
// stronger contract: AFTER import, the importer's cwd is empty.
//
// If this test ever fails, something else in server.js's top-level
// scope grew a write side effect — the same class of regression that
// breaks `node -e "import('.../server.js')"` for any host that
// watches its cwd (dev servers, file-sync daemons, etc.).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = resolve(__dirname, '..', '..', 'src', 'server.js');

test('importing server.js from a fresh cwd creates zero filesystem artifacts (H-1)', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'server-import-'));
  const prevCwd = process.cwd();
  process.chdir(sandbox);
  try {
    // Cache-busting query so a previous test-run's module cache cannot
    // mask a real regression.
    await import(`${SERVER_JS}?t=${Date.now()}`);
    const after = readdirSync(sandbox);
    assert.deepEqual(
      after,
      [],
      `expected empty sandbox after server.js import; got ${JSON.stringify(after)}`
    );
  } finally {
    process.chdir(prevCwd);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
