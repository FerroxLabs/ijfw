/**
 * _generate-corpus.js — DETERMINISTIC generator for the T20 truncation
 * fixture corpus. Each fixture subdirectory carries every artifact the
 * recovery test needs to materialise a real temp project AND verify the
 * post-recovery state:
 *
 *   - `meta.json`             — fixture descriptor (category, target files,
 *                                expected final state, expected recovery
 *                                verdict).
 *   - `events.jsonl`          — pre-recorded per-subagent event log (T5
 *                                envelope shape). Empty for `no-events`.
 *   - `intent-journal.jsonl`  — pre-recorded intent journal (T4 begin/commit
 *                                records).
 *   - `snapshots/<verbId>.json` — pre-recorded snapshot sidecars for
 *                                overwrite-verb partials.
 *   - `target/<rel>`          — pre-recorded ON-DISK content of target files
 *                                AT THE MOMENT OF TRUNCATION (i.e. AFTER a
 *                                begin's mutation, BEFORE its commit).
 *
 * The test reconstructs a project from these artifacts, runs the recovery
 * module, then asserts that each target file matches the expected final
 * state in `meta.json`.
 *
 * Run once: `node _generate-corpus.js` → writes 25 fixtures.
 * (This script is NOT invoked by the test — it just produces the
 * deterministic fixtures we then check into the repo.)
 */

