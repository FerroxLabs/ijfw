import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateBlackboardClaim,
  validateBlackboardTask,
  validateTeamBundle,
  validateTeamCharter,
  validateWorkflowManifest,
} from './src/team/schemas.js';

const fixtureDir = new URL('./fixtures/team/', import.meta.url);

function readFixture(filename) {
  return JSON.parse(readFileSync(new URL(filename, fixtureDir), 'utf8'));
}

test('team fixtures validate across project archetypes', () => {
  const files = readdirSync(fixtureDir).filter((file) => file.endsWith('.json')).sort();
  assert.deepEqual(files, [
    'book.json',
    'business.json',
    'content.json',
    'design.json',
    'mixed.json',
    'research.json',
    'software.json',
  ]);

  for (const file of files) {
    const fixture = readFixture(file);
    const validation = validateTeamBundle(fixture);
    assert.equal(validation.ok, true, `${file}: ${validation.errors.join('; ')}`);
  }
});

test('team charter validation rejects missing role contracts', () => {
  const charter = {
    schema_version: 'team-charter/v1',
    team_name: 'broken-team',
    project_archetypes: ['software'],
    roles: [
      {
        name: 'builder',
        role_type: 'software',
        model: 'sonnet',
        phase_scope: ['execute'],
        owns: [],
        reviews: [],
        handoff: { format: 'markdown', required_sections: ['tests'] },
        coordination: { parallel_safe: true, claim_required: true, conflicts_with: [] },
      },
    ],
  };

  const validation = validateTeamCharter(charter);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /roles\[0\]\.owns must contain at least 1 item/);
});

test('workflow validation rejects unknown owners and dependency targets', () => {
  const { charter, workflow } = readFixture('software.json');
  const broken = structuredClone(workflow);
  broken.artifacts[0].owner = 'missing-agent';
  broken.artifacts[1].depends_on = ['missing-artifact'];
  broken.waves[0].artifact_ids = ['missing-artifact'];

  const validation = validateWorkflowManifest(broken, charter);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /owner references unknown role "missing-agent"/);
  assert.match(validation.errors.join('\n'), /depends_on\[0\] references unknown artifact "missing-artifact"/);
  assert.match(validation.errors.join('\n'), /waves\[0\]\.artifact_ids\[0\] references unknown artifact "missing-artifact"/);
});

test('bundle validation rejects blackboard records pointing at unknown artifacts', () => {
  const bundle = readFixture('design.json');
  bundle.blackboard.tasks[0].artifact_ids = ['missing-artifact'];
  bundle.blackboard.claims[0].artifact_id = 'missing-artifact';

  const validation = validateTeamBundle(bundle);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /task\.artifact_ids\[0\] references unknown artifact "missing-artifact"/);
  assert.match(validation.errors.join('\n'), /claim\.artifact_id references unknown artifact "missing-artifact"/);
});

test('blackboard task and claim validation reject invalid statuses', () => {
  const { workflow } = readFixture('content.json');

  const task = {
    id: 'task-x',
    title: 'Do work',
    status: 'waiting',
    artifact_ids: ['campaign-brief'],
  };
  const claim = {
    id: 'claim-x',
    artifact_id: 'campaign-brief',
    agent: 'content-strategist',
    status: 'locked',
  };

  const taskValidation = validateBlackboardTask(task, workflow);
  const claimValidation = validateBlackboardClaim(claim, workflow);

  assert.equal(taskValidation.ok, false);
  assert.match(taskValidation.errors.join('\n'), /task.status must be one of:/);
  assert.equal(claimValidation.ok, false);
  assert.match(claimValidation.errors.join('\n'), /claim.status must be one of:/);
});

test('workflow artifacts may use non-file refs for project-agnostic work', () => {
  const { charter, workflow } = readFixture('business.json');
  const nonFileWorkflow = structuredClone(workflow);
  delete nonFileWorkflow.artifacts[0].paths;
  nonFileWorkflow.artifacts[0].refs = ['board:operating-plan'];

  const validation = validateWorkflowManifest(nonFileWorkflow, charter);
  assert.equal(validation.ok, true, validation.errors.join('; '));
});
