// S5 — GATED PREFERENCE INJECTION (the personalization layer's admission gate).
//
// IJFW personalization is an EVIDENCE-ADMISSION system: nothing becomes "you"
// without clearing a high bar. This suite proves the S5 runtime gate that lets a
// corroborated preference slug INJECT into the flat rules-file snapshot ONLY when
// ALL of the following hold (fail-closed on every axis):
//
//   1. PRECISION-ELIGIBLE (S2)  — atom carries `precision_eligible === true`.
//   2. CONFIDENCE  > BRIEF_MIN_CONFIDENCE (0.45).
//   3. EVIDENCE    >= BRIEF_MIN_EVIDENCE (3) — the real corroboration barrier.
//   4. APPROVED (S3)            — id in injectEligibleIds(profile, registry):
//                                 registry state `approved` AND a citation locator.
//
// Until a slug clears ALL four it is STORED but NOT injected — this is exactly
// what sidesteps the 0.00-precision regression. The brief stays a SMALL,
// task-relevant packet (400-token budget), descriptive by default.
//
// We test BOTH layers we own: the pure gate (eligiblePreferenceSlugs +
// renderSnapshot in render-brief.js) AND the serve path (profileSnapshot in
// serve.js) which loads the approval registry from disk and threads it in.
//
// Isolation: a fresh IJFW_PROFILE_DIR per test; no real homedir writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProfile, makeInference } from '../src/profile/schema.js';
import {
  renderSnapshot,
  eligiblePreferenceSlugs,
  BRIEF_MIN_CONFIDENCE,
  BRIEF_MIN_EVIDENCE,
} from '../src/profile/render-brief.js';
import { profileSnapshot } from '../src/profile/serve.js';
import { writeProfile } from '../src/profile/store.js';
import { approvalsPath } from '../src/profile/audit.js';

async function withProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-s5-'));
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

/** A confirmed style axis (>=5 sessions of evidence) so the snapshot is non-empty. */
function confirmedAxis(ema) {
  return { ema, alpha: 6, beta: 2, evidence_count: 6 };
}

/**
 * A preference atom that clears the corroboration floors AND carries a citation
 * locator (source_sessions) so it CAN be approved (cite-or-drop). `precision`
 * stamps the S2 verdict; pass false/undefined to model a not-yet-cleared slug.
 */
function prefAtom(subject, phrase, over = {}) {
  const inf = makeInference({
    kind: 'preference',
    subject,
    value: { phrase },
    confidence: 0.9,
    evidence_count: 5,
    sensitivity: 'low',
    source_sessions: ['sA', 'sB', 'sC'], // citation locator -> approvable
    source_hosts: ['claude'],
  });
  // makeInference returns a fixed field set; stamp the forward-compatible S2
  // precision flag (and any overrides) AFTER minting.
  return { ...inf, precision_eligible: over.precision_eligible === true, ...over };
}

/** Build a profile whose global.dialectic is exactly the given atoms. */
function profileWith(atoms, style = 0.95) {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(style);
  p.global.dialectic = atoms;
  return p;
}

/** An approval registry approving the given ids (S3 control surface). */
function approve(...ids) {
  const reg = {};
  for (const id of ids) reg[id] = { state: 'approved', ts: new Date().toISOString() };
  return reg;
}

const ID = (subject) => `preference::${subject}`;

// ---------------------------------------------------------------------------
// 1) UN-APPROVED — corroborated + precision-eligible but NO approval => held back.
// ---------------------------------------------------------------------------
test('S5: an un-approved slug is NOT injected (even precision-eligible + corroborated)', () => withProfileDir(() => {
  const atom = prefAtom('tabs', 'use tabs not spaces', { precision_eligible: true });
  const p = profileWith([atom]);

  // No registry => injectEligibleIds is empty => nothing approved.
  const { text, fields } = renderSnapshot(p, { env: {}, includePreferences: true });
  assert.doesNotMatch(text, /use tabs not spaces/, 'un-approved preference must not appear');
  assert.ok(!fields.includes(ID('tabs')), 'un-approved id must not be in fields');
  // Style still surfaces — the snapshot is otherwise unchanged.
  assert.match(text, /style\.terseness:/);

  // And the pure gate agrees.
  assert.equal(eligiblePreferenceSlugs(p, { registry: null }).length, 0);
}));

