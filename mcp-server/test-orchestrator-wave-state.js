import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readWaveState,
  writeWaveState,
  checkpointWave,
  appendSummary,
  deriveStatus,
  filterByWave,
  renderBody,
  quoteYamlStr,
} from './src/orchestrator/wave-state.js';
import {
  initBlackboard,
  claimArtifact,
  releaseClaim,
  addBlackboardNote,
  writeBlackboardTasks,
} from './src/blackboard.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'wave-state-'));
}

test('read returns null for nonexistent wave', async () => {
  const root = makeTmp();
  const result = await readWaveState('W10-A0', root);
  assert.equal(result, null);
});

test('write then read roundtrip', async () => {
  const root = makeTmp();
  const state = {
    frontmatter: { wave_id: 'W10-A0', status: 'in_progress', agents: ['a', 'b'] },
    body: '# Notes\n\nhi',
  };
  await writeWaveState('W10-A0', state, root);
  const read = await readWaveState('W10-A0', root);
  assert.ok(read !== null);
  assert.deepEqual(read.frontmatter.wave_id, 'W10-A0');
  assert.deepEqual(read.frontmatter.status, 'in_progress');
  assert.deepEqual(read.frontmatter.agents, ['a', 'b']);
  assert.equal(read.body, '# Notes\n\nhi');
});

test('write auto-creates parent dirs', async () => {
  const root = makeTmp();
  // .ijfw/ does not exist in fresh tmp
  assert.equal(existsSync(join(root, '.ijfw')), false);
  await writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0' }, body: '' }, root);
  assert.ok(existsSync(join(root, '.ijfw', 'wave-W10-A0', 'STATE.md')));
});

test('checkpointWave seeds new state when missing (S5: empty blackboard → pending)', async () => {
  const root = makeTmp();
  const result = await checkpointWave('W10-A0', root);
  assert.equal(result.frontmatter.wave_id, 'W10-A0');
  // S5: with zero claims, status defaults to 'pending' (no work to be in-progress on).
  assert.equal(result.frontmatter.status, 'pending');
  assert.ok(typeof result.frontmatter.created_at === 'string');
  assert.ok(result.frontmatter.created_at.includes('T')); // ISO format
  assert.ok(typeof result.frontmatter.checkpoint_at === 'string');
  assert.ok(result.frontmatter.checkpoint_at.includes('T'));
  // S5: rollup metadata seeded even on empty wave.
  assert.equal(result.frontmatter.claims_active, 0);
  assert.deepEqual(result.frontmatter.findings_recent, []);
  assert.deepEqual(result.frontmatter.blockers_open, []);
  assert.deepEqual(result.frontmatter.agents, []);
  assert.ok(existsSync(join(root, '.ijfw', 'wave-W10-A0', 'STATE.md')));
});

test('checkpointWave preserves created_at + existing status when blackboard has no wave entries', async () => {
  const root = makeTmp();
  const initial = {
    frontmatter: {
      wave_id: 'W10-A0',
      status: 'review',
      created_at: '2020-01-01T00:00:00.000Z',
      checkpoint_at: '2020-01-01T00:00:00.000Z',
    },
    body: '## prior body\n',
  };
  await writeWaveState('W10-A0', initial, root);

  const result = await checkpointWave('W10-A0', root);

  // S5: when no claims tagged for this wave, prior status is preserved.
  assert.equal(result.frontmatter.status, 'review');
  // S5: created_at is preserved across checkpoints.
  assert.equal(result.frontmatter.created_at, '2020-01-01T00:00:00.000Z');
  // checkpoint_at is always advanced.
  assert.notEqual(result.frontmatter.checkpoint_at, '2020-01-01T00:00:00.000Z');
  assert.ok(result.frontmatter.checkpoint_at > '2020-01-01T00:00:00.000Z');
});

