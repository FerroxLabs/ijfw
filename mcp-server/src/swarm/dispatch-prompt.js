// Prompt scaffolding for prepared swarm tasks.
//
// This helper is intentionally pure and dependency-free. It renders the task
// record already prepared on the blackboard; command integration lives in the
// CLI layer.

export function renderSwarmDispatchPrompt(task, options = {}) {
  const normalized = normalizeTask(task);
  const projectRoot = stringValue(options.projectRoot);
  const lead = stringValue(options.lead) || 'main agent';
  const codex = Boolean(options.codex);

  const lines = [
    `# IJFW Swarm Worker Prompt: ${normalized.id}`,
    '',
    'You are working inside an IJFW prepared swarm task. Stay inside the task scope, coordinate through the blackboard, and report blockers early.',
    '',
    '## Task',
    field('Task id', normalized.id),
    field('Title', normalized.title),
    field('Owner', normalized.owner),
    field('Status', normalized.status),
    field('Wave', normalized.wave_id),
    field('Wave mode', normalized.wave_mode),
  ];

  if (projectRoot) lines.push(field('Project root', projectRoot));

  if (codex) {
    lines.push(
      '',
      '## Codex Dispatch',
      `- Preferred custom agent: ${codexAgentName(normalized.owner)}`,
      '- If this Codex runtime cannot invoke named `.codex/agents/*.toml` agents, spawn a generic `worker` for implementation/review tasks or `explorer` for read-only discovery, then paste this prompt into it.',
      '- Keep `fork_context` false unless the worker needs the full parent conversation; pass only the task scope and relevant files when possible.',
    );
  }

  lines.push(
    '',
    '## Artifact Scope',
    listBlock('Artifact ids', normalized.artifact_ids),
    listBlock('Allowed paths', normalized.paths, 'No path scope was provided. Coordinate by artifact id, references, and the blackboard before editing project artifacts.'),
    listBlock('Allowed refs', normalized.refs, 'No external or internal refs were provided.'),
  );

  lines.push(
    '',
    '## Dependencies',
    listBlock('Depends on', normalized.depends_on, 'No prepared task dependencies.'),
  );

  if (normalized.blocked_by.length) {
    lines.push(listBlock('Blocked by', normalized.blocked_by.map(formatBlocker)));
  }

  if (normalized.blocker) {
    lines.push(listBlock('Current blocker', [normalized.blocker]));
  }

  lines.push(
    '',
    '## Verification',
    listBlock('Required checks or review gates', normalized.verification, 'No verification was specified. Define an appropriate check for this artifact type and include the result in your completion note.'),
  );

  if (normalized.review_criteria.length) {
    lines.push(
      '',
      '## Review Criteria',
      listBlock('Criteria', normalized.review_criteria),
    );
  }

  lines.push(
    '',
    '## Blackboard Commands',
    `- Start when you begin: \`ijfw swarm start ${normalized.id}\``,
    `- Complete when finished: \`ijfw swarm complete ${normalized.id} "<summary and verification result>"\``,
    `- Block if stuck: \`ijfw swarm block ${normalized.id} "<blocker and requested help>"\``,
  );

  if (normalized.status === 'blocked') {
    lines.push('', 'This task is currently blocked. Do not start implementation/review work until the blocker is resolved or the lead marks the task ready.');
  } else if (normalized.status !== 'ready') {
    lines.push('', `This task is currently \`${normalized.status}\`. Confirm with ${lead} before changing its lifecycle state.`);
  }

  lines.push(
    '',
    '## Operating Constraints',
    '- Do not revert user changes or edits by other agents.',
    '- Touch only the allowed artifact scope unless the lead expands it.',
    '- Preserve project-agnostic output: this task may be code, design, writing, research, business, operations, or another artifact type.',
    '- Keep handoff notes concise and include changed artifacts, verification performed, and any residual risk.',
  );

  return lines.filter((line) => line !== null && line !== undefined).join('\n').trimEnd();
}

function normalizeTask(task) {
  const source = task && typeof task === 'object' ? task : {};
  return {
    id: stringValue(source.id) || 'unknown-task',
    title: stringValue(source.title) || 'Untitled prepared swarm task',
    owner: stringValue(source.owner) || 'unassigned',
    status: stringValue(source.status) || 'unknown',
    wave_id: stringValue(source.wave_id) || 'unknown',
    wave_mode: stringValue(source.wave_mode) || 'unknown',
    artifact_ids: stringArray(source.artifact_ids),
    paths: stringArray(source.paths),
    refs: stringArray(source.refs),
    depends_on: stringArray(source.depends_on),
    verification: stringArray(source.verification),
    review_criteria: stringArray(source.review_criteria),
    blocked_by: Array.isArray(source.blocked_by) ? source.blocked_by : [],
    blocker: stringValue(source.blocker),
  };
}

function field(label, value) {
  return `- ${label}: ${value || 'none'}`;
}

function listBlock(label, values, empty = 'None.') {
  const items = stringArray(values);
  if (!items.length) return `- ${label}: ${empty}`;
  return [`- ${label}:`, ...items.map((value) => `  - ${value}`)].join('\n');
}

function formatBlocker(blocker) {
  if (!blocker || typeof blocker !== 'object') return stringValue(blocker) || 'unknown blocker';
  const parts = [];
  if (blocker.task_id) parts.push(`task ${blocker.task_id}`);
  if (blocker.status) parts.push(`status ${blocker.status}`);
  if (blocker.artifact_id) parts.push(`artifact ${blocker.artifact_id}`);
  if (blocker.agent) parts.push(`agent ${blocker.agent}`);
  if (Array.isArray(blocker.paths) && blocker.paths.length) parts.push(`paths ${blocker.paths.join(', ')}`);
  return parts.join('; ') || JSON.stringify(blocker);
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function stringValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function codexAgentName(value) {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'ijfw_agent';
}