// ---------------------------------------------------------------------------
// 2) PRECISION-INELIGIBLE — approved + corroborated but S2 flag absent => held back.
// ---------------------------------------------------------------------------
test('S5: a precision-INELIGIBLE slug is NOT injected (even approved + corroborated)', () => withProfileDir(() => {
  const atom = prefAtom('tabs', 'use tabs not spaces'); // precision_eligible defaults false
  const p = profileWith([atom]);
  const registry = approve(ID('tabs'));

  const { text, fields } = renderSnapshot(p, { env: {}, includePreferences: true, registry });
  assert.doesNotMatch(text, /use tabs not spaces/, 'precision-ineligible preference must not appear');
  assert.ok(!fields.includes(ID('tabs')));
  assert.equal(eligiblePreferenceSlugs(p, { registry }).length, 0);
}));

// ---------------------------------------------------------------------------
// 3) SUB-BAR — approved + precision-eligible but below the confidence / evidence
//    floor => held back. Two atoms: one thin-evidence, one low-confidence.
// ---------------------------------------------------------------------------
test('S5: sub-bar slugs (low confidence OR <3 evidence) are NOT injected', () => withProfileDir(() => {
  const thin = prefAtom('thin', 'thin evidence pref', {
    precision_eligible: true, evidence_count: BRIEF_MIN_EVIDENCE - 1, // 2 < 3
  });
  const weak = prefAtom('weak', 'weak confidence pref', {
    precision_eligible: true, confidence: BRIEF_MIN_CONFIDENCE, // == floor, not > floor
  });
  const p = profileWith([thin, weak]);
  const registry = approve(ID('thin'), ID('weak'));

  const { text, fields } = renderSnapshot(p, { env: {}, includePreferences: true, registry });
  assert.doesNotMatch(text, /thin evidence pref/, 'sub-evidence preference must not appear');
  assert.doesNotMatch(text, /weak confidence pref/, 'sub-confidence preference must not appear');
  assert.ok(!fields.includes(ID('thin')) && !fields.includes(ID('weak')));
  assert.equal(eligiblePreferenceSlugs(p, { registry }).length, 0);
}));

// ---------------------------------------------------------------------------
// 4) THE HAPPY PATH — approved + precision-eligible + corroborated => INJECTED.
// ---------------------------------------------------------------------------
test('S5: an approved + corroborated + precision-eligible slug IS injected', () => withProfileDir(() => {
  const atom = prefAtom('tabs', 'use tabs not spaces', { precision_eligible: true });
  const p = profileWith([atom]);
  const registry = approve(ID('tabs'));

  const { text, fields } = renderSnapshot(p, { env: {}, includePreferences: true, registry });
  assert.match(text, /preference\.tabs: use tabs not spaces/, 'a cleared slug must inject');
  assert.ok(fields.includes(ID('tabs')), 'the cleared id is recorded in fields (egress)');

  // Pure gate returns exactly the one cleared slug.
  const slugs = eligiblePreferenceSlugs(p, { registry });
  assert.equal(slugs.length, 1);
  assert.equal(slugs[0].id, ID('tabs'));

  // Default OFF: without the flag, no preference content even when cleared.
  const off = renderSnapshot(p, { env: {}, registry });
  assert.doesNotMatch(off.text, /use tabs not spaces/, 'includePreferences default is OFF');
}));

// ---------------------------------------------------------------------------
// 5) CITATION-LESS — approved in the registry but the atom has NO locator =>
//    injectEligibleIds withholds it (cite-or-drop). Proves the approval alone
//    is insufficient; grounding is required.
// ---------------------------------------------------------------------------
test('S5: an approved but CITATION-LESS slug is NOT injected (cite-or-drop)', () => withProfileDir(() => {
  const atom = prefAtom('tabs', 'use tabs not spaces', {
    precision_eligible: true, source_sessions: [], source_hosts: [], // no locator
  });
  const p = profileWith([atom]);
  const registry = approve(ID('tabs'));

  const { text } = renderSnapshot(p, { env: {}, includePreferences: true, registry });
  assert.doesNotMatch(text, /use tabs not spaces/, 'a citation-less atom can never inject');
  assert.equal(eligiblePreferenceSlugs(p, { registry }).length, 0);
}));

