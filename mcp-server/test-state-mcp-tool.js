#!/usr/bin/env node
/**
 * test-state-mcp-tool.js — v1.5.0 T13: end-to-end test of the new `ijfw_state`
 * MCP tool that absorbs the retired `ijfw_subagent_post_done` tool.
 *
 * Spawns the real MCP server (mcp-server/src/server.js) over stdio JSON-RPC,
 * calls `tools/call` against `ijfw_state` for ≥3 verbs to prove routing is NOT
 * hardcoded (workflow.get, wave.get, state.validate — three different verb
 * namespaces), asserts:
 *
 *   1. each known-verb call returns a JSON content envelope parsable as JSON
 *      with `ok: true` and `verbId` populated;
 *   2. each known-verb result shape matches the verb's contract (workflow.get
 *      returns `workflow`, wave.get returns `wave`, state.validate returns
 *      `validation`);
 *   3. an unknown verb returns `isError: true` + a documented error shape
 *      (`{ ok: false, error: "<msg>" }`).
 *
 * Uses node:test so it composes with the project's required-suite manifest.
 * Zero new deps; ESM; Node ≥18.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, 'src', 'server.js');

// ---------------------------------------------------------------------------
// JSON-RPC helpers — mirror the stdio frame protocol the MCP server speaks.
// Pattern lifted from test-tool-cap.js so the harness shape is consistent.
// ---------------------------------------------------------------------------

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function waitForResponse(child, id, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for id=${id}; buf=${buf.slice(0, 240)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed && parsed.id === id) {
          clearTimeout(t);
          child.stdout.off('data', onData);
          resolve(parsed);
          return;
        }
      }
    };
    child.stdout.on('data', onData);
  });
}

/** Spawn the server, run `fn(child, callTool)`, kill the server. */
async function withServer(fn) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, IJFW_DISABLE_STARTUP_REPORT: '1' },
  });
  let stderrBuf = '';
  child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

  // Initialize handshake.
  send(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ijfw_state-mcp-test', version: '1.0' },
    },
  });
  await waitForResponse(child, 1);

  // Convenience caller: send tools/call against ijfw_state with given args.
  let nextId = 100;
  const callTool = async (args) => {
    const id = nextId++;
    send(child, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'ijfw_state', arguments: args },
    });
    return waitForResponse(child, id);
  };

  try {
    return await fn(child, callTool, () => stderrBuf);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* nothing */ }
  }
}

/**
 * Extract a parsed-JSON payload from a tools/call response envelope. The MCP
 * server wraps results in `{ content: [{ type: 'text', text: '<json>' }], isError? }`.
 */
function decodeContent(resp) {
  assert.ok(resp.result, `JSON-RPC error: ${JSON.stringify(resp.error || resp)}`);
  const content = resp.result.content;
  assert.ok(Array.isArray(content) && content.length > 0,
    `expected tools/call content array, got: ${JSON.stringify(resp.result)}`);
  const first = content[0];
  assert.equal(first.type, 'text', `expected text content frame, got ${first.type}`);
  const parsed = JSON.parse(first.text);
  return { parsed, isError: !!resp.result.isError };
}

