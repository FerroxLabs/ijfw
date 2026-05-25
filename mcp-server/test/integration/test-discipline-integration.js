/**
 * test-discipline-integration.js — integration tests for populateDisciplineBlock
 * across all 6 project types (code | narrative | business | design | research | unknown).
 *
 * Style: node:test synchronous-style test() blocks, matching the rest of
 * mcp-server/test/integration/. Spawns temp repos under os.tmpdir() and
 * cleans up in finally blocks.
 *
 * Run: cd mcp-server && node --test test/integration/test-discipline-integration.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
      // Empty-body contract: markers present, body is whitespace-only (no domain content).
      assert.ok(
        blockBody.trim().length === 0,
        'DISCIPLINE block body must be empty for type "unknown"',
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
