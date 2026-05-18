// test-orchestrator-phase-e.js -- Tests for runCrossOp({ mode: 'phase-e-auto' })
//
// Mocks auditor dispatch so no real CLI binaries are invoked.
// Pattern: prime audit-roster._installedCache + set env API keys to control
// reachability, then assert on the returned verdict/findings/outputPath.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We patch _installedCache before importing runCrossOp so isInstalled reads
// from our primed cache rather than hitting the real PATH.
import { _installedCache } from './src/audit-roster.js';

// Patch fireExternal by monkeypatching the module-level spawn indirection.
// Since we can't mock ESM imports cleanly in node:test, we control behavior
// by priming _installedCache (CLI absent) and setting env API keys (API path)
// so the orchestrator's fireExternal picks the API path and we control the
// response via the api-client mock below.
//
// For full no-network tests we need a lighter approach: run phase-e-auto
// with picks that have NO CLI and NO API key → they get skipped.  Then we
// test with API key present by verifying the correct NOTE is emitted.

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'phase-e-'));
}

// Mark all known auditors as NOT installed (CLI absent) so tests are hermetic.
function clearInstalledCache() {
  _installedCache.clear();
  for (const id of ['codex', 'gemini', 'claude', 'qwen', 'deepseek', 'kimi', 'opencode', 'aider', 'copilot']) {
    _installedCache.set(id, false);
  }
}

// ---------------------------------------------------------------------------
// Test 1: picks default ['codex','gemini','claude'] when no swarm.json
// ---------------------------------------------------------------------------
test('phase-e-auto: uses default auditor list when no swarm.json', async () => {
  clearInstalledCache();
  const root = makeTmp();
  // No .ijfw/swarm.json, no API keys → all 3 default auditors skipped
  const { runCrossOp } = await import('./src/cross-orchestrator.js');
  const result = await runCrossOp({
    mode: 'phase-e-auto',
    target: 'test-phase',
    projectDir: root,
    env: {}, // no API keys
    quiet: true,
  });
  // All skipped → CONDITIONAL verdict (no HIGH findings)
  assert.equal(result.verdict, 'CONDITIONAL');
  assert.ok(Array.isArray(result.findings));
  assert.ok(typeof result.outputPath === 'string');
  assert.ok(result.outputPath.includes('CROSS-AUDIT-r1.md'));
  // Notes should mention the 3 defaults were skipped
  assert.ok(Array.isArray(result.notes));
  assert.ok(result.notes.length >= 3, `expected ≥3 notes, got ${result.notes.length}: ${result.notes.join('; ')}`);
});

// ---------------------------------------------------------------------------
// Test 2: honors swarm.json auditors array
// ---------------------------------------------------------------------------
test('phase-e-auto: honors .ijfw/swarm.json auditors field', async () => {
  clearInstalledCache();
  const root = makeTmp();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(
    join(root, '.ijfw', 'swarm.json'),
    JSON.stringify({ project_type: 'node', specialists: [], auditors: ['qwen'], auditor_count: 1 }),
    'utf8'
  );
  const { runCrossOp } = await import('./src/cross-orchestrator.js');
  const result = await runCrossOp({
    mode: 'phase-e-auto',
    target: 'test-phase',
    projectDir: root,
    env: {}, // qwen CLI not installed, no API key
    quiet: true,
  });
  assert.ok(Array.isArray(result.notes));
  // Only qwen should be mentioned as skipped (not codex/gemini/claude)
  const noteText = result.notes.join(' ');
  assert.ok(noteText.includes('qwen'), `expected 'qwen' in notes: ${noteText}`);
  assert.ok(!noteText.includes('codex'), `unexpected 'codex' in notes: ${noteText}`);
});

// ---------------------------------------------------------------------------
// Test 3: graceful degradation — CLI missing AND no apiFallback → skip NOTE
// ---------------------------------------------------------------------------
test('phase-e-auto: skips auditor when CLI missing and no apiFallback env key', async () => {
  clearInstalledCache();
  const root = makeTmp();
  // opencode has apiFallback: null — always skipped when CLI absent
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(
    join(root, '.ijfw', 'swarm.json'),
    JSON.stringify({ project_type: 'node', specialists: [], auditors: ['opencode'] }),
    'utf8'
  );
  const { runCrossOp } = await import('./src/cross-orchestrator.js');
  const result = await runCrossOp({
    mode: 'phase-e-auto',
    target: 'test-phase',
    projectDir: root,
    env: {},
    quiet: true,
  });
  assert.ok(result.notes.some(n => n.includes('opencode')));
  assert.equal(result.verdict, 'CONDITIONAL');
});

