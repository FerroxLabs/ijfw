// FIX 2 (CRITICAL-1 / M1 / H4) — the merge fold must enforce the documented
// anti-poison levers that were DEAD: per-host trust weighting, the single-session
// influence cap (delta per axis), and asymmetric decay (contradiction moves
// faster). Before the fix, foldStyleAxis used step = min(1, alpha*weight) with
// weight only guarded >0, so a delta with style.<axis>.weight:1000 overwrote an
// axis in ONE merge, and trust_weight was dropped entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyDelta } from '../src/profile/merge.js';
import { makeProfile } from '../src/profile/schema.js';
import { STYLE_DELTA_CAP, CONFIRM_ALPHA, CONTRADICT_ALPHA } from '../src/profile/capture.js';

const axis = (p) => p.global.style.terseness;

test('FIX2: weight:1000 CANNOT move an axis more than STYLE_DELTA_CAP in one merge', () => {
  const p = makeProfile();
  const before = axis(p).ema; // 0.5
  const next = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 1000 } } });
  const moved = Math.abs(axis(next).ema - before);
  assert.ok(moved <= STYLE_DELTA_CAP + 1e-9,
    `a single session must not move an axis past the cap (${STYLE_DELTA_CAP}); moved ${moved}`);
  assert.ok(axis(next).ema < 1.0, 'a huge weight cannot pin the axis to the sample in one merge');
});

test('FIX2: incoming weight is clamped to [0,1] (a >1 weight behaves as 1, not as a multiplier)', () => {
  const p = makeProfile();
  const cap = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 1 } } });
  const huge = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 50 } } });
  assert.ok(Math.abs(axis(cap).ema - axis(huge).ema) < 1e-9,
    'weight>1 must clamp to 1 — a 50x weight cannot move the axis further than weight 1');
});

test('FIX2: a LOW-trust host moves an axis LESS than a FULL-trust host', () => {
  const p = makeProfile();
  const full = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 1, trust: 1.0 } } });
  const low = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 1, trust: 0.5 } } });
  const fullMove = axis(full).ema - 0.5;
  const lowMove = axis(low).ema - 0.5;
  assert.ok(fullMove > lowMove + 1e-9,
    `trust must scale the move: full(${fullMove}) > low(${lowMove})`);
  assert.ok(lowMove > 0, 'a low-trust host still moves the axis a little');
});

test('FIX2: trust cannot be used to EXCEED the per-session cap', () => {
  const p = makeProfile();
  const before = axis(p).ema;
  // Attempt to amplify via an out-of-range trust.
  const next = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 1000, trust: 1000 } } });
  assert.ok(Math.abs(axis(next).ema - before) <= STYLE_DELTA_CAP + 1e-9,
    'no combination of weight*trust can move past STYLE_DELTA_CAP in one merge');
});

test('FIX2: a CONTRADICTING signal adapts FASTER than a CONFIRMING one (asymmetric decay)', () => {
  // Build a profile whose terseness EMA sits clearly above 0.5 (a settled belief).
  let high = makeProfile();
  for (let i = 0; i < 6; i++) {
    high = applyDelta(high, { style: { terseness: { sample: 1.0, weight: 1, trust: 1.0 } } });
  }
  const settled = axis(high).ema;
  assert.ok(settled > 0.6, `precondition: belief settled high (got ${settled})`);

  // Confirming move: another high sample (same side of 0.5). Small.
  const confirm = applyDelta(high, { style: { terseness: { sample: 1.0, weight: 1, trust: 1.0 } } });
  const confirmDelta = Math.abs(axis(confirm).ema - settled);

  // Contradicting move: a LOW sample (opposite side of 0.5). Must be larger.
  const contradict = applyDelta(high, { style: { terseness: { sample: 0.0, weight: 1, trust: 1.0 } } });
  const contradictDelta = Math.abs(axis(contradict).ema - settled);

  assert.ok(contradictDelta > confirmDelta + 1e-9,
    `contradiction must move faster: contradict(${contradictDelta}) > confirm(${confirmDelta})`);
  // And it reflects the two learning rates (fast > slow).
  assert.ok(CONTRADICT_ALPHA > CONFIRM_ALPHA, 'precondition: contradict alpha is the faster rate');
});

test('FIX2: a zero/negative weight is a no-op on the EMA (cannot drag the axis)', () => {
  const p = makeProfile();
  const before = axis(p).ema;
  const z = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 0 } } });
  assert.ok(Math.abs(axis(z).ema - before) < 1e-9, 'weight 0 must not move the EMA');
  const neg = applyDelta(p, { style: { terseness: { sample: 1.0, weight: -5 } } });
  assert.ok(Math.abs(axis(neg).ema - before) < 1e-9, 'negative weight clamps to 0 -> no move');
});
