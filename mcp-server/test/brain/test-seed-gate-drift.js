import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROJECT_MARKERS } from '../../src/brain/seed-gate.js';

// The seed-gate project-marker list is defined THREE times -- once per language
// surface that materializes on-disk content:
//   1. JS   : mcp-server/src/brain/seed-gate.js  (PROJECT_MARKERS)
//   2. bash : claude/skills/ijfw-agents-md/scripts/seed-gate.sh (IJFW_SEED_MARKERS)
//   3. bash : scripts/build-codebase-index.sh    (ijfw_has_project_marker)
// They MUST stay identical or a directory would be treated as a project by one
// surface and a scratch dir by another. This test fails the moment they drift.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function sorted(set) {
  return [...set].sort();
}

// --- 1. JS source of truth ---
const jsMarkers = new Set(PROJECT_MARKERS);

// --- 2. seed-gate.sh IJFW_SEED_MARKERS="..." ---
function parseShSeedGate() {
  const src = readFileSync(
    join(repoRoot, 'claude', 'skills', 'ijfw-agents-md', 'scripts', 'seed-gate.sh'),
    'utf8'
  );
  const m = src.match(/IJFW_SEED_MARKERS="([^"]+)"/);
  assert.ok(m, 'seed-gate.sh must define IJFW_SEED_MARKERS="..."');
  return new Set(m[1].trim().split(/\s+/));
}

// --- 3. build-codebase-index.sh `for _m in ... ; do` ---
function parseIndexerMarkers() {
  const src = readFileSync(join(repoRoot, 'scripts', 'build-codebase-index.sh'), 'utf8');
  // Grab the multi-line `for _m in <markers>; do` list inside
  // ijfw_has_project_marker. Markers may wrap across lines with backslashes.
  const m = src.match(/for\s+_m\s+in\s+([\s\S]*?);\s*do/);
  assert.ok(m, 'build-codebase-index.sh must define `for _m in ...; do`');
  const list = m[1].replace(/\\/g, ' ').trim().split(/\s+/);
  return new Set(list);
}

test('seed-gate marker list: JS == seed-gate.sh', () => {
  assert.deepEqual(sorted(parseShSeedGate()), sorted(jsMarkers),
    'seed-gate.sh IJFW_SEED_MARKERS drifted from seed-gate.js PROJECT_MARKERS');
});

test('seed-gate marker list: JS == indexer guard', () => {
  assert.deepEqual(sorted(parseIndexerMarkers()), sorted(jsMarkers),
    'build-codebase-index.sh ijfw_has_project_marker drifted from seed-gate.js PROJECT_MARKERS');
});
