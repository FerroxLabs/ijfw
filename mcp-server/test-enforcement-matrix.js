/**
 * test-enforcement-matrix.js — T16 accuracy check
 *
 * Parses docs/ENFORCEMENT-MATRIX.md §5 "Mechanism file index" and asserts:
 *   1. Every PATH: entry exists on disk (relative to repo root).
 *   2. Every VERB: entry is present in the VERBS registry exported from
 *      mcp-server/src/orchestrator/state-sdk.js.
 *
 * Uses real I/O — no mocks. Fails fast on any mismatch so a stale matrix
 * entry causes an immediate CI failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repo root — two levels up from mcp-server/
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Parse the mechanism index from ENFORCEMENT-MATRIX.md §5
// ---------------------------------------------------------------------------

const MATRIX_PATH = join(REPO_ROOT, 'docs', 'ENFORCEMENT-MATRIX.md');

function parseMechanismIndex(matrixPath) {
  const raw = readFileSync(matrixPath, 'utf8');

  // Extract the fenced code block inside §5
  const match = raw.match(/```\n([\s\S]*?)```/);
  assert.ok(
    match,
    'ENFORCEMENT-MATRIX.md §5 must contain a fenced code block with PATH:/VERB: entries',
  );

  const paths = [];
  const verbs = [];

  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PATH:')) {
      paths.push(trimmed.slice('PATH:'.length).trim());
    } else if (trimmed.startsWith('VERB:')) {
      verbs.push(trimmed.slice('VERB:'.length).trim());
    }
  }

  assert.ok(paths.length > 0, 'mechanism index must list at least one PATH entry');
  assert.ok(verbs.length > 0, 'mechanism index must list at least one VERB entry');

  return { paths, verbs };
}

// ---------------------------------------------------------------------------
// Load VERBS registry (real import — no mock)
// ---------------------------------------------------------------------------

async function loadVerbs() {
  const sdkPath = join(REPO_ROOT, 'mcp-server', 'src', 'orchestrator', 'state-sdk.js');
  assert.ok(
    existsSync(sdkPath),
    `state-sdk.js not found at expected path: ${sdkPath}`,
  );
  const mod = await import(`file://${sdkPath}`);
  assert.ok(
    mod.VERBS && typeof mod.VERBS === 'object',
    'state-sdk.js must export VERBS (the frozen verb registry)',
  );
  return mod.VERBS;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('ENFORCEMENT-MATRIX.md exists', () => {
  assert.ok(
    existsSync(MATRIX_PATH),
    `docs/ENFORCEMENT-MATRIX.md not found at: ${MATRIX_PATH}`,
  );
});

test('every PATH entry in mechanism index exists on disk', () => {
  const { paths } = parseMechanismIndex(MATRIX_PATH);
  const missing = [];

  for (const relPath of paths) {
    const abs = join(REPO_ROOT, relPath);
    if (!existsSync(abs)) {
      missing.push(relPath);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `The following mechanism paths listed in ENFORCEMENT-MATRIX.md §5 do not exist on disk:\n${missing.map((p) => `  ${p}`).join('\n')}`,
  );
});

test('every VERB entry in mechanism index is registered in state-sdk.js VERBS', async () => {
  const { verbs } = parseMechanismIndex(MATRIX_PATH);
  const VERBS = await loadVerbs();
  const knownVerbs = new Set(Object.keys(VERBS));
  const unknown = [];

  for (const verb of verbs) {
    if (!knownVerbs.has(verb)) {
      unknown.push(verb);
    }
  }

  assert.deepEqual(
    unknown,
    [],
    `The following verbs listed in ENFORCEMENT-MATRIX.md §5 are NOT in state-sdk.js VERBS:\n${unknown.map((v) => `  "${v}"`).join('\n')}\nKnown verbs: ${[...knownVerbs].sort().join(', ')}`,
  );
});

test('VERBS registry covers all 20 frozen verbs from contract §8', async () => {
  const VERBS = await loadVerbs();
  const CONTRACT_VERBS = [
    'workflow.get', 'workflow.set-phase',
    'wave.get', 'wave.advance', 'wave.record-task',
    'phase.plan-check', 'phase.complete',
    'subagent.dispatch', 'subagent.checkpoint', 'subagent.post-done',
    'event.emit', 'telemetry.record',
    'roster.synthesize', 'roster.record',
    'extension.set-active',
    'decision.add', 'blocker.add', 'blocker.resolve',
    'state.replay', 'state.validate',
  ];
  const knownVerbs = new Set(Object.keys(VERBS));
  const missing = CONTRACT_VERBS.filter((v) => !knownVerbs.has(v));
  assert.deepEqual(
    missing,
    [],
    `Contract §8 verbs missing from VERBS registry: ${missing.join(', ')}`,
  );
  assert.equal(
    knownVerbs.size,
    20,
    `VERBS registry should have exactly 20 entries (contract §8); found ${knownVerbs.size}: ${[...knownVerbs].sort().join(', ')}`,
  );
});

test('W3 boundary verbs (phase.complete, phase.plan-check, subagent.post-done, wave.advance) are all in matrix index', () => {
  const { verbs } = parseMechanismIndex(MATRIX_PATH);
  const verbSet = new Set(verbs);
  const W3_BOUNDARIES = ['phase.complete', 'phase.plan-check', 'subagent.post-done', 'wave.advance'];

  for (const boundary of W3_BOUNDARIES) {
    assert.ok(
      verbSet.has(boundary),
      `W3 boundary verb "${boundary}" is missing from ENFORCEMENT-MATRIX.md §5 VERB index`,
    );
  }
});

test('matrix index lists the expected number of PATH entries (≥17)', () => {
  const { paths } = parseMechanismIndex(MATRIX_PATH);
  assert.ok(
    paths.length >= 17,
    `Expected ≥17 PATH entries in mechanism index, found ${paths.length}`,
  );
});

test('matrix index lists all 20 contract verbs (full coverage)', () => {
  const { verbs } = parseMechanismIndex(MATRIX_PATH);
  assert.equal(
    verbs.length,
    20,
    `Expected exactly 20 VERB entries in mechanism index (one per contract §8 verb), found ${verbs.length}`,
  );
});
