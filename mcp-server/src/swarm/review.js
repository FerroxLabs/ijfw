// Review task materialization for swarm lifecycle.
//
// This sidecar is dependency-free and intentionally does not write to the
// blackboard. CLI integration can decide when to persist these task records.

const DONE_STATUSES = new Set(['done']);

export function deriveReviewTasks(source = {}, options = {}) {
  const normalized = normalizeSource(source, options);
  const tasks = [];

  for (const wave of normalized.waves) {
    for (const artifactId of wave.artifact_ids || []) {
      const artifact = normalized.artifactsById.get(artifactId);
      if (!artifact) continue;

      const reviewers = Array.isArray(artifact.reviewers) ? artifact.reviewers : [];
      for (const reviewer of reviewers) {
        const implementationTaskId = swarmTaskId(wave.id, artifact.id);
        const implementationTask = normalized.implementationTasksById.get(implementationTaskId);
        const dependencyKnown = implementationTask != null;
        const dependencyDone = !dependencyKnown || DONE_STATUSES.has(implementationTask.status);
        const reviewCriteria = criteriaForReviewer(normalized.rolesByName.get(reviewer), artifact);

        tasks.push({
          id: `review:${wave.id}:${artifact.id}:${reviewer}`,
          title: `${reviewer}: review ${artifact.id}`,
          status: dependencyDone ? 'ready' : 'blocked',
          wave_id: wave.id,
          wave_mode: 'review',
          artifact_ids: [artifact.id],
          owner: reviewer,
          reviewers: [],
          paths: artifact.paths || [],
          refs: artifact.refs || [],
          depends_on: [implementationTaskId],
          verification: artifact.verification || [],
          review_criteria: reviewCriteria,
          blocked_by: dependencyDone ? [] : [{
            task_id: implementationTaskId,
            status: implementationTask.status,
          }],
        });
      }
    }
  }

  return tasks;
}

function normalizeSource(source, options) {
  const sourceTasks = Array.isArray(source) ? source : source.tasks;
  const plan = source.plan || options.plan || (Array.isArray(source.waves) ? source : null);
  const implementationTasks = sourceTasks || options.tasks || [];
  const workflow = source.workflow || options.workflow || planToWorkflow(plan) || tasksToWorkflow(implementationTasks);
  const charter = source.charter || options.charter || null;

  return {
    waves: workflow?.waves || [],
    artifactsById: new Map((workflow?.artifacts || []).map((artifact) => [artifact.id, artifact])),
    rolesByName: new Map((charter?.roles || []).map((role) => [role.name, role])),
    implementationTasksById: new Map(implementationTasks.map((task) => [task.id, task])),
  };
}

function planToWorkflow(plan) {
  if (!plan?.ok || !Array.isArray(plan.waves)) return null;

  const artifacts = [];
  const waves = plan.waves.map((wave) => {
    for (const task of wave.tasks || []) {
      artifacts.push({
        id: task.artifact_id,
        type: task.artifact_type,
        paths: task.paths || [],
        refs: task.refs || [],
        owner: task.owner,
        reviewers: task.reviewers || [],
        depends_on: task.depends_on || [],
        verification: task.verification || [],
      });
    }
    return {
      id: wave.id,
      mode: wave.mode,
      artifact_ids: wave.artifact_ids || [],
    };
  });

  return { artifacts, waves };
}

function tasksToWorkflow(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const artifacts = [];
  const wavesById = new Map();
  for (const task of tasks) {
    const waveId = task.wave_id;
    if (!waveId || !Array.isArray(task.artifact_ids)) continue;
    if (!wavesById.has(waveId)) {
      wavesById.set(waveId, {
        id: waveId,
        mode: task.wave_mode || 'parallel',
        artifact_ids: [],
      });
    }

    const wave = wavesById.get(waveId);
    for (const artifactId of task.artifact_ids) {
      if (!wave.artifact_ids.includes(artifactId)) wave.artifact_ids.push(artifactId);
      artifacts.push({
        id: artifactId,
        type: task.artifact_type,
        paths: task.paths || [],
        refs: task.refs || [],
        owner: task.owner,
        reviewers: task.reviewers || [],
        depends_on: task.depends_on || [],
        verification: task.verification || [],
      });
    }
  }

  return { artifacts, waves: Array.from(wavesById.values()) };
}

function criteriaForReviewer(role, artifact) {
  if (!role || !Array.isArray(role.reviews)) return [];
  const match = role.reviews.find((review) => review.artifact_type === artifact.type);
  return match?.criteria || [];
}

function swarmTaskId(waveId, artifactId) {
  return `swarm:${waveId}:${artifactId}`;
}
