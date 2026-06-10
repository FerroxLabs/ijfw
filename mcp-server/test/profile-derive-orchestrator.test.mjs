// P3.2 — the fallback ladder in derive.js (moat-critical).
//
// deriveProfile(signals, opts):
//   1. ALWAYS run deriveHeuristic (zero-LLM, the floor).
//   2. ONLY if a local model is configured (IJFW_PROFILE_LOCAL_URL, or the
//      reused local tier endpoint) run deriveDialectic and MERGE its inferences
//      ON TOP (dialectic ADDS, never overrides the heuristic floor).
//   3. Local-LLM ABSENT or ERROR -> heuristic-only. NEVER silent cloud. Cloud is
//      reachable ONLY when IJFW_PROFILE_CLOUD_OPT_IN is explicitly set AND a
//      cloud transport is supplied (derive.js never constructs one itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveProfile } from '../src/profile/derive.js';

const META = {
  avg_msg_chars: 40, emoji_per_msg: 0, code_block_ratio: 0.6,
  formality_markers: 0.2, turn_cadence_per_min: 5, msg_count: 20,
};

function signals(nSessions = 3) {
  const style = [];
  const feedback = [];
  for (let i = 0; i < nSessions; i++) {
    style.push({ ...META, session_id: `s${i}`, host: 'claude',
      ts: new Date(Date.UTC(2026, 5, 1 + i)).toISOString() });
  }
  feedback.push({ ts: new Date(Date.UTC(2026, 5, 2)).toISOString(),
    kind: 'correction', phrase: 'use tabs not spaces', context: '' });
  return { metadata: META, style, feedback, sessionId: 's0', host: 'claude' };
}

test('heuristic floor is ALWAYS produced, even with zero LLM config', async () => {
  const env = {}; // no IJFW_PROFILE_LOCAL_URL, no opt-in
  const delta = await deriveProfile(signals(), { env });
  assert.ok(delta && typeof delta === 'object');
  // style fingerprint present (the heuristic floor)
  assert.ok(delta.style && delta.style.terseness, 'style floor present');
  // preference inference from the correction feedback present
  assert.ok(Array.isArray(delta.inferences) && delta.inferences.length >= 1,
    'heuristic preference inference present');
});

test('NO local URL + NO cloud opt-in => ZERO network calls (injected throwing fetch)', async () => {
  // If derive.js ever reached the network without a configured local URL or an
  // explicit cloud opt-in, this throwing fetch would surface. It must NOT be
  // called: heuristic-only, fully self-contained.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('NETWORK FORBIDDEN'); };
  try {
    const delta = await deriveProfile(signals(), { env: {} });
    assert.equal(fetchCalls, 0, 'no fetch attempted without local URL / opt-in');
    assert.ok(delta.style && delta.style.terseness, 'heuristic profile still intact');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('local configured but ERRORS => heuristic-only, no cloud fallback', async () => {
  const env = { IJFW_PROFILE_LOCAL_URL: 'http://127.0.0.1:1/never' };
  let cloudCalls = 0;
  const cloudTransport = async () => { cloudCalls += 1; return { text: '{"inferences":[]}' }; };
  const throwingLocal = async () => { throw new Error('local refused'); };
  const logs = [];
  const delta = await deriveProfile(signals(), {
    env,
    _localTransport: throwingLocal,
    _cloudTransport: cloudTransport, // present, but must NOT be used
    log: (m) => logs.push(m),
  });
  assert.equal(cloudCalls, 0, 'local error never silently falls through to cloud');
  assert.ok(delta.style && delta.style.terseness, 'heuristic floor survives local error');
  assert.ok(logs.some((l) => /dialectic/i.test(l)), 'the degrade was LOGGED, not swallowed');
});

test('local configured + working => dialectic inferences ADD to the heuristic floor', async () => {
  const env = { IJFW_PROFILE_LOCAL_URL: 'http://127.0.0.1:11434' };
  const localTransport = async () => ({
    text: JSON.stringify({ inferences: [
      { kind: 'trait', subject: 'prefers terse replies', value: 'terse', confidence: 0.95 },
    ] }),
  });
  const base = await deriveProfile(signals(), { env: {} }); // heuristic only
  const withDialectic = await deriveProfile(signals(), { env, _localTransport: localTransport });
  const baseInf = (base.inferences || []).length;
  const dialInf = (withDialectic.inferences || []).length;
  assert.ok(dialInf > baseInf, 'dialectic added at least one inference on top');
  // The heuristic floor is preserved (additive, not overriding).
  assert.ok(withDialectic.style && withDialectic.style.terseness,
    'heuristic style floor still present alongside dialectic');
  // dialectic inference carries a LOW confidence (capped), proving it did not
  // override the heuristic's own confidence policy.
  const dialTrait = withDialectic.inferences.find((i) => i.kind === 'trait');
  assert.ok(dialTrait && dialTrait.confidence < 0.7, 'dialectic trait stays low-confidence');
});

test('cloud is reachable ONLY with explicit opt-in AND an explicit cloud transport', async () => {
  // Opt-in set, local ABSENT, cloud transport supplied => cloud may run.
  const env = { IJFW_PROFILE_CLOUD_OPT_IN: '1' };
  let cloudCalls = 0;
  const cloudTransport = async () => {
    cloudCalls += 1;
    return { text: JSON.stringify({ inferences: [
      { kind: 'trait', subject: 'likes ci', value: 'ci', confidence: 0.9 },
    ] }) };
  };
  const delta = await deriveProfile(signals(5), { env, _cloudTransport: cloudTransport });
  assert.equal(cloudCalls, 1, 'explicit opt-in + explicit cloud transport => cloud runs');
  assert.ok(delta.style, 'heuristic floor still present');
});

test('opt-in WITHOUT a cloud transport still does NOT reach the network', async () => {
  // The structural guarantee: derive.js never constructs a cloud transport. Even
  // with the opt-in flag, absent an injected cloud transport, nothing networks.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('NETWORK FORBIDDEN'); };
  try {
    const delta = await deriveProfile(signals(), { env: { IJFW_PROFILE_CLOUD_OPT_IN: '1' } });
    assert.equal(fetchCalls, 0, 'opt-in alone, no transport => no network');
    assert.ok(delta.style, 'heuristic floor present');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('empty signals => clean no-op-ish delta, never throws', async () => {
  const delta = await deriveProfile({}, { env: {} });
  assert.ok(delta && typeof delta === 'object', 'returns an object');
  // No style metadata, no feedback -> no style / no inferences fields, but valid.
  assert.equal(delta.style, undefined);
});
