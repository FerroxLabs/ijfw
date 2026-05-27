import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  deriveOpenBlockers,
} from './src/orchestrator/wave-state.js';
import {
  initBlackboard,
  claimArtifact,
  releaseClaim,
  addBlackboardNote,
  writeBlackboardTasks,
} from './src/blackboard.js';
import { query } from './src/orchestrator/state-sdk.js';

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

test('S5: legacy blackboard blocker (addBlackboardNote) still drives status=blocked', async () => {
  // T7: legacy blockers (via addBlackboardNote(kind:'blocker'), targeting
  // blockers.jsonl) keep driving `status='blocked'` for back-compat. They do
  // NOT populate `blockers_open` — that field is now exclusively sourced from
  // decisions.jsonl (the SDK blocker.add target). The legacy blocker's
  // message DOES still appear in the body's "## Open blockers" section so a
  // human reading STATE.md sees what's wrong.
  const root = makeTmp();
  initBlackboard(root);
  claimArtifact(root, { artifact_id: 'W11-X:file-a', agent: 'agentA', paths: ['a'] });
  addBlackboardNote(root, { kind: 'blocker', author: 'agentA', message: '[W11-X] disk full' });

  const result = await checkpointWave('W11-X', root);

  assert.equal(result.frontmatter.status, 'blocked');
  // Legacy blockers do NOT populate blockers_open (which is now ids-only,
  // sourced from decisions.jsonl).
  assert.deepEqual(result.frontmatter.blockers_open, []);
  // Body still surfaces the legacy blocker for humans.
  assert.match(result.body, /^## Open blockers/m);
  assert.match(result.body, /- \[W11-X\] disk full/);
});

test('T7 cross-verb: blocker.add then checkpoint surfaces blocker id in blockers_open', async () => {
  // The falsifiable proof that T4→T7 reconciliation holds: an SDK blocker is
  // visible in STATE.md frontmatter as a stable id, and a subsequent
  // blocker.resolve flips it back to absent on next checkpoint.
  const root = makeTmp();
  initBlackboard(root);

  const blockerId = 'BLK-W11X-001';
  const addResult = await query(
    'blocker.add',
    {
      id: blockerId,
      text: 'disk full',
      waveId: 'W11-X',
      dedupKey: `blocker.add:${blockerId}:t1`,
    },
    { projectRoot: root },
  );
  assert.equal(addResult.ok, true);

  const afterAdd = await checkpointWave('W11-X', root);
  assert.equal(afterAdd.frontmatter.status, 'blocked');
  assert.deepEqual(afterAdd.frontmatter.blockers_open, [blockerId]);
  // The optional human summary mirrors the blocker text.
  assert.ok(Array.isArray(afterAdd.frontmatter.blockers_open_summary));
  assert.match(afterAdd.frontmatter.blockers_open_summary[0] ?? '', /disk full/);
  // Body shows the merged blocker (legacy + SDK source) under H2.
  assert.match(afterAdd.body, /^## Open blockers/m);

  // The blocker survives a re-read from disk via the SDK-routed write.
  const persistedAfterAdd = await readWaveState('W11-X', root);
  assert.deepEqual(persistedAfterAdd?.frontmatter.blockers_open, [blockerId]);

  // Resolve the blocker; next checkpoint must drop it from blockers_open.
  const resResult = await query(
    'blocker.resolve',
    {
      id: blockerId,
      resolution: 'cleared disk',
      waveId: 'W11-X',
      dedupKey: `blocker.resolve:${blockerId}:t1`,
    },
    { projectRoot: root },
  );
  assert.equal(resResult.ok, true);
  assert.equal(resResult.resolved, true);

  const afterResolve = await checkpointWave('W11-X', root);
  assert.deepEqual(afterResolve.frontmatter.blockers_open, []);
  // No claims + no open blockers → deriveStatus preserves the prior persisted
  // status ('blocked' from the previous checkpoint). This is intentional: a
  // wave that was blocked stays blocked until something positive happens
  // (a claim is filed or all are released). The persisted blocker history is
  // the audit trail; `blockers_open` correctly reports zero open blockers.
  assert.equal(afterResolve.frontmatter.status, 'blocked');
});

test('T7 cross-verb: SDK blocker on a different wave does NOT leak into this wave', async () => {
  const root = makeTmp();
  initBlackboard(root);
  await query(
    'blocker.add',
    {
      id: 'BLK-OTHER-001',
      text: 'wrong wave',
      waveId: 'W99-Z',
      dedupKey: 'blocker.add:BLK-OTHER-001:t1',
    },
    { projectRoot: root },
  );

  const result = await checkpointWave('W11-X', root);
  assert.deepEqual(result.frontmatter.blockers_open, []);
});

test('T7 deriveOpenBlockers unit: filters by waveId and excludes resolved', () => {
  const blackboard = {
    recent: {
      decisions: [
        { kind: 'blocker', blockerId: 'B1', text: 'one', waveId: 'W11-X' },
        { kind: 'blocker', blockerId: 'B2', text: 'two', waveId: 'W11-X' },
        { kind: 'blocker', blockerId: 'B3', text: 'other-wave', waveId: 'W99-Z' },
        { kind: 'blocker-resolution', blockerId: 'B2', waveId: 'W11-X' },
      ],
    },
  };
  const { ids, summaries } = deriveOpenBlockers(blackboard, 'W11-X');
  assert.deepEqual(ids, ['B1']);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /one/);
});

test('T7 deriveOpenBlockers unit: empty / missing decisions yields empty arrays', () => {
  assert.deepEqual(deriveOpenBlockers({}, 'W11-X'), { ids: [], summaries: [] });
  assert.deepEqual(deriveOpenBlockers({ recent: {} }, 'W11-X'), { ids: [], summaries: [] });
  assert.deepEqual(
    deriveOpenBlockers({ recent: { decisions: [] } }, 'W11-X'),
    { ids: [], summaries: [] },
  );
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

test('S5 perf: checkpointWave with 1000 tasks runs under 1500ms', async () => {
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
  // V155-014 (v1.5.5): threshold bumped from 500ms → 1500ms because the
  // body write now lands inside the SDK's `_withLocks` critical section
  // (intent-journal + waves.json + per-wave STATE.md), so checkpointWave
  // pays the journaling overhead on every call. This is the conscious
  // correctness-for-perf trade — `state.replay` can now roll back a
  // partial body write, which the prior #4-only re-acquisition could not.
  assert.ok(elapsed < 1500, `checkpointWave took ${elapsed}ms (expected <1500ms)`);
});

// ---------------------------------------------------------------------------
// T7: SDK regression — wave-state.js routes writes through the state-SDK.
//
// Strategy: wrap fs write surfaces in a path-scoped spy AND observe `query()`
// calls. The legitimacy contract for wave-state.js is:
//   * Frontmatter writes  → MUST call `query('wave.advance', ...)`.
//   * SUMMARY.md          → raw append is fine (not §1 canonical state).
//   * STATE.md body       → raw atomic write is the documented SDK-gap
//                           workaround (T7-followup-1) until the SDK exposes
//                           a body-write verb. Allowed.
// The spy raises if wave-state.js touches a path that wave-state has NEVER
// owned (workflow.json, waves.json) — i.e. proof it bypassed the SDK to write
// a sibling state file directly. Intent-journal / decisions.jsonl /
// events-*.jsonl writes from inside the SDK are EXPECTED (this is the SDK
// doing its job) — those paths are allow-listed because the SDK itself owns
// them. The spy is scoped specifically to surfaces wave-state.js was the
// historical raw-writer of (workflow.json, waves.json) plus any paths that
// would represent a clear bypass.
// ---------------------------------------------------------------------------

const WRITE_METHODS = [
  'writeFile', 'writeFileSync',
  'open', 'openSync',
];

// Paths that, if written from wave-state.js directly, would represent an SDK
// bypass. The SDK ITSELF writes intent-journal / decisions / events / homedir
// active-extension — those are SDK-internal and DO NOT appear here.
const BYPASS_PATH_PATTERNS = [
  /\/\.ijfw\/state\/workflow\.json(\.tmp[^/]*)?$/,
  /\/\.ijfw\/state\/waves\.json(\.tmp[^/]*)?$/,
];

function pathFromArgs(args) {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof first.toString === 'function') {
    const s = first.toString();
    return typeof s === 'string' ? s : null;
  }
  return null;
}

function isBypassPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  return BYPASS_PATH_PATTERNS.some((re) => re.test(p));
}

function installBypassWriteSpies(blocked) {
  const replaced = WRITE_METHODS.map((name) => {
    const original = fs[name];
    const handle = mock.method(fs, name, function (...args) {
      const p = pathFromArgs(args);
      if (isBypassPath(p)) {
        blocked.push({ method: name, path: p });
        throw new Error(
          `wave-state: raw fs.${name} call to SDK-managed path "${p}" — must route through state-SDK query() instead`,
        );
      }
      return original.apply(this, args);
    });
    return handle;
  });
  return () => replaced.forEach((m) => m.mock.restore());
}

test('T7 spy: writeWaveState does not raw-write workflow.json / waves.json', async () => {
  const root = makeTmp();
  const blocked = [];
  const restore = installBypassWriteSpies(blocked);
  try {
    await writeWaveState(
      'W14-A',
      { frontmatter: { wave_id: 'W14-A', status: 'in_progress' }, body: '# body' },
      root,
    );
  } finally {
    restore();
  }
  assert.deepEqual(
    blocked,
    [],
    `writeWaveState bypassed SDK: ${JSON.stringify(blocked)}`,
  );
  // Sanity: STATE.md is on disk and contains both frontmatter + body.
  const raw = readFileSync(join(root, '.ijfw', 'wave-W14-A', 'STATE.md'), 'utf8');
  assert.match(raw, /wave_id: W14-A/);
  assert.match(raw, /status: in_progress/);
  assert.match(raw, /# body/);
});

test('T7 spy: checkpointWave does not raw-write workflow.json / waves.json', async () => {
  const root = makeTmp();
  initBlackboard(root);
  claimArtifact(root, { artifact_id: 'W14-B:f', agent: 'agentA', paths: ['x'] });
  addBlackboardNote(root, { kind: 'finding', author: 'agentA', message: '[W14-B] f1' });

  const blocked = [];
  const restore = installBypassWriteSpies(blocked);
  try {
    await checkpointWave('W14-B', root);
  } finally {
    restore();
  }
  assert.deepEqual(
    blocked,
    [],
    `checkpointWave bypassed SDK: ${JSON.stringify(blocked)}`,
  );
});

test('T7 proof-of-routing: writeWaveState writes a wave.advance intent record', async () => {
  // Read the intent-journal AFTER writeWaveState — if frontmatter writes
  // routed through `query('wave.advance', ...)`, the SDK will have appended a
  // begin+commit pair to .ijfw/state/intent-journal.jsonl. We assert exactly
  // one begin+commit pair with `verb:'wave.advance'`. This is a direct
  // observation of the SDK doing its job — the canonical proof of routing.
  const root = makeTmp();
  await writeWaveState(
    'W14-D',
    { frontmatter: { wave_id: 'W14-D', status: 'in_progress' }, body: '' },
    root,
  );
  const journalPath = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
  assert.ok(existsSync(journalPath), 'SDK must create the intent journal');
  const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  const records = lines.map((l) => JSON.parse(l));
  const begins = records.filter((r) => r.verb === 'wave.advance' && r.phase === 'begin');
  const commits = records.filter((r) => r.verb === 'wave.advance' && r.phase === 'commit');
  assert.equal(begins.length, 1, `expected exactly one wave.advance begin; got ${begins.length}`);
  assert.equal(commits.length, 1, `expected exactly one wave.advance commit; got ${commits.length}`);
  // begin + commit share the same verbId.
  assert.equal(begins[0].verbId, commits[0].verbId);
});
