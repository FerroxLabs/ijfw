#!/usr/bin/env node
/**
 * test-tool-cap.js -- Live MCP introspection of the tool-cap.
 *
 * Per IJFW MCP discipline: the server may register at most 10 tools. The
 * structural grep in test.js can drift if a new tool is added without
 * removing one. This harness spawns bin/ijfw-memory, speaks JSON-RPC over
 * stdio, calls tools/list, and asserts:
 *
 *   1. result.tools.length === 10
 *   2. names match the expected canonical set exactly (no extras, none missing)
 *
 * Hard-fails on any deviation. This is the actual gate.
 *
 * Zero external deps; ESM.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// bin/ijfw-memory is a bash launcher (not portable to Windows). The test
// targets the MCP server itself, so spawn server.js directly via the active
// node binary -- works on every platform.
const SERVER = join(__dirname, 'src', 'server.js');

const EXPECTED_TOOLS = [
  'ijfw_memory_recall',
  'ijfw_memory_store',
  'ijfw_memory_search',
  'ijfw_memory_prelude',
  'ijfw_prompt_check',
  'ijfw_metrics',
  'ijfw_cross_project_search',
  'ijfw_update_check',
  'ijfw_update_apply',
  'ijfw_run',
];
const EXPECTED_COUNT = 10;

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

// Buffer stdout, return a promise that resolves with the matched JSON-RPC
// response for `id`. Supports newline-delimited JSON-RPC frames.
function waitForResponse(child, id, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => {
      reject(new Error(`tool-cap: timed out after ${timeoutMs}ms waiting for id=${id}. buf=${buf.slice(0, 240)}`));
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

async function main() {
  console.log('=== tool-cap live introspection ===');
  console.log(`spawn: ${process.execPath} ${SERVER}`);

  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, IJFW_DISABLE_STARTUP_REPORT: '1' },
  });

  let stderrBuf = '';
  child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

  child.on('error', (err) => {
    console.error(`tool-cap: spawn error: ${err && err.message}`);
    process.exit(2);
  });

  try {
    // 1) initialize
    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ijfw-tool-cap-test', version: '1.0' },
      },
    });
    const initResp = await waitForResponse(child, 1);
    if (!initResp.result) {
      throw new Error(`initialize did not yield a result: ${JSON.stringify(initResp)}`);
    }

    // 2) tools/list
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolsResp = await waitForResponse(child, 2);
    if (!toolsResp.result || !Array.isArray(toolsResp.result.tools)) {
      throw new Error(`tools/list did not yield a tools array: ${JSON.stringify(toolsResp)}`);
    }

    const tools = toolsResp.result.tools;
    const names = tools.map((t) => t.name).sort();
    const expectedSorted = [...EXPECTED_TOOLS].sort();

    let pass = 0;
    let fail = 0;

    // Assertion 1: count.
    if (tools.length === EXPECTED_COUNT) {
      console.log(`  [PASS] tool count == ${EXPECTED_COUNT} (got ${tools.length})`);
      pass++;
    } else {
      console.log(`  [FAIL] tool count == ${EXPECTED_COUNT} (got ${tools.length}). Names: ${names.join(', ')}`);
      fail++;
    }

    // Assertion 2: names match exactly.
    const missing = expectedSorted.filter((n) => !names.includes(n));
    const extras = names.filter((n) => !expectedSorted.includes(n));
    if (missing.length === 0 && extras.length === 0) {
      console.log(`  [PASS] tool names match canonical set exactly`);
      pass++;
    } else {
      console.log(`  [FAIL] tool names mismatch. missing=${JSON.stringify(missing)} extras=${JSON.stringify(extras)}`);
      fail++;
    }

    console.log(`\ntool-cap: pass=${pass} fail=${fail}`);
    if (fail > 0) {
      if (stderrBuf) console.error(`\n[server stderr]\n${stderrBuf.slice(0, 800)}`);
      process.exit(1);
    }
  } finally {
    try { child.kill('SIGTERM'); } catch { /* nothing */ }
  }
}

main().catch((e) => {
  console.error('test-tool-cap crashed:', e && e.stack || e);
  process.exit(2);
});
