/**
 * profile/eval/plumbing.test.mjs — PHASE P5.1.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS A PLUMBING / REGRESSION TEST. IT IS *NOT* PROOF THE SYSTEM       │
 * │ "LEARNS YOU."                                                            │
 * │                                                                          │
 * │ It asserts ONE thing: synthetic signals round-trip through the REAL      │
 * │ derivation pipeline (deriveHeuristic / deriveProfile) into a profile     │
 * │ delta with the expected shape. That is a wiring check — it proves the    │
 * │ pipes connect, nothing more.                                             │
 * │                                                                          │
 * │ It deliberately TRAINS AND TESTS ON THE SAME SIGNAL (the circular setup  │
 * │ the slice-1 audit flagged as "the Honcho move" — assert-not-prove). That │
 * │ circularity is FINE for a plumbing test and FATAL for a proof-of-        │
 * │ learning claim. Do NOT cite this test as evidence the profile captures   │
 * │ or changes behavior.                                                     │
 * │                                                                          │
 * │ The REAL evidence lives in the two held-out gates:                       │
 * │   - Gate C (gate-c-capture.mjs): held-out capture, precision AND recall. │
 * │   - Gate B (gate-b-behavior.mjs): behavioral A/B, paired McNemar.        │
 * │ The word "prove" is reserved for Gate B passing — never for this file.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Cite (why circular-capture eval is not proof): PrefEval [2502.09597].
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveHeuristic } from '../derive-heuristic.js';
import { deriveProfile } from '../derive.js';

const SIGNALS = {
  metadata: {
    avg_msg_chars: 38, emoji_per_msg: 0, code_block_ratio: 0.7,
    formality_markers: 0.55, turn_cadence_per_min: 6, msg_count: 20,
  },
  feedback: [
    { ts: '2026-06-01T00:00:00.000Z', kind: 'correction', phrase: 'use tabs not spaces', context: '' },
  ],
  sessionId: 's0',
  host: 'claude',
};

test('[PLUMBING / NOT PROOF] synthetic signals round-trip through the REAL deriveHeuristic into a delta', () => {
  const delta = deriveHeuristic(SIGNALS);
  // Shape-only assertions — this is a wiring check, not a learning claim.
  assert.ok(delta && typeof delta === 'object', 'delta produced');
  assert.ok(delta.style && delta.style.terseness, 'style axis present');
  assert.ok(Array.isArray(delta.inferences) && delta.inferences.length === 1, 'one preference inference');
  assert.equal(delta.inferences[0].kind, 'preference');
  assert.equal(delta.inferences[0].subject, 'use tabs not spaces');
});

test('[PLUMBING / NOT PROOF] deriveProfile orchestrator returns the heuristic floor with zero LLM config', async () => {
  // No local URL, no cloud opt-in -> heuristic-only floor. Round-trip wiring only.
  const delta = await deriveProfile(SIGNALS, { env: {} });
  assert.ok(delta && typeof delta === 'object');
  assert.ok(delta.style && delta.style.terseness, 'heuristic floor style present');
  assert.ok(Array.isArray(delta.inferences) && delta.inferences.length >= 1, 'heuristic floor inference present');
});

test('[PLUMBING / NOT PROOF] this file makes NO held-out or behavioral claim (guard)', () => {
  // A literal guard so a future reader cannot quietly upgrade this plumbing test
  // into a proof: the only thing asserted here is round-trip wiring. Real proof
  // is Gate C (held-out capture) + Gate B (behavioral A/B), in their own files.
  assert.ok(true, 'plumbing only — see gate-c-capture.mjs / gate-b-behavior.mjs for proof');
});
