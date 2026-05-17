#!/usr/bin/env node
/**
 * test-cross-ide-conflict.js — IJFW v1.4.3 W9-B (B18)
 *
 * Coverage:
 *  1. legitimate hand-off (codex's last-seen earlier than active.activated_at) → divergent=false
 *  2. true divergence (claude wrote at T while codex was here at T-10) → divergent=true
 *  3. same IDE re-reads → divergent=false
 *  4. last-seen file >30 days old gets unlinked on read
 *  5. --strict-ide refuses when divergent
 *  6. non-strict (default) — warning surfaced but proceeds
 *  7. pre-v1.4.3 active.json (no activated_by_ide) → divergent=false; no error
 *  8. runtime-mediator.maybeWarnDivergence emits stderr warning on divergent state
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod } from 'node:fs/promises';
import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeActiveExtension,
  detectCrossIdeDivergence,
  __testing,
} from './src/active-extension-writer.js';
import { maybeWarnDivergence } from './src/runtime-mediator.js';
import { _resetIdeCacheForTest } from './src/ide-detect.js';
import * as activeCli from './src/dispatch/active-cli.js';

async function makeTmp(label) {
  return mkdtemp(join(tmpdir(), `ijfw-xide-${label}-`));
}

async function cleanup(dir) {
  try { await chmod(dir, 0o700); } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function withHome(label, fn) {
  const home = await makeTmp(label);
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    await cleanup(home);
  }
}

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then((rr) => ({ result: rr, stderr: lines.join('') }))
        .finally(() => { process.stderr.write = orig; });
    }
    process.stderr.write = orig;
    return Promise.resolve({ result: r, stderr: lines.join('') });
  } catch (err) {
    process.stderr.write = orig;
    throw err;
  }
}

async function writeActive(home, name, ide, activatedAt) {
  const dir = join(home, '.ijfw', 'state');
  await mkdir(dir, { recursive: true });
  const body = {
    name,
    scope: 'project',
    permissions: { reads: [], writes: [] },
    activated_at: activatedAt,
  };
  if (ide) {
    body.activated_by_ide = ide;
    body.activated_by_pid = 99999;
  }
  await writeFile(join(dir, 'active-extension.json'), JSON.stringify(body, null, 2), 'utf8');
}

async function writeLastSeenFile(home, ide, lastSeenAt) {
  const dir = join(home, '.ijfw', 'state');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `last-seen-by-${ide}.json`),
    JSON.stringify({ ide, last_seen_at: lastSeenAt }, null, 2),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// 1. legitimate hand-off
// ---------------------------------------------------------------------------
//
// Design rule: divergent iff active.activated_at < currentIde.last_seen.
//
// Legitimate hand-off pattern: codex was last here at T=1, then claude wrote
// active.json at T=2. activated_at(2) > last_seen(1) → NOT divergent: claude
// legitimately took over while codex was away.
test('legitimate hand-off: claude wrote AFTER codex was last here → divergent=false', async () => {
  await withHome('legit', async (home) => {
    // codex was last here at T=1
    await writeLastSeenFile(home, 'codex', '2026-05-15T00:00:01.000Z');
    // claude wrote LATER at T=2
    await writeActive(home, 'ext-1', 'claude', '2026-05-15T00:00:02.000Z');
    const v = await detectCrossIdeDivergence({ homeDir: home, currentIde: 'codex' });
    assert.equal(v.divergent, false, `expected non-divergent (legit handoff), got ${JSON.stringify(v)}`);
    assert.equal(v.last_writer, 'claude');
    assert.equal(v.current_ide, 'codex');
  });
});

// ---------------------------------------------------------------------------
// 2. true divergence
// ---------------------------------------------------------------------------
//
// True divergence pattern: claude wrote active.json at T=1, then codex came in
// and touched state at T=2 (recording its own last-seen), but the active.json
// was never refreshed by codex. activated_at(1) < last_seen(2) → divergent:
// stale state from before codex's last visit, never updated.
test('true divergence: codex last-seen is MORE RECENT than active → divergent=true', async () => {
  await withHome('true-div', async (home) => {
    // claude wrote active at T=1
    await writeActive(home, 'ext-1', 'claude', '2026-05-15T00:00:01.000Z');
    // codex last-seen LATER at T=2 — codex was here since claude's write
    // without refreshing active.json.
    await writeLastSeenFile(home, 'codex', '2026-05-15T00:00:02.000Z');
    const v = await detectCrossIdeDivergence({ homeDir: home, currentIde: 'codex' });
    assert.equal(v.divergent, true, `expected divergent, got ${JSON.stringify(v)}`);
    assert.equal(v.last_writer, 'claude');
    assert.equal(v.current_ide, 'codex');
    assert.ok(typeof v.age_seconds === 'number');
  });
});

// ---------------------------------------------------------------------------
// 3. same IDE re-reads
// ---------------------------------------------------------------------------
test('same IDE re-reads → divergent=false', async () => {
  await withHome('same-ide', async (home) => {
    await writeActive(home, 'ext-2', 'claude', '2026-05-15T00:00:00.000Z');
    await writeLastSeenFile(home, 'claude', '2026-05-15T00:00:01.000Z');
    const v = await detectCrossIdeDivergence({ homeDir: home, currentIde: 'claude' });
    assert.equal(v.divergent, false);
    assert.equal(v.last_writer, 'claude');
    assert.equal(v.current_ide, 'claude');
  });
});

// ---------------------------------------------------------------------------
// 4. stale last-seen file (>30 days) cleanup
// ---------------------------------------------------------------------------
test('last-seen file rotation: file with mtime > 30 days old gets unlinked on read', async () => {
  await withHome('stale', async (home) => {
    await writeLastSeenFile(home, 'gemini', '2026-04-01T00:00:00.000Z');
    const stalePath = join(home, '.ijfw', 'state', 'last-seen-by-gemini.json');
    // Backdate mtime 40 days.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(stalePath, fortyDaysAgo, fortyDaysAgo);
    // Drive a divergence check — this triggers cleanupStaleLastSeen.
    await detectCrossIdeDivergence({ homeDir: home, currentIde: 'codex' });
    // Stale file should now be gone.
    let exists = true;
    try { await stat(stalePath); } catch (err) { if (err.code === 'ENOENT') exists = false; }
    assert.equal(exists, false, 'stale gemini last-seen file should have been unlinked');
  });
});

test('cleanupStaleLastSeen direct call returns count', async () => {
  await withHome('stale-direct', async (home) => {
    await writeLastSeenFile(home, 'ide-a', '2026-01-01T00:00:00.000Z');
    await writeLastSeenFile(home, 'ide-b', '2026-01-01T00:00:00.000Z');
    const staleP1 = join(home, '.ijfw', 'state', 'last-seen-by-ide-a.json');
    const staleP2 = join(home, '.ijfw', 'state', 'last-seen-by-ide-b.json');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(staleP1, old, old);
    await utimes(staleP2, old, old);
    const removed = await __testing.cleanupStaleLastSeen({ homeDir: home });
    assert.equal(removed, 2);
  });
});

// ---------------------------------------------------------------------------
// 5. --strict-ide refuses when divergent
// ---------------------------------------------------------------------------
test('--strict-ide refuses activation when divergent', async () => {
  await withHome('strict', async (home) => {
    // Plant the to-be-activated extension manifest in user scope.
    const extDir = join(home, '.ijfw', 'extensions-user', 'my-ext');
    await mkdir(extDir, { recursive: true });
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({ name: 'my-ext', permissions: { reads: [], writes: [] } }),
      'utf8',
    );
    // Set up divergence: claude wrote active, then codex was last-seen LATER.
    await writeActive(home, 'other-ext', 'claude', '2026-05-15T00:00:01.000Z');
    await writeLastSeenFile(home, 'codex', '2026-05-15T00:00:02.000Z');

    const r = await activeCli.handlers.activate(
      ['my-ext', '--ide', 'codex', '--strict-ide'],
      { homedir: home, projectRoot: home },
    );
    assert.equal(r.ok, false, `expected refusal, got: ${JSON.stringify(r)}`);
    assert.match(r.error, /strict-ide/);
    assert.match(r.error, /claude/);
  });
});

// ---------------------------------------------------------------------------
// 6. non-strict default proceeds even when divergent
// ---------------------------------------------------------------------------
test('non-strict default: activation proceeds when divergent', async () => {
  await withHome('non-strict', async (home) => {
    const extDir = join(home, '.ijfw', 'extensions-user', 'my-ext');
    await mkdir(extDir, { recursive: true });
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({ name: 'my-ext', permissions: { reads: [], writes: [] } }),
      'utf8',
    );
    await writeLastSeenFile(home, 'codex', '2026-05-15T00:00:01.000Z');
    await writeActive(home, 'other-ext', 'claude', '2026-05-15T00:00:02.000Z');

    const r = await activeCli.handlers.activate(
      ['my-ext', '--ide', 'codex'],
      { homedir: home, projectRoot: home },
    );
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r)}`);
    // Verify stamp landed.
    const written = JSON.parse(await readFile(join(home, '.ijfw', 'state', 'active-extension.json'), 'utf8'));
    assert.equal(written.activated_by_ide, 'codex');
    assert.equal(written.name, 'my-ext');
  });
});

// ---------------------------------------------------------------------------
// 7. pre-v1.4.3 back-compat
// ---------------------------------------------------------------------------
test('pre-v1.4.3 active.json (no activated_by_ide) → divergent=false; no error', async () => {
  await withHome('pre-v143', async (home) => {
    // Write active.json WITHOUT activated_by_ide.
    const dir = join(home, '.ijfw', 'state');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'active-extension.json'),
      JSON.stringify({
        name: 'old-ext',
        scope: 'project',
        permissions: { reads: [], writes: [] },
        activated_at: '2026-05-01T00:00:00.000Z',
      }),
      'utf8',
    );
    const v = await detectCrossIdeDivergence({ homeDir: home, currentIde: 'codex' });
    assert.equal(v.divergent, false);
    assert.equal(v.last_writer, null);
  });
});

// ---------------------------------------------------------------------------
// 8. runtime-mediator maybeWarnDivergence emits stderr on divergence
// ---------------------------------------------------------------------------
test('runtime-mediator.maybeWarnDivergence emits stderr warning on divergent state', async () => {
  await withHome('rt-warn', async (home) => {
    // Set up divergence as in test 2.
    await writeActive(home, 'ext-z', 'claude', '2026-05-15T00:00:01.000Z');
    await writeLastSeenFile(home, 'codex', '2026-05-15T00:00:02.000Z');
    // Force currentIde=codex via env override + cache reset.
    _resetIdeCacheForTest();
    const prev = process.env.IJFW_IDE_ID;
    process.env.IJFW_IDE_ID = 'codex';
    try {
      const cap = await captureStderr(() => maybeWarnDivergence({ homeDir: home }));
      assert.equal(cap.result.divergent, true);
      assert.match(cap.stderr, /last activated by 'claude'/);
      assert.match(cap.stderr, /this IDE is 'codex'/);
    } finally {
      if (prev === undefined) delete process.env.IJFW_IDE_ID; else process.env.IJFW_IDE_ID = prev;
      _resetIdeCacheForTest();
    }
  });
});

test('runtime-mediator.maybeWarnDivergence emits no stderr when not divergent', async () => {
  await withHome('rt-quiet', async (home) => {
    // Same IDE wrote active.json as is currently running.
    await writeActive(home, 'ext-z', 'codex', '2026-05-15T00:00:00.000Z');
    _resetIdeCacheForTest();
    const prev = process.env.IJFW_IDE_ID;
    process.env.IJFW_IDE_ID = 'codex';
    try {
      const cap = await captureStderr(() => maybeWarnDivergence({ homeDir: home }));
      assert.equal(cap.result.divergent, false);
      // No divergence warning line.
      assert.equal(/last activated by/.test(cap.stderr), false, `unexpected stderr: ${cap.stderr}`);
    } finally {
      if (prev === undefined) delete process.env.IJFW_IDE_ID; else process.env.IJFW_IDE_ID = prev;
      _resetIdeCacheForTest();
    }
  });
});

// ---------------------------------------------------------------------------
// active-cli wiring sanity
// ---------------------------------------------------------------------------
test('dispatch/active-cli.js exports frozen handlers + subcommandHelp', () => {
  assert.equal(typeof activeCli.handlers, 'object');
  assert.equal(typeof activeCli.handlers.active, 'function');
  assert.equal(typeof activeCli.handlers.activate, 'function');
  assert.equal(typeof activeCli.subcommandHelp, 'object');
  assert.ok(Object.isFrozen(activeCli.handlers));
  assert.ok(Object.isFrozen(activeCli.subcommandHelp));
});

test('active --check reports current state JSON', async () => {
  await withHome('active-check', async (home) => {
    await writeActive(home, 'ext-c', 'claude', '2026-05-15T00:00:00.000Z');
    _resetIdeCacheForTest();
    const prev = process.env.IJFW_IDE_ID;
    process.env.IJFW_IDE_ID = 'claude';
    try {
      const r = await activeCli.handlers.active(['--check'], { homedir: home });
      assert.equal(r.ok, true);
      const parsed = JSON.parse(r.output);
      assert.equal(parsed.active.name, 'ext-c');
      assert.equal(parsed.current_ide, 'claude');
      assert.equal(parsed.divergent, false);
    } finally {
      if (prev === undefined) delete process.env.IJFW_IDE_ID; else process.env.IJFW_IDE_ID = prev;
      _resetIdeCacheForTest();
    }
  });
});

test('writeActiveExtension with opts.ideId stamps activated_by_ide + activated_by_pid', async () => {
  await withHome('stamp', async (home) => {
    const r = await writeActiveExtension(
      { name: 'stamped', permissions: { reads: [], writes: [] } },
      'user',
      { homeDir: home, ideId: 'claude' },
    );
    assert.equal(r.ok, true);
    const written = JSON.parse(await readFile(r.path, 'utf8'));
    assert.equal(written.activated_by_ide, 'claude');
    assert.equal(typeof written.activated_by_pid, 'number');
    assert.ok(written.activated_by_pid > 0);
  });
});

test('writeActiveExtension WITHOUT opts.ideId omits stamp fields (back-compat)', async () => {
  await withHome('no-stamp', async (home) => {
    const r = await writeActiveExtension(
      { name: 'plain', permissions: { reads: [], writes: [] } },
      'user',
      { homeDir: home },
    );
    assert.equal(r.ok, true);
    const written = JSON.parse(await readFile(r.path, 'utf8'));
    assert.equal(written.activated_by_ide, undefined);
    assert.equal(written.activated_by_pid, undefined);
    assert.ok(typeof written.activated_at === 'string');
  });
});
