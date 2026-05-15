import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomic } from './lib/atomic-io.js';

export function renderCodexAgentToml(role, bundle = {}) {
  assertRole(role);
  const charter = bundle.charter || bundle;
  const workflow = bundle.workflow || null;
  const archetypes = list(charter.project_archetypes).length ? list(charter.project_archetypes) : ['mixed'];
  const agentName = codexAgentName(role.name);
  const description = renderDescription(role, archetypes);
  const instructions = renderDeveloperInstructions(role, { archetypes, workflow });
  const lines = [
    `name = ${tomlString(agentName)}`,
    `description = ${tomlString(description)}`,
  ];

  const codexConfig = role.codex && typeof role.codex === 'object' ? role.codex : {};
  if (typeof codexConfig.model === 'string' && codexConfig.model.trim()) {
    lines.push(`model = ${tomlString(codexConfig.model.trim())}`);
  }
  if (typeof codexConfig.model_reasoning_effort === 'string' && codexConfig.model_reasoning_effort.trim()) {
    lines.push(`model_reasoning_effort = ${tomlString(codexConfig.model_reasoning_effort.trim())}`);
  }

  lines.push(`developer_instructions = ${tomlMultiline(instructions)}`);
  return `${lines.join('\n')}\n`;
}

export function syncCodexAgents(projectRoot = process.cwd(), options = {}) {
  const root = resolve(projectRoot);
  const bundle = options.bundle || readTeamBundle(root);
  if (!bundle?.charter?.roles?.length) {
    return { ok: false, error: 'missing-team-charter', agentsDir: join(root, '.codex', 'agents'), agentFiles: [] };
  }

  const agentsDir = join(root, '.codex', 'agents');
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });

  const agentFiles = [];
  for (const role of bundle.charter.roles) {
    const agentPath = join(agentsDir, `${codexAgentFilename(role.name)}.toml`);
    writeAtomic(agentPath, renderCodexAgentToml(role, bundle), { mode: 0o600 });
    agentFiles.push(agentPath);
  }

  return {
    ok: true,
    agentsDir,
    agentFiles,
    count: agentFiles.length,
  };
}

function readTeamBundle(root) {
  const charterPath = join(root, '.ijfw', 'team', 'charter.json');
  if (!existsSync(charterPath)) return null;
  const workflowPath = join(root, '.ijfw', 'team', 'workflow.json');
  return {
    charter: JSON.parse(readFileSync(charterPath, 'utf8')),
    workflow: existsSync(workflowPath) ? JSON.parse(readFileSync(workflowPath, 'utf8')) : null,
  };
}

function renderDescription(role, archetypes) {
  const owns = list(role.owns).map((item) => item.artifact_type).filter(Boolean);
  const owned = owns.length ? owns.join(', ') : 'assigned artifacts';
  return `${role.name} for ${archetypes.join(', ')} projects; owns ${owned}.`;
}

function renderDeveloperInstructions(role, context) {
  const owns = renderArtifactRefs(role.owns, '- No primary ownership declared.');
  const reviews = renderReviews(role.reviews);
  const phaseScope = list(role.phase_scope).join(', ') || 'project workflow';
  const archetypes = context.archetypes.join(', ');
  const artifacts = renderWorkflowArtifacts(role.name, context.workflow);
  const conflicts = list(role.coordination?.conflicts_with).join(', ') || 'none declared';
  const claimRequired = role.coordination?.claim_required ? 'yes' : 'no';
  const parallelSafe = role.coordination?.parallel_safe ? 'yes' : 'no';
  const sections = list(role.handoff?.required_sections).join(', ') || 'changed_artifacts, verification, risks';

  return [
    `You are the ${role.name} Codex custom agent for this IJFW Team Assembly.`,
    '',
    `Role type: ${role.role_type}`,
    `Project archetypes: ${archetypes}`,
    `Phase scope: ${phaseScope}`,
    '',
    'Work project-agnostically. Treat artifacts as whatever this project uses: source files, documents, designs, datasets, plans, research notes, workflows, diagrams, or other durable project outputs.',
    '',
    'Owns:',
    owns,
    '',
    'Reviews:',
    reviews,
    '',
    'Workflow artifacts assigned to this role:',
    artifacts,
    '',
    'Blackboard coordination:',
    `- Claim required: ${claimRequired}`,
    `- Parallel safe: ${parallelSafe}`,
    `- Conflicts with: ${conflicts}`,
    '- Before editing or producing durable output, coordinate through the IJFW blackboard when swarm execution is active.',
    '- Start assigned swarm work with: ijfw swarm start <task-id>',
    '- Complete finished swarm work with: ijfw swarm complete <task-id>',
    '- Report blocked swarm work with: ijfw swarm block <task-id> --message <why>',
    '- Record findings, decisions, and blockers in .ijfw/blackboard/ through IJFW commands when relevant.',
    '',
    'Safety:',
    '- You are not alone in this repo. Never revert user changes or another agent\'s changes unless the parent session explicitly asks for that exact revert.',
    '- Keep edits scoped to your claimed artifacts and paths. If ownership is unclear, stop and report the ambiguity.',
    '- Preserve existing project conventions and validate the behavior or artifact quality you changed.',
    '',
    'Handoff:',
    `- Format: ${role.handoff?.format || 'markdown'}`,
    `- Required sections: ${sections}`,
  ].join('\n');
}

function renderArtifactRefs(refs, fallback) {
  const lines = list(refs).map((item) => {
    const targets = list(item.paths).concat(list(item.refs));
    const targetText = targets.length ? targets.join(', ') : 'project-defined locations';
    return `- ${item.artifact_type || 'artifact'}: ${targetText}`;
  });
  return lines.length ? lines.join('\n') : fallback;
}

function renderReviews(refs) {
  const lines = list(refs).map((item) => {
    const criteria = list(item.criteria).join(', ') || 'quality, correctness, fit';
    return `- ${item.artifact_type || 'artifact'}: ${criteria}`;
  });
  return lines.length ? lines.join('\n') : '- No review responsibility declared.';
}

function renderWorkflowArtifacts(roleName, workflow) {
  const artifacts = list(workflow?.artifacts).filter((artifact) => {
    return artifact.owner === roleName || list(artifact.reviewers).includes(roleName);
  });
  if (!artifacts.length) return '- No workflow artifact mapping found; follow the role owns/reviews contract.';
  return artifacts.map((artifact) => {
    const relationship = artifact.owner === roleName ? 'owns' : 'reviews';
    const targets = list(artifact.paths).concat(list(artifact.refs));
    const targetText = targets.length ? ` (${targets.join(', ')})` : '';
    return `- ${artifact.id}: ${relationship} ${artifact.type}${targetText}`;
  }).join('\n');
}

function assertRole(role) {
  if (!role || typeof role !== 'object') throw new TypeError('role must be an object');
  if (!role.name || typeof role.name !== 'string') throw new TypeError('role.name is required');
  if (!role.role_type || typeof role.role_type !== 'string') throw new TypeError('role.role_type is required');
}

function codexAgentName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return name || 'ijfw_agent';
}

function codexAgentFilename(value) {
  const name = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'ijfw-agent';
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlMultiline(value) {
  return `"""\n${String(value).replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}
