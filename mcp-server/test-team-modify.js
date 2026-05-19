// Tests for the team modify helpers (audit-MED-teams-#7 + #13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamAssembly } from './src/team/generator.js';
import {
  addTeamRole,
  checkTeamAssembly,
  listTeamRoles,
  removeTeamRole,
  swapTeamRole,
} from './src/team/modify.js';

function makeTmp() { return mkdtempSync(join(tmpdir(), 'ijfw-team-modify-test-')); }
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

function writeRoleFile(dir, role) {
  const path = join(dir, 'new-role.json');
  writeFileSync(path, JSON.stringify(role));
  return path;
}

function sampleRole(name, type = 'software') {
  return {
    name,
    role_type: type,
    model: 'sonnet',
    effort: 'medium',
    phase_scope: ['execute'],
    owns: [{ artifact_type: 'module', paths: ['src/**'] }],
    reviews: [],
    handoff: { format: 'markdown', required_sections: ['changed_artifacts'] },
    coordination: { parallel_safe: true, claim_required: true, conflicts_with: [] },
  };
}

test('listTeamRoles surfaces roles from a fresh charter', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software', teamName: 'demo-team' });
    const result = listTeamRoles(dir);
    assert.equal(result.ok, true);
    assert.equal(result.team_name, 'demo-team');
    assert.ok(result.roles.length >= 1);
    for (const role of result.roles) {
      assert.ok(role.name);
      assert.ok(role.role_type);
    }
  } finally {
    cleanup(dir);
  }
});

test('addTeamRole validates and writes a new role + re-syncs codex agents', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    const charterPath = writeRoleFile(dir, sampleRole('helper-bot'));
    const result = addTeamRole(dir, { charterPath });
    assert.equal(result.ok, true);
    assert.equal(result.role.name, 'helper-bot');
    assert.ok(result.codex.ok, 'codex resync should succeed');
    assert.ok(existsSync(join(dir, '.codex', 'agents', 'helper-bot.toml')));
    // Listing now sees the new role.
    const list = listTeamRoles(dir);
    assert.ok(list.roles.some((r) => r.name === 'helper-bot'));
  } finally {
    cleanup(dir);
  }
});

test('addTeamRole rejects a duplicate name', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    const list = listTeamRoles(dir);
    const dup = list.roles[0].name;
    const charterPath = writeRoleFile(dir, sampleRole(dup));
    const result = addTeamRole(dir, { charterPath });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'role-exists');
  } finally {
    cleanup(dir);
  }
});

test('removeTeamRole removes by name', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    const list = listTeamRoles(dir);
    const target = list.roles[0].name;
    const result = removeTeamRole(dir, { name: target });
    assert.equal(result.ok, true);
    assert.equal(result.removed, target);
    const after = listTeamRoles(dir);
    assert.ok(!after.roles.some((r) => r.name === target));
  } finally {
    cleanup(dir);
  }
});

test('removeTeamRole returns role-not-found for unknown names', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    const result = removeTeamRole(dir, { name: 'nobody' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'role-not-found');
  } finally {
    cleanup(dir);
  }
});

test('swapTeamRole replaces a role in place', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    const list = listTeamRoles(dir);
    const target = list.roles[0].name;
    const replacement = sampleRole(`${target}-v2`);
    const charterPath = writeRoleFile(dir, replacement);
    const result = swapTeamRole(dir, { oldName: target, charterPath });
    assert.equal(result.ok, true);
    assert.equal(result.swapped.old, target);
    assert.equal(result.swapped.new, `${target}-v2`);
  } finally {
    cleanup(dir);
  }
});

// ── audit-MED-teams-#13: standalone validator ─────────────────────────────

test('checkTeamAssembly returns ok for a fresh team', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    const report = checkTeamAssembly(dir);
    assert.equal(report.ok, true);
    assert.ok(report.has_charter);
    assert.ok(report.has_workflow);
    assert.ok(report.role_count >= 1);
    assert.ok(report.artifact_count >= 1);
  } finally {
    cleanup(dir);
  }
});

test('checkTeamAssembly flags missing files', () => {
  const dir = makeTmp();
  try {
    const report = checkTeamAssembly(dir);
    assert.equal(report.ok, false);
    assert.equal(report.has_charter, false);
    assert.equal(report.has_workflow, false);
    assert.ok(report.charter.errors.length > 0);
    assert.ok(report.workflow.errors.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('checkTeamAssembly flags structurally broken charters', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    // Corrupt charter: drop required schema_version.
    const charterPath = join(dir, '.ijfw', 'team', 'charter.json');
    const charter = JSON.parse(readFileSync(charterPath, 'utf8'));
    delete charter.schema_version;
    writeFileSync(charterPath, JSON.stringify(charter, null, 2));
    const report = checkTeamAssembly(dir);
    assert.equal(report.ok, false);
    assert.ok(report.charter.errors.length > 0);
  } finally {
    cleanup(dir);
  }
});
