// P2 — Heuristic derivation (ZERO LLM). Pure functions that emit a ProfileDelta
// the P0 merge layer (`applyDelta` in src/profile/merge.js) consumes. These
// tests pin the delta SHAPE to what `applyDelta`/`mergeStyle`/`mergeExpertise`
// actually read, and assert the engine is pure + deterministic + LLM-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  deriveStyle,
  styleAxisConfirmed,
  deriveExpertise,
  expertiseBand,
  derivePreferences,
  deriveHeuristic,
} from '../src/profile/derive-heuristic.js';
import { detectFeedback } from '../src/feedback-detector.js';
import { applyDelta, wilsonLowerBound } from '../src/profile/merge.js';
import { makeProfile, STYLE_AXES, inferenceId } from '../src/profile/schema.js';

const MODULE_PATH = fileURLToPath(new URL('../src/profile/derive-heuristic.js', import.meta.url));

// ---------------------------------------------------------------------------
// P2.1 — EMA style fingerprint.
// deriveStyle takes per-session METADATA (not transcripts) and returns
// per-axis OBSERVATIONS shaped `{ axis: { sample:0..1, weight } }` — exactly
// what merge.js `mergeStyle` reads (it owns the EMA + Beta fold). We emit the
// observation, the merge applies α — no double-apply.
// ---------------------------------------------------------------------------

test('P2.1 deriveStyle emits {axis:{sample,weight}} observations the merge consumes', () => {
  const meta = {
    avg_msg_chars: 40,        // short messages -> terse
    emoji_per_msg: 1.5,       // emoji-heavy
    code_block_ratio: 0.4,
    formality_markers: 0.8,   // formal
    turn_cadence_per_min: 6,  // high energy
  };
  const style = deriveStyle(meta);
  // Every axis present, every observation in the merge-expected shape.
  for (const axis of STYLE_AXES) {
    assert.ok(style[axis], `axis ${axis} present`);
    assert.ok(typeof style[axis].sample === 'number', `${axis}.sample is number`);
    assert.ok(style[axis].sample >= 0 && style[axis].sample <= 1, `${axis}.sample in [0,1]`);
    assert.ok(typeof style[axis].weight === 'number' && style[axis].weight > 0, `${axis}.weight>0`);
  }
});

test('P2.1 a terse metadata stream moves the terseness axis UP through the merge', () => {
  // Very short messages => high terseness sample => EMA rises above the 0.5 prior.
  const terse = deriveStyle({ avg_msg_chars: 20 });
  const verbose = deriveStyle({ avg_msg_chars: 2000 });
  assert.ok(terse.terseness.sample > 0.5, 'short msgs -> high terseness sample');
  assert.ok(verbose.terseness.sample < 0.5, 'long msgs -> low terseness sample');

  // And the sample, folded by the REAL merge, moves the axis EMA in-direction.
  const p0 = makeProfile();
  const up = applyDelta(p0, { style: { terseness: { sample: terse.terseness.sample, weight: terse.terseness.weight } } });
  assert.ok(up.global.style.terseness.ema > 0.5, 'merge moves terseness EMA up');
});

test('P2.1 emoji rate -> emoji_use and formality markers -> formality move in-direction', () => {
  const heavy = deriveStyle({ emoji_per_msg: 3, formality_markers: 1 });
  const none = deriveStyle({ emoji_per_msg: 0, formality_markers: 0 });
  assert.ok(heavy.emoji_use.sample > none.emoji_use.sample, 'more emoji -> higher emoji_use');
  assert.ok(heavy.formality.sample > none.formality.sample, 'more markers -> higher formality');
});

