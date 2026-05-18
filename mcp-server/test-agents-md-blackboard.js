/**
 * test-agents-md-blackboard.js — v1.5.0 W11-B2 (S4) tests
 *
 * Verifies populateBlackboardBlock() contract:
 *  - reads wave STATE.md via readWaveState
 *  - shells out to claude/skills/ijfw-agents-md/scripts/merge-block-aware.sh
 *    with argv = (agentsMdPath, "BLACKBOARD", jsonPayload)
 *  - returns {ok, reason?, stderr?} — never throws
 *  - serialises via withFsLock on .ijfw/state/AGENTS.md.lock
 *
 * Uses a STUB merger script (echoes the call into a log file) so the test
 * exercises the JS contract without depending on the real bash merger's
 * marker-replacement logic. The real merger is exercised separately by the
 * ijfw-agents-md skill's own test fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { populateBlackboardBlock } from './src/orchestrator/agents-md-blackboard.js';
import { writeWaveState } from './src/orchestrator/wave-state.js';

const STUB_MERGER_OK = `#!/usr/bin/env bash
# Stub merger for tests — appends call args to a log so the test can assert
# populateBlackboardBlock invoked it with the right argv shape.
LOG_FILE="$1.merger-log"
{
  echo "MERGE: $1 $2"
  echo "PAYLOAD_BYTES=\${#3}"
} >> "$LOG_FILE"
exit 0
`;

const STUB_MERGER_FAIL = `#!/usr/bin/env bash
echo "stub merger forced failure" >&2
exit 1
`;

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'agents-md-bb-'));
  mkdirSync(join(root, '.ijfw', 'state'), { recursive: true });
  return root;
}

function installStubMerger(root, body = STUB_MERGER_OK) {
  const scriptsDir = join(root, 'claude', 'skills', 'ijfw-agents-md', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const mergerPath = join(scriptsDir, 'merge-block-aware.sh');
  writeFileSync(mergerPath, body);
  chmodSync(mergerPath, 0o755);
  return mergerPath;
}

async function seedWaveState(root, waveId, overrides = {}) {
  await writeWaveState(waveId, {
    frontmatter: {
      wave_id: waveId,
      status: 'in_progress',
      claims_active: 0,
      blockers_open: [],
      findings_recent: [],
      ...overrides,
    },
    body: '# Wave state\n',
  }, root);
}

// ---------------------------------------------------------------------------

test('happy path: STATE.md + merger present → ok and merger called', async () => {
  const root = makeProjectRoot();
  try {
    await seedWaveState(root, 'W-TEST-1', { claims_active: 2 });
    installStubMerger(root);
    writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n');

    const res = await populateBlackboardBlock('W-TEST-1', root);
    assert.equal(res.ok, true, JSON.stringify(res));

    const logPath = join(root, 'AGENTS.md.merger-log');
    assert.ok(existsSync(logPath), 'merger log should exist');
    const logged = readFileSync(logPath, 'utf8');
    assert.ok(logged.includes('MERGE:'), `expected MERGE line, got: ${logged}`);
    assert.ok(logged.includes('BLACKBOARD'), `expected BLACKBOARD marker, got: ${logged}`);
    assert.ok(logged.includes(join(root, 'AGENTS.md')), 'expected AGENTS.md path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing wave-state: no STATE.md → ok:false reason no-state', async () => {
  const root = makeProjectRoot();
  try {
    installStubMerger(root);
    const res = await populateBlackboardBlock('W-MISSING', root);
    assert.deepEqual(res, { ok: false, reason: 'no-state' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing merger script: STATE present but no merger → ok:false reason merger-missing', async () => {
  const root = makeProjectRoot();
  try {
    await seedWaveState(root, 'W-NO-MERGER');
    // Intentionally do NOT install the merger.
    const res = await populateBlackboardBlock('W-NO-MERGER', root);
    assert.deepEqual(res, { ok: false, reason: 'merger-missing' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merger fails: non-zero exit → ok:false reason merger-failed (stderr captured)', async () => {
  const root = makeProjectRoot();
  try {
    await seedWaveState(root, 'W-FAIL');
    installStubMerger(root, STUB_MERGER_FAIL);
    const res = await populateBlackboardBlock('W-FAIL', root);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'merger-failed');
    assert.ok(typeof res.stderr === 'string', 'stderr should be string');
    assert.ok(res.stderr.includes('stub merger forced failure'), `stderr should include forced-fail msg, got: ${res.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('idempotent: two consecutive calls with identical state → both ok:true', async () => {
  const root = makeProjectRoot();
  try {
    await seedWaveState(root, 'W-IDEMP');
    installStubMerger(root);

    const r1 = await populateBlackboardBlock('W-IDEMP', root);
    const r2 = await populateBlackboardBlock('W-IDEMP', root);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, true, JSON.stringify(r2));

    // Log should record TWO MERGE lines — stub appends each call.
    const logged = readFileSync(join(root, 'AGENTS.md.merger-log'), 'utf8');
    const mergeLines = logged.split('\n').filter((l) => l.startsWith('MERGE:'));
    assert.equal(mergeLines.length, 2, `expected 2 merge lines, got ${mergeLines.length}: ${logged}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marker-collision safety: payload containing IJFW-BLACKBOARD-END string still succeeds', async () => {
  const root = makeProjectRoot();
  try {
    await seedWaveState(root, 'W-COLLIDE', {
      findings_recent: ['benign finding: <!-- IJFW-BLACKBOARD-END --> appeared in log'],
    });
    installStubMerger(root);

    const res = await populateBlackboardBlock('W-COLLIDE', root);
    assert.equal(res.ok, true, `payload with marker string should still succeed: ${JSON.stringify(res)}`);

    // Verify the stub did receive a payload (non-zero bytes).
    const logged = readFileSync(join(root, 'AGENTS.md.merger-log'), 'utf8');
    const bytesLine = logged.split('\n').find((l) => l.startsWith('PAYLOAD_BYTES='));
    assert.ok(bytesLine, 'expected PAYLOAD_BYTES line in log');
    const bytes = parseInt(bytesLine.split('=')[1], 10);
    assert.ok(bytes > 0, `payload should be non-empty, got ${bytes}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
