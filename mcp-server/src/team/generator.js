// Team Assembly 2.0 generator.
//
// Creates project-local agent markdown plus machine-readable charter/workflow
// contracts from archetype fixtures. This is the first executable slice; later
// waves can replace fixture selection with richer brief-aware synthesis.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from '../lib/atomic-io.js';
import { syncCodexAgents } from '../codex-agents.js';
import { detect } from '../project-type-detector.js';
import { assertValidTeamBundle, validateTeamCharter, validateWorkflowManifest } from './schemas.js';

const FIXTURE_DIR = resolve(fileURLToPath(new URL('../../fixtures/team/', import.meta.url)));
const SUPPORTED_ARCHETYPES = new Set(['software', 'design', 'content', 'book', 'research', 'business', 'mixed']);

export function detectTeamArchetype(projectRoot = process.cwd(), options = {}) {
  if (options.archetype) return normalizeArchetype(options.archetype);
  const detected = detect(projectRoot, { maxFiles: options.maxFiles || 4000, c9Available: false });
  return normalizeArchetype(detected.primary_type || detected.type);
}

export function loadTeamTemplate(archetype) {
  const normalized = normalizeArchetype(archetype);
  const path = join(FIXTURE_DIR, `${normalized}.json`);
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  assertValidTeamBundle(bundle);
  return structuredClone(bundle);
}

export function createTeamAssembly(projectRoot = process.cwd(), options = {}) {
  const root = resolve(projectRoot);
  const archetype = detectTeamArchetype(root, options);
  const bundle = loadTeamTemplate(archetype);
  const teamName = options.teamName || `${basename(root) || archetype}-team`;

  bundle.charter.team_name = teamName;
  bundle.charter.generated_at = new Date().toISOString();
  bundle.charter.source_archetype = archetype;
  bundle.workflow.generated_at = bundle.charter.generated_at;
  bundle.workflow.source_archetype = archetype;

  const teamDir = join(root, '.ijfw', 'team');
  const agentsDir = join(root, '.ijfw', 'agents');
  mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });

  const charterPath = join(teamDir, 'charter.json');
  const workflowPath = join(teamDir, 'workflow.json');
  if (!options.force && (existsSync(charterPath) || existsSync(workflowPath))) {
    return { ok: false, error: 'exists', teamDir, agentsDir, archetype };
  }

  writeAtomic(charterPath, `${JSON.stringify(bundle.charter, null, 2)}\n`, { mode: 0o600 });
  writeAtomic(workflowPath, `${JSON.stringify(bundle.workflow, null, 2)}\n`, { mode: 0o600 });

  const agentFiles = [];
  for (const role of bundle.charter.roles) {
    const agentPath = join(agentsDir, `${role.name}.md`);
    writeAtomic(agentPath, renderAgent(role, bundle), { mode: 0o600 });
    agentFiles.push(agentPath);
  }
  const codexAgents = syncCodexAgents(root, { bundle });

  return {
    ok: true,
    archetype,
    team_name: teamName,
    teamDir,
    agentsDir,
    charterPath,
    workflowPath,
    agentFiles,
    codexAgents,
  };
}

export function readTeamAssembly(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const charterPath = join(root, '.ijfw', 'team', 'charter.json');
  const workflowPath = join(root, '.ijfw', 'team', 'workflow.json');
  const agentsDir = join(root, '.ijfw', 'agents');
  const charter = existsSync(charterPath) ? JSON.parse(readFileSync(charterPath, 'utf8')) : null;
  const workflow = existsSync(workflowPath) ? JSON.parse(readFileSync(workflowPath, 'utf8')) : null;
  const agents = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((file) => file.endsWith('.md')).sort()
    : [];
  const charterValidation = charter ? validateTeamCharter(charter) : { ok: false, errors: ['missing charter'] };
  const workflowValidation = workflow ? validateWorkflowManifest(workflow, charter) : { ok: false, errors: ['missing workflow'] };
  return {
    ok: Boolean(charter && workflow && charterValidation.ok && workflowValidation.ok),
    charterPath,
    workflowPath,
    agentsDir,
    agents,
    charter,
    workflow,
    validation: {
      charter: charterValidation,
      workflow: workflowValidation,
    },
  };
}

function normalizeArchetype(value) {
  const archetype = String(value || '').toLowerCase();
  return SUPPORTED_ARCHETYPES.has(archetype) ? archetype : 'mixed';
}

function renderAgent(role, bundle) {
  const owned = role.owns.map((item) => `- ${item.artifact_type}: ${(item.paths || item.refs || []).join(', ')}`).join('\n');
  const reviews = role.reviews.map((item) => `- ${item.artifact_type}: ${item.criteria.join(', ')}`).join('\n') || '- None';
  const phases = role.phase_scope.join(', ');
  const sections = role.handoff.required_sections.join(', ');
  const archetypes = bundle.charter.project_archetypes.join(', ');

  return `---\nname: ${role.name}\nmodel: ${role.model}\neffort: ${role.effort || 'medium'}\ndescription: ${role.name} for ${archetypes} projects; owns ${role.owns.map((item) => item.artifact_type).join(', ')}.\nallowed-tools: Read, Write, Edit, Bash\n---\n\n# ${role.name}\n\nYou are part of this project's IJFW team assembly.\n\nProject archetypes: ${archetypes}\nRole type: ${role.role_type}\nPhase scope: ${phases}\n\n## Owns\n\n${owned}\n\n## Reviews\n\n${reviews}\n\n## Coordination\n\n- Claim required: ${role.coordination.claim_required ? 'yes' : 'no'}\n- Parallel safe: ${role.coordination.parallel_safe ? 'yes' : 'no'}\n- Conflicts with: ${role.coordination.conflicts_with.length ? role.coordination.conflicts_with.join(', ') : 'none'}\n\n## Handoff\n\nFormat: ${role.handoff.format}\nRequired sections: ${sections}\n\nRecord claims, findings, blockers, and decisions in .ijfw/blackboard/ when swarm execution is active.\n`;
}