test('P2.1 code_block_ratio is a real input: it monotonically nudges the formality sample', () => {
  // FIX 1: code_block_ratio was a documented input (JSDoc + SAMPLE_INPUT) with
  // ZERO effect — never read into any axis. It now blends into formality
  // (code-heavy sessions skew slightly formal), with formality_markers as the
  // PRIMARY signal and code_block_ratio a bounded nudge. Two sessions with
  // IDENTICAL formality_markers but different code_block_ratio must differ, and
  // the difference must be monotone-increasing in code_block_ratio.
  const lowCode = deriveStyle({ formality_markers: 0.5, code_block_ratio: 0.0 });
  const midCode = deriveStyle({ formality_markers: 0.5, code_block_ratio: 0.5 });
  const highCode = deriveStyle({ formality_markers: 0.5, code_block_ratio: 1.0 });
  assert.ok(midCode.formality.sample > lowCode.formality.sample, 'more code -> higher formality (vs none)');
  assert.ok(highCode.formality.sample > midCode.formality.sample, 'monotone increasing in code_block_ratio');
  // formality_markers stays PRIMARY: a marker swing must dominate a code swing.
  const lowMarkHighCode = deriveStyle({ formality_markers: 0.1, code_block_ratio: 1.0 });
  const highMarkLowCode = deriveStyle({ formality_markers: 0.9, code_block_ratio: 0.0 });
  assert.ok(highMarkLowCode.formality.sample > lowMarkHighCode.formality.sample, 'markers dominate code (primary signal)');
  // All samples remain clamped to [0,1].
  for (const s of [lowCode, midCode, highCode, lowMarkHighCode, highMarkLowCode]) {
    assert.ok(s.formality.sample >= 0 && s.formality.sample <= 1, 'formality sample clamped [0,1]');
  }
  // The axis counts as OBSERVED when code_block_ratio is present even with no markers.
  const codeOnly = deriveStyle({ code_block_ratio: 0.8 });
  assert.ok(codeOnly.formality.weight > 0.1, 'code_block_ratio alone marks formality observed (full weight)');
});

test('P2.1 cold-start axes are flagged UNCONFIRMED until >=5 sessions of evidence', () => {
  // styleAxisConfirmed reads a merged profile axis (Beta evidence_count).
  const p = makeProfile(); // fresh: every axis evidence_count = 0
  for (const axis of STYLE_AXES) {
    assert.equal(styleAxisConfirmed(p.global.style[axis]), false, `${axis} cold-start unconfirmed`);
  }
  // Fold 5 sessions of terseness observations through the real merge.
  let q = p;
  for (let i = 0; i < 5; i += 1) {
    q = applyDelta(q, { style: { terseness: { sample: 0.9, weight: 1 } } });
  }
  assert.equal(styleAxisConfirmed(q.global.style.terseness), true, 'terseness confirmed at >=5 sessions');
  assert.equal(styleAxisConfirmed(q.global.style.formality), false, 'untouched axis still unconfirmed');
});

// ---------------------------------------------------------------------------
// P2.2 — Wilson-score expertise.
// deriveExpertise emits raw `{domain:{accepts,n}}` counts — the shape
// merge.js `mergeExpertise` accumulates + recomputes wilsonLowerBound over.
// Per-outcome semantics: accept=strong positive, edit-after=negative,
// discard=neutral (excluded from n). expertiseBand classifies a MERGED
// Wilson LB, requiring N>=5 before naming a band.
// ---------------------------------------------------------------------------

test('P2.2 deriveExpertise emits {domain:{accepts,n}} counts the merge consumes', () => {
  const exp = deriveExpertise([
    { domain: 'rust', outcome: 'accept' },
    { domain: 'rust', outcome: 'accept' },
    { domain: 'rust', outcome: 'edit-after' }, // negative -> counts in n, not accepts
    { domain: 'rust', outcome: 'discard' },     // neutral -> excluded from n entirely
  ]);
  assert.deepEqual(exp.rust, { accepts: 2, n: 3 }, 'accept=+,edit=−(in n),discard=neutral(out)');
  // Fold through the REAL merge; Wilson LB is recomputed there.
  const merged = applyDelta(makeProfile(), { expertise: exp });
  assert.equal(merged.expertise.rust.accepts, 2);
  assert.equal(merged.expertise.rust.n, 3);
  assert.equal(merged.expertise.rust.wilsonLB, wilsonLowerBound(2, 3), 'merge recomputes Wilson');
});

