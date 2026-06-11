/**
 * test-mediator-tool-coverage.js -- audit fix: sandbox bypass via unmapped tools.
 *
 * Locks in two invariants:
 *   1. EVERY tool the server advertises has an explicit mapping in
 *      toolNameToActionTarget() -- including the four that previously had
 *      none (ijfw_memory_facts, ijfw_brain, ijfw_state,
 *      ijfw_cross_audit_converge) and ran with no permission/quota check
 *      while an extension was active.
 *   2. gatePermissionAndQuota() is fail-closed for unmapped tools whenever
 *      an extension descriptor is present (well-formed OR malformed), and
 *      stays allow-all when no extension is active (back-compat).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toolNameToActionTarget } from './src/runtime-mediator.js';
import { gatePermissionAndQuota } from './src/server.js';

async function makeTmp(label) {
  return mkdtemp(join(tmpdir(), `ijfw-tool-coverage-${label}-`));
}

async function cleanup(dir) {
  try { await chmod(dir, 0o700); } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function withIsolatedHome(label, fn) {
  const fakeHome = await makeTmp(label);
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return await fn(fakeHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    await cleanup(fakeHome);
  }
}

// Mirror of the names in server.js TOOLS. If a tool is added there without a
// mapping, the runtime gate now denies it under an active extension; update
// toolNameToActionTarget AND this list together.
const ADVERTISED_TOOLS = [
  'ijfw_memory_recall',
  'ijfw_memory_store',
  'ijfw_memory_search',
  'ijfw_memory_prelude',
  'ijfw_memory_facts',
  'ijfw_prompt_check',
  'ijfw_metrics',
  'ijfw_cross_project_search',
  'ijfw_run',
  'ijfw_brain',
  'ijfw_state',
  'ijfw_cross_audit_converge',
];

test('every advertised MCP tool has a (action, target) mapping', () => {
  for (const name of ADVERTISED_TOOLS) {
    const mapping = toolNameToActionTarget(name, {});
    assert.ok(mapping, `${name} must map to an (action, target) tuple`);
    assert.ok(mapping.action === 'read' || mapping.action === 'write', `${name} action`);
    assert.equal(typeof mapping.target, 'string');
  }
});

test('the four previously unmapped tools map as expected', () => {
  assert.deepEqual(toolNameToActionTarget('ijfw_memory_facts', {}), {
    action: 'read', target: 'memory:read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_brain', { verb: 'wiki.read' }), {
    action: 'write', target: 'brain:wiki.read',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_brain', {}), {
    action: 'write', target: 'brain:*',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_state', { verb: 'subagent.post-done' }), {
    action: 'write', target: 'state:subagent.post-done',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_state', {}), {
    action: 'write', target: 'state:*',
  });
  assert.deepEqual(toolNameToActionTarget('ijfw_cross_audit_converge', {}), {
    action: 'write', target: 'audit:converge',
  });
});

test('gate: unmapped tool is DENIED while an extension is active (fail-closed)', async () => {
  await withIsolatedHome('failclosed', async (home) => {
    const activeExt = {
      name: 'demo-ext',
      scope: 'project',
      permissions: { reads: ['*'], writes: ['*'] }, // even full perms cannot cover an unmapped tool
    };
    const r = await gatePermissionAndQuota({
      toolName: 'some_future_tool',
      args: {},
      activeExt,
      home,
      manifestQuotas: {},
    });
    assert.equal(r.allowed, false, 'unmapped tool must be denied under an active extension');
    assert.match(r.reason, /not covered by extension policy/);
    assert.equal(r.response.isError, true);
  });
});

test('gate: unmapped tool is DENIED when extension state is malformed', async () => {
  await withIsolatedHome('malformed', async (home) => {
    // Shape getActiveExtension returns for a corrupt state file.
    const activeExt = { __malformed: true };
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_some_other_tool',
      args: {},
      activeExt,
      home,
      manifestQuotas: {},
    });
    assert.equal(r.allowed, false, 'malformed state must never be a free pass');
  });
});

test('gate: unmapped tool stays allowed with NO active extension (back-compat)', async () => {
  const r = await gatePermissionAndQuota({
    toolName: 'some_future_tool',
    args: {},
    activeExt: null,
    home: tmpdir(),
    manifestQuotas: {},
  });
  assert.equal(r.allowed, true);
});

test('gate: write-capable ijfw_state denied when extension lacks state: writes', async () => {
  await withIsolatedHome('statewrite', async (home) => {
    const activeExt = {
      name: 'read-only-ext',
      scope: 'project',
      permissions: { reads: ['memory:read'], writes: [] },
    };
    const denied = await gatePermissionAndQuota({
      toolName: 'ijfw_state',
      args: { verb: 'workflow.advance' },
      activeExt,
      home,
      manifestQuotas: {},
    });
    assert.equal(denied.allowed, false);

    const allowed = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_facts',
      args: {},
      activeExt,
      home,
      manifestQuotas: {},
    });
    assert.equal(allowed.allowed, true, 'memory:read perm covers ijfw_memory_facts');
  });
});