// ---------------------------------------------------------------------------
// Test 4: apiFallback used when CLI missing but API key set
// ---------------------------------------------------------------------------
test('phase-e-auto: annotates pick as API-only when CLI absent but key set', async () => {
  clearInstalledCache();
  const root = makeTmp();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(
    join(root, '.ijfw', 'swarm.json'),
    JSON.stringify({ project_type: 'node', specialists: [], auditors: ['codex'] }),
    'utf8'
  );
  // codex CLI absent but OPENAI_API_KEY set → should be reachable via API
  // The actual API call will fail (fake key) but the pick IS included.
  // We just verify: no "skipped" note for codex, and an outputPath is written.
  const { runCrossOp } = await import('./src/cross-orchestrator.js');
  const result = await runCrossOp({
    mode: 'phase-e-auto',
    target: 'test-phase',
    projectDir: root,
    env: { OPENAI_API_KEY: 'sk-test-fake' },
    quiet: true,
  });
  // codex should NOT appear in skipped notes (it was picked via API path)
  const noteText = (result.notes || []).join(' ');
  assert.ok(!noteText.includes("skipped auditor 'codex'"), `codex should not be skipped: ${noteText}`);
  assert.ok(existsSync(result.outputPath));
});

// ---------------------------------------------------------------------------
// Test 5: output path increments N correctly
// ---------------------------------------------------------------------------
test('phase-e-auto: increments CROSS-AUDIT-r<N>.md correctly', async () => {
  clearInstalledCache();
  const root = makeTmp();
  // Pre-seed an existing r1 and r2
  mkdirSync(join(root, '.planning', 'test-phase'), { recursive: true });
  writeFileSync(join(root, '.planning', 'test-phase', 'CROSS-AUDIT-r1.md'), '# old\n', 'utf8');
  writeFileSync(join(root, '.planning', 'test-phase', 'CROSS-AUDIT-r2.md'), '# old\n', 'utf8');

  const { runCrossOp } = await import('./src/cross-orchestrator.js');
  const result = await runCrossOp({
    mode: 'phase-e-auto',
    target: 'test-phase',
    projectDir: root,
    env: {},
    quiet: true,
  });
  assert.ok(result.outputPath.endsWith('CROSS-AUDIT-r3.md'), `expected r3, got: ${result.outputPath}`);
  assert.ok(existsSync(result.outputPath));
});

// ---------------------------------------------------------------------------
// Test 6: returns {verdict, findings, outputPath} shape
// ---------------------------------------------------------------------------
test('phase-e-auto: return shape has verdict, findings, outputPath', async () => {
  clearInstalledCache();
  const root = makeTmp();
  const { runCrossOp } = await import('./src/cross-orchestrator.js');
  const result = await runCrossOp({
    mode: 'phase-e-auto',
    target: 'v1.4.4',
    projectDir: root,
    env: {},
    quiet: true,
  });
  assert.ok('verdict' in result, 'missing verdict');
  assert.ok('findings' in result, 'missing findings');
  assert.ok('outputPath' in result, 'missing outputPath');
  assert.ok(['PASS', 'CONDITIONAL', 'FAIL'].includes(result.verdict), `unexpected verdict: ${result.verdict}`);
  assert.ok(Array.isArray(result.findings));
  assert.ok(existsSync(result.outputPath), `outputPath not written: ${result.outputPath}`);
});

// ---------------------------------------------------------------------------
// Test 7: swarm.json auditors + auditor_count defaults applied by loadSwarmConfig
// ---------------------------------------------------------------------------
test('swarm-config: loadSwarmConfig applies auditors defaults to old swarm.json', async () => {
  const root = makeTmp();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  // Write a swarm.json without auditors/auditor_count (pre-v1.4.4 format)
  writeFileSync(
    join(root, '.ijfw', 'swarm.json'),
    JSON.stringify({ project_type: 'node', specialists: [] }),
    'utf8'
  );
  const { loadSwarmConfig, DEFAULT_AUDITORS, DEFAULT_AUDITOR_COUNT } = await import('./src/swarm-config.js');
  const config = loadSwarmConfig(root);
  assert.deepEqual(config.auditors, DEFAULT_AUDITORS);
  assert.equal(config.auditor_count, DEFAULT_AUDITOR_COUNT);
});

// ---------------------------------------------------------------------------
// Test 8: fresh swarm.json written by loadSwarmConfig includes auditors field
// ---------------------------------------------------------------------------
test('swarm-config: new swarm.json seeded with auditors field', async () => {
  const root = makeTmp();
  // No .ijfw/swarm.json — let loadSwarmConfig create one
  const { loadSwarmConfig, DEFAULT_AUDITORS } = await import('./src/swarm-config.js');
  const config = loadSwarmConfig(root);
  assert.ok(Array.isArray(config.auditors));
  assert.deepEqual(config.auditors, DEFAULT_AUDITORS);
  // Verify the written file also has the field
  const written = JSON.parse(readFileSync(join(root, '.ijfw', 'swarm.json'), 'utf8'));
  assert.ok(Array.isArray(written.auditors));
});