test('P2.2 8/10 accepts -> Expert band; N<5 -> unknown', () => {
  const records = [];
  for (let i = 0; i < 8; i += 1) records.push({ domain: 'ts', outcome: 'accept' });
  for (let i = 0; i < 2; i += 1) records.push({ domain: 'ts', outcome: 'edit-after' });
  const exp = deriveExpertise(records);
  assert.deepEqual(exp.ts, { accepts: 8, n: 10 });
  const merged = applyDelta(makeProfile(), { expertise: exp });
  assert.equal(expertiseBand(merged.expertise.ts), 'expert', '8/10 -> expert band');

  // Below the N>=5 floor: band is "unknown" no matter how high the ratio.
  const thin = deriveExpertise([
    { domain: 'go', outcome: 'accept' },
    { domain: 'go', outcome: 'accept' },
  ]);
  const mergedThin = applyDelta(makeProfile(), { expertise: thin });
  assert.equal(expertiseBand(mergedThin.expertise.go), 'unknown', 'N<5 -> unknown');
});

test('P2.2 only the spec outcomes count toward n; unknown kinds are excluded (no silent corruption)', () => {
  // FIX 2: the P2.2 spec (design-v2 §4) defines exactly THREE authorship
  // outcomes — accept / edit-after / discard. No repo source emits authorship
  // outcomes yet (deriveExpertise has no caller; feedback-detector emits the
  // SEPARATE preference vocabulary correction/confirmation/preference/rule).
  // So `reject` and the `edit_after`/`edit` aliases had no spec basis and no
  // emitter — they were removed. An UNKNOWN outcome must be excluded from n.
  const exp = deriveExpertise([
    { domain: 'py', outcome: 'accept' },      // +1 accept, +1 n
    { domain: 'py', outcome: 'edit-after' },  // +1 n (spec negative)
    { domain: 'py', outcome: 'discard' },     // neutral -> excluded from n
    { domain: 'py', outcome: 'reject' },      // NOT a spec outcome -> excluded from n
    { domain: 'py', outcome: 'edit_after' },  // undocumented alias -> excluded
    { domain: 'py', outcome: 'edit' },        // undocumented alias -> excluded
    { domain: 'py', outcome: 'banana' },      // garbage -> excluded
  ]);
  assert.deepEqual(exp.py, { accepts: 1, n: 2 }, 'only accept + edit-after count; unknowns excluded');
});

test('P2.3 the authorship outcome vocabulary is distinct from the feedback-kind vocabulary', () => {
  // FIX 2 corroboration: feedback-detector emits {correction,confirmation,
  // preference,rule} as preference KINDS — NOT as authorship outcomes. Passing
  // a feedback KIND where an authorship OUTCOME is expected must be a no-op
  // (excluded from n), proving the two vocabularies don't silently cross-wire.
  const exp = deriveExpertise([
    { domain: 'x', outcome: 'correction' },
    { domain: 'x', outcome: 'confirmation' },
    { domain: 'x', outcome: 'preference' },
    { domain: 'x', outcome: 'rule' },
  ]);
  assert.deepEqual(exp, {}, 'feedback kinds are not authorship outcomes -> no expertise emitted');
});