// ---------------------------------------------------------------------------
// 6) BUDGET — many cleared preferences truncate to the token budget; style still
//    leads, and the emitted set never exceeds the cap.
// ---------------------------------------------------------------------------
test('S5: the 400-token budget is respected (cleared prefs truncate, style preserved)', () => withProfileDir(() => {
  const atoms = [];
  const ids = [];
  for (let i = 0; i < 60; i += 1) {
    const subject = `pref-${i}`;
    atoms.push(prefAtom(subject, `preference number ${i} with a fair amount of descriptive standing text`, { precision_eligible: true }));
    ids.push(ID(subject));
  }
  const p = profileWith(atoms);
  const registry = approve(...ids);

  const budget = 120;
  const { text, fields } = renderSnapshot(p, { env: {}, includePreferences: true, registry, tokenBudget: budget });

  // Some but NOT all preferences fit; the style line still leads.
  assert.match(text, /style\.terseness:/, 'high-priority style line is kept');
  const emittedPrefs = fields.filter((f) => f.startsWith('preference::'));
  assert.ok(emittedPrefs.length > 0, 'at least one cleared preference is injected');
  assert.ok(emittedPrefs.length < ids.length, 'budget truncates the rest');

  // Hard budget bound: ~4 chars/token; the emitted text must not exceed it.
  assert.ok(Math.ceil(text.length / 4) <= budget + 5, `snapshot (${Math.ceil(text.length / 4)} tok) stays within budget (${budget})`);
}));

// ---------------------------------------------------------------------------
// 7) SERVE PATH — profileSnapshot loads the on-disk approval registry and applies
//    the SAME gate end to end. An approved+cleared slug surfaces; flipping the
//    registry to `rejected` withholds it.
// ---------------------------------------------------------------------------
test('S5 serve: profileSnapshot threads the on-disk approval registry through the gate', () => withProfileDir(() => {
  const atom = prefAtom('tabs', 'use tabs not spaces', { precision_eligible: true });
  const p = profileWith([atom]);
  const w = writeProfile(p);
  assert.ok(w.ok, JSON.stringify(w));

  // No approvals file yet => fail-closed => nothing injected.
  const cold = profileSnapshot({ env: {}, includePreferences: true, context: { host: 'claude', session: 's1' } });
  assert.ok(cold.ok);
  assert.doesNotMatch(cold.snapshot, /use tabs not spaces/, 'absent registry => fail-closed');

  // Approve on disk => the slug clears and surfaces.
  writeFileSync(approvalsPath(), `${JSON.stringify(approve(ID('tabs')), null, 2)}\n`, 'utf8');
  const hot = profileSnapshot({ env: {}, includePreferences: true, context: { host: 'claude', session: 's1' } });
  assert.ok(hot.ok);
  assert.match(hot.snapshot, /preference\.tabs: use tabs not spaces/, 'approved+cleared slug surfaces via serve');
  assert.ok(hot.fields.includes(ID('tabs')));
  assert.ok(hot.egress, 'an emitted preference is recorded in the egress ledger');

  // Reject on disk => withheld again.
  writeFileSync(approvalsPath(), `${JSON.stringify({ [ID('tabs')]: { state: 'rejected', ts: new Date().toISOString() } }, null, 2)}\n`, 'utf8');
  const rejected = profileSnapshot({ env: {}, includePreferences: true, context: { host: 'claude', session: 's1' } });
  assert.doesNotMatch(rejected.snapshot, /use tabs not spaces/, 'rejected slug is withheld');
}));

// ---------------------------------------------------------------------------
// 8) DIALECTIC GUARD — a dialectic BELIEF (not a preference) is never injected as
//    a preference slug even when approved + precision-eligible + corroborated.
// ---------------------------------------------------------------------------
test('S5: a dialectic belief is never injected as a preference slug', () => withProfileDir(() => {
  const belief = {
    ...makeInference({
      kind: 'dialectic', subject: 'risk', value: { phrase: 'is risk-averse' },
      confidence: 0.5, evidence_count: 5, sensitivity: 'low',
      source_sessions: ['sA', 'sB', 'sC'],
    }),
    precision_eligible: true,
  };
  const p = profileWith([belief]);
  const registry = approve('dialectic::risk');

  const { text } = renderSnapshot(p, { env: {}, includePreferences: true, registry });
  assert.doesNotMatch(text, /is risk-averse/, 'a dialectic belief is not an actionable preference');
  assert.equal(eligiblePreferenceSlugs(p, { registry }).length, 0);
}));
