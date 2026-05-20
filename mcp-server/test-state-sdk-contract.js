// test-state-sdk-contract.js — T1 contract validator.
//
// Parses .planning/v150-gap-closure/STATE-SDK-CONTRACT.md and asserts the
// frozen contract is complete: every required verb has a full block, all four
// cross-cutting models are present and non-empty, and the lock hierarchy is a
// concrete ordered list of real file references (not prose).
//
// This file IS the completion contract for T1 — `node --test` must pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- Resolve the contract doc robustly --------------------------------------
// The test runs from repo root via `node --test mcp-server/test-state-sdk-contract.js`.
// Compute the path relative to this file (mcp-server/) -> repo root -> .planning/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const CONTRACT_PATH = join(
  repoRoot,
  '.planning',
  'v150-gap-closure',
  'STATE-SDK-CONTRACT.md',
);

const doc = readFileSync(CONTRACT_PATH, 'utf8');
const lines = doc.split(/\r?\n/);

// --- The required verb set (frozen — must all be present) -------------------
const REQUIRED_VERBS = [
  'workflow.get',
  'workflow.set-phase',
  'wave.get',
  'wave.advance',
  'wave.record-task',
  'phase.plan-check',
  'phase.complete',
  'subagent.dispatch',
  'subagent.checkpoint',
  'subagent.post-done',
  'event.emit',
  'telemetry.record',
  'roster.synthesize',
  'roster.record',
  'extension.set-active',
  'decision.add',
  'blocker.add',
  'blocker.resolve',
  'state.replay',
  'state.validate',
];

const VERB_SUBFIELDS = ['Signature', 'Payload', 'Returns', 'Day-1', 'Locks'];

// --- Extract every "### verb: <name>" block ---------------------------------
// A block runs from its header line to the next "### " or "## " header (or EOF).
function extractVerbBlocks(text) {
  const blocks = new Map();
  const verbHeader = /^###\s+verb:\s+(\S+)\s*$/;
  const anyHeader = /^#{2,3}\s+/;
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(verbHeader);
    if (!m) continue;
    const name = m[1];
    const body = [];
    for (let j = i + 1; j < all.length; j++) {
      if (anyHeader.test(all[j])) break;
      body.push(all[j]);
    }
    blocks.set(name, body.join('\n'));
  }
  return blocks;
}

const verbBlocks = extractVerbBlocks(doc);

// --- Verb-block tests -------------------------------------------------------
test('every required verb has a "### verb: <name>" block', () => {
  for (const verb of REQUIRED_VERBS) {
    assert.ok(
      verbBlocks.has(verb),
      `missing block for required verb: "${verb}"`,
    );
  }
});

test('the verb set is at least 17 verbs (brief floor)', () => {
  assert.ok(
    REQUIRED_VERBS.length >= 17,
    `required verb set has ${REQUIRED_VERBS.length}, expected >= 17`,
  );
});

for (const verb of REQUIRED_VERBS) {
  test(`verb "${verb}" has all 5 sub-fields, each non-empty`, () => {
    const block = verbBlocks.get(verb);
    assert.ok(block, `no block for "${verb}"`);
    for (const field of VERB_SUBFIELDS) {
      // Match a bullet line like:  "- Signature: query(...)"
      const re = new RegExp(`^-\\s*${field}\\s*:\\s*(.+)$`, 'm');
      const m = block.match(re);
      assert.ok(
        m,
        `verb "${verb}" is missing sub-field "${field}"`,
      );
      const content = m[1].trim();
      assert.ok(
        content.length > 0,
        `verb "${verb}" sub-field "${field}" has no content after the label`,
      );
    }
  });
}

// --- Cross-cutting model tests ----------------------------------------------
// Extract a "## N. CROSS-CUTTING MODEL ..." section body.
function extractSection(headingMatcher) {
  const sectionHeader = /^##\s+/;
  for (let i = 0; i < lines.length; i++) {
    if (sectionHeader.test(lines[i]) && headingMatcher.test(lines[i])) {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (sectionHeader.test(lines[j])) break;
        body.push(lines[j]);
      }
      return { heading: lines[i], body: body.join('\n') };
    }
  }
  return null;
}

const MODELS = [
  { name: 'Lock hierarchy', matcher: /CROSS-CUTTING MODEL 1.*Lock hierarchy/i },
  { name: 'Intent/commit record', matcher: /CROSS-CUTTING MODEL 2.*Intent\s*\/\s*commit/i },
  { name: 'Event record', matcher: /CROSS-CUTTING MODEL 3.*Event record/i },
  { name: 'Gate failure rule', matcher: /CROSS-CUTTING MODEL 4.*Gate failure/i },
];