test('P2.2 expertise band boundary: Wilson LB just below 0.45 -> proficient, just above -> expert', () => {
  // FIX 3: the 0.45 expert cut is a named constant (EXPERT_WILSON_THRESHOLD).
  // Reference: 8/10 accepts -> Wilson LB ~0.49 -> expert. We bracket the cut by
  // searching {accepts/n} grids for a merged record whose recomputed Wilson LB
  // straddles 0.45, then assert the band flips exactly at the threshold.
  const grids = [];
  for (let n = 5; n <= 40; n += 1) {
    for (let a = 0; a <= n; a += 1) grids.push({ accepts: a, n });
  }
  const lbOf = (g) => applyDelta(makeProfile(), { expertise: { d: g } }).expertise.d.wilsonLB;
  // Just BELOW 0.45 (and at/above the proficient cut 0.25) -> 'proficient'.
  const below = grids
    .map((g) => ({ g, lb: lbOf(g) }))
    .filter((x) => x.lb >= 0.25 && x.lb < 0.45)
    .sort((p, q) => q.lb - p.lb)[0]; // closest below the cut
  assert.ok(below && below.lb < 0.45 && below.lb >= 0.25, 'found a record with LB just below 0.45');
  const mergedBelow = applyDelta(makeProfile(), { expertise: { d: below.g } });
  assert.equal(expertiseBand(mergedBelow.expertise.d), 'proficient', `LB ${below.lb.toFixed(4)} (<0.45) -> proficient`);
  // Just ABOVE 0.45 -> 'expert'.
  const above = grids
    .map((g) => ({ g, lb: lbOf(g) }))
    .filter((x) => x.lb >= 0.45)
    .sort((p, q) => p.lb - q.lb)[0]; // closest above the cut
  assert.ok(above && above.lb >= 0.45, 'found a record with LB just above 0.45');
  const mergedAbove = applyDelta(makeProfile(), { expertise: { d: above.g } });
  assert.equal(expertiseBand(mergedAbove.expertise.d), 'expert', `LB ${above.lb.toFixed(4)} (>=0.45) -> expert`);
  // Exact-threshold guard via the local classifier (synthetic wilsonLB record).
  assert.equal(expertiseBand({ accepts: 0, n: 5, wilsonLB: 0.45 }), 'expert', 'LB == 0.45 is inclusive -> expert');
  assert.equal(expertiseBand({ accepts: 0, n: 5, wilsonLB: 0.4499 }), 'proficient', 'LB just under 0.45 -> proficient');
  assert.equal(expertiseBand({ accepts: 0, n: 5, wilsonLB: 0.25 }), 'proficient', 'LB == 0.25 is inclusive -> proficient');
  assert.equal(expertiseBand({ accepts: 0, n: 5, wilsonLB: 0.2499 }), 'novice', 'LB just under 0.25 -> novice');
});

// ---------------------------------------------------------------------------
// P2.3 — Preference tags from .session-feedback.jsonl records.
// Schema (verified vs src/feedback-detector.js): { ts, kind, phrase, context }
// with kind ∈ {correction, confirmation, preference, rule}. Each record maps
// to a preference Inference (schema.makeInference shape) the merge dedupes by
// id and evidence-accumulates. `correction` carries the strongest confidence.
// ---------------------------------------------------------------------------

test('P2.3 derivePreferences maps feedback kinds -> preference Inferences (correction strongest)', () => {
  const records = [
    { ts: '2026-06-01T10:00:00.000Z', kind: 'correction', phrase: "don't add comments", context: '...' },
    { ts: '2026-06-01T10:05:00.000Z', kind: 'preference', phrase: 'I prefer tabs', context: '...' },
    { ts: '2026-06-01T10:06:00.000Z', kind: 'confirmation', phrase: 'perfect', context: '...' },
    { ts: '2026-06-01T10:07:00.000Z', kind: 'rule', phrase: 'every time run tests', context: '...' },
  ];
  const infs = derivePreferences(records, { sessionId: 's1', host: 'claude' });
  assert.equal(infs.length, 4, 'one inference per feedback record');
  for (const inf of infs) {
    assert.equal(inf.kind, 'preference', 'tagged as preference kind');
    assert.ok(typeof inf.subject === 'string' && inf.subject.length, 'has subject');
    assert.equal(inf.id, inferenceId('preference', inf.subject), 'id is deterministic');
    assert.ok(inf.confidence > 0 && inf.confidence <= 1, 'confidence in (0,1]');
    assert.equal(inf.evidence_count, 1, 'one observation each');
    assert.deepEqual(inf.source_sessions, ['s1']);
    assert.deepEqual(inf.source_hosts, ['claude']);
    assert.ok(Date.parse(inf.last_confirmed) > 0, 'last_confirmed threaded from record ts');
  }
  const byKind = (k) => infs.find((i) => i.value && i.value.kind === k);
  // correction is the strongest signal (design-v2 §5).
  assert.ok(byKind('correction').confidence > byKind('preference').confidence, 'correction > preference');
  assert.ok(byKind('preference').confidence > byKind('confirmation').confidence, 'preference > confirmation');
  assert.ok(byKind('correction').confidence >= byKind('rule').confidence, 'correction strongest overall');
});

