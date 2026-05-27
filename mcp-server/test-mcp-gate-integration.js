#!/usr/bin/env node
/**
 * test-mcp-gate-integration.js -- v1.5.0 audit-H5.1
 *
 * Locks in the MCP runtime-mediator as the SINGLE tier-2 sandbox enforcement
 * point for the four platforms with NO native pre-tool hook lifecycle:
 *   - Gemini CLI
 *   - Cursor
 *   - Windsurf
 *   - Copilot (VS Code)
 *
 * On those platforms `server.js:98` (inside `gatePermissionAndQuota`) is the
 * only gate that runs before a tool handler. Hook-lifecycle platforms (Claude
 * Code / Codex / Hermes / Wayland) get a *parallel* enforcement layer via
 * shell hooks, but that's defence-in-depth — the MCP boundary still has to
 * work standalone.
 *
 * Boundary we exercise: `gatePermissionAndQuota({ toolName, args, activeExt,
 * home, manifestQuotas })` exported from `src/server.js`. This is the exact
 * function the dispatch loop calls at server.js:1599. Using the exported gate
 * (rather than spinning a full MCP server over stdio) keeps the test fast and
 * deterministic while still standing on the real production code path —
 * server.js:1599 just threads its own `getActiveExtension()` result into the
 * same call we make here.
 *
 * Test matrix:
 *  (a) backcompat: no state file present  -> all tools allowed
 *  (b) fail-closed: malformed state file  -> structured DENY (not a throw)
 *  (c) granular allow/deny: writes:["tool:ijfw_memory_store"] - currently the
 *      runtime-mediator targets are `memory:write` / `memory:read`, so the
 *      vocabulary actually tested matches what server.js:1599 dispatches.
 *      writes:["memory:write"] reads:[] -> store OK, recall DENIED.
 *  (d) side-effect: a (c)-denied call writes one JSON line to
 *      <HOME>/.ijfw/state/permission-events.jsonl with the expected fields.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getActiveExtension,
  toolNameToActionTarget,
} from './src/runtime-mediator.js';
import { gatePermissionAndQuota } from './src/server.js';

// -- HOME isolation helpers (mirrors test-runtime-mediator.js for consistency)

async function makeTmp(label) {
  return mkdtemp(join(tmpdir(), `ijfw-mcp-gate-${label}-`));
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

async function seedState(home, contents) {
  const dir = join(home, '.ijfw', 'state');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'active-extension.json'), contents, 'utf8');
}

/**
 * Run the dispatch-side gate exactly the way server.js:1591-1609 does.
 * Mirrors that block so a regression in the production code path would show
 * up here: any divergence between this helper and server.js:1591-1609 means
 * the integration boundary moved.
 */
async function runGate(toolName, args, home) {
  let activeExt = null;
  try {
    activeExt = await getActiveExtension({ homeDir: home });
  } catch {
    activeExt = { __malformed: true };
  }
  // We pass {} for manifestQuotas — no quota policy in scope for this test.
  // The permission gate executes before the quota gate, matching production.
  return gatePermissionAndQuota({
    toolName,
    args: args || {},
    activeExt,
    home,
    manifestQuotas: {},
  });
}

// -- (a) backcompat invariant ------------------------------------------------

test('mcp-gate (a) backcompat: no state file -> all representative tools allowed', async () => {
  await withIsolatedHome('backcompat', async (home) => {
    // No state file written. activeExt === null -> gate is a no-op.
    const tools = [
      'ijfw_memory_store',
      'ijfw_memory_recall',
      'ijfw_memory_search',
      'ijfw_memory_prelude',
      'ijfw_metrics',
      'ijfw_update_check',
      // V155-017 (v1.5.5): ijfw_update_apply retired from MCP.
      'ijfw_prompt_check',
      'ijfw_run',
    ];
    for (const t of tools) {
      const gate = await runGate(t, { command: 'ls' }, home);
      assert.equal(gate.allowed, true, `${t} should be allowed without state file`);
      assert.equal(gate.response, undefined, `${t} should have no error response`);
    }
  });
});

// -- (b) fail-closed on malformed state -------------------------------------

test('mcp-gate (b) fail-closed: malformed state -> structured DENY (no throw)', async () => {
  await withIsolatedHome('malformed', async (home) => {
    await seedState(home, '{ not-json{{{');
    let gate;
    let threw = false;
    try {
      gate = await runGate('ijfw_memory_store', { content: 'x' }, home);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'malformed state must NOT throw — gate must return a structured deny');
    assert.equal(gate.allowed, false, 'malformed state must be denied');
    assert.ok(gate.response, 'deny must carry a response payload');
    assert.equal(gate.response.isError, true, 'deny response must flag isError');
    // The runtime-mediator deny shape: response.content[0].text carries the
    // human-readable reason; gate.reason carries the machine reason. We
    // assert on the machine reason because that's the contract callers
    // (including any future structured-error consumer) can rely on. The
    // string "malformed" appears in the reason per runtime-mediator.js:117.
    assert.match(gate.reason, /malformed/, `expected /malformed/ in reason, got: ${gate.reason}`);
    // Also assert the user-facing text follows the documented prefix shape.
    assert.match(gate.response.content[0].text, /permission denied/);
  });
});

