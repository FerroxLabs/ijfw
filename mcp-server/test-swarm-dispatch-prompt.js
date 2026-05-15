import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSwarmDispatchPrompt } from './src/swarm/dispatch-prompt.js';

test('renderSwarmDispatchPrompt includes implementation task scope and commands', () => {
  const prompt = renderSwarmDispatchPrompt({
    id: 'swarm:w1:runtime-module',
    title: 'implementation-engineer: runtime-module',
    status: 'ready',
    wave_id: 'w1',
    wave_mode: 'parallel',
    artifact_ids: ['runtime-module'],
    owner: 'implementation-engineer',
    reviewers: ['test-reviewer'],
    paths: ['mcp-server/src/runtime.js', 'mcp-server/test-runtime.js'],
    refs: ['.planning/1.3.2/PLAN.md'],
    depends_on: [],
    verification: ['node mcp-server/test-runtime.js'],
  }, { projectRoot: '/tmp/project' });

  assert.match(prompt, /Task id: swarm:w1:runtime-module/);
  assert.match(prompt, /Owner: implementation-engineer/);
  assert.match(prompt, /Status: ready/);
  assert.match(prompt, /runtime-module/);
  assert.match(prompt, /mcp-server\/src\/runtime\.js/);
  assert.match(prompt, /\.planning\/1\.3\.2\/PLAN\.md/);
  assert.match(prompt, /No prepared task dependencies/);
  assert.match(prompt, /node mcp-server\/test-runtime\.js/);
  assert.match(prompt, /ijfw swarm start swarm:w1:runtime-module/);
  assert.match(prompt, /ijfw swarm complete swarm:w1:runtime-module/);
  assert.match(prompt, /ijfw swarm block swarm:w1:runtime-module/);
  assert.match(prompt, /Do not revert user changes or edits by other agents/);
});

test('renderSwarmDispatchPrompt includes review task criteria and dependency', () => {
  const prompt = renderSwarmDispatchPrompt({
    id: 'review:w1:screen-system:visual-qa',
    title: 'visual-qa: review screen-system',
    status: 'ready',
    wave_id: 'w1',
    wave_mode: 'review',
    artifact_ids: ['screen-system'],
    owner: 'visual-qa',
    paths: ['design/screens/**'],
    refs: ['DESIGN.md', 'figma:screen-system'],
    depends_on: ['swarm:w1:screen-system'],
    verification: ['visual audit'],
    review_criteria: ['layout', 'contrast', 'responsive-fit'],
  });

  assert.match(prompt, /Task id: review:w1:screen-system:visual-qa/);
  assert.match(prompt, /Wave mode: review/);
  assert.match(prompt, /Depends on:\n  - swarm:w1:screen-system/);
  assert.match(prompt, /Required checks or review gates:\n  - visual audit/);
  assert.match(prompt, /Review Criteria/);
  assert.match(prompt, /layout/);
  assert.match(prompt, /contrast/);
  assert.match(prompt, /responsive-fit/);
  assert.match(prompt, /Preserve project-agnostic output/);
});

test('renderSwarmDispatchPrompt warns blocked tasks not to start', () => {
  const prompt = renderSwarmDispatchPrompt({
    id: 'swarm:w2:market-analysis',
    title: 'researcher: market-analysis',
    status: 'blocked',
    wave_id: 'w2',
    wave_mode: 'sequential',
    artifact_ids: ['market-analysis'],
    owner: 'researcher',
    paths: [],
    refs: ['customer-interviews.csv'],
    depends_on: ['swarm:w1:research-corpus'],
    verification: ['source audit', 'assumptions review'],
    blocked_by: [{
      task_id: 'swarm:w1:research-corpus',
      status: 'ready',
    }, {
      artifact_id: 'market-analysis',
      agent: 'strategy-lead',
      paths: ['research/**'],
    }],
    blocker: 'Waiting on approved interview corpus.',
  });

  assert.match(prompt, /Status: blocked/);
  assert.match(prompt, /No path scope was provided/);
  assert.match(prompt, /Blocked by:\n  - task swarm:w1:research-corpus; status ready/);
  assert.match(prompt, /artifact market-analysis; agent strategy-lead; paths research\/\*\*/);
  assert.match(prompt, /Current blocker:\n  - Waiting on approved interview corpus\./);
  assert.match(prompt, /This task is currently blocked\. Do not start/);
  assert.match(prompt, /ijfw swarm block swarm:w2:market-analysis/);
});

test('renderSwarmDispatchPrompt includes Codex custom-agent fallback guidance', () => {
  const prompt = renderSwarmDispatchPrompt({
    id: 'swarm:w1:runtime-module',
    title: 'implementation-engineer: runtime-module',
    status: 'ready',
    wave_id: 'w1',
    wave_mode: 'parallel',
    artifact_ids: ['runtime-module'],
    owner: 'implementation-engineer',
    paths: ['src/**/*.js'],
  }, { codex: true });

  assert.match(prompt, /## Codex Dispatch/);
  assert.match(prompt, /Preferred custom agent: implementation_engineer/);
  assert.match(prompt, /generic `worker`/);
  assert.match(prompt, /\.codex\/agents\/\*\.toml/);
  assert.match(prompt, /fork_context/);
});
