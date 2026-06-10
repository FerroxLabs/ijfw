// SLICE S4 — edit-diff capture, the CORRECTION LOOP (the HEART of the product).
//
// The clean ground-truth signal = diff(agent-PROPOSED span, user-COMMITTED span).
// Per the cross-audit: that diff IS the citation. These tests pin:
//   - an X->Y edit-delta produces a CITED evidence row (scope + cited span +
//     content hashes), metadata-minimized (no raw secrets / PII)
//   - the edit-delta grounds a CORRECTION preference (NOT a regex trigger)
//   - the DORMANT accept/edit-after expertise emitter is now fed + folded
//     (Wilson lower bound) via mergeExpertise
//   - ADMISSION GATE: a preference stays UNCONFIRMED below 3 corroborations
//     across NON-ADJACENT sessions
//   - 3 non-adjacent corroborations CONFIRM a slug
//   - a CONTRADICTING later edit flips the sign (invalidate-with-history)
//   - a SINGLE accidental edit does NOT confirm (under-learn, don't mis-learn)
//   - a stale confirmed preference DECAYS back to unconfirmed (half-life)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractEditDelta,
  captureEditDelta,
  scopeForPath,
  citedSpan,
  editFilePath,
  CITED_SPAN_MAX,
} from '../src/profile/capture.js';
import {
  deriveEditPreferences,
  editOutcomes,
  deriveHeuristic,
  expertiseBand,
} from '../src/profile/derive-heuristic.js';
import {
  applyDelta,
  confirmationState,
  EVIDENCE_CONFIRM_MIN,
  CONFIRM_HALF_LIFE_MS,
  enforceBounds,
} from '../src/profile/merge.js';
import { makeProfile } from '../src/profile/schema.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ijfw-edit-'));
}
function readLines(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A non-CI, non-ambiguous env so global_eligible can be true.
const CLEAN_ENV = { USER: 'tester', IJFW_HOST: 'claude-code' };

// ---------------------------------------------------------------------------
// scope + cited span — metadata minimization.
// ---------------------------------------------------------------------------

test('scopeForPath derives file_pattern + language + repo_rel, never an absolute path', () => {
  const root = '/Users/someone/dev/proj';
  const s = scopeForPath(`${root}/src/app.ts`, { cwd: root });
  assert.equal(s.file_pattern, '*.ts');
  assert.equal(s.language, 'typescript');
  assert.equal(s.repo_rel, 'src/app.ts');
  // repo_rel must NOT leak the homedir-rooted absolute path (username exposure).
  assert.ok(!s.repo_rel.includes('/Users/someone'), 'repo_rel leaked the absolute path');
});

test('citedSpan scrubs direct PII + assigned secrets and caps length', () => {
  const span = citedSpan('const apiKey = "sk-LIVE-deadbeef"; email me at a@b.com 123-45-6789');
  assert.ok(!span.includes('sk-LIVE-deadbeef'), 'secret leaked into cited span');
  assert.ok(!span.includes('a@b.com'), 'email leaked into cited span');
  assert.ok(!span.includes('123-45-6789'), 'SSN leaked into cited span');
  const long = citedSpan('x'.repeat(1000));
  assert.ok(long.length <= CITED_SPAN_MAX, 'cited span exceeds the cap');
});

// ---------------------------------------------------------------------------
// (1) an X->Y edit-delta produces a CITED evidence row.
// ---------------------------------------------------------------------------

test('extractEditDelta: X->Y change is an edit-after with a cited committed span + hashes', () => {
  const d = extractEditDelta({
    filePath: '/r/src/x.js',
    proposed: 'var x = 1;',
    committed: 'const x = 1;',
    cwd: '/r',
  });
  assert.equal(d.changed, true);
  assert.equal(d.outcome, 'edit-after');
  assert.equal(d.scope.language, 'javascript');
  assert.ok(d.proposed_hash && d.committed_hash, 'both content hashes present');
  assert.notEqual(d.proposed_hash, d.committed_hash, 'X != Y => different hashes');
  assert.ok(d.cited_span.includes('const x'), 'cited span carries the committed direction');
});

test('extractEditDelta: identical proposed/committed is an accept (landed unchanged)', () => {
  const d = extractEditDelta({ filePath: '/r/x.js', proposed: 'const x = 1;', committed: 'const x = 1;', cwd: '/r' });
  assert.equal(d.changed, false);
  assert.equal(d.outcome, 'accept');
});

test('captureEditDelta writes ONE cited evidence row to .session-edits.jsonl, no raw secret', () => {
  const root = freshRoot();
  try {
    const r = captureEditDelta({
      sessionId: 's1',
      filePath: join(root, 'src', 'auth.js'),
      proposed: 'const token = "SECRET-PROPOSED-9f3a";',
      committed: 'const token = process.env.TOKEN;',
      ts: 1000,
      cwd: root,
      env: CLEAN_ENV,
    });
    assert.equal(r.ok, true);
    const rows = readLines(editFilePath(root));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.outcome, 'edit-after');
    assert.equal(row.scope.language, 'javascript');
    assert.equal(row.global_eligible, true);
    // The raw proposed secret must NEVER appear anywhere in the persisted row.
    const blob = JSON.stringify(row);
    assert.ok(!blob.includes('SECRET-PROPOSED-9f3a'), 'edit row leaked the proposed secret');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (2) the edit-delta grounds a CORRECTION preference + feeds expertise.
// ---------------------------------------------------------------------------

test('deriveEditPreferences grounds a CORRECTION inference in an edit-delta (not a regex)', () => {
  const rows = [{
    ts: '2026-06-01T00:00:00.000Z',
    outcome: 'edit-after',
    changed: true,
    scope: { language: 'javascript', file_pattern: '*.js' },
    proposed_hash: 'aaaa',
    committed_hash: 'bbbb',
    cited_span: 'const x = 1',
  }];
  const infs = deriveEditPreferences(rows, { sessionId: 's1', host: 'claude-code', sessionOrdinal: 1 });
  assert.equal(infs.length, 1);
  assert.equal(infs[0].kind, 'correction');
  assert.ok(infs[0].subject.startsWith('javascript::'), 'subject scoped to the language');
  assert.equal(infs[0].value.cited.committed_hash, 'bbbb', 'value carries the citation');
  assert.deepEqual(infs[0].source_ordinals, [1], 'ordinal threaded for non-adjacency gate');
});

test('deriveEditPreferences ignores accept rows (those are expertise, not preference)', () => {
  const infs = deriveEditPreferences([{ outcome: 'accept', changed: false, scope: { language: 'go' }, cited_span: 'x' }]);
  assert.equal(infs.length, 0);
});

test('editOutcomes routes accept->positive / edit-after->negative; mergeExpertise folds Wilson', () => {
  // 8 accepts + 0 edits in javascript -> Wilson LB high enough to band as expert.
  const rows = [];
  for (let i = 0; i < 8; i += 1) rows.push({ outcome: 'accept', changed: false, scope: { language: 'javascript' } });
  for (let i = 0; i < 2; i += 1) rows.push({ outcome: 'edit-after', changed: true, scope: { language: 'javascript' } });
  const outcomes = editOutcomes(rows);
  assert.equal(outcomes.length, 10);
  const delta = deriveHeuristic({ edits: rows, sessionId: 's1', host: 'claude-code' });
  assert.ok(delta.expertise && delta.expertise.javascript, 'expertise emitted from edit outcomes');
  assert.equal(delta.expertise.javascript.accepts, 8);
  assert.equal(delta.expertise.javascript.n, 10);
  const p = applyDelta(makeProfile(), { expertise: delta.expertise });
  assert.ok(p.expertise.javascript.wilsonLB > 0, 'merge recomputed a Wilson lower bound');
  assert.equal(expertiseBand(p.expertise.javascript), 'expert', '8/10 accepts -> expert band');
});

// ---------------------------------------------------------------------------
// (3) ADMISSION GATE — under-learn, don't mis-learn.
// ---------------------------------------------------------------------------

// Helper: fold the SAME correction subject from N distinct sessions at ordinals.
function foldCorrection(profile, { sessionId, ordinal, committedHash = 'bbbb', ts, now }) {
  const inf = deriveEditPreferences([{
    ts,
    outcome: 'edit-after',
    changed: true,
    scope: { language: 'javascript', file_pattern: '*.js' },
    proposed_hash: 'aaaa',
    committed_hash: committedHash,
    cited_span: 'const x = 1',
  }], { sessionId, host: 'claude-code', sessionOrdinal: ordinal });
  return applyDelta(profile, { inferences: inf }, { now });
}

test('a SINGLE accidental edit does NOT confirm a preference', () => {
  let p = makeProfile();
  p = foldCorrection(p, { sessionId: 's1', ordinal: 1, ts: '2026-06-01T00:00:00.000Z' });
  const inf = p.global.dialectic[0];
  assert.equal(inf.evidence_count, 1);
  assert.equal(inf.confirmed, false, 'one edit must stay UNCONFIRMED');
  assert.equal(confirmationState(inf), 'unconfirmed');
});

test('two corroborations (below the floor) still do NOT confirm', () => {
  let p = makeProfile();
  p = foldCorrection(p, { sessionId: 's1', ordinal: 1, ts: '2026-06-01T00:00:00.000Z' });
  p = foldCorrection(p, { sessionId: 's3', ordinal: 3, ts: '2026-06-03T00:00:00.000Z' });
  const inf = p.global.dialectic[0];
  assert.equal([...new Set(inf.source_sessions)].length, 2);
  assert.equal(inf.confirmed, false, 'two distinct sessions is still below the >=3 floor');
});

test('3 NON-ADJACENT corroborations CONFIRM the slug', () => {
  const now = Date.parse('2026-06-10T00:00:00.000Z');
  let p = makeProfile();
  // ordinals 1, 3, 5 -> distinct + non-adjacent (gaps > 1).
  p = foldCorrection(p, { sessionId: 's1', ordinal: 1, ts: '2026-06-05T00:00:00.000Z', now });
  p = foldCorrection(p, { sessionId: 's3', ordinal: 3, ts: '2026-06-06T00:00:00.000Z', now });
  p = foldCorrection(p, { sessionId: 's5', ordinal: 5, ts: '2026-06-07T00:00:00.000Z', now });
  const inf = p.global.dialectic[0];
  assert.equal([...new Set(inf.source_sessions)].length, EVIDENCE_CONFIRM_MIN);
  assert.equal(inf.confirmed, true, '3 non-adjacent sessions -> CONFIRMED');
  assert.equal(confirmationState(inf, { now }), 'confirmed');
});

test('3 ADJACENT corroborations (back-to-back sessions) do NOT confirm', () => {
  const now = Date.parse('2026-06-10T00:00:00.000Z');
  let p = makeProfile();
  // ordinals 1, 2, 3 -> consecutive => a single burst, not spread-out work.
  p = foldCorrection(p, { sessionId: 's1', ordinal: 1, ts: '2026-06-05T00:00:00.000Z', now });
  p = foldCorrection(p, { sessionId: 's2', ordinal: 2, ts: '2026-06-05T01:00:00.000Z', now });
  p = foldCorrection(p, { sessionId: 's3', ordinal: 3, ts: '2026-06-05T02:00:00.000Z', now });
  const inf = p.global.dialectic[0];
  assert.equal(inf.confirmed, false, 'consecutive ordinals are adjacent => not independent corroboration');
});

// ---------------------------------------------------------------------------
// (4) a CONTRADICTING later edit flips the sign (invalidate-with-history).
// ---------------------------------------------------------------------------

test('a contradicting later edit flips the sign and pushes the prior to history', () => {
  const now = Date.parse('2026-06-10T00:00:00.000Z');
  let p = makeProfile();
  // Confirm direction A (committed_hash bbbb) across 3 non-adjacent sessions.
  p = foldCorrection(p, { sessionId: 's1', ordinal: 1, committedHash: 'bbbb', ts: '2026-06-05T00:00:00.000Z', now });
  p = foldCorrection(p, { sessionId: 's3', ordinal: 3, committedHash: 'bbbb', ts: '2026-06-06T00:00:00.000Z', now });
  p = foldCorrection(p, { sessionId: 's5', ordinal: 5, committedHash: 'bbbb', ts: '2026-06-07T00:00:00.000Z', now });
  assert.equal(p.global.dialectic[0].confirmed, true, 'direction A confirmed first');

  // A LATER edit on the SAME scope-subject points at a DIFFERENT committed span.
  p = foldCorrection(p, { sessionId: 's9', ordinal: 9, committedHash: 'cccc', ts: '2026-06-09T00:00:00.000Z', now });
  const inf = p.global.dialectic[0];
  assert.equal(inf.value.cited.committed_hash, 'cccc', 'value flipped to the new direction');
  assert.ok(Array.isArray(inf.history) && inf.history.length === 1, 'prior belief pushed to history');
  assert.equal(inf.history[0].reason, 'contradicted-by-later-edit');
  // Corroboration RESET — the new direction has not itself re-earned confirmed.
  assert.equal(inf.confirmed, false, 'flip resets corroboration; new direction must re-earn confirmed');
});

// ---------------------------------------------------------------------------
// half-life decay — a stale confirmed preference drops to unconfirmed.
// ---------------------------------------------------------------------------

test('confirmationState: a confirmed preference goes stale past the half-life', () => {
  const inf = {
    source_sessions: ['s1', 's3', 's5'],
    source_ordinals: [1, 3, 5],
    last_confirmed: '2026-01-01T00:00:00.000Z',
  };
  const fresh = Date.parse('2026-01-02T00:00:00.000Z');
  assert.equal(confirmationState(inf, { now: fresh }), 'confirmed');
  const stale = Date.parse('2026-01-01T00:00:00.000Z') + CONFIRM_HALF_LIFE_MS + 1000;
  assert.equal(confirmationState(inf, { now: stale }), 'unconfirmed', 'past half-life -> unconfirmed');
});

test('enforceBounds drops confirmed:false on a stale low-evidence preference (decay)', () => {
  const p = makeProfile();
  p.global.dialectic.push({
    id: 'correction::javascript::const x 1',
    kind: 'correction',
    subject: 'javascript::const x 1',
    value: { kind: 'correction' },
    confidence: 0.7,
    evidence_count: 1, // below decayEvidenceFloor
    last_confirmed: '2020-01-01T00:00:00.000Z', // very stale
    source_sessions: ['s1'],
    source_hosts: ['claude-code'],
    sensitivity: 'med',
    confirmed: true, // pretend it was confirmed; staleness must revoke it
  });
  const out = enforceBounds(p);
  const inf = out.global.dialectic.find((x) => x.id === 'correction::javascript::const x 1');
  assert.ok(inf, 'stale low-evidence inference is decayed-not-deleted (confidence 0.35 > archiveBelow 0.1)');
  assert.equal(inf.confirmed, false, 'decay revokes the confirmed flag');
  assert.ok(inf.confidence < 0.7, 'decay reduced confidence');
});

// ---------------------------------------------------------------------------
// deriveHeuristic integration — edits feed BOTH inferences AND expertise.
// ---------------------------------------------------------------------------

test('deriveHeuristic folds edits into inferences (correction) AND expertise', () => {
  const edits = [
    { ts: '2026-06-01T00:00:00.000Z', outcome: 'edit-after', changed: true, scope: { language: 'python' }, proposed_hash: 'a', committed_hash: 'b', cited_span: 'def f(): pass' },
    { outcome: 'accept', changed: false, scope: { language: 'python' } },
  ];
  const delta = deriveHeuristic({ edits, sessionId: 's1', host: 'claude-code', sessionOrdinal: 1 });
  assert.ok(Array.isArray(delta.inferences) && delta.inferences.length === 1, 'one correction inference');
  assert.equal(delta.inferences[0].kind, 'correction');
  assert.ok(delta.expertise && delta.expertise.python, 'python expertise from accept+edit-after');
  assert.equal(delta.expertise.python.n, 2);
  assert.equal(delta.expertise.python.accepts, 1);
});

test('deriveHeuristic is deterministic on edit input (deep-equal on repeat)', () => {
  const edits = [{ ts: '2026-06-01T00:00:00.000Z', outcome: 'edit-after', changed: true, scope: { language: 'rust' }, proposed_hash: 'a', committed_hash: 'b', cited_span: 'let x = 1' }];
  const a = deriveHeuristic({ edits, sessionId: 's1', host: 'claude-code', sessionOrdinal: 2 });
  const b = deriveHeuristic({ edits, sessionId: 's1', host: 'claude-code', sessionOrdinal: 2 });
  assert.deepEqual(a, b);
});
