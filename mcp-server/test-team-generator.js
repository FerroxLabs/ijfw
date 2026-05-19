import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTeamAssembly,
  detectTeamArchetype,
  loadTeamTemplate,
  readTeamAssembly,
  scoreBrief,
} from './src/team/generator.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-team-generator-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('loadTeamTemplate validates and clones archetype fixtures', () => {
  const first = loadTeamTemplate('software');
  const second = loadTeamTemplate('software');
  first.charter.team_name = 'mutated';
  assert.equal(second.charter.team_name, 'software-delivery-team');
});

test('detectTeamArchetype accepts explicit archetype and normalizes unknown to mixed', () => {
  const dir = makeTmp();
  try {
    assert.equal(detectTeamArchetype(dir, { archetype: 'design' }), 'design');
    assert.equal(detectTeamArchetype(dir, { archetype: 'unknown-domain' }), 'mixed');
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly writes charter workflow and agent files', () => {
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'content', teamName: 'launch-content-team' });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'content');
    assert.ok(existsSync(join(dir, '.ijfw', 'team', 'charter.json')));
    assert.ok(existsSync(join(dir, '.ijfw', 'team', 'workflow.json')));
    assert.ok(existsSync(join(dir, '.ijfw', 'agents', 'content-strategist.md')));
    assert.ok(existsSync(join(dir, '.ijfw', 'agents', 'editor.md')));

    const charter = JSON.parse(readFileSync(join(dir, '.ijfw', 'team', 'charter.json'), 'utf8'));
    assert.equal(charter.team_name, 'launch-content-team');
    assert.equal(charter.source_archetype, 'content');

    const agent = readFileSync(join(dir, '.ijfw', 'agents', 'content-strategist.md'), 'utf8');
    assert.match(agent, /name: content-strategist/);
    assert.match(agent, /Record claims, findings, blockers, and decisions/);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly preserves existing team unless force is set', () => {
  const dir = makeTmp();
  try {
    assert.equal(createTeamAssembly(dir, { archetype: 'book' }).ok, true);
    const blocked = createTeamAssembly(dir, { archetype: 'design' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'exists');

    const forced = createTeamAssembly(dir, { archetype: 'design', force: true });
    assert.equal(forced.ok, true);
    const state = readTeamAssembly(dir);
    assert.equal(state.ok, true);
    assert.deepEqual(state.charter.project_archetypes, ['design']);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly can detect a software project from package.json', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{}\n');
    const result = createTeamAssembly(dir, { maxFiles: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'software');
  } finally {
    cleanup(dir);
  }
});

// --- F-FUN-1 (H2.1): brief-aware archetype routing ----------------------

test('detectTeamArchetype routes a book brief to book even from an empty dir', () => {
  const dir = makeTmp();
  try {
    const brief = 'I want to write a novel about a chef. Five chapters, first-person prose.';
    assert.equal(detectTeamArchetype(dir, { brief }), 'book');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype routes a research brief to research', () => {
  const dir = makeTmp();
  try {
    const brief = 'Research paper on quantum entanglement with a literature review and methodology.';
    assert.equal(detectTeamArchetype(dir, { brief }), 'research');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype routes a campaign brief to content', () => {
  const dir = makeTmp();
  try {
    const brief = 'Launch marketing campaign with blog posts, social media, and SEO copy.';
    assert.equal(detectTeamArchetype(dir, { brief }), 'content');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype defaults a software project with no brief from filesystem signal', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    // No brief -- filesystem must drive. Manifest -> software.
    assert.equal(detectTeamArchetype(dir, { maxFiles: 20 }), 'software');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype brief outweighs filesystem when both have signal', () => {
  const dir = makeTmp();
  try {
    // Filesystem says software (package.json), brief says book.
    // F-FUN-1 contract: brief wins when brief has explicit signal.
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    const brief = 'Write a book about chefs. Five chapters of literary fiction prose.';
    assert.equal(detectTeamArchetype(dir, { brief, maxFiles: 20 }), 'book');
  } finally {
    cleanup(dir);
  }
});

test('scoreBrief returns per-domain scores and handles empty briefs', () => {
  // Empty brief: all zeros.
  const empty = scoreBrief('');
  assert.equal(empty.software, 0);
  assert.equal(empty.book, 0);
  // Domain-explicit phrase scores at least the flip threshold (>= 2).
  const bookScore = scoreBrief('I want to write a book about cooking.');
  assert.ok(bookScore.book >= 2, `expected book>=2, got ${bookScore.book}`);
  // Ambiguous brief shouldn't pick a winner from a single token alone.
  const ambig = scoreBrief('research');
  // "research" alone is just 1 token-hit; below the flip threshold.
  assert.equal(ambig.research, 1);
});

test('normalizeArchetype canonicalizes detector language labels to software', () => {
  // F-FUN-1 mapping fix: typescript/javascript/python aren't in
  // SUPPORTED_ARCHETYPES but they're software in every meaningful sense.
  // The detector calling path goes through detectTeamArchetype's explicit
  // archetype option -- that's the public surface that exercises the mapping.
  const dir = makeTmp();
  try {
    assert.equal(detectTeamArchetype(dir, { archetype: 'typescript' }), 'software');
    assert.equal(detectTeamArchetype(dir, { archetype: 'javascript' }), 'software');
    assert.equal(detectTeamArchetype(dir, { archetype: 'python' }), 'software');
    assert.equal(detectTeamArchetype(dir, { archetype: 'campaign' }), 'content');
    assert.equal(detectTeamArchetype(dir, { archetype: 'novel' }), 'book');
    // Unknown still collapses to mixed.
    assert.equal(detectTeamArchetype(dir, { archetype: 'martian-poetry-slam' }), 'mixed');
  } finally {
    cleanup(dir);
  }
});

