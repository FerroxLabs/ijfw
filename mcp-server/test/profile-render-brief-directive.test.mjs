// Push v2 — DIRECTIVE rendering mode for renderBrief (opt-in).
//
// CHANGE 1 hypothesis: phrasing the SAME gated/derived profile content as
// ACTIONABLE GUIDANCE ("prefer concise responses") instead of OBSERVATION
// ("terseness: terse") may move host behaviour where the descriptive default
// does not. This suite proves:
//   - the DEFAULT stays descriptive (the deliberate anti-over-personalization
//     choice) — directive must be strictly opt-in;
//   - directive uses imperative verbs and an action-oriented header;
//   - directive applies the SAME inclusion floors + sensitivity gating as
//     descriptive (same fields, same redaction, no leakage of med/high);
//   - directive is byte-for-byte derived from the same content (it asserts no
//     new fact the descriptive brief didn't already carry).
//
// Isolation: a fresh IJFW_PROFILE_DIR per test (no real homedir writes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta } from '../src/profile/merge.js';
import { renderBrief } from '../src/profile/render-brief.js';

async function withProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-directive-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  const prevShare = process.env.IJFW_PROFILE_SHARE_SENSITIVE;
  const prevRedact = process.env.IJFW_PROFILE_REDACT;
  const prevKill = process.env.IJFW_PROFILE_KILL;
  process.env.IJFW_PROFILE_DIR = dir;
  delete process.env.IJFW_PROFILE_SHARE_SENSITIVE;
  delete process.env.IJFW_PROFILE_REDACT;
  delete process.env.IJFW_PROFILE_KILL;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prev;
    if (prevShare === undefined) delete process.env.IJFW_PROFILE_SHARE_SENSITIVE; else process.env.IJFW_PROFILE_SHARE_SENSITIVE = prevShare;
    if (prevRedact === undefined) delete process.env.IJFW_PROFILE_REDACT; else process.env.IJFW_PROFILE_REDACT = prevRedact;
    if (prevKill === undefined) delete process.env.IJFW_PROFILE_KILL; else process.env.IJFW_PROFILE_KILL = prevKill;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A confirmed style axis (>=5 sessions of evidence). */
function confirmedAxis(ema) {
  return { ema, alpha: 6, beta: 2, evidence_count: 6 };
}

test('directive: DEFAULT mode is descriptive (opt-in only) — no opts.style', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.05); // very expansive
  const { text } = renderBrief(p, { env: {} });
  // Descriptive default: observation wording + non-directive header.
  assert.match(text, /observed patterns — informative, not directive/);
  assert.match(text, /terseness: expansive/);
  assert.doesNotMatch(text, /prefer expansive/);
}));

test('directive: explicit descriptive == default (back-compat)', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.05);
  const a = renderBrief(p, { env: {} }).text;
  const b = renderBrief(p, { env: {}, style: 'descriptive' }).text;
  assert.equal(a, b, 'style:"descriptive" must equal the default render exactly');
}));

test('directive: style axis phrased as actionable guidance', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.05);  // expansive
  p.global.style.formality = confirmedAxis(0.9);   // formal
  p.global.style.emoji_use = confirmedAxis(0.9);   // frequent
  const { text, fields } = renderBrief(p, { env: {}, style: 'directive' });
  // Action header, not the "observed patterns" header.
  assert.match(text, /derived guidance — adapt your responses to fit/);
  assert.doesNotMatch(text, /informative, not directive/);
  // Imperative phrasing of the same derived bands.
  assert.match(text, /prefer expansive, detailed responses/);
  assert.match(text, /prefer a formal, precise tone/);
  assert.match(text, /emoji are welcome/);
  // SAME fields emitted as descriptive (gating unchanged).
  assert.ok(fields.includes('style:terseness'));
  assert.ok(fields.includes('style:formality'));
  assert.ok(fields.includes('style:emoji_use'));
}));

test('directive: terse band emits a "concise" imperative', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.95); // terse
  const { text } = renderBrief(p, { env: {}, style: 'directive' });
  assert.match(text, /prefer concise, terse responses/);
}));

test('directive: preference inference phrased as a "honor this" directive', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [makeInference({
      kind: 'preference', subject: 'x', value: { phrase: 'concise replies' },
      confidence: 0.9, evidence_count: 5, sensitivity: 'low',
    })],
  });
  const { text } = renderBrief(p, { env: {}, style: 'directive' });
  assert.match(text, /Honor this preference: concise replies/);
  assert.doesNotMatch(text, /Observed preference/);
}));

test('directive: dialectic-capped trait stays SOFT (no hard command)', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [makeInference({
      kind: 'dialectic', subject: 'y', value: { phrase: 'values rigorous proofs' },
      confidence: 0.5, evidence_count: 4, sensitivity: 'low',
    })],
  });
  const { text } = renderBrief(p, { env: {}, style: 'directive' });
  // Soft directive ("where it fits"), never an imperative assertion of a derived belief.
  assert.match(text, /Where it fits, lean toward: values rigorous proofs/);
  assert.doesNotMatch(text, /Honor this preference: values rigorous proofs/);
}));

test('directive: SAME sensitivity gating — med/high still excluded by default', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'low', value: { phrase: 'low sens pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'med', value: { phrase: 'med sens pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'med' }),
      makeInference({ kind: 'dialectic', subject: 'high', value: { phrase: 'high sens belief' }, confidence: 0.9, evidence_count: 5, sensitivity: 'high' }),
    ],
  });
  const { text, fields } = renderBrief(p, { env: {}, style: 'directive' }); // no opt-in
  assert.match(text, /low sens pref/);
  assert.doesNotMatch(text, /med sens pref/);
  assert.doesNotMatch(text, /high sens belief/);
  assert.deepEqual(fields, ['preference::low']);
}));

test('directive: respects the kill-switch (empty brief, like descriptive)', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.05);
  process.env.IJFW_PROFILE_KILL = '1';
  const { text, fields } = renderBrief(p, { env: process.env, style: 'directive' });
  assert.equal(text, '');
  assert.deepEqual(fields, []);
}));

test('directive: cold-start (empty profile) yields an empty brief', () => withProfileDir(() => {
  const { text, fields } = renderBrief(makeProfile(), { env: {}, style: 'directive' });
  assert.equal(text, '');
  assert.deepEqual(fields, []);
}));