for (const model of MODELS) {
  test(`cross-cutting model "${model.name}" is present and non-empty`, () => {
    const section = extractSection(model.matcher);
    assert.ok(section, `cross-cutting model section "${model.name}" not found`);
    // "non-empty" = meaningful content beyond whitespace; require a real body.
    assert.ok(
      section.body.replace(/\s/g, '').length > 80,
      `cross-cutting model "${model.name}" section is empty/too thin`,
    );
  });
}

test('all 4 cross-cutting models are present', () => {
  for (const model of MODELS) {
    assert.ok(
      extractSection(model.matcher),
      `cross-cutting model "${model.name}" missing`,
    );
  }
});

// --- Lock hierarchy: concrete ordered file list -----------------------------
test('lock hierarchy is a concrete ORDERED list of real file references', () => {
  const section = extractSection(MODELS[0].matcher);
  assert.ok(section, 'lock hierarchy section not found');

  // The acquire-order is an ordered (numbered) list: lines like "1. `path` — ...".
  const orderedItems = section.body
    .split(/\r?\n/)
    .filter((l) => /^\s*\d+\.\s+/.test(l));

  assert.ok(
    orderedItems.length >= 8,
    `lock hierarchy has ${orderedItems.length} ordered items, expected >= 8`,
  );

  // Each item must reference a real state file — not prose. A "file reference"
  // looks like a path with a slash and a known state extension, or a known
  // bare state filename.
  const fileLike =
    /(\.ijfw\/[^\s`]+|~\/\.ijfw\/[^\s`]+|AGENTS\.md|workflow\.json|waves\.json|STATE\.md|[A-Za-z0-9_*-]+\.(?:json|jsonl|md))/;

  let fileRefCount = 0;
  for (const item of orderedItems) {
    if (fileLike.test(item)) fileRefCount++;
  }
  assert.ok(
    fileRefCount >= 8,
    `lock hierarchy: only ${fileRefCount} of ${orderedItems.length} ordered ` +
      `items contain a concrete file reference (expected >= 8)`,
  );

  // The order must be strictly 1,2,3,... — a real ordered list, not a bag.
  const numbers = orderedItems.map((l) => parseInt(l.match(/^\s*(\d+)\./)[1], 10));
  for (let i = 0; i < numbers.length; i++) {
    assert.equal(
      numbers[i],
      i + 1,
      `lock hierarchy item #${i + 1} is numbered ${numbers[i]} — not strictly ordered`,
    );
  }

  // The intent journal must be first and the homedir file last (deadlock-free
  // coarse-to-fine invariant from the brief / Model 1).
  assert.match(
    orderedItems[0],
    /intent-journal/,
    'lock hierarchy item #1 must be the intent journal',
  );
  assert.match(
    orderedItems[orderedItems.length - 1],
    /~\/\.ijfw|active-extension/,
    'lock hierarchy last item must be the homedir active-extension file',
  );
});

// --- CLI face is stated explicitly ------------------------------------------
test('the CLI face "ijfw state:<verb>" colon-namespace is stated', () => {
  assert.match(
    doc,
    /ijfw\s+state:<verb>/,
    'contract must state the "ijfw state:<verb>" colon-namespace CLI face',
  );
  assert.ok(
    /colon-namespace/i.test(doc),
    'contract must describe the CLI face as a colon-namespace',
  );
});

// --- Append verbs carry a dedup key -----------------------------------------
test('append-style verbs declare a dedupKey in their Payload', () => {
  const appendVerbs = [
    'wave.record-task',
    'subagent.checkpoint',
    'event.emit',
    'telemetry.record',
    'roster.record',
    'decision.add',
    'blocker.add',
    'blocker.resolve',
  ];
  for (const verb of appendVerbs) {
    const block = verbBlocks.get(verb);
    assert.ok(block, `no block for append verb "${verb}"`);
    assert.match(
      block,
      /dedupKey/,
      `append verb "${verb}" must carry a dedupKey (appends are not idempotent)`,
    );
  }
});

// --- Gate failure rule names the three outcomes -----------------------------
test('gate failure rule documents verdict-fail / execution-fail / MCP-unavailable', () => {
  const section = extractSection(MODELS[3].matcher);
  assert.ok(section, 'gate failure rule section not found');
  assert.match(section.body, /verdict-fail/i, 'must name verdict-fail');
  assert.match(section.body, /execution-fail/i, 'must name execution-fail');
  assert.match(section.body, /MCP-unavailable/i, 'must name the MCP-unavailable bypass');
});