import {
  existsSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TS = '2026-05-20T12:00:00.000Z';

// Helpers ----------------------------------------------------------------

function writeArtifact(absPath, content) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

function asJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

function buildEvent({ seq, verb, subId, verbId, outcome = 'ok' }) {
  return {
    seq,
    verb,
    subagentId: subId,
    ts: TS,
    verbId,
    outcome,
    payloadDigest: `sha256-fixture-${verbId}`,
  };
}

function buildBegin({ verb, verbId, targets, kind, payloadDigest, dedupKey }) {
  const rec = {
    verb, verbId, phase: 'begin', ts: TS, targets,
    payloadDigest: payloadDigest || `sha256-fixture-${verbId}`,
    kind,
  };
  if (dedupKey) rec.dedupKey = dedupKey;
  return rec;
}

function buildCommit({ verb, verbId, kind, payloadDigest, dedupKey }) {
  const rec = {
    verb, verbId, phase: 'commit', ts: TS,
    payloadDigest: payloadDigest || `sha256-fixture-${verbId}`,
    kind,
  };
  if (dedupKey) rec.dedupKey = dedupKey;
  return rec;
}

function writeFixture(id, {
  category, subId, waveId, eventStream, journal, snapshots, targetFiles,
  expectedFinalState, expectedDetection, expectedRecovery, notes,
}) {
  const dir = join(__dirname, id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // meta.json — the test contract.
  const meta = {
    id, category, waveId, subId,
    notes: notes || '',
    expectedDetection,            // { truncated: false|string, reasonContains?: string }
    expectedRecovery,             // { recovered: boolean }
    expectedFinalState,           // { '<rel>': '<content>' | null (deleted) }
    expectedTerminalVerb: 'subagent.post-done',
  };
  writeArtifact(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  // events.jsonl
  writeArtifact(join(dir, 'events.jsonl'), asJsonl(eventStream));

  // intent-journal.jsonl
  writeArtifact(join(dir, 'intent-journal.jsonl'), asJsonl(journal));

  // snapshots/ — only present when a snapshot was captured
  for (const [verbId, snap] of Object.entries(snapshots || {})) {
    writeArtifact(join(dir, 'snapshots', `${verbId}.json`), `${JSON.stringify(snap, null, 2)}\n`);
  }

  // target/ — content of mutated files at the moment of truncation
  for (const [rel, content] of Object.entries(targetFiles || {})) {
    if (content === null) continue; // intentionally absent
    writeArtifact(join(dir, 'target', rel), content);
  }
}

// =======================================================================
// Category 1: clean-exit (5) — full run, terminal verb, no partials.
// Recovery is essentially a no-op; the expected final state matches the
// state at truncation time. Tests prove recovery does not corrupt clean
// runs.
// =======================================================================

for (let i = 1; i <= 5; i += 1) {
  const subId = `cleanA${i}`;
  const verb1Id = `v-clean-${i}-set-phase`;
  const verb2Id = `v-clean-${i}-post-done`;
  const wfRel = '.ijfw/state/workflow.json';
  const wfAfter = JSON.stringify({ phase: `clean-${i}`, ts: TS });

  writeFixture(`fx-01-clean-exit-${String(i).padStart(2, '0')}`, {
    category: 'clean-exit',
    waveId: `W20-clean-${i}`,
    subId,
    eventStream: [
      buildEvent({ seq: 1, verb: 'workflow.set-phase', subId, verbId: verb1Id }),
      buildEvent({ seq: 2, verb: 'subagent.post-done', subId, verbId: verb2Id }),
    ],
    journal: [
      buildBegin({ verb: 'workflow.set-phase', verbId: verb1Id, targets: [wfRel], kind: 'overwrite' }),
      buildCommit({ verb: 'workflow.set-phase', verbId: verb1Id, kind: 'overwrite' }),
    ],
    snapshots: {},                          // overwrite verb committed — sidecar already cleaned
    targetFiles: { [wfRel]: wfAfter },      // post-commit content
    expectedFinalState: { [wfRel]: wfAfter }, // recovery leaves clean state untouched
    expectedDetection: { truncated: false, reasonContains: 'clean exit' },
    expectedRecovery: { recovered: true },
    notes: 'baseline — clean exit with terminal verb; recovery is a no-op',
  });
}

// =======================================================================
// Category 2: mid-overwrite (5) — overwrite verb began, mutated target,
// no commit. Snapshot sidecar exists with pre-begin content. Recovery
// MUST snapshot-roll-back: target restored to pre-begin content.
// =======================================================================

for (let i = 1; i <= 5; i += 1) {
  const subId = `midO${i}`;
  const verb1Id = `v-midO-${i}-set-phase`;        // already committed
  const verb2Id = `v-midO-${i}-advance`;          // PARTIAL — overwrite verb
  const wfRel = '.ijfw/state/workflow.json';
  const wfBefore = JSON.stringify({ phase: `midO-pre-${i}` });
  const wfHalfApplied = JSON.stringify({ phase: `midO-HALF-${i}`, partial: true });

  writeFixture(`fx-02-mid-overwrite-${String(i).padStart(2, '0')}`, {
    category: 'mid-overwrite',
    waveId: `W20-midO-${i}`,
    subId,
    eventStream: [
      buildEvent({ seq: 1, verb: 'workflow.set-phase', subId, verbId: verb1Id }),
      // No event for the partial verb's commit — the stream truncates here.
    ],
    journal: [
      buildBegin({ verb: 'workflow.set-phase', verbId: verb1Id, targets: [wfRel], kind: 'overwrite' }),
      buildCommit({ verb: 'workflow.set-phase', verbId: verb1Id, kind: 'overwrite' }),
      // Partial: begin written, target mutated, no commit.
      buildBegin({ verb: 'wave.advance', verbId: verb2Id, targets: [wfRel], kind: 'overwrite' }),
    ],
    snapshots: {
      [verb2Id]: {
        verbId: verb2Id,
        targets: [{
          relPath: wfRel,
          absPath: '<<ABS>>', // test fills in
          existed: true,
          content: wfBefore,
        }],
      },
    },
    // At truncation moment, file holds the half-applied content.
    targetFiles: { [wfRel]: wfHalfApplied },
    // After recovery: target restored to pre-begin content.
    expectedFinalState: { [wfRel]: wfBefore },
    expectedDetection: { truncated: 'open-partial', reasonContains: 'open begin' },
    expectedRecovery: { recovered: true },
    notes: 'overwrite verb partial — snapshot-rollback restores wfBefore',
  });
}

// =======================================================================
// Category 3: mid-append (5) — append verb began, appended a durable
// record, no commit. Snapshot is INTENTIONALLY ABSENT (append verbs
// never write one — §4). Recovery seals the partial; the append stays.
// =======================================================================

for (let i = 1; i <= 5; i += 1) {
  const subId = `midA${i}`;
  const verbAddId = `v-midA-${i}-decision-add`; // PARTIAL — append verb
  const decisionsRel = '.ijfw/blackboard/decisions.jsonl';
  const decisionsAfter = `${JSON.stringify({
    id: `d-${i}`, text: `decision ${i}`, dedupKey: `dk-midA-${i}`,
  })}\n`;

  writeFixture(`fx-03-mid-append-${String(i).padStart(2, '0')}`, {
    category: 'mid-append',
    waveId: `W20-midA-${i}`,
    subId,
    eventStream: [
      // Append verb's tap event MAY have fired before truncation — include
      // a non-terminal subagent.checkpoint to make detection clearer.
      buildEvent({ seq: 1, verb: 'subagent.checkpoint', subId, verbId: `v-midA-${i}-ckpt` }),
    ],
    journal: [
      // Already-committed append (sealed by a prior commit).
      buildBegin({
        verb: 'subagent.checkpoint', verbId: `v-midA-${i}-ckpt`,
        targets: ['.ijfw/wave-W20-midA-' + i + '/subagent-' + subId + '.checkpoint.json'],
        kind: 'append', dedupKey: `dk-ckpt-midA-${i}`,
      }),
      buildCommit({ verb: 'subagent.checkpoint', verbId: `v-midA-${i}-ckpt`, kind: 'append', dedupKey: `dk-ckpt-midA-${i}` }),
      // Partial append: begin only, no commit.
      buildBegin({
        verb: 'decision.add', verbId: verbAddId, targets: [decisionsRel],
        kind: 'append', dedupKey: `dk-midA-${i}`,
      }),
    ],
    snapshots: {},
    // Truncation moment: the durable append IS on disk.
    targetFiles: { [decisionsRel]: decisionsAfter },
    // After recovery: the append IS PRESERVED (seal-in-place, not rolled back).
    expectedFinalState: { [decisionsRel]: decisionsAfter },
    expectedDetection: { truncated: 'open-partial', reasonContains: 'open begin' },
    expectedRecovery: { recovered: true },
    notes: 'append verb partial — sealed in place; durable append preserved',
  });
}

// =======================================================================
// Category 4: no-events (5) — subagent dispatched but emitted no events
// (truncated before its first tap fired). Journal carries an open begin.
// Recovery snapshot-rolls-back the overwrite partial.
// =======================================================================

for (let i = 1; i <= 5; i += 1) {
  const subId = `noEv${i}`;
  const verbId = `v-noEv-${i}-set-phase`;
  const wfRel = '.ijfw/state/workflow.json';
  const wfBefore = JSON.stringify({ phase: `noEv-pre-${i}` });
  const wfPartial = JSON.stringify({ phase: `noEv-PARTIAL-${i}` });

  writeFixture(`fx-04-no-events-${String(i).padStart(2, '0')}`, {
    category: 'no-events',
    waveId: `W20-noEv-${i}`,
    subId,
    eventStream: [],                                  // emit truncated before tap
    journal: [
      buildBegin({ verb: 'workflow.set-phase', verbId, targets: [wfRel], kind: 'overwrite' }),
    ],
    snapshots: {
      [verbId]: {
        verbId,
        targets: [{
          relPath: wfRel,
          absPath: '<<ABS>>',
          existed: true,
          content: wfBefore,
        }],
      },
    },
    targetFiles: { [wfRel]: wfPartial },
    expectedFinalState: { [wfRel]: wfBefore },
    expectedDetection: { truncated: 'no-events-open-begin', reasonContains: 'no events' },
    expectedRecovery: { recovered: true },
    notes: 'subagent emitted no events; recovery rolls back open begin',
  });
}

// =======================================================================
// Category 5: error-terminated (5) — stream ends with outcome:'error'.
// Journal partial closes via replay. Two flavours: overwrite-partial
// after error (rollback) + append-partial after error (seal).
// =======================================================================

for (let i = 1; i <= 5; i += 1) {
  const subId = `errT${i}`;
  // Alternate between overwrite-partial (odd i) and append-partial (even).
  const isOverwrite = i % 2 === 1;
  const partialVerbId = `v-errT-${i}-partial`;
  const errEventVerb = isOverwrite ? 'wave.advance' : 'decision.add';

  if (isOverwrite) {
    const wfRel = '.ijfw/state/workflow.json';
    const wfBefore = JSON.stringify({ phase: `errT-pre-${i}` });
    const wfPartial = JSON.stringify({ phase: `errT-PARTIAL-${i}` });
    writeFixture(`fx-05-error-terminated-${String(i).padStart(2, '0')}`, {
      category: 'error-terminated',
      waveId: `W20-errT-${i}`,
      subId,
      eventStream: [
        buildEvent({ seq: 1, verb: 'workflow.set-phase', subId, verbId: `v-errT-${i}-ok` }),
        buildEvent({ seq: 2, verb: errEventVerb, subId, verbId: partialVerbId, outcome: 'error' }),
      ],
      journal: [
        buildBegin({ verb: 'workflow.set-phase', verbId: `v-errT-${i}-ok`, targets: [wfRel], kind: 'overwrite' }),
        buildCommit({ verb: 'workflow.set-phase', verbId: `v-errT-${i}-ok`, kind: 'overwrite' }),
        buildBegin({ verb: errEventVerb, verbId: partialVerbId, targets: [wfRel], kind: 'overwrite' }),
      ],
      snapshots: {
        [partialVerbId]: {
          verbId: partialVerbId,
          targets: [{
            relPath: wfRel,
            absPath: '<<ABS>>',
            existed: true,
            content: wfBefore,
          }],
        },
      },
      targetFiles: { [wfRel]: wfPartial },
      expectedFinalState: { [wfRel]: wfBefore },
      expectedDetection: { truncated: 'error-terminated', reasonContains: "outcome='error'" },
      expectedRecovery: { recovered: true },
      notes: 'error-terminated with overwrite partial — rollback restores baseline',
    });
  } else {
    const decisionsRel = '.ijfw/blackboard/decisions.jsonl';
    const decisionsAfter = `${JSON.stringify({
      id: `d-errT-${i}`, text: `errT ${i}`, dedupKey: `dk-errT-${i}`,
    })}\n`;
    writeFixture(`fx-05-error-terminated-${String(i).padStart(2, '0')}`, {
      category: 'error-terminated',
      waveId: `W20-errT-${i}`,
      subId,
      eventStream: [
        buildEvent({ seq: 1, verb: 'subagent.checkpoint', subId, verbId: `v-errT-${i}-ckpt` }),
        buildEvent({ seq: 2, verb: errEventVerb, subId, verbId: partialVerbId, outcome: 'error' }),
      ],
      journal: [
        buildBegin({ verb: 'subagent.checkpoint', verbId: `v-errT-${i}-ckpt`, targets: ['.ijfw/wave-W20-errT-' + i + '/subagent-' + subId + '.checkpoint.json'], kind: 'append', dedupKey: `dk-ckpt-errT-${i}` }),
        buildCommit({ verb: 'subagent.checkpoint', verbId: `v-errT-${i}-ckpt`, kind: 'append', dedupKey: `dk-ckpt-errT-${i}` }),
        buildBegin({ verb: errEventVerb, verbId: partialVerbId, targets: [decisionsRel], kind: 'append', dedupKey: `dk-errT-${i}` }),
      ],
      snapshots: {},
      targetFiles: { [decisionsRel]: decisionsAfter },
      expectedFinalState: { [decisionsRel]: decisionsAfter },
      expectedDetection: { truncated: 'error-terminated', reasonContains: "outcome='error'" },
      expectedRecovery: { recovered: true },
      notes: 'error-terminated with append partial — seal-in-place preserves record',
    });
  }
}

// eslint-disable-next-line no-console
console.log('truncation-corpus: generated 25 fixtures (5 per category × 5 categories)');
