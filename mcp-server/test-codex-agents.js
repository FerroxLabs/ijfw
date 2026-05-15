import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCodexAgentToml, syncCodexAgents } from './src/codex-agents.js';
import { createTeamAssembly, loadTeamTemplate } from './src/team/generator.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-codex-agents-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('renderCodexAgentToml emits required Codex custom agent fields', () => {
  const bundle = loadTeamTemplate('software');
  const role = bundle.charter.roles[0];
  const toml = renderCodexAgentToml(role, bundle);

  assert.match(toml, /^name = "implementation_engineer"$/m);
  assert.match(toml, /^description = "implementation-engineer for software projects; owns module\."$/m);
  assert.match(toml, /^developer_instructions = """$/m);
  assert.match(toml, /Role type: software/);
  assert.match(toml, /Project archetypes: software/);
  assert.match(toml, /- module: src\/\*\*\/\*\.js/);
  assert.match(toml, /- test: coverage, regression/);
  assert.match(toml, /ijfw swarm start <task-id>/);
  assert.match(toml, /ijfw swarm complete <task-id>/);
  assert.match(toml, /ijfw swarm block <task-id> --message <why>/);
  assert.match(toml, /Never revert user changes or another agent's changes/);
  assert.match(toml, /source files, documents, designs, datasets, plans, research notes, workflows, diagrams/);
  assert.doesNotMatch(toml, /^model = /m);
  assert.doesNotMatch(toml, /^model_reasoning_effort = /m);
});

test('renderCodexAgentToml includes Codex-specific model fields only when explicitly present', () => {
  const bundle = loadTeamTemplate('software');
  const role = structuredClone(bundle.charter.roles[1]);
  role.codex = { model: 'gpt-5.4-mini', model_reasoning_effort: 'medium' };

  const toml = renderCodexAgentToml(role, bundle);
  assert.match(toml, /^model = "gpt-5\.4-mini"$/m);
  assert.match(toml, /^model_reasoning_effort = "medium"$/m);
});

test('syncCodexAgents writes project-scoped agents from existing Team Assembly files', () => {
  const dir = makeTmp();
  try {
    const bundle = loadTeamTemplate('content');
    mkdirSync(join(dir, '.ijfw', 'team'), { recursive: true });
    writeFileSync(join(dir, '.ijfw', 'team', 'charter.json'), `${JSON.stringify(bundle.charter, null, 2)}\n`);
    writeFileSync(join(dir, '.ijfw', 'team', 'workflow.json'), `${JSON.stringify(bundle.workflow, null, 2)}\n`);

    const result = syncCodexAgents(dir);
    assert.equal(result.ok, true);
    assert.equal(result.count, bundle.charter.roles.length);
    assert.ok(existsSync(join(dir, '.codex', 'agents', 'content-strategist.toml')));
    assert.ok(existsSync(join(dir, '.codex', 'agents', 'editor.toml')));

    const agent = readFileSync(join(dir, '.codex', 'agents', 'content-strategist.toml'), 'utf8');
    assert.match(agent, /^name = "content_strategist"$/m);
    assert.match(agent, /Role type: content/);
    assert.match(agent, /Blackboard coordination:/);
  } finally {
    cleanup(dir);
  }
});

test('syncCodexAgents reports missing Team Assembly without creating files', () => {
  const dir = makeTmp();
  try {
    const result = syncCodexAgents(dir);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing-team-charter');
    assert.deepEqual(result.agentFiles, []);
    assert.equal(existsSync(join(dir, '.codex', 'agents')), false);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly syncs Codex custom agents alongside IJFW agents', () => {
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'software', teamName: 'codex-native-team' });
    assert.equal(result.ok, true);
    assert.equal(result.codexAgents.ok, true);
    assert.ok(existsSync(join(dir, '.codex', 'agents', 'implementation-engineer.toml')));

    const agent = readFileSync(join(dir, '.codex', 'agents', 'implementation-engineer.toml'), 'utf8');
    assert.match(agent, /^name = "implementation_engineer"$/m);
    assert.match(agent, /codex-native-team|implementation-engineer/);
  } finally {
    cleanup(dir);
  }
});
