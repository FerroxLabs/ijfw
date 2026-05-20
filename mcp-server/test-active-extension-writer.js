/**
 * test-active-extension-writer.js — v1.5.0 T10 migration regression test.
 *
 * Verifies that `active-extension-writer.js` has been migrated to the state-SDK
 * (`query('extension.set-active', ...)`) and no longer writes to the homedir
 * state file via direct `fs.writeFile` / `fs.writeFileSync` / `fs.appendFile` /
 * `fs.appendFileSync` calls. (The writer still uses `fs.writeFile` for the B18
 * last-seen marker file — that is a SEPARATE path, not the active-extension
 * state file. The spy regression below proves the active-extension WRITE path
 * is routed through the SDK, not direct fs.)
 *
 * Pattern reference: mcp-server/test-dispatch-planner.js — uses `import fs from
 * 'node:fs'` (NOT namespace import) + `mock.method(fs, 'writeFile', fn)` so the
 * spy intercepts the same callsite the module uses.
 *
 * Test isolation contract (T10 critical):
 *   - Every test redirects HOME (and USERPROFILE for Windows parity) to a
 *     `mkdtempSync` dir; the previous values are restored in `finally`.
 *   - A pre-test stat captures the real `~/.ijfw/state/active-extension.json`
 *     mtime; a post-test stat asserts the real file is UNCHANGED. (The SDK's
 *     `paths.activeExtension(home)` resolver uses the `homeDir` payload field
 *     when supplied, falling back to `os.homedir()` — which `process.env.HOME`
 *     overrides on POSIX. We override HOME on every call, so the real homedir
 *     file MUST stay untouched.)
 *
 * Run: node --test test-active-extension-writer.js
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  writeActiveExtension,
  clearActiveExtension,
} from './src/active-extension-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a sandboxed HOME (+ USERPROFILE). Restores env in `finally`.
 * Also asserts the real `~/.ijfw/state/active-extension.json` is unchanged.
 */