test('P2.3 preference inferences merge cleanly + evidence-accumulate across sessions', () => {
  const r1 = derivePreferences(
    [{ ts: '2026-06-01T00:00:00.000Z', kind: 'correction', phrase: "don't add comments", context: '' }],
    { sessionId: 's1', host: 'claude' },
  );
  const r2 = derivePreferences(
    [{ ts: '2026-06-05T00:00:00.000Z', kind: 'correction', phrase: "don't add comments", context: '' }],
    { sessionId: 's2', host: 'cursor' },
  );
  let p = applyDelta(makeProfile(), { inferences: r1 });
  p = applyDelta(p, { inferences: r2 });
  assert.equal(p.global.dialectic.length, 1, 'same phrase -> deduped to one atom');
  const inf = p.global.dialectic[0];
  assert.equal(inf.evidence_count, 2, 'evidence summed across two sessions');
  assert.deepEqual([...inf.source_sessions].sort(), ['s1', 's2']);
  assert.deepEqual([...inf.source_hosts].sort(), ['claude', 'cursor']);
  assert.equal(inf.last_confirmed, '2026-06-05T00:00:00.000Z', 'most-recent confirmation wins');
});

test('P2.3 unknown/garbage kinds are ignored; empty input -> []', () => {
  assert.deepEqual(derivePreferences([]), []);
  assert.deepEqual(derivePreferences(null), []);
  const infs = derivePreferences([
    { ts: '2026-06-01T00:00:00.000Z', kind: 'banana', phrase: 'x', context: '' },
    { ts: '2026-06-01T00:00:00.000Z', kind: 'correction', phrase: '', context: '' }, // empty phrase -> skip
  ]);
  assert.equal(infs.length, 0, 'unknown kind + empty phrase both dropped');
});

// ---------------------------------------------------------------------------
// DEFECT 3 — REAL detector rows carry the preference CONTENT in `context`,
// while `phrase` is the matched TRIGGER TOKEN only ("No,", "always use",
// "I prefer"). derivePreferences must key the inference subject on the
// preference OBJECT ("use tabs not spaces"), NOT on the trigger word.
//
// This drives the row through the REAL shipped feedback-detector — the exact
// wire shape `.session-feedback.jsonl` carries in live usage — so the test
// fails if the profile side ever regresses to slugging the trigger token.
//
// CRITICAL-2 invariants kept: slug-only value (no verbatim user text), no
// special-category / direct-PII survival, single session stays at
// evidence_count 1 (below the brief-surfacing floor).
// ---------------------------------------------------------------------------