test('r13-M-03: appendSummary creates SUMMARY.md and writes ISO-dated delta', async () => {
  const root = makeTmp();
  await appendSummary('W10-A0', {
    agent_id: 'W10-A0',
    task_id: 't1',
    commits: ['abc123'],
    tests_delta: '+6 / 0 fail',
  }, root);
  const summary = readFileSync(join(root, '.ijfw', 'wave-W10-A0', 'SUMMARY.md'), 'utf8');
  assert.match(summary, /^### \d{4}-\d{2}-\d{2}T/m, 'ISO date heading');
  assert.match(summary, /\*\*agent:\*\* W10-A0/);
  assert.match(summary, /\*\*task:\*\* t1/);
  assert.match(summary, /\*\*commits:\*\* abc123/);
});

test('r13-M-03: appendSummary appends multiple deltas without corruption', async () => {
  const root = makeTmp();
  await appendSummary('W10-A0', { task_id: 't1', tests_delta: '+1' }, root);
  await appendSummary('W10-A0', { task_id: 't2', tests_delta: '+5' }, root);
  const summary = readFileSync(join(root, '.ijfw', 'wave-W10-A0', 'SUMMARY.md'), 'utf8');
  const headings = summary.match(/^### /mg) || [];
  assert.equal(headings.length, 2, 'two distinct deltas appended');
  assert.match(summary, /task:\*\* t1/);
  assert.match(summary, /task:\*\* t2/);
});

test('r13-M-03: appendSummary skips empty fields gracefully', async () => {
  const root = makeTmp();
  await appendSummary('W10-A0', { agent_id: 'W10-A0' }, root);
  const summary = readFileSync(join(root, '.ijfw', 'wave-W10-A0', 'SUMMARY.md'), 'utf8');
  assert.match(summary, /\*\*agent:\*\* W10-A0/);
  assert.doesNotMatch(summary, /task:/);
  assert.doesNotMatch(summary, /commits:/);
});

test('withFsLock parent-dir auto-create regression — no ENOENT on fresh tmpdir', async () => {
  // Regression: v1.4.3 aaf3052 — lock path parent must be auto-created.
  // A fresh tmpdir has no .ijfw/ subtree at all; writeWaveState must not throw ENOENT.
  const root = makeTmp();
  assert.equal(existsSync(join(root, '.ijfw')), false);
  // Must not throw
  await assert.doesNotReject(
    () => writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0' }, body: '' }, root),
  );
  // Lock path parent (.ijfw/wave-W10-A0/) was created
  assert.ok(existsSync(join(root, '.ijfw', 'wave-W10-A0')));
});

// ---------------------------------------------------------------------------
// W11-B1 / S5 — full checkpointWave rollup tests
// ---------------------------------------------------------------------------

test('S5: checkpointWave reflects active vs released claims tagged by wave', async () => {
  const root = makeTmp();
  initBlackboard(root);
  // Two claims tagged via artifact_id prefix; one released, one active.
  const c1 = claimArtifact(root, { artifact_id: 'W11-X:file-a', agent: 'agentA', paths: ['a'] });
  assert.equal(c1.ok, true);
  const c2 = claimArtifact(root, { artifact_id: 'W11-X:file-b', agent: 'agentB', paths: ['b'] });
  assert.equal(c2.ok, true);
  // Also add an unrelated claim that should NOT count.
  claimArtifact(root, { artifact_id: 'W99-Z:file-c', agent: 'agentC', paths: ['c'] });
  // Release one of the W11-X claims.
  releaseClaim(root, { artifact_id: 'W11-X:file-b', agent: 'agentB' });

  const result = await checkpointWave('W11-X', root);

  // One claim is still 'active'; the other is 'released' → status='in_progress'.
  assert.equal(result.frontmatter.claims_active, 1);
  assert.equal(result.frontmatter.status, 'in_progress');
  // Both wave-tagged agents are listed (deduped).
  assert.deepEqual(result.frontmatter.agents.sort(), ['agentA', 'agentB']);
});

test('S5: checkpointWave findings_recent reflects last-5 of wave-tagged blackboard slice', async () => {
  const root = makeTmp();
  initBlackboard(root);
  // Blackboard.readJsonl returns the last 5 raw lines; checkpointWave then
  // filters by wave tag and slices last 5 of the filtered set. Seed 5
  // wave-tagged findings (all should survive both windows).
  for (let i = 1; i <= 5; i++) {
    addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: `[W11-X] finding ${i}` });
  }

  const result = await checkpointWave('W11-X', root);

  assert.equal(result.frontmatter.findings_recent.length, 5);
  // Findings preserved in append order: 1..5.
  assert.match(result.frontmatter.findings_recent[0], /finding 1/);
  assert.match(result.frontmatter.findings_recent[4], /finding 5/);
  // Body has H2 'Recent findings' section.
  assert.match(result.body, /^## Recent findings/m);
});

test('S5: checkpointWave filters wave-tagged findings out of mixed blackboard window', async () => {
  const root = makeTmp();
  initBlackboard(root);
  // 3 wave-tagged + 1 unrelated — all 4 fit in the blackboard's last-5 window,
  // so filtering should keep exactly the 3 wave-tagged entries.
  addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: '[W11-X] a' });
  addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: '[W11-X] b' });
  addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: '[W99-Z] noise' });
  addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: '[W11-X] c' });

  const result = await checkpointWave('W11-X', root);

  assert.equal(result.frontmatter.findings_recent.length, 3);
  // findings_recent is YAML-quoted because messages contain '[' / ']'.
  assert.match(result.frontmatter.findings_recent[0], /\[W11-X\] a/);
  assert.match(result.frontmatter.findings_recent[2], /\[W11-X\] c/);
});