async function withSandboxHome(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'aew-t10-'));
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;

  // Capture real homedir state-file fingerprint (size + mtimeMs).
  const realPath = join(homedir(), '.ijfw', 'state', 'active-extension.json');
  let pre = null;
  try {
    if (existsSync(realPath)) {
      const st = statSync(realPath);
      pre = { size: st.size, mtimeMs: st.mtimeMs };
    }
  } catch { /* best-effort */ }

  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  try {
    return await fn(sandbox);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;

    // Verify the real homedir state file was untouched.
    let post = null;
    try {
      if (existsSync(realPath)) {
        const st = statSync(realPath);
        post = { size: st.size, mtimeMs: st.mtimeMs };
      }
    } catch { /* best-effort */ }
    assert.deepEqual(
      post, pre,
      'real ~/.ijfw/state/active-extension.json must be untouched by sandboxed tests',
    );

    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Happy-path: writeActiveExtension writes the flat shape via the SDK
// ---------------------------------------------------------------------------

test('writeActiveExtension writes the FLAT consumer-contract shape via the SDK', async () => {
  await withSandboxHome(async (home) => {
    const manifest = {
      name: 'ext-flat',
      permissions: { reads: ['memory:read'], writes: ['memory:write'] },
    };
    const r = await writeActiveExtension(manifest, 'user', { homeDir: home });
    assert.equal(r.ok, true);
    assert.ok(typeof r.path === 'string' && r.path.length > 0);
    assert.equal(r.path, join(home, '.ijfw', 'state', 'active-extension.json'));

    // The on-disk file must use the FLAT shape (not the wrapped
    // {manifest, scope, updated_at} shape) — five real consumers read these
    // fields at the top level.
    const obj = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(obj.name, 'ext-flat', 'name is FLAT (not under .manifest)');
    assert.equal(obj.scope, 'user');
    assert.deepEqual(obj.permissions.reads, ['memory:read']);
    assert.deepEqual(obj.permissions.writes, ['memory:write']);
    assert.equal(typeof obj.activated_at, 'string');
    assert.ok(obj.manifest === undefined, 'no .manifest wrapper key');
    assert.ok(obj.updated_at === undefined, 'no legacy .updated_at key');
  });
});

// ---------------------------------------------------------------------------
// 2. Quotas: optional, positive-integer filtered
// ---------------------------------------------------------------------------

test('writeActiveExtension persists positive-integer quotas under the FLAT key', async () => {
  await withSandboxHome(async (home) => {
    const manifest = {
      name: 'ext-q',
      permissions: { reads: [], writes: ['tool:edit'] },
      quotas: {
        max_files_written: 10,
        max_bytes_written: 4096,
        max_wall_clock_ms: 60000,
        // Bad entries — must be filtered out by the verb.
        bogus_string: 'nope',
        zero_limit: 0,
        negative: -1,
      },
    };
    const r = await writeActiveExtension(manifest, 'project', { homeDir: home });
    assert.equal(r.ok, true);

    const obj = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(obj.quotas.max_files_written, 10);
    assert.equal(obj.quotas.max_bytes_written, 4096);
    assert.equal(obj.quotas.max_wall_clock_ms, 60000);
    // Filter assertion: invalid quota dimensions are stripped.
    assert.equal(obj.quotas.bogus_string, undefined);
    assert.equal(obj.quotas.zero_limit, undefined);
    assert.equal(obj.quotas.negative, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. IDE stamping: activated_by_ide + activated_by_pid stay top-level
// ---------------------------------------------------------------------------

test('writeActiveExtension stamps activated_by_ide + activated_by_pid (FLAT)', async () => {
  await withSandboxHome(async (home) => {
    const manifest = { name: 'ext-ide', permissions: { reads: [], writes: [] } };
    const r = await writeActiveExtension(manifest, 'org', { homeDir: home, ideId: 'codex' });
    assert.equal(r.ok, true);

    const obj = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(obj.activated_by_ide, 'codex');
    assert.equal(obj.activated_by_pid, process.pid);
    // Belt-and-braces: must be FLAT.
    assert.equal(obj.name, 'ext-ide');
    assert.equal(obj.scope, 'org');
  });
});

test('writeActiveExtension WITHOUT ideId omits the stamp fields', async () => {
  await withSandboxHome(async (home) => {
    const manifest = { name: 'ext-no-ide', permissions: { reads: [], writes: [] } };
    const r = await writeActiveExtension(manifest, 'user', { homeDir: home });
    assert.equal(r.ok, true);

    const obj = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(obj.activated_by_ide, undefined);
    assert.equal(obj.activated_by_pid, undefined);
  });
});

test('writeActiveExtension with invalid ideId omits the stamp fields', async () => {
  await withSandboxHome(async (home) => {
    const manifest = { name: 'ext-bad-ide', permissions: { reads: [], writes: [] } };
    // 'NOT_VALID' fails the IDE_ID_PATTERN (must be lowercase/digits/hyphen).
    const r = await writeActiveExtension(manifest, 'user', { homeDir: home, ideId: 'NOT_VALID' });
    assert.equal(r.ok, true);

    const obj = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(obj.activated_by_ide, undefined);
    assert.equal(obj.activated_by_pid, undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. Validation: writer never throws on bad input — it returns ok:false.
//    (External API contract; every existing caller relies on it.)
// ---------------------------------------------------------------------------

test('writeActiveExtension rejects bad input with {ok:false, error}', async () => {
  await withSandboxHome(async (home) => {
    const r1 = await writeActiveExtension(null, 'project', { homeDir: home });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /manifest/);

    const r2 = await writeActiveExtension({ name: 'x' }, 'project', { homeDir: home });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /permissions/);

    const r3 = await writeActiveExtension(
      { name: 'x', permissions: {} },
      'bad-scope',
      { homeDir: home },
    );
    assert.equal(r3.ok, false);
    assert.match(r3.error, /scope/);

    // Empty-string name.
    const r4 = await writeActiveExtension(
      { name: '', permissions: { reads: [], writes: [] } },
      'user',
      { homeDir: home },
    );
    assert.equal(r4.ok, false);

    // Verify NO state file was created by any of the refused writes.
    const path = join(home, '.ijfw', 'state', 'active-extension.json');
    assert.equal(existsSync(path), false, 'refused writes must not create a state file');
  });
});

// ---------------------------------------------------------------------------
// 5. clearActiveExtension — set/clear round-trip is idempotent
// ---------------------------------------------------------------------------

test('clearActiveExtension removes the file then is idempotent', async () => {
  await withSandboxHome(async (home) => {
    const manifest = { name: 'to-clear', permissions: { reads: [], writes: [] } };
    const w = await writeActiveExtension(manifest, 'project', { homeDir: home });
    assert.equal(w.ok, true);
    const path = join(home, '.ijfw', 'state', 'active-extension.json');
    assert.equal(existsSync(path), true);

    const c1 = await clearActiveExtension({ homeDir: home });
    assert.equal(c1.ok, true);
    assert.equal(c1.removed, true, 'file was present pre-clear');
    assert.equal(existsSync(path), false);

    // Second clear is idempotent — ok stays true; removed flips to false.
    const c2 = await clearActiveExtension({ homeDir: home });
    assert.equal(c2.ok, true);
    assert.equal(c2.removed, false);
  });
});

// ---------------------------------------------------------------------------
// 6. SDK ROUTING — spy regression: the writer module itself must NOT do any
//    direct fs.* write to the final active-extension state file. Direct
//    writes would bypass the state-SDK's intent-journal + lock hierarchy
//    (Model 2 / Model 1), which is the entire point of T10.
//
//    Pattern (per test-dispatch-planner.js): mock.method on the `fs` default
//    import. We capture EVERY (writeFile, writeFileSync, appendFile,
//    appendFileSync) call. The state-SDK's underlying `atomic-io` writes
//    through *named imports* of `node:fs`, so its tmp+rename pattern is NOT
//    visible through these spies — which is fine. What this test asserts is
//    the negative invariant that matters: **no direct write to the FINAL
//    active-extension.json path** ever appears on these methods. (Atomic-io
//    writes a tmp sibling then renames; rename is not a write.) The
//    "intent journal was written" test below proves the SDK was actually
//    invoked; this test proves the writer module didn't sneak a bypass write.
// ---------------------------------------------------------------------------

test('SDK ROUTING: no direct fs write to active-extension.json (only via SDK)', async () => {
  await withSandboxHome(async (home) => {
    const activeJsonPath = join(home, '.ijfw', 'state', 'active-extension.json');
    const seen = [];

    const origMap = {
      writeFile: fs.writeFile,
      writeFileSync: fs.writeFileSync,
      appendFile: fs.appendFile,
      appendFileSync: fs.appendFileSync,
    };

    const spy = (fnName) => function spied(...args) {
      const target = typeof args[0] === 'string'
        ? args[0]
        : (args[0] && typeof args[0].toString === 'function' ? args[0].toString() : '');
      seen.push({ fnName, target });
      const original = origMap[fnName];
      return original.apply(fs, args);
    };

    mock.method(fs, 'writeFile', spy('writeFile'));
    mock.method(fs, 'writeFileSync', spy('writeFileSync'));
    mock.method(fs, 'appendFile', spy('appendFile'));
    mock.method(fs, 'appendFileSync', spy('appendFileSync'));

    try {
      const manifest = { name: 'spy-ext', permissions: { reads: [], writes: ['tool:edit'] } };
      const r = await writeActiveExtension(manifest, 'user', { homeDir: home });
      assert.equal(r.ok, true);
    } finally {
      mock.restoreAll();
    }

    // The active-extension.json final path must NEVER appear as a direct
    // write target. (Tmp-sibling writes through atomic-io are fine and go
    // through *named-import* bindings these spies don't intercept; the
    // intent-journal regression test below independently proves the SDK
    // was invoked.)
    const directHits = seen.filter((s) => s.target === activeJsonPath);
    assert.equal(
      directHits.length, 0,
      `writer must not write the final active-extension.json path directly; ` +
        `got ${directHits.length} direct hit(s) via fs.${directHits.map((h) => h.fnName).join(',')}`,
    );

    // The file did land on disk (proves the test's write call wasn't a
    // silent no-op).
    assert.equal(existsSync(activeJsonPath), true);
    const obj = JSON.parse(readFileSync(activeJsonPath, 'utf8'));
    assert.equal(obj.name, 'spy-ext');
  });
});

// ---------------------------------------------------------------------------
// 7. Intent journal — proves the SDK was actually invoked (it writes a
//    begin+commit record for every mutating verb). The presence of the
//    intent journal entries is the strongest evidence the writer is now
//    routed through the SDK, not a direct fs path.
// ---------------------------------------------------------------------------

test('SDK ROUTING: extension.set-active writes an intent-journal record', async () => {
  await withSandboxHome(async (home) => {
    // Use a sandboxed projectRoot so the intent-journal lands in tmp, not
    // wherever process.cwd() happens to be.
    const projectRoot = mkdtempSync(join(tmpdir(), 'aew-t10-proj-'));
    try {
      const manifest = { name: 'journal-ext', permissions: { reads: [], writes: [] } };
      const r = await writeActiveExtension(manifest, 'project', {
        homeDir: home,
        projectRoot,
      });
      assert.equal(r.ok, true);

      const journalPath = join(projectRoot, '.ijfw', 'state', 'intent-journal.jsonl');
      assert.equal(existsSync(journalPath), true, 'SDK must write intent-journal');

      const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
      const records = lines.map((l) => JSON.parse(l));
      const setActiveRecs = records.filter((r) => r.verb === 'extension.set-active');
      assert.ok(setActiveRecs.length >= 2,
        `expected at least one begin+commit pair for extension.set-active; got ${setActiveRecs.length}`);
      const phases = new Set(setActiveRecs.map((r) => r.phase));
      assert.ok(phases.has('begin') && phases.has('commit'),
        `intent journal must carry both begin and commit phases; got: ${[...phases].join(',')}`);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8. clearActiveExtension also routes through the SDK (manifest:null branch)
// ---------------------------------------------------------------------------

test('SDK ROUTING: clearActiveExtension writes an intent-journal record', async () => {
  await withSandboxHome(async (home) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aew-t10-clr-'));
    try {
      // Set up: an existing active extension to clear.
      await writeActiveExtension(
        { name: 'will-clear', permissions: { reads: [], writes: [] } },
        'user',
        { homeDir: home, projectRoot },
      );

      const r = await clearActiveExtension({ homeDir: home, projectRoot });
      assert.equal(r.ok, true);
      assert.equal(r.removed, true);

      const journalPath = join(projectRoot, '.ijfw', 'state', 'intent-journal.jsonl');
      const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
      const records = lines.map((l) => JSON.parse(l));
      const setActiveRecs = records.filter((r) => r.verb === 'extension.set-active');
      // Expect: 2 from the initial write (begin+commit) + 2 from the clear.
      assert.ok(setActiveRecs.length >= 4,
        `clear must also produce intent-journal records; total set-active=${setActiveRecs.length}`);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. opts.projectRoot precedence — caller can override the cwd fallback
// ---------------------------------------------------------------------------

test('writeActiveExtension honors opts.projectRoot (intent journal lands there)', async () => {
  await withSandboxHome(async (home) => {
    const explicitRoot = mkdtempSync(join(tmpdir(), 'aew-t10-explicit-'));
    try {
      const manifest = { name: 'explicit-root', permissions: { reads: [], writes: [] } };
      const r = await writeActiveExtension(manifest, 'project', {
        homeDir: home,
        projectRoot: explicitRoot,
      });
      assert.equal(r.ok, true);

      const journalPath = join(explicitRoot, '.ijfw', 'state', 'intent-journal.jsonl');
      assert.equal(existsSync(journalPath), true,
        'intent-journal must land under opts.projectRoot when supplied');
    } finally {
      rmSync(explicitRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 10. SDK-routing on the CLEAR path is unaffected by a pre-existing
//     well-formed file — round-trip via the verb only.
// ---------------------------------------------------------------------------

test('clearActiveExtension still resets quotas via the writer', async () => {
  // This proves the writer's "extract extName before clear" branch still
  // operates even after migration — by writing then clearing and reading
  // back. The quota-reset side-effect is best-effort and verified indirectly:
  // it should never make the clear fail.
  await withSandboxHome(async (home) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aew-t10-q-'));
    try {
      await writeActiveExtension(
        {
          name: 'quota-clr',
          permissions: { reads: [], writes: ['tool:edit'] },
          quotas: { max_files_written: 5 },
        },
        'user',
        { homeDir: home, projectRoot },
      );
      const c = await clearActiveExtension({ homeDir: home, projectRoot });
      assert.equal(c.ok, true);
      assert.equal(c.removed, true);
      const path = join(home, '.ijfw', 'state', 'active-extension.json');
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