test('DEFECT3 a REAL detector row keys the subject on the preference CONTENT, not the trigger token', () => {
  // The literal message a user types. The REAL detector sets phrase=trigger,
  // context=fuller message — this is the live wire contract, not a hand-authored row.
  const message = 'No, use tabs not spaces in src/list.js when you indent the paginate function.';
  const [hit] = detectFeedback(message);
  assert.ok(hit, 'the real detector fires on the correction message');
  assert.equal(hit.kind, 'correction');
  // Pin the defect's precondition: phrase is the trigger token, NOT the content.
  assert.equal(hit.phrase, 'No,', 'detector phrase is the trigger token only (live contract)');
  assert.match(hit.context, /use tabs not spaces/i, 'the content lives in context');

  const row = { ts: '2026-06-07T10:00:00.000Z', kind: hit.kind, phrase: hit.phrase, context: hit.context };
  const [inf] = derivePreferences([row], { sessionId: 's1', host: 'claude' });
  assert.ok(inf, 'one preference minted from the real detector row');

  // The headline guarantee: the subject reflects the PREFERENCE OBJECT.
  assert.match(inf.subject, /tabs/, 'subject carries the preference content ("tabs")');
  assert.match(inf.subject, /use tabs not spaces/, 'subject is the preference object, not the trigger');
  // The trigger word must NOT be the subject (the pre-fix behaviour slugged "no").
  assert.notEqual(inf.subject, 'no', 'subject is NOT the bare trigger token');
  assert.ok(!/^no\b/.test(inf.subject), 'subject does not lead with the trigger token');

  // CRITICAL-2 (slug-only): no verbatim user text in the serialized inference;
  // value carries the structured kind only — never a `phrase`/raw-text field.
  const serialized = JSON.stringify(inf);
  assert.ok(!serialized.includes(message), 'verbatim message must not survive into the inference');
  assert.deepEqual(inf.value, { kind: 'correction' }, 'value is slug-only (structured kind, no raw text)');
  // CRITICAL-2 (corroboration): a single session stays at evidence_count 1,
  // below the brief-surfacing floor.
  assert.equal(inf.evidence_count, 1, 'single session => evidence_count 1 (below brief floor)');
});

test('DEFECT3 a mid-message preference trigger still yields a content-keyed subject', () => {
  // "always use" fires mid-message; the content follows the trigger. The subject
  // must still carry the preference object, not the trigger or the lead-in fluff.
  const message = 'Going forward, always use tabs not spaces for indentation in this repo.';
  const [hit] = detectFeedback(message);
  assert.ok(hit && hit.kind === 'preference');
  assert.equal(hit.phrase, 'always use', 'trigger token (mid-message)');
  const [inf] = derivePreferences(
    [{ ts: '2026-06-07T10:05:00.000Z', kind: hit.kind, phrase: hit.phrase, context: hit.context }],
    { sessionId: 's2', host: 'cursor' },
  );
  assert.ok(inf, 'preference minted');
  assert.match(inf.subject, /tabs not spaces/, 'subject carries the preference object after the trigger');
  assert.ok(!inf.subject.includes('always use'), 'the trigger token is stripped from the subject');
});

test('DEFECT3 content extraction does NOT regress the phrase-only wire shape (empty context)', () => {
  // The existing PII/integration tests author content in `phrase` with an empty
  // `context`. The fix must keep slugging `phrase` in that case — a pure
  // backward-compatibility pin so no existing consumer/test breaks.
  const [inf] = derivePreferences(
    [{ ts: '2026-06-07T10:10:00.000Z', kind: 'correction', phrase: 'use tabs not spaces', context: '' }],
    { sessionId: 's3', host: 'claude' },
  );
  assert.ok(inf, 'phrase-only row still mints');
  assert.match(inf.subject, /use tabs not spaces/, 'phrase content is preserved when context is empty');
});

// ---------------------------------------------------------------------------
// P2.4 — Emit a single ProfileDelta. The top-level entry point composes
// style + expertise + preferences into one delta `applyDelta` consumes. Pure,
// deterministic, ZERO network/LLM/child_process.
// ---------------------------------------------------------------------------

const SAMPLE_INPUT = {
  metadata: {
    avg_msg_chars: 30, emoji_per_msg: 2, code_block_ratio: 0.3,
    formality_markers: 0.2, turn_cadence_per_min: 8,
  },
  outcomes: [
    { domain: 'rust', outcome: 'accept' },
    { domain: 'rust', outcome: 'accept' },
    { domain: 'rust', outcome: 'edit-after' },
  ],
  feedback: [
    { ts: '2026-06-01T00:00:00.000Z', kind: 'correction', phrase: "don't add comments", context: '' },
  ],
  sessionId: 's1',
  host: 'claude',
};

