import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { ROLE_TOOL_ALLOWLIST, renderCodexAgentToml, syncCodexAgents, toolsForRoleType } from './src/codex-agents.js';
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

// ── audit-MED-teams-#8: role-type → tool-allowlist map ────────────────────

test('toolsForRoleType maps research to Read-only', () => {
  assert.deepEqual(toolsForRoleType('research'), ['Read']);
});

test('toolsForRoleType maps review to Read+Edit', () => {
  assert.deepEqual(toolsForRoleType('review'), ['Read', 'Edit']);
});

test('toolsForRoleType maps software/lead/qa to full toolbelt', () => {
  assert.ok(toolsForRoleType('software').includes('Bash'));
  assert.ok(toolsForRoleType('lead').includes('Bash'));
  assert.ok(toolsForRoleType('qa').includes('Bash'));
});

test('toolsForRoleType maps book/content to Read+Write+Edit (no Bash)', () => {
  for (const rt of ['book', 'content']) {
    const tools = toolsForRoleType(rt);
    assert.ok(tools.includes('Read'));
    assert.ok(tools.includes('Write'));
    assert.ok(tools.includes('Edit'));
    assert.ok(!tools.includes('Bash'), `${rt} should not get Bash`);
  }
});

test('toolsForRoleType falls back to software for unknown role types', () => {
  assert.deepEqual(toolsForRoleType('mystery'), ROLE_TOOL_ALLOWLIST.software);
  assert.deepEqual(toolsForRoleType(null), ROLE_TOOL_ALLOWLIST.software);
});

test('renderCodexAgentToml emits a tools = [...] array matching the role type', () => {
  const bundle = loadTeamTemplate('research');
  const role = bundle.charter.roles[0];
  const toml = renderCodexAgentToml(role, bundle);
  // Research roles should at least include Read.
  assert.match(toml, /^tools = \[/m);
  assert.match(toml, /"Read"/);
});

// ── audit-MED-teams-#11: content-hash skip ─────────────────────────────────

test('syncCodexAgents skips identical files (no mtime thrash)', () => {
  const dir = makeTmp();
  try {
    const r1 = createTeamAssembly(dir, { archetype: 'software', teamName: 'skip-test' });
    assert.equal(r1.ok, true);
    const agentPath = join(dir, '.codex', 'agents', 'implementation-engineer.toml');
    const mtime1 = statSync(agentPath).mtimeMs;

    // Wait > filesystem mtime resolution then resync.
    const wait = new Date(Date.now() + 10);
    while (Date.now() < wait.getTime()) { /* busy wait 10ms */ }

    const r2 = syncCodexAgents(dir);
    assert.equal(r2.ok, true);
    assert.ok(r2.skipped >= 1, `expected at least one skipped agent, got ${r2.skipped}`);
    const mtime2 = statSync(agentPath).mtimeMs;
    assert.equal(mtime1, mtime2, 'mtime must not advance on identical-content resync');
  } finally {
    cleanup(dir);
  }
});

// ── audit-MED-teams-#12: symlink-realpath containment gate ─────────────────

test('syncCodexAgents rejects a .codex/agents/ symlink that escapes the project root', () => {
  if (platform() === 'win32') return; // symlinks need admin/dev-mode on Windows
  const dir = makeTmp();
  const outsideRoot = makeTmp();
  try {
    // Bootstrap a real team assembly in `dir`.
    const r1 = createTeamAssembly(dir, { archetype: 'software', teamName: 'escape-test' });
    assert.equal(r1.ok, true);
    // Then wipe .codex/agents and swap for a symlink to an outside dir.
    rmSync(join(dir, '.codex', 'agents'), { recursive: true, force: true });
    mkdirSync(outsideRoot, { recursive: true });
    symlinkSync(outsideRoot, join(dir, '.codex', 'agents'), 'dir');

    const r2 = syncCodexAgents(dir);
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'agents-escapes-project');
  } finally {
    cleanup(dir);
    cleanup(outsideRoot);
  }
});
