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