test('S5: open blockers force status=blocked and populate blockers_open', async () => {
  const root = makeTmp();
  initBlackboard(root);
  // Add an active claim plus an open blocker — blocker wins.
  claimArtifact(root, { artifact_id: 'W11-X:file-a', agent: 'agentA', paths: ['a'] });
  addBlackboardNote(root, { kind: 'blocker', author: 'agentA', message: '[W11-X] disk full' });

  const result = await checkpointWave('W11-X', root);

  assert.equal(result.frontmatter.status, 'blocked');
  assert.equal(result.frontmatter.blockers_open.length, 1);
  assert.match(result.frontmatter.blockers_open[0], /disk full/);
  assert.match(result.body, /^## Open blockers/m);
  assert.match(result.body, /- \[W11-X\] disk full/);
});

test('S5: renderBody returns markdown with H2 sections for findings + blockers', () => {
  const body = renderBody({
    findings: [
      { message: '[W11-X] f1' },
      { message: '[W11-X] f2' },
    ],
    blockers: [
      { message: '[W11-X] b1' },
    ],
  }, null);
  assert.match(body, /^## Recent findings/m);
  assert.match(body, /^- \[W11-X\] f1$/m);
  assert.match(body, /^- \[W11-X\] f2$/m);
  assert.match(body, /^## Open blockers/m);
  assert.match(body, /^- \[W11-X\] b1$/m);
});

test('S5: quoteYamlStr quotes strings with YAML-significant chars and emits raw otherwise', () => {
  // Quoted: contains ':'
  assert.equal(quoteYamlStr('foo: bar'), '"foo: bar"');
  // Quoted: contains '#'
  assert.equal(quoteYamlStr('a # b'), '"a # b"');
  // Quoted: contains '[' / ']'
  assert.equal(quoteYamlStr('arr[0]'), '"arr[0]"');
  // Quoted: contains '"' (escapes embedded quotes)
  assert.equal(quoteYamlStr('say "hi"'), '"say \\"hi\\""');
  // Quoted: contains ' -' (space-dash list ambiguity)
  assert.equal(quoteYamlStr('foo - bar'), '"foo - bar"');
  // Unquoted: plain identifier.
  assert.equal(quoteYamlStr('plain_value-123'), 'plain_value-123');
  // Non-string input coerces to string.
  assert.equal(quoteYamlStr(42), '42');
});

test('S5: deriveStatus rules — blocker > released > active > preserve', () => {
  // Blocker wins.
  assert.equal(deriveStatus({ claims: [], findings: [], blockers: [{ message: 'x' }] }, null), 'blocked');
  // No claims, no prior state → 'pending'.
  assert.equal(deriveStatus({ claims: [], findings: [], blockers: [] }, null), 'pending');
  // No claims, prior status → preserved.
  assert.equal(
    deriveStatus({ claims: [], findings: [], blockers: [] }, { frontmatter: { status: 'review' } }),
    'review',
  );
  // All released → 'review'.
  assert.equal(
    deriveStatus({ claims: [{ status: 'released' }, { status: 'released' }], findings: [], blockers: [] }, null),
    'review',
  );
  // Mixed → 'in_progress'.
  assert.equal(
    deriveStatus({ claims: [{ status: 'active' }, { status: 'released' }], findings: [], blockers: [] }, null),
    'in_progress',
  );
});

test('S5: filterByWave tags via wave_id, artifact_id prefix, and bracket message', () => {
  const blackboard = {
    claims: {
      data: {
        claims: [
          { artifact_id: 'W11-X:a', agent: 'a', status: 'active' }, // prefix match
          { wave_id: 'W11-X', artifact_id: 'misc', agent: 'b', status: 'active' }, // explicit
          { artifact_id: 'W99-Z:c', agent: 'c', status: 'active' }, // unrelated
        ],
      },
    },
    recent: {
      findings: [
        { message: '[W11-X] tagged' },
        { message: 'untagged' },
      ],
      blockers: [
        { message: '[W11-X] blocked here' },
      ],
    },
  };
  const filtered = filterByWave(blackboard, 'W11-X');
  assert.equal(filtered.claims.length, 2);
  assert.equal(filtered.findings.length, 1);
  assert.equal(filtered.blockers.length, 1);
});

test('S5: status transition appends SUMMARY.md delta', async () => {
  const root = makeTmp();
  initBlackboard(root);

  // First checkpoint: empty blackboard → status 'pending' (new wave).
  await checkpointWave('W11-X', root);

  // Add a blocker → second checkpoint transitions pending → blocked.
  addBlackboardNote(root, { kind: 'blocker', author: 'agentA', message: '[W11-X] stop' });
  await checkpointWave('W11-X', root);

  const summary = readFileSync(join(root, '.ijfw', 'wave-W11-X', 'SUMMARY.md'), 'utf8');
  assert.match(summary, /\*\*agent:\*\* checkpointWave/);
  assert.match(summary, /\*\*surprises:\*\* status: pending → blocked/);
});

test('S5 perf: checkpointWave with 1000 tasks runs under 500ms', async () => {
  const root = makeTmp();
  initBlackboard(root);
  // Seed 1000 tasks (rollup doesn't read tasks directly, but the path is hot).
  const tasks = [];
  for (let i = 0; i < 1000; i++) {
    tasks.push({ id: `t-${i}`, status: 'open', wave_id: 'W11-X', title: `task ${i}` });
  }
  writeBlackboardTasks(root, tasks, { replace: true });
  // Also seed 50 wave-tagged findings + 20 claims to stress the filter loop.
  for (let i = 0; i < 50; i++) {
    addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: `[W11-X] f${i}` });
  }
  for (let i = 0; i < 20; i++) {
    claimArtifact(root, { artifact_id: `W11-X:art-${i}`, agent: `agent-${i % 4}`, paths: [`p${i}`] });
  }

  const start = Date.now();
  await checkpointWave('W11-X', root);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `checkpointWave took ${elapsed}ms (expected <500ms)`);
});
