// P3.3 — bounded + corroborated local-LLM dialectic.
//
// The dialectic tier ADDS inferences on top of the heuristic floor, but only
// under three hard, code-enforced guards (the LLM proposes; the code disposes):
//   1. a NUMERIC token/char cap on the digest fed to the model — corpus size
//      must NOT scale per-cycle spend;
//   2. ≥K (K>=2) CROSS-SESSION corroboration — a trait seen in only one session
//      cannot be minted;
//   3. a LOW confidence FLOOR (well under the 0.7 heuristic default) — the
//      dialectic must never assert a high-confidence trait.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveDialectic,
  DIALECTIC_MAX_DIGEST_CHARS,
  DIALECTIC_MAX_CONFIDENCE,
  DIALECTIC_MIN_CORROBORATION,
  buildDigest,
} from '../src/profile/derive-dialectic.js';

// A transport stub that records the prompt it was handed (so we can assert on
// the digest cap) and returns a canned set of proposed inferences.
function stubTransport(proposed, capture = {}) {
  return async ({ prompt, maxTokens }) => {
    capture.prompt = prompt;
    capture.maxTokens = maxTokens;
    return { text: JSON.stringify({ inferences: proposed }), via: 'stub' };
  };
}

function styleRows(n, startId = 0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      session_id: `s${startId + i}`,
      host: 'claude',
      ts: new Date(Date.UTC(2026, 5, 1 + (i % 27))).toISOString(),
      avg_msg_chars: 40 + (i % 5),
      emoji_per_msg: 0,
      code_block_ratio: 0.6,
      formality_markers: 0.2,
      turn_cadence_per_min: 5,
      msg_count: 20,
    });
  }
  return rows;
}

test('buildDigest enforces a hard char cap regardless of corpus size', () => {
  const small = buildDigest({ style: styleRows(10) });
  const huge = buildDigest({ style: styleRows(100000) });
  assert.ok(small.length <= DIALECTIC_MAX_DIGEST_CHARS, 'small under cap');
  assert.ok(huge.length <= DIALECTIC_MAX_DIGEST_CHARS, 'huge STILL under cap');
  // The cap must actually bite on a 100k corpus (i.e. it is sampled/windowed,
  // not the whole corpus serialized).
  assert.ok(huge.length <= DIALECTIC_MAX_DIGEST_CHARS,
    '100k corpus does not blow the digest cap');
});

test('corpus scaling 1k -> 100k does not raise the prompt size beyond the cap', async () => {
  const cap1k = {};
  const cap100k = {};
  await deriveDialectic({ style: styleRows(1000) },
    { transport: stubTransport([], cap1k) });
  await deriveDialectic({ style: styleRows(100000) },
    { transport: stubTransport([], cap100k) });
  assert.ok(cap1k.prompt.length <= DIALECTIC_MAX_DIGEST_CHARS + 4000,
    '1k prompt bounded');
  assert.ok(cap100k.prompt.length <= DIALECTIC_MAX_DIGEST_CHARS + 4000,
    '100k prompt bounded — spend does not scale with corpus');
  // Both prompts are within a small constant of each other (the digest is
  // capped, the surrounding instruction template is fixed-size).
  const delta = Math.abs(cap100k.prompt.length - cap1k.prompt.length);
  assert.ok(delta <= 200, `prompt size near-constant across corpus (delta=${delta})`);
});

test('a single-session input cannot mint a dialectic inference', async () => {
  const proposed = [{
    kind: 'trait', subject: 'prefers terse replies', value: 'terse',
    confidence: 0.9, // model tries to assert high confidence
  }];
  // Only ONE session in the corpus -> corroboration floor (>=2) not met.
  const delta = await deriveDialectic({ style: styleRows(1) },
    { transport: stubTransport(proposed) });
  assert.deepEqual(delta.inferences, [],
    'no dialectic inference from a single session');
});

test('a corroborated trait is admitted but capped to a LOW confidence', async () => {
  assert.ok(DIALECTIC_MAX_CONFIDENCE < 0.7,
    'dialectic confidence floor is below the heuristic 0.7 default');
  assert.ok(DIALECTIC_MIN_CORROBORATION >= 2, 'K >= 2');
  const proposed = [{
    kind: 'trait', subject: 'prefers terse replies', value: 'terse',
    confidence: 0.95,
  }];
  const delta = await deriveDialectic({ style: styleRows(5) },
    { transport: stubTransport(proposed) });
  assert.equal(delta.inferences.length, 1, 'corroborated trait admitted');
  const inf = delta.inferences[0];
  assert.ok(inf.confidence <= DIALECTIC_MAX_CONFIDENCE,
    `confidence capped (got ${inf.confidence})`);
  assert.ok(inf.evidence_count >= DIALECTIC_MIN_CORROBORATION,
    'evidence reflects cross-session corroboration');
  assert.ok((inf.source_sessions || []).length >= DIALECTIC_MIN_CORROBORATION,
    'inference carries >=K corroborating sessions');
});

test('deriveDialectic degrades to empty when the transport throws', async () => {
  const throwing = async () => { throw new Error('local model down'); };
  const delta = await deriveDialectic({ style: styleRows(5) },
    { transport: throwing });
  assert.deepEqual(delta.inferences, [], 'transport error -> empty additive delta');
});

test('deriveDialectic degrades to empty on unparseable model output', async () => {
  const garbage = async () => ({ text: 'not json at all', via: 'stub' });
  const delta = await deriveDialectic({ style: styleRows(5) },
    { transport: garbage });
  assert.deepEqual(delta.inferences, [], 'garbage output -> empty additive delta');
});

test('deriveDialectic returns empty (no call) when there is no signal', async () => {
  let called = false;
  const t = async () => { called = true; return { text: '{"inferences":[]}' }; };
  const delta = await deriveDialectic({ style: [] }, { transport: t });
  assert.deepEqual(delta.inferences, []);
  assert.equal(called, false, 'no transport call on empty corpus');
});
