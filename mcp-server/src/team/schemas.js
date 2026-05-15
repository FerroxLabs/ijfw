const ARCHETYPES = new Set([
  'software',
  'design',
  'content',
  'book',
  'research',
  'business',
  'education',
  'operations',
  'mixed',
]);

const ROLE_TYPES = new Set([
  'lead',
  'software',
  'design',
  'content',
  'book',
  'research',
  'business',
  'education',
  'operations',
  'review',
  'qa',
]);

const TASK_STATUSES = new Set(['todo', 'ready', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'cancelled']);
const CLAIM_STATUSES = new Set(['active', 'released', 'expired']);

export function validateTeamCharter(charter) {
  const errors = [];
  requireObject(charter, 'charter', errors);
  if (errors.length) return result(errors);

  requireString(charter.schema_version, 'charter.schema_version', errors);
  requireString(charter.team_name, 'charter.team_name', errors);
  validateArchetypes(charter.project_archetypes, 'charter.project_archetypes', errors);
  requireArray(charter.roles, 'charter.roles', errors, { min: 1 });

  const roleNames = new Set();
  if (Array.isArray(charter.roles)) {
    charter.roles.forEach((role, index) => {
      const path = `charter.roles[${index}]`;
      validateRole(role, path, errors);
      if (isObject(role) && typeof role.name === 'string') {
        if (roleNames.has(role.name)) errors.push(`${path}.name must be unique`);
        roleNames.add(role.name);
      }
    });
  }

  return result(errors);
}

export function validateWorkflowManifest(workflow, charter = null) {
  const errors = [];
  requireObject(workflow, 'workflow', errors);
  if (errors.length) return result(errors);

  requireString(workflow.schema_version, 'workflow.schema_version', errors);
  validateArchetypes(workflow.project_archetypes, 'workflow.project_archetypes', errors);
  requireArray(workflow.artifacts, 'workflow.artifacts', errors, { min: 1 });
  requireArray(workflow.waves, 'workflow.waves', errors, { min: 1 });

  const roleNames = rolesFromCharter(charter);
  const artifactIds = new Set();

  if (Array.isArray(workflow.artifacts)) {
    workflow.artifacts.forEach((artifact, index) => {
      const path = `workflow.artifacts[${index}]`;
      validateArtifact(artifact, path, errors, roleNames);
      if (isObject(artifact) && typeof artifact.id === 'string') {
        if (artifactIds.has(artifact.id)) errors.push(`${path}.id must be unique`);
        artifactIds.add(artifact.id);
      }
    });
  }

  if (Array.isArray(workflow.artifacts)) {
    workflow.artifacts.forEach((artifact, index) => {
      if (!isObject(artifact) || !Array.isArray(artifact.depends_on)) return;
      artifact.depends_on.forEach((id, depIndex) => {
        if (!artifactIds.has(id)) errors.push(`workflow.artifacts[${index}].depends_on[${depIndex}] references unknown artifact "${id}"`);
      });
    });
  }

  if (Array.isArray(workflow.waves)) {
    const waveIds = new Set();
    workflow.waves.forEach((wave, index) => {
      const path = `workflow.waves[${index}]`;
      validateWave(wave, path, errors, artifactIds);
      if (isObject(wave) && typeof wave.id === 'string') {
        if (waveIds.has(wave.id)) errors.push(`${path}.id must be unique`);
        waveIds.add(wave.id);
      }
    });
  }

  return result(errors);
}

export function validateBlackboardTask(task, workflow = null) {
  const errors = [];
  requireObject(task, 'task', errors);
  if (errors.length) return result(errors);

  requireString(task.id, 'task.id', errors);
  requireString(task.title, 'task.title', errors);
  requireString(task.status, 'task.status', errors);
  if (typeof task.status === 'string' && !TASK_STATUSES.has(task.status)) {
    errors.push(`task.status must be one of: ${Array.from(TASK_STATUSES).join(', ')}`);
  }
  requireArray(task.artifact_ids, 'task.artifact_ids', errors, { min: 1, strings: true });
  optionalStringArray(task.depends_on, 'task.depends_on', errors);
  optionalString(task.owner, 'task.owner', errors);

  const artifactIds = artifactsFromWorkflow(workflow);
  if (artifactIds && Array.isArray(task.artifact_ids)) {
    task.artifact_ids.forEach((id, index) => {
      if (!artifactIds.has(id)) errors.push(`task.artifact_ids[${index}] references unknown artifact "${id}"`);
    });
  }

  return result(errors);
}

