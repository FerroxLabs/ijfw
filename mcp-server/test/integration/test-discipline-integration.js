/**
 * test-discipline-integration.js — integration tests for populateDisciplineBlock
 * across all 6 project types (code | narrative | business | design | research | unknown).
 *
 * Style: node:test synchronous-style test() blocks, matching the rest of
 * mcp-server/test/integration/. Spawns temp repos under os.tmpdir() and
 * cleans up in the after() hook.
 *
 * Run: cd mcp-server && node --test test/integration/test-discipline-integration.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { populateDisciplineBlock } from '../../src/orchestrator/agents-md-blackboard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp repo directory and return its path. */
function makeTempRepo() {
  return mkdtempSync(join(tmpdir(), 'discipline-test-'));
}

/** Extract the inner body of <!-- IJFW-DISCIPLINE-START --> ... END --> */
function readDisciplineBlock(agentsMdPath) {
  const src = readFileSync(agentsMdPath, 'utf8');
  const startM = '<!-- IJFW-DISCIPLINE-START -->';
  const endM = '<!-- IJFW-DISCIPLINE-END -->';
  const s = src.indexOf(startM);
  const e = src.indexOf(endM);
  if (s === -1 || e === -1 || e <= s) return null;
  return src.slice(s + startM.length, e);
}

// Collect temp dirs for cleanup after all tests.
const tempDirs = [];