test('P2.4 deriveHeuristic emits a single ProfileDelta in the exact shape applyDelta reads', () => {
  const delta = deriveHeuristic(SAMPLE_INPUT);
  // style: { axis: { sample, weight } }
  assert.ok(delta.style && typeof delta.style === 'object');
  for (const axis of STYLE_AXES) {
    assert.ok('sample' in delta.style[axis] && 'weight' in delta.style[axis], `style.${axis} obs shape`);
  }
  // expertise: { domain: { accepts, n } }
  assert.deepEqual(delta.expertise.rust, { accepts: 2, n: 3 });
  // inferences: Inference[]
  assert.ok(Array.isArray(delta.inferences) && delta.inferences.length === 1);
  assert.equal(delta.inferences[0].kind, 'preference');
  // provenance carries a content-derived recency stamp (no wall clock)
  assert.ok(delta.provenance && typeof delta.provenance.updated === 'string');

  // The whole delta folds through the REAL merge without error and lands data.
  const merged = applyDelta(makeProfile(), delta);
  assert.ok(merged.global.style.terseness.evidence_count >= 1, 'style landed');
  assert.equal(merged.expertise.rust.n, 3, 'expertise landed');
  assert.equal(merged.global.dialectic.length, 1, 'preference landed');
});

test('P2.4 deriveHeuristic is PURE + DETERMINISTIC (same input -> deep-equal delta)', () => {
  const a = deriveHeuristic(SAMPLE_INPUT);
  const b = deriveHeuristic(SAMPLE_INPUT);
  assert.deepEqual(a, b, 'deterministic — no clocks, no randomness');
  // input not mutated
  assert.equal(SAMPLE_INPUT.outcomes.length, 3);
  // empty input -> a well-formed, empty-ish delta that no-ops cleanly
  const empty = deriveHeuristic({});
  const before = makeProfile();
  const after = applyDelta(before, empty);
  assert.equal(after.global.dialectic.length, 0, 'empty input -> no inferences');
  assert.deepEqual(Object.keys(after.expertise), [], 'empty input -> no expertise');
});

test('P2.4 the derive module imports NO network/LLM/child_process surface (zero-LLM moat at source)', () => {
  const src = readFileSync(MODULE_PATH, 'utf8');
  // No import of forbidden modules. FIX 4: this is the INTERIM module-local
  // source-scan guard; the full import-GRAPH guard (transitive) lands in P4.5.
  // Catch BOTH the `node:`-prefixed AND the bare specifiers — Node resolves
  // `'http'`/`'https'`/`'net'`/`'tls'`/`'dgram'` to the same core modules — and
  // cover the additional raw-socket modules (net/tls/dgram) the original scan
  // missed entirely.
  const NET_MODULES = ['http', 'https', 'net', 'tls', 'dgram'];
  const forbidden = [
    ...NET_MODULES.flatMap((mod) => [
      new RegExp(`from\\s+['"]node:${mod}['"]`),   // node:http
      new RegExp(`from\\s+['"]${mod}['"]`),         // bare http
    ]),
    /from\s+['"]node:child_process['"]/,
    /from\s+['"][^'"]*child_process['"]/,
    /from\s+['"][^'"]*tiered-llm[^'"]*['"]/,
    /from\s+['"][^'"]*\bllm\b[^'"]*['"]/,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(src), `module must not import ${re}`);
  }
  // No direct network/exec calls.
  assert.ok(!/\bfetch\s*\(/.test(src), 'no fetch( call');
  assert.ok(!/\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\(/.test(src), 'no child_process exec');
  assert.ok(!/\brequire\s*\(/.test(src), 'no dynamic require (ESM, no escape hatch)');
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic import (no deferred network/LLM load)');
});
