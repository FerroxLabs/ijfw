// F-FUN-4 + F-FUN-5 (audit-MED-teams-#7 + #13): team-charter mutation
// helpers. Honors the SKILL.md "Custom Agent Requests" promise -- users can
// add, remove, swap, list, and check roles on their custom team without
// hand-editing JSON.
//
// Every mutating helper:
//   1. Reads the current charter/workflow.
//   2. Applies the mutation in-memory.
//   3. Validates the resulting charter via team/schemas.js.
//   4. Writes the charter back atomically.
//   5. Re-runs syncCodexAgents so .codex/agents/ stays in lockstep.
//
// `checkTeamAssembly` is the standalone validator surfaced by
// `ijfw team check` -- it does not write anything and does not require
// `ijfw swarm plan` to surface error messages.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomic } from '../lib/atomic-io.js';
import { syncCodexAgents } from '../codex-agents.js';
import { readTeamAssembly } from './generator.js';
import { validateTeamCharter, validateWorkflowManifest } from './schemas.js';

function teamPaths(root) {
  return {
    charterPath: join(root, '.ijfw', 'team', 'charter.json'),
    workflowPath: join(root, '.ijfw', 'team', 'workflow.json'),
  };
}

function loadCharter(root) {
  const { charterPath } = teamPaths(root);
  if (!existsSync(charterPath)) return null;
  return JSON.parse(readFileSync(charterPath, 'utf8'));
}

function loadWorkflow(root) {
  const { workflowPath } = teamPaths(root);
  if (!existsSync(workflowPath)) return null;
  return JSON.parse(readFileSync(workflowPath, 'utf8'));
}

function writeCharter(root, charter) {
  const { charterPath } = teamPaths(root);
  writeAtomic(charterPath, `${JSON.stringify(charter, null, 2)}\n`, { mode: 0o600 });
  return charterPath;
}

/**
 * List the current roles + summary metadata for the team. Returns a
 * structured payload so callers (CLI + future MCP tool) can render however
 * they like.
 */
export function listTeamRoles(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const charter = loadCharter(root);
  if (!charter) return { ok: false, error: 'missing-charter' };
  const roles = Array.isArray(charter.roles) ? charter.roles : [];
  return {
    ok: true,
    team_name: charter.team_name || null,
    project_archetypes: charter.project_archetypes || [],
    roles: roles.map((r) => ({
      name: r.name,
      role_type: r.role_type,
      model: r.model,
      effort: r.effort || 'medium',
      phase_scope: r.phase_scope || [],
    })),
  };
}

/**
 * Add a role to the charter. The charter is supplied as a JSON path; we
 * read+validate it before splicing in. Triggers a codex agent re-sync.
 */
export function addTeamRole(projectRoot, { charterPath, role }) {
  const root = resolve(projectRoot);
  const charter = loadCharter(root);
  if (!charter) return { ok: false, error: 'missing-charter' };

  const incoming = role || readJsonFile(charterPath);
  if (!incoming || typeof incoming !== 'object') return { ok: false, error: 'invalid-role-payload' };
  if (!incoming.name) return { ok: false, error: 'role-name-required' };

  const existing = (charter.roles || []).find((r) => r.name === incoming.name);
  if (existing) return { ok: false, error: 'role-exists', name: incoming.name };

  const next = { ...charter, roles: [...(charter.roles || []), incoming] };
  const validation = validateTeamCharter(next);
  if (!validation.ok) return { ok: false, error: 'invalid-charter', errors: validation.errors };

  writeCharter(root, next);
  const codex = syncCodexAgents(root);
  return { ok: true, role: incoming, codex };
}

/**
 * Remove a role by name. Refuses if removing the role would leave the
 * charter invalid (e.g. last role).
 */
export function removeTeamRole(projectRoot, { name }) {
  const root = resolve(projectRoot);
  const charter = loadCharter(root);
  if (!charter) return { ok: false, error: 'missing-charter' };

  const before = (charter.roles || []).length;
  const roles = (charter.roles || []).filter((r) => r.name !== name);
  if (roles.length === before) return { ok: false, error: 'role-not-found', name };

  const next = { ...charter, roles };
  const validation = validateTeamCharter(next);
  if (!validation.ok) return { ok: false, error: 'invalid-charter', errors: validation.errors };

  writeCharter(root, next);
  const codex = syncCodexAgents(root);
  return { ok: true, removed: name, codex };
}

/**
 * Replace one role with another. `oldName` must exist; `replacement` is a
 * full role object (or path to a JSON file describing one).
 */
export function swapTeamRole(projectRoot, { oldName, charterPath, replacement }) {
  const root = resolve(projectRoot);
  const charter = loadCharter(root);
  if (!charter) return { ok: false, error: 'missing-charter' };

  const incoming = replacement || readJsonFile(charterPath);
  if (!incoming || typeof incoming !== 'object') return { ok: false, error: 'invalid-role-payload' };
  if (!incoming.name) return { ok: false, error: 'role-name-required' };

  const roles = charter.roles || [];
  const idx = roles.findIndex((r) => r.name === oldName);
  if (idx === -1) return { ok: false, error: 'role-not-found', name: oldName };

  // Name collision when the replacement keeps a *different* existing name.
  if (incoming.name !== oldName && roles.some((r) => r.name === incoming.name)) {
    return { ok: false, error: 'role-exists', name: incoming.name };
  }

  const nextRoles = roles.slice();
  nextRoles[idx] = incoming;
  const next = { ...charter, roles: nextRoles };
  const validation = validateTeamCharter(next);
  if (!validation.ok) return { ok: false, error: 'invalid-charter', errors: validation.errors };

  writeCharter(root, next);
  const codex = syncCodexAgents(root);
  return { ok: true, swapped: { old: oldName, new: incoming.name }, codex };
}

/**
 * F-FUN-5 (audit-MED-teams-#13): standalone team validation. Returns a
 * structured pass/fail report so the CLI can render a human-readable list
 * without forcing the caller into `ijfw swarm plan`.
 */
export function checkTeamAssembly(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const charter = loadCharter(root);
  const workflow = loadWorkflow(root);
  const report = {
    ok: true,
    has_charter: Boolean(charter),
    has_workflow: Boolean(workflow),
    charter: { ok: true, errors: [] },
    workflow: { ok: true, errors: [] },
    role_count: 0,
    artifact_count: 0,
  };
  if (!charter) {
    report.ok = false;
    report.charter = { ok: false, errors: ['charter.json is missing -- run: ijfw team init'] };
  } else {
    const c = validateTeamCharter(charter);
    report.charter = c;
    report.role_count = Array.isArray(charter.roles) ? charter.roles.length : 0;
    if (!c.ok) report.ok = false;
  }
  if (!workflow) {
    report.ok = false;
    report.workflow = { ok: false, errors: ['workflow.json is missing -- run: ijfw team init'] };
  } else {
    const w = validateWorkflowManifest(workflow, charter);
    report.workflow = w;
    report.artifact_count = Array.isArray(workflow.artifacts) ? workflow.artifacts.length : 0;
    if (!w.ok) report.ok = false;
  }
  return report;
}

function readJsonFile(path) {
  if (!path) return null;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Re-exports for the CLI surface so it can `import * as teamModify`.
export { readTeamAssembly };