// Pre-clean any orphaned discipline-test-* dirs from killed prior runs.
before(() => {
  const tmp = tmpdir();
  for (const e of readdirSync(tmp).filter((n) => n.startsWith('discipline-test-'))) {
    try { rmSync(join(tmp, e), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Per-type signature phrases (stable phrases from each discipline-<type>.md)
// ---------------------------------------------------------------------------

const TYPE_SIGNATURES = {
  code:      'Plausibility is not correctness',
  narrative: 'Plausibility is not continuity',
  business:  'Plausibility is not feasibility',
  design:    'Plausibility is not conformance',
  research:  'Plausibility is not evidence',
};

// ---------------------------------------------------------------------------
// Tests: one test per project type (6 types)
// ---------------------------------------------------------------------------

for (const projectType of ['code', 'narrative', 'business', 'design', 'research', 'unknown']) {
  test(`populateDisciplineBlock writes DISCIPLINE block for type: ${projectType}`, async () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);

    const result = await populateDisciplineBlock(tmpRepo, projectType);
    assert.deepEqual(result, { ok: true }, `return value must be { ok: true } for type "${projectType}"`);

    const agentsMdPath = join(tmpRepo, 'AGENTS.md');
    const src = readFileSync(agentsMdPath, 'utf8');

    assert.ok(
      src.includes('<!-- IJFW-DISCIPLINE-START -->'),
      `AGENTS.md must contain DISCIPLINE start marker for type "${projectType}"`,
    );
    assert.ok(
      src.includes('<!-- IJFW-DISCIPLINE-END -->'),
      `AGENTS.md must contain DISCIPLINE end marker for type "${projectType}"`,
    );

    const blockBody = readDisciplineBlock(agentsMdPath);
    assert.notEqual(blockBody, null, 'DISCIPLINE block markers must be present and ordered');

    if (projectType === 'unknown') {
      // Track F2 changes selectDisciplineTemplate(unknown) to return a helpful
      // comment block containing 'IJFW: project type is'. Accept either the new
      // hint OR an empty body (permissive: handles the brief window where only
      // this commit has landed and F2 is not yet merged).
      const hasHint = blockBody.includes('IJFW: project type is');
      const isEmpty = blockBody.trim().length === 0;
      assert.ok(
        hasHint || isEmpty,
        'DISCIPLINE block for "unknown" must either contain IJFW hint or be empty',
      );
      // Verify no typed-domain content leaked in.
      for (const sig of Object.values(TYPE_SIGNATURES)) {
        assert.ok(
          !blockBody.includes(sig),
          `unknown type must not contain domain signature "${sig}"`,
        );
      }
    } else {
      // Non-unknown types: assert the type-specific signature phrase is present.
      const sig = TYPE_SIGNATURES[projectType];
      assert.ok(
        blockBody.includes(sig),
        `DISCIPLINE block for type "${projectType}" must contain signature: "${sig}"`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Idempotency tests: two calls with same args must produce byte-identical output
// ---------------------------------------------------------------------------

for (const projectType of ['code', 'narrative', 'business', 'design', 'research', 'unknown']) {
  test(`populateDisciplineBlock is idempotent for type: ${projectType}`, async () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);

    await populateDisciplineBlock(tmpRepo, projectType);
    const bytes1 = readFileSync(join(tmpRepo, 'AGENTS.md'));

    await populateDisciplineBlock(tmpRepo, projectType);
    const bytes2 = readFileSync(join(tmpRepo, 'AGENTS.md'));

    assert.equal(
      bytes1.equals(bytes2),
      true,
      `re-running populateDisciplineBlock for type "${projectType}" must produce byte-identical AGENTS.md`,
    );
  });
}

// ---------------------------------------------------------------------------
// Cross-detection test: no explicit type supplied + package.json present
// -> detectProjectTypeFromRepo infers 'code' -> code-discipline body written
// ---------------------------------------------------------------------------

test('populateDisciplineBlock auto-detects code type from package.json', async () => {
  const tmpRepo = makeTempRepo();
  tempDirs.push(tmpRepo);

  // Place a package.json to trigger 'code' detection.
  writeFileSync(join(tmpRepo, 'package.json'), JSON.stringify({ name: 'test-proj', version: '0.0.1' }));

  // Call without explicit projectType — detection must kick in.
  const result = await populateDisciplineBlock(tmpRepo);
  assert.deepEqual(result, { ok: true }, 'auto-detection must return { ok: true }');

  const agentsMdPath = join(tmpRepo, 'AGENTS.md');
  const blockBody = readDisciplineBlock(agentsMdPath);
  assert.notEqual(blockBody, null, 'DISCIPLINE block markers must be present after auto-detection');
  assert.ok(
    blockBody.includes(TYPE_SIGNATURES.code),
    `auto-detected code discipline must contain signature: "${TYPE_SIGNATURES.code}"`,
  );
});

// ---------------------------------------------------------------------------
// New assertions for fixes 5B-L1-03, 5B-L2-05, 5B-L2-07
// ---------------------------------------------------------------------------

test('populateBlackboardBlock with unsafe projectRoot returns unsafe-path', async () => {
  // Import populateBlackboardBlock here — it's exported from the same module.
  const { populateBlackboardBlock } = await import('../../src/orchestrator/agents-md-blackboard.js');
  // '/' as projectRoot means AGENTS.md would be at '/AGENTS.md' which is at
  // the repo root itself — validateSafeRepoPath rejects this (rel === '').
  const result = await populateBlackboardBlock('w1', '/');
  // May return no-state (readWaveState returns null for '/') or unsafe-path
  // depending on whether the guard fires before readWaveState. Either way it
  // must NOT be ok:true.
  assert.ok(result.ok === false, 'unsafe projectRoot must not produce ok:true');
});

test('populateDisciplineBlock with unsafe projectRoot returns unsafe-path', async () => {
  const result = await populateDisciplineBlock('/', 'code');
  assert.equal(result.ok, false, 'must return ok:false for unsafe projectRoot');
  assert.equal(result.reason, 'unsafe-path', 'reason must be unsafe-path');
});

test('populateDisciplineBlock second call returns noop:true (no-op short-circuit)', async () => {
  const tmpRepo = makeTempRepo();
  tempDirs.push(tmpRepo);

  const first = await populateDisciplineBlock(tmpRepo, 'code');
  assert.equal(first.ok, true, 'first call must succeed');

  const second = await populateDisciplineBlock(tmpRepo, 'code');
  assert.equal(second.ok, true, 'second call must return ok:true');
  assert.equal(second.noop, true, 'second call must return noop:true (content unchanged)');
});

test('populateDisciplineBlock unknown type body has IJFW hint or is empty', async () => {
  const tmpRepo = makeTempRepo();
  tempDirs.push(tmpRepo);

  const result = await populateDisciplineBlock(tmpRepo, 'unknown');
  assert.equal(result.ok, true, 'unknown type must return ok:true');

  const agentsMdPath = join(tmpRepo, 'AGENTS.md');
  const blockBody = readDisciplineBlock(agentsMdPath);
  assert.notEqual(blockBody, null, 'DISCIPLINE block markers must be present');
  const hasHint = blockBody.includes('IJFW: project type is');
  const isEmpty = blockBody.trim().length === 0;
  assert.ok(
    hasHint || isEmpty,
    'unknown type block must contain IJFW hint or be empty',
  );
});

test('populateDisciplineBlock accepts waveId option', async () => {
  const tmpRepo = makeTempRepo();
  tempDirs.push(tmpRepo);

  const result = await populateDisciplineBlock(tmpRepo, 'code', { waveId: 'w42' });
  assert.equal(result.ok, true, 'waveId option must be accepted and call must succeed');
});

// ---------------------------------------------------------------------------
// W1 wiring regression guard — populateDisciplineBlock must be invoked from
// production code, not just from tests. The cross-audit's W1 lens caught this
// as a real BLOCKER: the function shipped as dead code because the only
// "calling path" was prose in ijfw-workflow/SKILL.md.
//
// This test asserts the wiring exists by source-inspecting wave-state.js for
// the load + invocation pattern. If a future change removes the wiring, this
// test fails — keeping the no-half-shipping invariant explicit.
// ---------------------------------------------------------------------------

test('wave-state.js::checkpointWave invokes populateDisciplineBlock (wiring guard)', async () => {
  const waveStatePath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    '..',
    'src',
    'orchestrator',
    'wave-state.js',
  );
  const src = readFileSync(waveStatePath, 'utf8');

  assert.match(
    src,
    /loadPopulateDisciplineBlock\s*\(/,
    'wave-state.js must define loadPopulateDisciplineBlock lazy loader',
  );
  assert.match(
    src,
    /mod\.populateDisciplineBlock/,
    'wave-state.js must import the populateDisciplineBlock symbol from agents-md-blackboard',
  );
  assert.match(
    src,
    /await populateDisciplineBlock\s*\(\s*projectRoot/,
    'wave-state.js::checkpointWave must call populateDisciplineBlock(projectRoot, ...)',
  );
});

test('wave-state.js wires DISCIPLINE invocation INSIDE checkpointWave (not orphan)', async () => {
  // Stronger guard: the populateDisciplineBlock call must appear within the
  // checkpointWave function body, not in some unreachable helper. We slice
  // from `export async function checkpointWave` to the next top-level
  // `export` and require the wiring to live inside that slice.
  const waveStatePath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    '..',
    'src',
    'orchestrator',
    'wave-state.js',
  );
  const src = readFileSync(waveStatePath, 'utf8');

  const fnStart = src.indexOf('export async function checkpointWave');
  assert.notEqual(fnStart, -1, 'checkpointWave must be exported');
  const nextExport = src.indexOf('\nexport ', fnStart + 1);
  const fnBody = nextExport === -1 ? src.slice(fnStart) : src.slice(fnStart, nextExport);

  assert.ok(
    /await populateDisciplineBlock\s*\(/.test(fnBody),
    'populateDisciplineBlock must be called INSIDE checkpointWave body, not in a sibling helper',
  );
});
