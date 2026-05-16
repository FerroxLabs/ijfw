#!/usr/bin/env node
/**
 * test-runtime-mediator.js -- IJFW 1.4.0 W7/B2
 *
 * Coverage:
 *  - getActiveExtension: absent | well-formed | malformed json | shape-incomplete
 *  - checkPermission: bundled (null) | malformed | match | miss | glob '*' |
 *    prefix glob 'memory:*' | wrong-action
 *  - toolNameToActionTarget: known tools | ijfw_run colon-parse | unknown
 *  - logPermissionEvent: append | safe under read-only HOME
 *
 * HOME isolation: every state-touching test swaps process.env.HOME to a
 * fresh mkdtemp dir for the duration of the test, then restores. No real
 * ~/.ijfw is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getActiveExtension,
  checkPermission,
  logPermissionEvent,
  toolNameToActionTarget,
} from './src/runtime-mediator.js';

async function makeTmp(label) {
  return mkdtemp(join(tmpdir(), `ijfw-rt-med-${label}-`));
}

async function cleanup(dir) {
  // Best effort: re-grant write in case a test made it read-only.
  try { await chmod(dir, 0o700); } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function withIsolatedHome(fn) {
  const fakeHome = await makeTmp('home');
  const prev = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return await fn(fakeHome);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await cleanup(fakeHome);
  }
}

async function seedState(home, contents) {
  const dir = join(home, '.ijfw', 'state');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'active-extension.json'), contents, 'utf8');
}

// -- getActiveExtension ----------------------------------------------------

test('getActiveExtension returns null when state file is absent', async () => {
  await withIsolatedHome(async (home) => {
    const r = await getActiveExtension({ homeDir: home });
    assert.equal(r, null);
  });
});

test('getActiveExtension returns parsed extension when state file is well-formed', async () => {
  await withIsolatedHome(async (home) => {
    const ext = {
      name: 'demo-ext',
      scope: 'project',
      permissions: { reads: ['memory:read'], writes: ['memory:write'] },
    };
    await seedState(home, JSON.stringify(ext));
    const r = await getActiveExtension({ homeDir: home });
    assert.equal(r.name, 'demo-ext');
    assert.equal(r.scope, 'project');
    assert.deepEqual(r.permissions.reads, ['memory:read']);
    assert.deepEqual(r.permissions.writes, ['memory:write']);
  });
});

test('getActiveExtension returns __malformed when JSON is invalid', async () => {
  await withIsolatedHome(async (home) => {
    await seedState(home, '{ this is not json');
    const r = await getActiveExtension({ homeDir: home });
    assert.equal(r && r.__malformed, true);
  });
});

test('getActiveExtension returns __malformed when shape is incomplete (missing permissions)', async () => {
  await withIsolatedHome(async (home) => {
    await seedState(home, JSON.stringify({ name: 'bad-ext', scope: 'project' }));
    const r = await getActiveExtension({ homeDir: home });
    assert.equal(r && r.__malformed, true);
  });
});

test('getActiveExtension returns __malformed when reads/writes are not arrays', async () => {
  await withIsolatedHome(async (home) => {
    await seedState(home, JSON.stringify({
      name: 'bad-ext',
      permissions: { reads: 'memory:read', writes: ['memory:write'] },
    }));
    const r = await getActiveExtension({ homeDir: home });
    assert.equal(r && r.__malformed, true);
  });
});

// -- checkPermission -------------------------------------------------------

test('checkPermission: null activeExt (bundled) -> allowed for all', () => {
  const r1 = checkPermission('read', 'memory:read', null);
  const r2 = checkPermission('write', 'memory:write', null);
  const r3 = checkPermission('write', 'anything:goes', null);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
});

test('checkPermission: __malformed -> denied', () => {
  const r = checkPermission('read', 'memory:read', { __malformed: true });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /malformed/);
});

test('checkPermission: write target in writes list -> allowed', () => {
  const ext = {
    name: 'x',
    permissions: { reads: [], writes: ['memory:write'] },
  };
  const r = checkPermission('write', 'memory:write', ext);
  assert.equal(r.allowed, true);
});

test('checkPermission: write target NOT in writes list -> denied', () => {
  const ext = {
    name: 'x',
    permissions: { reads: ['memory:read'], writes: ['memory:write'] },
  };
  const r = checkPermission('write', 'update:apply', ext);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not permitted/);
});

test("checkPermission: glob '*' in writes -> all writes allowed", () => {
  const ext = {
    name: 'x',
    permissions: { reads: [], writes: ['*'] },
  };
  const r1 = checkPermission('write', 'memory:write', ext);
  const r2 = checkPermission('write', 'update:apply', ext);
  const r3 = checkPermission('write', 'run:compute', ext);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
});

test("checkPermission: prefix glob 'memory:*' matches 'memory:write'", () => {
  const ext = {
    name: 'x',
    permissions: { reads: ['memory:*'], writes: ['memory:*'] },
  };
  const r1 = checkPermission('write', 'memory:write', ext);
  const r2 = checkPermission('read', 'memory:read', ext);
  const r3 = checkPermission('write', 'update:apply', ext);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
});

test('checkPermission: read action against writes list -> denied (wrong action)', () => {
  // writes contains 'memory:write' but caller is asking for 'read' action.
  // The 'read' action consults permissions.reads only.
  const ext = {
    name: 'x',
    permissions: { reads: [], writes: ['memory:write', 'memory:read'] },
  };
  const r = checkPermission('read', 'memory:read', ext);
  assert.equal(r.allowed, false);
});

// -- toolNameToActionTarget ------------------------------------------------

test('toolNameToActionTarget: maps known tool names correctly', () => {
  assert.deepEqual(toolNameToActionTarget('ijfw_memory_store', {}), {
    action: 'write', target: 'memory:write',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_memory_recall', {}), {
    action: 'read', target: 'memory:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_memory_search', {}), {
    action: 'read', target: 'memory:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_memory_status', {}), {
    action: 'read', target: 'memory:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_memory_prelude', {}), {
    action: 'read', target: 'memory:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_cross_project_search', {}), {
    action: 'read', target: 'memory:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_metrics', {}), {
    action: 'read', target: 'metrics:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_update_check', {}), {
    action: 'read', target: 'update:check',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_update_apply', {}), {
    action: 'write', target: 'update:apply',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_prompt_check', {}), {
    action: 'read', target: 'prompt:check',
  });

  // ijfw_run with colon-syntax command -> subject parsed from first token.
  assert.deepEqual(
    toolNameToActionTarget('ijfw_run', { command: 'compute:python foo.py' }),
    { action: 'write', target: 'run:compute' }
  );
  assert.deepEqual(
    toolNameToActionTarget('ijfw_run', { command: 'index:src' }),
    { action: 'write', target: 'run:index' }
  );
  // ijfw_run with non-colon-syntax command -> target run:*.
  assert.deepEqual(
    toolNameToActionTarget('ijfw_run', { command: 'ls -la' }),
    { action: 'write', target: 'run:*' }
  );
  // ijfw_run with no args -> target run:*.
  assert.deepEqual(
    toolNameToActionTarget('ijfw_run', {}),
    { action: 'write', target: 'run:*' }
  );
  assert.deepEqual(
    toolNameToActionTarget('ijfw_run', null),
    { action: 'write', target: 'run:*' }
  );
});

test('toolNameToActionTarget: unknown tool returns null', () => {
  assert.equal(toolNameToActionTarget('something_else', {}), null);
  assert.equal(toolNameToActionTarget('', {}), null);
});

// -- logPermissionEvent ----------------------------------------------------

test('logPermissionEvent appends one JSON line per call to permission-events.jsonl', async () => {
  await withIsolatedHome(async (home) => {
    const ev1 = {
      tool: 'ijfw_memory_store', extension: 'demo', action: 'write',
      target: 'memory:write', allowed: false, reason: 'nope',
      ts: '2026-05-16T00:00:00.000Z',
    };
    const ev2 = {
      tool: 'ijfw_memory_recall', extension: 'demo', action: 'read',
      target: 'memory:read', allowed: true, reason: 'matched memory:read',
      ts: '2026-05-16T00:00:01.000Z',
    };
    await logPermissionEvent(ev1, { homeDir: home });
    await logPermissionEvent(ev2, { homeDir: home });

    const logPath = join(home, '.ijfw', 'state', 'permission-events.jsonl');
    const contents = await readFile(logPath, 'utf8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), ev1);
    assert.deepEqual(JSON.parse(lines[1]), ev2);
  });
});

test('logPermissionEvent never throws even if HOME is read-only', async () => {
  await withIsolatedHome(async (home) => {
    // Make the home dir itself read-only so mkdir of ~/.ijfw/state fails.
    await chmod(home, 0o500);
    try {
      // Must complete without throwing.
      await logPermissionEvent({
        tool: 'ijfw_memory_store', extension: 'demo', action: 'write',
        target: 'memory:write', allowed: false, reason: 'nope',
        ts: '2026-05-16T00:00:00.000Z',
      }, { homeDir: home });
      // If we reach here without throwing, the test passes.
      assert.ok(true);
    } finally {
      await chmod(home, 0o700);
    }
  });
});
