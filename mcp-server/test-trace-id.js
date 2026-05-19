/**
 * test-trace-id.js -- v1.5.0 N4.obs M1+M2.
 *
 * Verifies:
 *   1. ensureTraceId mints a v4 UUID when env is empty.
 *   2. ensureTraceId adopts a valid env-supplied trace id (worktree inheritance).
 *   3. ensureTraceId rejects malformed env values and mints a fresh id.
 *   4. setTraceId throws on invalid input.
 *   5. traceEnv builds a child env that carries the trace id.
 *   6. composePath builds Helicone-style hierarchical paths and sanitises input.
 *   7. recordCheckpoint stamps `trace_id` and `path` into the on-disk payload.
 *   8. writeReceipt stamps `trace_id` when a trace is active.
 *
 * Zero deps. Node built-ins only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureTraceId,
  getTraceId,
  setTraceId,
  resetTraceId,
  traceEnv,
  isValidTraceId,
  composePath,
} from './src/observability/trace-id.js';
import { recordCheckpoint, readLastCheckpoint } from './src/orchestrator/subagent-telemetry.js';
import { writeReceipt, readReceipts, purgeReceipts } from './src/receipts.js';

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log('  ok ' + label);
    pass++;
  } else {
    console.error('  FAIL ' + label + (detail !== undefined ? ' -- ' + detail : ''));
    fail++;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

(async () => {
  // -- 1. ensureTraceId mints a UUID when env is empty
  console.log('\n-- 1. ensureTraceId mints a UUID when env is empty --');
  resetTraceId();
  {
    const id = ensureTraceId();
    ok('returns a valid UUID', UUID_RE.test(id), `got ${id}`);
    ok('subsequent call returns the same id', ensureTraceId() === id);
    ok('env is now set', process.env.IJFW_TRACE_ID === id);
  }

  // -- 2. adopt env-supplied trace
  console.log('\n-- 2. ensureTraceId adopts a valid env-supplied trace id --');
  resetTraceId();
  process.env.IJFW_TRACE_ID = FIXED;
  {
    const id = ensureTraceId();
    ok('adopts fixed id from env', id === FIXED);
    ok('getTraceId() returns same', getTraceId() === FIXED);
  }

  // -- 3. reject malformed env
  console.log('\n-- 3. ensureTraceId rejects malformed env and mints fresh --');
  resetTraceId();
  process.env.IJFW_TRACE_ID = 'not-a-uuid';
  {
    const id = ensureTraceId();
    ok('did NOT adopt malformed env value', id !== 'not-a-uuid');
    ok('minted a valid UUID instead', UUID_RE.test(id));
  }

  // -- 4. setTraceId throws on invalid input
  console.log('\n-- 4. setTraceId throws on invalid input --');
  resetTraceId();
  {
    let threw = false;
    try { setTraceId('bogus'); } catch { threw = true; }
    ok('setTraceId("bogus") throws', threw);
    setTraceId(FIXED);
    ok('setTraceId(valid) adopts the id', getTraceId() === FIXED);
  }

  // -- 5. traceEnv
  console.log('\n-- 5. traceEnv carries the trace id to a child --');
  resetTraceId();
  setTraceId(FIXED);
  {
    const env = traceEnv({ FOO: 'bar' });
    ok('traceEnv carries trace id', env.IJFW_TRACE_ID === FIXED);
    ok('traceEnv merges extras', env.FOO === 'bar');
  }

  // -- 6. composePath
  console.log('\n-- 6. composePath builds Helicone-style paths --');
  ok('full path', composePath({ waveId: 'W12-A', subId: 'N05', tool: 'Bash' }) === '/wave-W12-A/sub-N05/tool-Bash');
  ok('partial path skips empties', composePath({ waveId: 'W12-A', subId: 'N05' }) === '/wave-W12-A/sub-N05');
  ok('extra segments append', composePath({ waveId: 'W', segments: ['retry-1'] }) === '/wave-W/retry-1');
  ok('empty input returns empty', composePath({}) === '');
  ok('null input returns empty', composePath(null) === '');
  {
    const dirty = composePath({ waveId: 'A_B', subId: 'sub' });
    ok('sanitise: clean input', dirty === '/wave-A_B/sub-sub', `got ${dirty}`);
    const grimy = composePath({ waveId: 'a/b c' });
    ok('sanitise: slashes & spaces collapse to _',
      grimy === '/wave-a_b_c',
      `got ${grimy}`);
  }

  // Guard: ensure IJFW_PARENT_PROJECT_ROOT is not set so checkpoints land in the
  // temp root we pass, not a stale env override from the runner.
  const priorParent = process.env.IJFW_PARENT_PROJECT_ROOT;
  delete process.env.IJFW_PARENT_PROJECT_ROOT;

  // -- 7. recordCheckpoint stamps trace_id + path
  console.log('\n-- 7. recordCheckpoint stamps trace_id + path --');
  const root = mkdtempSync(join(tmpdir(), 'ijfw-traceid-cp-'));
  try {
    resetTraceId();
    setTraceId(FIXED);
    await recordCheckpoint('W99-X', 'TEST-A', { last_action: 'unit test' }, root);
    const cp = await readLastCheckpoint('W99-X', 'TEST-A', root);
    ok('checkpoint has trace_id', cp && cp.trace_id === FIXED);
    ok('checkpoint has default path',
      cp && cp.path === '/wave-W99-X/sub-TEST-A',
      `got ${cp && cp.path}`);

    await recordCheckpoint('W99-X', 'TEST-B', { path: '/wave-W99-X/sub-TEST-B/tool-Bash' }, root);
    const cp2 = await readLastCheckpoint('W99-X', 'TEST-B', root);
    ok('caller-supplied path is preserved',
      cp2 && cp2.path === '/wave-W99-X/sub-TEST-B/tool-Bash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // -- 8. writeReceipt stamps trace_id
  console.log('\n-- 8. writeReceipt stamps trace_id when active --');
  const receiptDir = mkdtempSync(join(tmpdir(), 'ijfw-traceid-rcpt-'));
  try {
    resetTraceId();
    setTraceId(FIXED);
    writeReceipt(receiptDir, { mode: 'cross', timestamp: '2026-01-01T00:00:00.000Z' });
    const rs = readReceipts(receiptDir);
    ok('one receipt written', rs.length === 1);
    ok('receipt has trace_id', rs[0].trace_id === FIXED);

    purgeReceipts(receiptDir);
    writeReceipt(receiptDir, { mode: 'cross', trace_id: 'caller-supplied' });
    const rs2 = readReceipts(receiptDir);
    ok('caller-supplied trace_id is preserved', rs2[0].trace_id === 'caller-supplied');

    purgeReceipts(receiptDir);
    resetTraceId();
    writeReceipt(receiptDir, { mode: 'cross' });
    const rs3 = readReceipts(receiptDir);
    ok('no active trace => no trace_id key', rs3[0].trace_id === undefined);
  } finally {
    rmSync(receiptDir, { recursive: true, force: true });
    resetTraceId();
    if (typeof priorParent === 'string') process.env.IJFW_PARENT_PROJECT_ROOT = priorParent;
  }

  ok('isValidTraceId(valid)', isValidTraceId(FIXED));
  ok('isValidTraceId(empty) false', !isValidTraceId(''));
  ok('isValidTraceId(undefined) false', !isValidTraceId(undefined));
  ok('isValidTraceId(non-string) false', !isValidTraceId(12345));

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