export function validateBlackboardClaim(claim, workflow = null) {
  const errors = [];
  requireObject(claim, 'claim', errors);
  if (errors.length) return result(errors);

  requireString(claim.id, 'claim.id', errors);
  requireString(claim.artifact_id, 'claim.artifact_id', errors);
  requireString(claim.agent, 'claim.agent', errors);
  requireString(claim.status, 'claim.status', errors);
  if (typeof claim.status === 'string' && !CLAIM_STATUSES.has(claim.status)) {
    errors.push(`claim.status must be one of: ${Array.from(CLAIM_STATUSES).join(', ')}`);
  }
  optionalStringArray(claim.paths, 'claim.paths', errors);
  optionalString(claim.claimed_at, 'claim.claimed_at', errors);
  optionalString(claim.expires_at, 'claim.expires_at', errors);

  const artifactIds = artifactsFromWorkflow(workflow);
  if (artifactIds && !artifactIds.has(claim.artifact_id)) {
    errors.push(`claim.artifact_id references unknown artifact "${claim.artifact_id}"`);
  }

  return result(errors);
}

export function validateTeamBundle(bundle) {
  const errors = [];
  requireObject(bundle, 'bundle', errors);
  if (errors.length) return result(errors);

  errors.push(...validateTeamCharter(bundle.charter).errors);
  errors.push(...validateWorkflowManifest(bundle.workflow, bundle.charter).errors);

  if (bundle.blackboard != null) {
    requireObject(bundle.blackboard, 'bundle.blackboard', errors);
    if (isObject(bundle.blackboard)) {
      if (bundle.blackboard.tasks != null) {
        requireArray(bundle.blackboard.tasks, 'bundle.blackboard.tasks', errors);
        if (Array.isArray(bundle.blackboard.tasks)) {
          bundle.blackboard.tasks.forEach((task, index) => {
            prefixErrors(validateBlackboardTask(task, bundle.workflow).errors, `bundle.blackboard.tasks[${index}]`, errors);
          });
        }
      }
      if (bundle.blackboard.claims != null) {
        requireArray(bundle.blackboard.claims, 'bundle.blackboard.claims', errors);
        if (Array.isArray(bundle.blackboard.claims)) {
          bundle.blackboard.claims.forEach((claim, index) => {
            prefixErrors(validateBlackboardClaim(claim, bundle.workflow).errors, `bundle.blackboard.claims[${index}]`, errors);
          });
        }
      }
    }
  }

  return result(errors);
}

export function assertValidTeamBundle(bundle) {
  const validation = validateTeamBundle(bundle);
  if (!validation.ok) {
    throw new Error(`Invalid team bundle:\n${validation.errors.map((e) => `- ${e}`).join('\n')}`);
  }
  return bundle;
}

function validateRole(role, path, errors) {
  requireObject(role, path, errors);
  if (!isObject(role)) return;
  requireString(role.name, `${path}.name`, errors);
  requireString(role.role_type, `${path}.role_type`, errors);
  if (typeof role.role_type === 'string' && !ROLE_TYPES.has(role.role_type)) {
    errors.push(`${path}.role_type must be one of: ${Array.from(ROLE_TYPES).join(', ')}`);
  }
  requireString(role.model, `${path}.model`, errors);
  optionalString(role.effort, `${path}.effort`, errors);
  requireArray(role.phase_scope, `${path}.phase_scope`, errors, { min: 1, strings: true });
  requireArray(role.owns, `${path}.owns`, errors, { min: 1 });
  requireArray(role.reviews, `${path}.reviews`, errors);
  validateHandoff(role.handoff, `${path}.handoff`, errors);
  validateCoordination(role.coordination, `${path}.coordination`, errors);

  if (Array.isArray(role.owns)) role.owns.forEach((item, index) => validateArtifactRef(item, `${path}.owns[${index}]`, errors));
  if (Array.isArray(role.reviews)) role.reviews.forEach((item, index) => validateReviewRef(item, `${path}.reviews[${index}]`, errors));
}

function validateArtifact(artifact, path, errors, roleNames) {
  requireObject(artifact, path, errors);
  if (!isObject(artifact)) return;
  requireString(artifact.id, `${path}.id`, errors);
  requireString(artifact.type, `${path}.type`, errors);
  if (artifact.paths == null && artifact.refs == null) {
    errors.push(`${path} must include paths or refs`);
  }
  optionalStringArray(artifact.paths, `${path}.paths`, errors);
  optionalStringArray(artifact.refs, `${path}.refs`, errors);
  requireString(artifact.owner, `${path}.owner`, errors);
  requireArray(artifact.reviewers, `${path}.reviewers`, errors, { strings: true });
  optionalStringArray(artifact.depends_on, `${path}.depends_on`, errors);
  requireArray(artifact.verification, `${path}.verification`, errors, { min: 1, strings: true });

  if (roleNames) {
    if (typeof artifact.owner === 'string' && !roleNames.has(artifact.owner)) {
      errors.push(`${path}.owner references unknown role "${artifact.owner}"`);
    }
    if (Array.isArray(artifact.reviewers)) {
      artifact.reviewers.forEach((reviewer, index) => {
        if (!roleNames.has(reviewer)) errors.push(`${path}.reviewers[${index}] references unknown role "${reviewer}"`);
      });
    }
  }
}