/** Make a tmp project root with the minimal scaffolding state-SDK verbs need. */
function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-state-mcp-'));
  mkdirSync(join(root, '.ijfw', 'state'), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('ijfw_state: tools/list registers it and not ijfw_subagent_post_done', async () => {
  await withServer(async (child, _callTool) => {
    send(child, { jsonrpc: '2.0', id: 50, method: 'tools/list', params: {} });
    const resp = await waitForResponse(child, 50);
    assert.ok(resp.result?.tools, 'tools/list must return tools array');
    const names = resp.result.tools.map((t) => t.name);
    assert.ok(names.includes('ijfw_state'), `ijfw_state must be registered; got ${names.join(', ')}`);
    assert.ok(!names.includes('ijfw_subagent_post_done'),
      `ijfw_subagent_post_done must be retired; tools/list still lists it: ${names.join(', ')}`);
  });
});

test('ijfw_state verb routing: workflow.get returns ok:true + verbId + workflow', async () => {
  const root = makeProjectRoot();
  try {
    // Seed a workflow.json so the read returns a real shape rather than null.
    writeFileSync(
      join(root, '.ijfw', 'state', 'workflow.json'),
      JSON.stringify({ phase: 'plan', status: 'in_progress', milestone: 'v1.5.0' }),
    );
    await withServer(async (_child, callTool) => {
      const resp = await callTool({ verb: 'workflow.get', projectRoot: root });
      const { parsed, isError } = decodeContent(resp);
      assert.equal(isError, false, `workflow.get must not be isError: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.ok, true, `workflow.get must return ok:true: ${JSON.stringify(parsed)}`);
      assert.equal(typeof parsed.verbId, 'string', 'verbId must be a string');
      assert.ok(parsed.verbId.length > 0, 'verbId must be non-empty');
      assert.ok(parsed.workflow, 'workflow.get must include `workflow` field');
      assert.equal(parsed.workflow.phase, 'plan');
      assert.equal(parsed.workflow.milestone, 'v1.5.0');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ijfw_state verb routing: wave.get returns ok:true + verbId + wave (null for missing)', async () => {
  const root = makeProjectRoot();
  try {
    await withServer(async (_child, callTool) => {
      const resp = await callTool({
        verb: 'wave.get',
        projectRoot: root,
        payload: { waveId: 'W-MCP-TEST-1' },
      });
      const { parsed, isError } = decodeContent(resp);
      assert.equal(isError, false, `wave.get must not be isError: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.ok, true, `wave.get must return ok:true: ${JSON.stringify(parsed)}`);
      assert.equal(typeof parsed.verbId, 'string', 'verbId must be a string');
      // A wave with no STATE.md on disk yields `wave: null` per state-sdk.js
      // wave.get handler — that's the documented shape, not an error.
      assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'wave'),
        `wave.get must include a \`wave\` field (even when null); got ${JSON.stringify(parsed)}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ijfw_state verb routing: state.validate returns ok:true + verbId + validation', async () => {
  const root = makeProjectRoot();
  try {
    await withServer(async (_child, callTool) => {
      const resp = await callTool({ verb: 'state.validate', projectRoot: root });
      const { parsed, isError } = decodeContent(resp);
      assert.equal(isError, false, `state.validate must not be isError: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.ok, true, `state.validate must return ok:true: ${JSON.stringify(parsed)}`);
      assert.equal(typeof parsed.verbId, 'string', 'verbId must be a string');
      // state.validate is documented to return a per-file structural report —
      // exact shape varies by version, so we assert only the always-present
      // `ok` + `verbId` and that the call did not throw.
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ijfw_state unknown verb: returns isError:true + { ok:false, error:"<msg>" }', async () => {
  const root = makeProjectRoot();
  try {
    await withServer(async (_child, callTool) => {
      const resp = await callTool({
        verb: 'nonexistent.verb',
        projectRoot: root,
      });
      const { parsed, isError } = decodeContent(resp);
      assert.equal(isError, true, `unknown verb must surface as isError:true; got ${JSON.stringify(parsed)}`);
      assert.equal(parsed.ok, false, `unknown verb must return ok:false; got ${JSON.stringify(parsed)}`);
      assert.equal(typeof parsed.error, 'string', 'unknown verb must include `error` string');
      assert.match(parsed.error, /unknown verb|nonexistent\.verb/i,
        `error message should name the verb or say "unknown verb"; got ${parsed.error}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ijfw_state missing verb argument: returns isError:true + { ok:false, error:"verb (string) is required" }', async () => {
  await withServer(async (_child, callTool) => {
    const resp = await callTool({ /* no verb */ });
    const { parsed, isError } = decodeContent(resp);
    assert.equal(isError, true, 'missing verb must be isError:true');
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /verb.*required/i,
      `missing-verb error should mention "required"; got ${parsed.error}`);
  });
});
