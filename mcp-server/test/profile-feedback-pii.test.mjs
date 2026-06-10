// FIX 4 (CRITICAL-2) — the feedback path must NOT leak verbatim PII into the
// global (exfiltrable) profile, and a SINGLE feedback row must not mint a
// brief-surfacing preference.
//
// Before the fix, derivePreferences minted a `med`-sensitivity inference whose
// `value` carried the VERBATIM feedback phrase (PII -> into the global store), at
// confidence up to 0.7 from ONE row with no corroboration.
//
// After the fix:
//   (a) the inference value carries the SLUG only — no verbatim user text;
//   (b) a special-category / direct-PII phrase is REFUSED before minting;
//   (c) a single session's feedback preference stays BELOW the brief-surfacing
//       floor — the real corroboration barrier is evidence_count >= 3 (the brief
//       keeps that gate even as the parallel-change lowers the confidence floor),
//       so a single-session row (evidence_count 1) cannot reach the brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { derivePreferences } from '../src/profile/derive-heuristic.js';
import { applyDelta } from '../src/profile/merge.js';
import { makeProfile } from '../src/profile/schema.js';
import { renderBrief, BRIEF_MIN_EVIDENCE } from '../src/profile/render-brief.js';

// The brief surfacing gate the dialectic corroboration must clear.
const BRIEF_EVIDENCE_FLOOR = BRIEF_MIN_EVIDENCE; // == 3 (kept even as confidence floor drops)

// TEST-ISOLATION: renderBrief reads the sensitivity files (redact.txt /
// share-hosts.txt) from profileDir(). With no override under the test runner the
// store now THROWS (fail-closed default) rather than touching the user's real
// ~/.ijfw/profile, so any test that reaches the store MUST point the global
// profile + state dirs at per-case temp dirs. Mirrors profile-e2e's withFixtures.
function withTmpProfile(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-pii-profile-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-pii-state-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  try {
    return fn();
  } finally {
    if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
    if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  }
}

test('FIX4: a normal feedback phrase yields a slug-only inference — serialized value has NO verbatim user text', () => {
  const phrase = 'Please ALWAYS use tabs not spaces in my Rust code';
  const out = derivePreferences([{ ts: '2026-06-02T00:00:00.000Z', kind: 'correction', phrase, context: '' }],
    { sessionId: 's1', host: 'claude' });
  assert.equal(out.length, 1, 'one preference minted from the correction');
  const inf = out[0];
  // The verbatim phrase must not appear anywhere in the serialized inference —
  // not in value, not in subject-as-typed. The slug is lowercased/normalized, so
  // the ORIGINAL casing/words-as-typed must be absent.
  const serialized = JSON.stringify(inf);
  assert.ok(!serialized.includes(phrase),
    'the exact verbatim phrase must not be embedded anywhere in the inference');
  assert.ok(!serialized.includes('ALWAYS'),
    'original-cased user text must not survive into the inference value');
  // value must NOT carry a `phrase` field with the raw text.
  if (inf.value && typeof inf.value === 'object') {
    assert.ok(!('phrase' in inf.value) || !String(inf.value.phrase).includes('tabs not spaces'),
      'value.phrase must not carry the verbatim feedback text');
  }
  // The slug subject is still present so dedupe/merge works.
  assert.ok(/tabs/.test(inf.subject), 'the slugged subject is retained for dedupe');
});

test('FIX4: a feedback correction containing a SPECIAL-CATEGORY phrase is REFUSED (not minted)', () => {
  const cases = [
    'my religion is important to how I name variables',
    'I have a health condition that affects my schedule',
    'because of my political affiliation, avoid that wording',
  ];
  for (const phrase of cases) {
    const out = derivePreferences([{ ts: '2026-06-02T00:00:00.000Z', kind: 'correction', phrase, context: '' }],
      { sessionId: 's1', host: 'claude' });
    assert.equal(out.length, 0, `special-category phrase must be refused: ${JSON.stringify(phrase)}`);
  }
});

test('FIX4: a feedback phrase carrying direct PII (email/phone) does NOT surface that PII verbatim', () => {
  const phrase = 'email me at alice.smith@example.com or call 415-555-0199';
  const out = derivePreferences([{ ts: '2026-06-02T00:00:00.000Z', kind: 'preference', phrase, context: '' }],
    { sessionId: 's1', host: 'claude' });
  // Either refused outright OR scrubbed — but NEVER surfacing the raw identifiers.
  const serialized = JSON.stringify(out);
  assert.ok(!/alice\.smith@example\.com/.test(serialized), 'email must not survive into the inference');
  assert.ok(!/415-555-0199/.test(serialized), 'phone number must not survive into the inference');
});

test('FIX4: a SINGLE-session feedback preference does NOT reach the brief-surfacing floor', () => {
  withTmpProfile(() => {
    const out = derivePreferences([{ ts: '2026-06-02T00:00:00.000Z', kind: 'correction',
      phrase: 'prefer functional style', context: '' }], { sessionId: 's1', host: 'claude' });
    assert.equal(out.length, 1);
    let p = makeProfile();
    p = applyDelta(p, { inferences: out });
    const inf = p.global.dialectic[0];
    assert.ok((Number(inf.evidence_count) || 0) < BRIEF_EVIDENCE_FLOOR,
      `a single session must stay below the brief evidence floor (${BRIEF_EVIDENCE_FLOOR})`);
    // And it is therefore NOT surfaced by the brief (the real corroboration gate
    // is evidence_count >= 3, which a single session cannot reach).
    const brief = renderBrief(p, { env: {}, shareSensitive: true });
    assert.ok(!brief.fields.some((f) => /functional/.test(String(f))),
      'a single-session preference is not surfaced in the brief fields');
    assert.ok(!/functional/.test(brief.text || ''),
      'a single-session preference is not surfaced in the brief text');
  });
});

test('FIX4: TWO distinct sessions reporting the SAME preference DO clear the corroboration floor', () => {
  const s1 = derivePreferences([{ ts: '2026-06-02T00:00:00.000Z', kind: 'correction',
    phrase: 'prefer functional style', context: '' }], { sessionId: 's1', host: 'claude' });
  const s2 = derivePreferences([{ ts: '2026-06-03T00:00:00.000Z', kind: 'correction',
    phrase: 'prefer functional style', context: '' }], { sessionId: 's2', host: 'cursor' });
  const s3 = derivePreferences([{ ts: '2026-06-04T00:00:00.000Z', kind: 'correction',
    phrase: 'prefer functional style', context: '' }], { sessionId: 's3', host: 'claude' });

  let p = makeProfile();
  p = applyDelta(p, { inferences: s1 });
  p = applyDelta(p, { inferences: s2 });
  p = applyDelta(p, { inferences: s3 });
  // Same subject -> deduped to one atom, evidence_count accumulated across sessions.
  assert.equal(p.global.dialectic.length, 1, 'same preference deduped across sessions');
  const inf = p.global.dialectic[0];
  assert.ok((Number(inf.evidence_count) || 0) >= BRIEF_EVIDENCE_FLOOR,
    'cross-session corroboration accumulates evidence to/over the brief floor');
});
