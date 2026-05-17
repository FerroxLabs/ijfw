/**
 * test-server-quota-integration.js — IJFW v1.4.3 W9-A3 (B16)
 *
 * Tests for the `gatePermissionAndQuota` helper exported from server.js +
 * cross-process race proof of the quota tracker's withFsLock serialization
 * (SEC-H-01).
 *
 * The integration test surface is intentionally the exported helper, not a
 * spun-up MCP server — that's the SEC-M-03 refactor's whole point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gatePermissionAndQuota } from './src/server.js';
import { checkAndIncrement, resetExtensionQuotas } from './src/extension-quota-tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(__dirname, 'test-fixtures', 'quota-race-child.mjs');

async function withTmpHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'ijfw-quota-int-test-'));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    await rm(home, { recursive: true, force: true });
  }
}

function makeActiveExt(overrides = {}) {
  return {
    name: 'test-ext',
    scope: 'user',
    permissions: {
      reads: ['memory:read', 'tool:*'],
      writes: ['memory:write', 'tool:*'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. No active extension → allowed=true (back-compat)
// ---------------------------------------------------------------------------
test('gatePermissionAndQuota: null activeExt returns allowed=true (back-compat)', async () => {
  await withTmpHome(async (home) => {
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_store',
      args: { content: 'hello' },
      activeExt: null,
      home,
      manifestQuotas: {},
    });
    assert.equal(r.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// 2. Within quota → allowed=true
// ---------------------------------------------------------------------------
test('gatePermissionAndQuota: within quota returns allowed=true', async () => {
  await withTmpHome(async (home) => {
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_store',
      args: { content: 'x'.repeat(100) },
      activeExt: makeActiveExt(),
      home,
      manifestQuotas: { max_bytes_written: 10_000 },
    });
    assert.equal(r.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// 3. Over quota → allowed=false, MCP error envelope shape
// ---------------------------------------------------------------------------
test('gatePermissionAndQuota: over quota returns allowed=false + MCP error envelope', async () => {
  await withTmpHome(async (home) => {
    // Pre-saturate to make the next call exceed.
    await checkAndIncrement('test-ext', 'bytes_written', 95, 100, { homeDir: home });
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_store',
      args: { content: 'y'.repeat(50) }, // 50 bytes, pushes 95+50=145 > 100
      activeExt: makeActiveExt(),
      home,
      manifestQuotas: { max_bytes_written: 100 },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.dimension, 'bytes_written');
    assert.ok(r.response, 'expected response envelope');
    assert.equal(r.response.isError, true);
    assert.ok(Array.isArray(r.response.content), 'content is array');
    assert.equal(r.response.content[0].type, 'text');
    assert.match(r.response.content[0].text, /exceeded quota bytes_written/);
  });
});

// ---------------------------------------------------------------------------
// 4. Permission deny path still works (no quota interaction needed)
// ---------------------------------------------------------------------------
test('gatePermissionAndQuota: permission deny short-circuits before quota', async () => {
  await withTmpHome(async (home) => {
    const lockedDown = makeActiveExt({
      permissions: { reads: [], writes: [] }, // nothing allowed
    });
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_store',
      args: { content: 'z' },
      activeExt: lockedDown,
      home,
      manifestQuotas: { max_bytes_written: 100_000 },
    });
    assert.equal(r.allowed, false);
    assert.ok(r.response);
    assert.match(r.response.content[0].text, /permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Quota deny is logged as permission event (allowed:false, reason:quota:...)
// ---------------------------------------------------------------------------
test('gatePermissionAndQuota: quota deny emits permission event with quota reason', async () => {
  await withTmpHome(async (home) => {
    // Drive AT limit so any further increment exceeds (tracker rejects increments that
    // would put nextCurrent > limit without persisting them — pre-drive must land
    // current exactly at limit, then the gate's own increment causes denial).
    await checkAndIncrement('test-ext', 'bytes_written', 100, 100, { homeDir: home });
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_store',
      args: { content: 'a'.repeat(50) },
      activeExt: makeActiveExt(),
      home,
      manifestQuotas: { max_bytes_written: 100 },
    });
    assert.equal(r.allowed, false);
    const logPath = join(home, '.ijfw', 'state', 'permission-events.jsonl');
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    assert.equal(last.allowed, false);
    assert.match(last.reason, /^quota:bytes_written/);
    assert.equal(last.extension, 'test-ext');
  });
});

// ---------------------------------------------------------------------------
// 6. wall_clock_ms enforcement
// ---------------------------------------------------------------------------
test('gatePermissionAndQuota: wall_clock_ms over limit denies', async () => {
  await withTmpHome(async (home) => {
    const past = new Date(Date.now() - 5_000).toISOString();
    await resetExtensionQuotas('test-ext', { homeDir: home, activated_at: past });
    const r = await gatePermissionAndQuota({
      toolName: 'ijfw_memory_recall',
      args: {},
      activeExt: makeActiveExt(),
      home,
      manifestQuotas: { max_wall_clock_ms: 1_000 },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.dimension, 'wall_clock_ms');
    assert.match(r.response.content[0].text, /wall_clock_ms/);
  });
});

// ---------------------------------------------------------------------------
// 7. SEC-H-01 PROOF — cross-process race via child_process.fork
// Two children each call checkAndIncrement(extName, 'files_written', 1, 1,
// opts). Exactly ONE must return allowed=true; the other allowed=false.
// This proves withFsLock serializes the quota tracker across OS processes.
// ---------------------------------------------------------------------------
test('cross-process race: quota tracker serializes across forked children (SEC-H-01)', async () => {
  await withTmpHome(async (home) => {
    const extName = 'race-ext';

    function spawnHandle() {
      const child = fork(CHILD_SCRIPT, [extName, home], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      let stderr = '';
      child.stderr?.on('data', (b) => { stderr += b.toString(); });
      const ready = new Promise((resolve) => {
        child.on('message', (msg) => { if (msg === 'ready') resolve(); });
      });
      const verdict = new Promise((resolve, reject) => {
        child.on('message', (msg) => {
          if (msg !== 'ready' && typeof msg === 'object') resolve(msg);
        });
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(`child exited ${code}; stderr=${stderr}`));
        });
        child.on('error', reject);
      });
      return { child, ready, verdict, send: (m) => child.send(m) };
    }

    const a = spawnHandle();
    const b = spawnHandle();
    await Promise.all([a.ready, b.ready]);
    a.send('go');
    b.send('go');
    const [va, vb] = await Promise.all([a.verdict, b.verdict]);
    // Explicitly disconnect IPC + kill so the test runner can exit.
    try { a.child.disconnect(); } catch { /* may already be disconnected */ }
    try { b.child.disconnect(); } catch { /* may already be disconnected */ }

    const allowedCount = [va, vb].filter((v) => v.allowed === true).length;
    const deniedCount = [va, vb].filter((v) => v.allowed === false).length;
    assert.equal(
      allowedCount,
      1,
      `cross-process race: expected exactly 1 allowed, got ${allowedCount}. ` +
        `a=${JSON.stringify(va)} b=${JSON.stringify(vb)}. ` +
        `This means withFsLock failed to serialize the quota tracker across OS processes — SEC-H-01 OPEN.`,
    );
    assert.equal(deniedCount, 1, `expected exactly 1 denied, got ${deniedCount}`);
  });
});