// -- (c) granular allow/deny -------------------------------------------------

test('mcp-gate (c) granular: writes=[memory:write] -> store OK, recall DENIED', async () => {
  await withIsolatedHome('granular', async (home) => {
    // The runtime-mediator vocabulary uses (action,target) tuples — see
    // toolNameToActionTarget(): ijfw_memory_store -> write memory:write,
    // ijfw_memory_recall -> read memory:read. So the granular test uses that
    // vocabulary (not `tool:*`, which is a separate hook-side vocabulary).
    // The test brief's intent — one tool allowed, another not — is preserved.
    const ext = {
      name: 'granular-ext',
      scope: 'project',
      permissions: {
        reads: [], // no read permissions
        writes: ['memory:write'],
      },
    };
    await seedState(home, JSON.stringify(ext));

    // sanity: vocab check against the production map.
    assert.deepEqual(
      toolNameToActionTarget('ijfw_memory_store', {}),
      { action: 'write', target: 'memory:write' },
    );
    assert.deepEqual(
      toolNameToActionTarget('ijfw_memory_recall', {}),
      { action: 'read', target: 'memory:read' },
    );

    const allowed = await runGate('ijfw_memory_store', { content: 'hello' }, home);
    assert.equal(allowed.allowed, true, 'ijfw_memory_store should be allowed (writes contains memory:write)');
    assert.equal(allowed.response, undefined);

    const denied = await runGate('ijfw_memory_recall', { query: 'x' }, home);
    assert.equal(denied.allowed, false, 'ijfw_memory_recall should be denied (reads is empty)');
    assert.ok(denied.response, 'deny must carry a response');
    assert.equal(denied.response.isError, true);
    assert.match(denied.reason, /not permitted/);
    assert.match(denied.response.content[0].text, /permission denied/);
  });
});

// -- (d) side-effect: permission-events.jsonl --------------------------------

test('mcp-gate (d) denied call appends a line to permission-events.jsonl', async () => {
  await withIsolatedHome('events', async (home) => {
    const ext = {
      name: 'evt-ext',
      scope: 'project',
      permissions: {
        reads: [],
        writes: ['memory:write'],
      },
    };
    await seedState(home, JSON.stringify(ext));

    // Trigger a deny — recall hits the empty reads list.
    const denied = await runGate('ijfw_memory_recall', { query: 'x' }, home);
    assert.equal(denied.allowed, false);

    const logPath = join(home, '.ijfw', 'state', 'permission-events.jsonl');
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length >= 1, `expected >=1 event line, got ${lines.length}`);

    // The denied event should be the most recent line. Parse it and assert
    // on the documented event shape — these are the fields downstream
    // dashboards / forensic tools key off.
    const event = JSON.parse(lines[lines.length - 1]);
    assert.equal(event.tool, 'ijfw_memory_recall');
    assert.equal(event.extension, 'evt-ext');
    assert.equal(event.action, 'read');
    assert.equal(event.target, 'memory:read');
    assert.equal(event.allowed, false);
    assert.match(event.reason, /not permitted/);
    assert.ok(typeof event.ts === 'string' && event.ts.length > 0, 'event must carry ISO timestamp');
  });
});

// -- (e) sanity: allowed call does NOT write a deny event --------------------
// Defence-in-depth assertion: the side-effect in (d) must be triggered by
// the deny path specifically — an allowed call should not pollute the log
// with a false positive. (server.js logPermissionEvent for allows is
// intentionally not on the deny code path inside gatePermissionAndQuota.)

test('mcp-gate (e) allowed call does NOT write a deny event', async () => {
  await withIsolatedHome('events-allow', async (home) => {
    const ext = {
      name: 'allow-ext',
      scope: 'project',
      permissions: {
        reads: ['memory:read'],
        writes: ['memory:write'],
      },
    };
    await seedState(home, JSON.stringify(ext));

    const gate = await runGate('ijfw_memory_store', { content: 'ok' }, home);
    assert.equal(gate.allowed, true);

    const logPath = join(home, '.ijfw', 'state', 'permission-events.jsonl');
    let raw = '';
    try { raw = await readFile(logPath, 'utf8'); } catch { /* may not exist */ }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    for (const l of lines) {
      const ev = JSON.parse(l);
      // If the log exists at all here, none of its lines should be a deny
      // attributable to this test's tool.
      assert.notEqual(
        ev.allowed === false && ev.tool === 'ijfw_memory_store',
        true,
        `unexpected deny event for allowed call: ${l}`,
      );
    }
  });
});