function validateWave(wave, path, errors, artifactIds) {
  requireObject(wave, path, errors);
  if (!isObject(wave)) return;
  requireString(wave.id, `${path}.id`, errors);
  requireString(wave.mode, `${path}.mode`, errors);
  if (typeof wave.mode === 'string' && !['parallel', 'sequential', 'review'].includes(wave.mode)) {
    errors.push(`${path}.mode must be parallel, sequential, or review`);
  }
  requireArray(wave.artifact_ids, `${path}.artifact_ids`, errors, { min: 1, strings: true });
  if (Array.isArray(wave.artifact_ids)) {
    wave.artifact_ids.forEach((id, index) => {
      if (!artifactIds.has(id)) errors.push(`${path}.artifact_ids[${index}] references unknown artifact "${id}"`);
    });
  }
}

function validateArtifactRef(ref, path, errors) {
  requireObject(ref, path, errors);
  if (!isObject(ref)) return;
  requireString(ref.artifact_type, `${path}.artifact_type`, errors);
  optionalStringArray(ref.paths, `${path}.paths`, errors);
  optionalStringArray(ref.refs, `${path}.refs`, errors);
  if (ref.paths == null && ref.refs == null) errors.push(`${path} must include paths or refs`);
}

function validateReviewRef(ref, path, errors) {
  requireObject(ref, path, errors);
  if (!isObject(ref)) return;
  requireString(ref.artifact_type, `${path}.artifact_type`, errors);
  requireArray(ref.criteria, `${path}.criteria`, errors, { min: 1, strings: true });
}

function validateHandoff(handoff, path, errors) {
  requireObject(handoff, path, errors);
  if (!isObject(handoff)) return;
  requireString(handoff.format, `${path}.format`, errors);
  requireArray(handoff.required_sections, `${path}.required_sections`, errors, { min: 1, strings: true });
}

function validateCoordination(coordination, path, errors) {
  requireObject(coordination, path, errors);
  if (!isObject(coordination)) return;
  if (typeof coordination.parallel_safe !== 'boolean') errors.push(`${path}.parallel_safe must be boolean`);
  if (typeof coordination.claim_required !== 'boolean') errors.push(`${path}.claim_required must be boolean`);
  optionalStringArray(coordination.conflicts_with, `${path}.conflicts_with`, errors);
}

function validateArchetypes(archetypes, path, errors) {
  requireArray(archetypes, path, errors, { min: 1, strings: true });
  if (!Array.isArray(archetypes)) return;
  archetypes.forEach((archetype, index) => {
    if (!ARCHETYPES.has(archetype)) errors.push(`${path}[${index}] must be a known project archetype`);
  });
}

function requireObject(value, path, errors) {
  if (!isObject(value)) errors.push(`${path} must be an object`);
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${path} must be a non-empty string`);
}

function optionalString(value, path, errors) {
  if (value != null && (typeof value !== 'string' || value.trim() === '')) errors.push(`${path} must be a non-empty string when present`);
}

function requireArray(value, path, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (options.min != null && value.length < options.min) errors.push(`${path} must contain at least ${options.min} item(s)`);
  if (options.strings) value.forEach((item, index) => requireString(item, `${path}[${index}]`, errors));
}

function optionalStringArray(value, path, errors) {
  if (value == null) return;
  requireArray(value, path, errors, { strings: true });
}

function rolesFromCharter(charter) {
  if (!isObject(charter) || !Array.isArray(charter.roles)) return null;
  return new Set(charter.roles.filter((role) => isObject(role) && typeof role.name === 'string').map((role) => role.name));
}

function artifactsFromWorkflow(workflow) {
  if (!isObject(workflow) || !Array.isArray(workflow.artifacts)) return null;
  return new Set(workflow.artifacts.filter((artifact) => isObject(artifact) && typeof artifact.id === 'string').map((artifact) => artifact.id));
}

function prefixErrors(source, prefix, target) {
  source.forEach((error) => target.push(`${prefix}: ${error}`));
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
