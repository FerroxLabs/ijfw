#!/usr/bin/env node
/**
 * test-memory-feedback.js -- IJFW 1.4.0 W7/B3
 *
 * Tests for readRecentReceipts / detectPatterns / getFeedbackSuggestions.
 * Uses isolated project roots and never touches real ~/.ijfw state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, utimes, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRecentReceipts,
  detectPatterns,
  detectRisingFailRate,
  detectCrossSkillCorrelation,
  detectRegression,
  getFeedbackSuggestions,
} from './src/memory-feedback.js';

async function makeProj(label) {
  return mkdtemp(join(tmpdir(), `ijfw-mf-${label}-`));
}

async function makeReceiptsDir(proj) {
  const dir = join(proj, '.ijfw', 'memory', 'gate-receipts');
  await mkdir(dir, { recursive: true });
  return dir;
}

function receipt(verdict, types, gateId = `g-${Math.random().toString(36).slice(2, 8)}`) {
  const arts = types.map((t, i) => ({ type: t, id: `${t}-${i}` }));
  return {
    schema_version: '1.0',
    gate_id: gateId,
    verdict,
    affected_artifacts: arts,
    ts: new Date().toISOString(),
  };
}

async function writeReceipt(dir, name, body, mtimeOffsetSec = 0) {
  const file = join(dir, `${name}.json`);
  await writeFile(file, JSON.stringify(body), 'utf8');
  if (mtimeOffsetSec !== 0) {
    const now = new Date();
    const t = new Date(now.getTime() + mtimeOffsetSec * 1000);
    await utimes(file, t, t);
  }
  return file;
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// --- readRecentReceipts ---------------------------------------------------

test('readRecentReceipts: empty receipts dir returns empty array', async () => {
  const proj = await makeProj('empty');
  try {
    await makeReceiptsDir(proj);
    const r = await readRecentReceipts(proj);
    assert.deepEqual(r, []);
  } finally { await cleanup(proj); }
});

test('readRecentReceipts: missing receipts dir returns empty array (not error)', async () => {
  const proj = await makeProj('missing');
  try {
    // no .ijfw/memory/gate-receipts/ at all
    const r = await readRecentReceipts(proj);
    assert.deepEqual(r, []);
  } finally { await cleanup(proj); }
});

test('readRecentReceipts: returns parsed receipts sorted by mtime desc', async () => {
  const proj = await makeProj('sort');
  try {
    const d = await makeReceiptsDir(proj);
    // Write three receipts with distinct mtimes; newest should come first.
    await writeReceipt(d, 'oldest', receipt('PASS', ['chapter'], 'oldest'), -300);
    await writeReceipt(d, 'mid',    receipt('FAIL', ['persona'], 'mid'),    -150);
    await writeReceipt(d, 'newest', receipt('FAIL', ['decision'], 'newest'), 0);
    const r = await readRecentReceipts(proj);
    assert.equal(r.length, 3);
    assert.equal(r[0].gate_id, 'newest');
    assert.equal(r[2].gate_id, 'oldest');
  } finally { await cleanup(proj); }
});

test('readRecentReceipts: malformed JSON files are skipped, not crashed', async () => {
  const proj = await makeProj('malformed');
  try {
    const d = await makeReceiptsDir(proj);
    await writeFile(join(d, 'broken.json'), '{not valid json', 'utf8');
    await writeReceipt(d, 'ok', receipt('FAIL', ['chapter'], 'ok-id'));
    const r = await readRecentReceipts(proj);
    assert.equal(r.length, 1);
    assert.equal(r[0].gate_id, 'ok-id');
  } finally { await cleanup(proj); }
});

test('readRecentReceipts: caps at limit param', async () => {
  const proj = await makeProj('limit');
  try {
    const d = await makeReceiptsDir(proj);
    for (let i = 0; i < 10; i++) {
      await writeReceipt(d, `r-${i}`, receipt('FAIL', ['chapter'], `r-${i}`), i);
    }
    const r = await readRecentReceipts(proj, 4);
    assert.equal(r.length, 4);
  } finally { await cleanup(proj); }
});

test('readRecentReceipts (W7.1/B3-H-01): files larger than MAX_FILE_BYTES are skipped pre-read', async () => {
  const proj = await makeProj('oversized');
  try {
    const d = await makeReceiptsDir(proj);
    // Create a 200 KB file (cap is 64 KB). With pre-stat enforcement this
    // must not be read into memory; entry is skipped.
    const big = join(d, 'huge.json');
    await writeFile(big, JSON.stringify({ verdict: 'FAIL', affected_artifacts: [{ type: 'chapter' }] }), 'utf8');
    await truncate(big, 200 * 1024);
    // Also plant a small ok receipt to confirm the reader still works.
    await writeReceipt(d, 'ok', receipt('FAIL', ['chapter'], 'ok-id'));
    const r = await readRecentReceipts(proj);
    assert.equal(r.length, 1, 'oversized file must be skipped, only ok-id remains');
    assert.equal(r[0].gate_id, 'ok-id');
  } finally { await cleanup(proj); }
});

test('readRecentReceipts (W7.1/B3-M-01): symlinked entries are rejected', async () => {
  const proj = await makeProj('symlink');
  const target = await makeProj('symlink-target');
  try {
    const d = await makeReceiptsDir(proj);
    // Plant a real file outside projectRoot.
    const targetFile = join(target, 'pwn.json');
    await writeFile(targetFile, JSON.stringify({ verdict: 'FAIL', affected_artifacts: [{ type: 'EXFIL' }] }), 'utf8');
    // Symlink from receipts dir into target.
    try {
      await symlink(targetFile, join(d, 'redir.json'));
    } catch (err) {
      // some CI envs disallow symlink; treat as inapplicable
      if (err && (err.code === 'EPERM' || err.code === 'ENOSYS')) return;
      throw err;
    }
    // Also plant a benign receipt.
    await writeReceipt(d, 'ok', receipt('FAIL', ['chapter'], 'ok-id'));
    const r = await readRecentReceipts(proj);
    assert.equal(r.length, 1, 'symlinked entry must be rejected');
    assert.equal(r[0].gate_id, 'ok-id');
    // Pattern detection on this set must NOT include the exfiltrated type.
    const types = r.flatMap((rr) => rr.affected_artifacts.map((a) => a.type));
    assert.ok(!types.includes('EXFIL'), 'symlinked target body must not leak into results');
  } finally { await cleanup(proj); await cleanup(target); }
});

test('getFeedbackSuggestions (W7.1/B3-N-01): negative/zero opts bound to defensible minimums', async () => {
  const proj = await makeProj('bounds');
  try {
    const d = await makeReceiptsDir(proj);
    for (let i = 0; i < 4; i++) {
      await writeReceipt(d, `r-${i}`, receipt('FAIL', ['chapter'], `g-${i}`), i);
    }
    // window: 0 should be clamped to 1 -> 1 receipt in window -> count=1, threshold default 3 -> no pattern.
    const sugg0 = await getFeedbackSuggestions(proj, { window: 0 });
    assert.deepEqual(sugg0, []);
    // window: -5 same as above
    const suggN = await getFeedbackSuggestions(proj, { window: -5 });
    assert.deepEqual(suggN, []);
    // threshold: 0 clamped to 1; window default 10 -> 4 FAIL -> 1 pattern
    const sugg1 = await getFeedbackSuggestions(proj, { threshold: 0 });
    assert.equal(sugg1.length, 1);
  } finally { await cleanup(proj); }
});

test('readRecentReceipts: receipts without affected_artifacts array are skipped', async () => {
  const proj = await makeProj('shape');
  try {
    const d = await makeReceiptsDir(proj);
    // bad shape: no affected_artifacts
    await writeReceipt(d, 'bad', { schema_version: '1.0', gate_id: 'bad', verdict: 'FAIL' });
    await writeReceipt(d, 'ok', receipt('FAIL', ['chapter'], 'ok'));
    const r = await readRecentReceipts(proj);
    assert.equal(r.length, 1);
    assert.equal(r[0].gate_id, 'ok');
  } finally { await cleanup(proj); }
});

// --- detectPatterns -------------------------------------------------------

test('detectPatterns: empty receipts returns no patterns', () => {
  assert.deepEqual(detectPatterns([]), []);
  assert.deepEqual(detectPatterns(null), []);
  assert.deepEqual(detectPatterns(undefined), []);
});

test('detectPatterns: 3 FAIL receipts same artifact_type → 1 pattern surfaced', () => {
  const receipts = [
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['chapter']),
  ];
  const patterns = detectPatterns(receipts);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].artifact_type, 'chapter');
  assert.equal(patterns[0].count, 3);
  assert.equal(patterns[0].kind, 'repeated-fail-on-same-artifact');
});

test('detectPatterns: 3 FAIL receipts DIFFERENT artifact_types → no pattern', () => {
  const receipts = [
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['persona']),
    receipt('FAIL', ['decision']),
  ];
  const patterns = detectPatterns(receipts);
  assert.equal(patterns.length, 0);
});

test('detectPatterns: mixed PASS+FAIL on same type below threshold → no pattern', () => {
  const receipts = [
    receipt('FAIL', ['chapter']),
    receipt('PASS', ['chapter']),
    receipt('PASS', ['chapter']),
    receipt('FAIL', ['chapter']),
  ];
  const patterns = detectPatterns(receipts);
  assert.equal(patterns.length, 0);
});

test('detectPatterns: receipts with missing affected_artifacts → skipped, not crashed', () => {
  const receipts = [
    { verdict: 'FAIL' }, // no array
    { verdict: 'FAIL', affected_artifacts: null },
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['chapter']),
  ];
  const patterns = detectPatterns(receipts);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].artifact_type, 'chapter');
  assert.equal(patterns[0].count, 3);
});

test('detectPatterns: window param limits scope', () => {
  // 5 FAIL receipts on chapter, but window=3 — only first 3 counted.
  const receipts = [
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['chapter']),
    receipt('FAIL', ['persona']),
    receipt('FAIL', ['persona']),
  ];
  const wide = detectPatterns(receipts, { window: 10, threshold: 3 });
  const narrow = detectPatterns(receipts, { window: 3, threshold: 3 });
  assert.equal(wide.length, 1);
  assert.equal(wide[0].artifact_type, 'chapter');
  assert.equal(narrow.length, 1);
  assert.equal(narrow[0].artifact_type, 'chapter');
  // Now slide the window past the 'chapter' receipts.
  const slid = detectPatterns(receipts.slice(2), { window: 3, threshold: 3 });
  // slice(2) = [chapter, persona, persona] - chapter count is 1, persona is 2 - no pattern
  assert.equal(slid.length, 0);
});

test('detectPatterns: same receipt with duplicate artifact types not double-counted', () => {
  const receipts = [
    receipt('FAIL', ['chapter', 'chapter', 'chapter']),
    receipt('FAIL', ['chapter']),
  ];
  const patterns = detectPatterns(receipts);
  assert.equal(patterns.length, 0, 'one receipt should count once per type');
});

// --- getFeedbackSuggestions ----------------------------------------------

test('getFeedbackSuggestions: end-to-end produces markdown bullet bodies', async () => {
  const proj = await makeProj('e2e');
  try {
    const d = await makeReceiptsDir(proj);
    for (let i = 0; i < 4; i++) {
      await writeReceipt(d, `r-${i}`, receipt('FAIL', ['chapter'], `g-${i}`), i);
    }
    const sugg = await getFeedbackSuggestions(proj);
    assert.equal(sugg.length, 1);
    assert.match(sugg[0], /Pattern detected: 4\/10 recent gates flagged on chapter/);
    assert.match(sugg[0], /reviewing chapter scope/);
  } finally { await cleanup(proj); }
});

test('getFeedbackSuggestions: missing receipts dir returns empty array (not error)', async () => {
  const proj = await makeProj('miss');
  try {
    const sugg = await getFeedbackSuggestions(proj);
    assert.deepEqual(sugg, []);
  } finally { await cleanup(proj); }
});

test('getFeedbackSuggestions: text leaks NO artifact IDs or full receipt content', async () => {
  const proj = await makeProj('noleak');
  try {
    const d = await makeReceiptsDir(proj);
    for (let i = 0; i < 3; i++) {
      const r = receipt('FAIL', ['chapter'], `secret-gate-${i}`);
      r.affected_artifacts[0].id = `SECRET-ID-${i}`;
      r.notes = 'CONFIDENTIAL_RECEIPT_BODY';
      await writeReceipt(d, `r-${i}`, r, i);
    }
    const sugg = await getFeedbackSuggestions(proj);
    assert.equal(sugg.length, 1);
    assert.ok(!sugg[0].includes('SECRET-ID'), `suggestion must not contain artifact IDs`);
    assert.ok(!sugg[0].includes('CONFIDENTIAL_RECEIPT_BODY'), `suggestion must not contain receipt notes`);
    assert.ok(!sugg[0].includes('secret-gate'), `suggestion must not contain gate IDs`);
  } finally { await cleanup(proj); }
});

// --- detectRisingFailRate ---------------------------------------------------

test('detectRisingFailRate: empty / small receipts returns no pattern', () => {
  assert.deepEqual(detectRisingFailRate([]), []);
  assert.deepEqual(detectRisingFailRate(null), []);
  assert.deepEqual(detectRisingFailRate([receipt('FAIL', ['chapter'])]), []);
});

test('detectRisingFailRate: triggers when fail rate rises by >= minRise', () => {
  // prior window (20..39): all PASS (0% fail)
  // recent window (0..19): all FAIL (100% fail)
  const recent = Array.from({ length: 20 }, (_, i) => receipt('FAIL', ['chapter'], `g-${i}`));
  const prior = Array.from({ length: 20 }, (_, i) => receipt('PASS', ['chapter'], `h-${i}`));
  const receipts = [...recent, ...prior];
  const patterns = detectRisingFailRate(receipts, { window: 20, minRise: 0.2 });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].kind, 'rising-fail-rate');
  assert.ok(patterns[0].to_rate > patterns[0].from_rate);
  assert.ok(patterns[0].suggestion.includes('rose from'));
  assert.ok(patterns[0].suggestion.includes('rolling back'));
});

test('detectRisingFailRate: does NOT trigger when rate rise is below minRise', () => {
  // prior: 10% fail (2/20), recent: 20% fail (4/20) -- rise of 0.10, below 0.20 threshold
  const recent = [
    ...Array.from({ length: 4 }, () => receipt('FAIL', ['chapter'])),
    ...Array.from({ length: 16 }, () => receipt('PASS', ['chapter'])),
  ];
  const prior = [
    ...Array.from({ length: 2 }, () => receipt('FAIL', ['chapter'])),
    ...Array.from({ length: 18 }, () => receipt('PASS', ['chapter'])),
  ];
  const patterns = detectRisingFailRate([...recent, ...prior], { window: 20, minRise: 0.2 });
  assert.deepEqual(patterns, []);
});

test('detectRisingFailRate: does NOT trigger when no prior window exists', () => {
  // Only 15 receipts, window=20 → prior slice is empty → no pattern
  const receipts = Array.from({ length: 15 }, () => receipt('FAIL', ['chapter']));
  const patterns = detectRisingFailRate(receipts, { window: 20, minRise: 0.2 });
  assert.deepEqual(patterns, []);
});

test('detectRisingFailRate: suggestion text contains no IDs', () => {
  const recent = Array.from({ length: 10 }, () => {
    const r = receipt('FAIL', ['chapter'], 'SECRET-GATE-ID');
    r.affected_artifacts[0].id = 'SECRET-ARTIFACT-ID';
    return r;
  });
  const prior = Array.from({ length: 10 }, () => receipt('PASS', ['chapter']));
  const patterns = detectRisingFailRate([...recent, ...prior], { window: 10, minRise: 0.2 });
  assert.equal(patterns.length, 1);
  assert.ok(!patterns[0].suggestion.includes('SECRET'), 'suggestion must not contain IDs');
});

test('detectRisingFailRate: handles malformed receipts without crash', () => {
  const junk = [null, undefined, 42, { verdict: 123 }, {}, { verdict: 'FAIL' }];
  assert.doesNotThrow(() => detectRisingFailRate(junk));
});

// --- detectCrossSkillCorrelation -------------------------------------------

test('detectCrossSkillCorrelation: empty receipts returns no pattern', () => {
  assert.deepEqual(detectCrossSkillCorrelation([]), []);
  assert.deepEqual(detectCrossSkillCorrelation(null), []);
});

test('detectCrossSkillCorrelation: triggers when >= minDistinctGates prefixes fail', () => {
  const receipts = [
    receipt('FAIL', ['chapter'], 'plan-check-001'),
    receipt('FAIL', ['chapter'], 'trident-scan-002'),
    receipt('FAIL', ['chapter'], 'preflight-run-003'),
  ];
  const patterns = detectCrossSkillCorrelation(receipts, { window: 10, minDistinctGates: 3 });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].kind, 'cross-skill-correlation');
  assert.equal(patterns[0].distinct_gates, 3);
  assert.ok(patterns[0].suggestion.includes('3 different gates'));
  assert.ok(patterns[0].suggestion.includes('review project state'));
});

test('detectCrossSkillCorrelation: does NOT trigger when fewer than minDistinctGates prefixes', () => {
  // Only 2 distinct prefixes (plan, trident) — below default minDistinctGates=3
  const receipts = [
    receipt('FAIL', ['chapter'], 'plan-check-001'),
    receipt('FAIL', ['chapter'], 'plan-check-002'),
    receipt('FAIL', ['chapter'], 'trident-scan-003'),
  ];
  const patterns = detectCrossSkillCorrelation(receipts, { window: 10, minDistinctGates: 3 });
  assert.deepEqual(patterns, []);
});

test('detectCrossSkillCorrelation: PASS receipts do not count toward distinct gates', () => {
  const receipts = [
    receipt('PASS', ['chapter'], 'plan-check-001'),
    receipt('PASS', ['chapter'], 'trident-scan-002'),
    receipt('FAIL', ['chapter'], 'preflight-run-003'),  // only 1 FAIL prefix
  ];
  const patterns = detectCrossSkillCorrelation(receipts, { window: 10, minDistinctGates: 3 });
  assert.deepEqual(patterns, []);
});

test('detectCrossSkillCorrelation: colon separator also splits prefix', () => {
  const receipts = [
    receipt('FAIL', ['chapter'], 'plan:check'),
    receipt('FAIL', ['chapter'], 'trident:scan'),
    receipt('FAIL', ['chapter'], 'preflight:run'),
  ];
  const patterns = detectCrossSkillCorrelation(receipts, { window: 10, minDistinctGates: 3 });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].distinct_gates, 3);
});

test('detectCrossSkillCorrelation: handles malformed receipts without crash', () => {
  const junk = [null, {}, { verdict: 'FAIL' }, { verdict: 'FAIL', gate_id: 42 }];
  assert.doesNotThrow(() => detectCrossSkillCorrelation(junk));
});

// --- detectRegression -------------------------------------------------------

test('detectRegression: empty receipts returns no pattern', () => {
  assert.deepEqual(detectRegression([]), []);
  assert.deepEqual(detectRegression(null), []);
});

test('detectRegression: 5×PASS then 2×FAIL on same (gate_id, artifact_type) triggers', () => {
  // receipts[0] = most recent (newest-first order)
  const fail1 = receipt('FAIL', ['chapter'], 'plan-check');
  const fail2 = receipt('FAIL', ['chapter'], 'plan-check');
  const pass1 = receipt('PASS', ['chapter'], 'plan-check');
  const pass2 = receipt('PASS', ['chapter'], 'plan-check');
  const pass3 = receipt('PASS', ['chapter'], 'plan-check');
  const pass4 = receipt('PASS', ['chapter'], 'plan-check');
  const pass5 = receipt('PASS', ['chapter'], 'plan-check');
  const receipts = [fail1, fail2, pass1, pass2, pass3, pass4, pass5];
  const patterns = detectRegression(receipts, { passWindow: 5, failWindow: 2 });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].kind, 'regression');
  assert.equal(patterns[0].gate_id, 'plan-check');
  assert.equal(patterns[0].artifact_type, 'chapter');
  assert.ok(patterns[0].suggestion.includes('plan-check'));
  assert.ok(patterns[0].suggestion.includes('chapter'));
  assert.ok(patterns[0].suggestion.includes('likely regression'));
});

test('detectRegression: does NOT trigger when prior window has a FAIL mixed in', () => {
  const fail1 = receipt('FAIL', ['chapter'], 'plan-check');
  const fail2 = receipt('FAIL', ['chapter'], 'plan-check');
  // prior window: 4×PASS + 1×FAIL → not "all PASS" → no regression
  const pass1 = receipt('PASS', ['chapter'], 'plan-check');
  const pass2 = receipt('PASS', ['chapter'], 'plan-check');
  const pass3 = receipt('PASS', ['chapter'], 'plan-check');
  const pass4 = receipt('PASS', ['chapter'], 'plan-check');
  const failMix = receipt('FAIL', ['chapter'], 'plan-check');
  const receipts = [fail1, fail2, pass1, pass2, pass3, pass4, failMix];
  const patterns = detectRegression(receipts, { passWindow: 5, failWindow: 2 });
  assert.deepEqual(patterns, []);
});

test('detectRegression: does NOT trigger when not enough receipts for both windows', () => {
  // Need passWindow=5 + failWindow=2 = 7 receipts; only 6 available
  const receipts = [
    receipt('FAIL', ['chapter'], 'plan-check'),
    receipt('FAIL', ['chapter'], 'plan-check'),
    receipt('PASS', ['chapter'], 'plan-check'),
    receipt('PASS', ['chapter'], 'plan-check'),
    receipt('PASS', ['chapter'], 'plan-check'),
    receipt('PASS', ['chapter'], 'plan-check'),
  ];
  const patterns = detectRegression(receipts, { passWindow: 5, failWindow: 2 });
  assert.deepEqual(patterns, []);
});

test('detectRegression: suggestion text does not contain artifact IDs', () => {
  const makeRegReceipt = (verdict) => {
    const r = receipt(verdict, ['chapter'], 'plan-check');
    r.affected_artifacts[0].id = 'SECRET-ID-999';
    return r;
  };
  const receipts = [
    makeRegReceipt('FAIL'),
    makeRegReceipt('FAIL'),
    makeRegReceipt('PASS'),
    makeRegReceipt('PASS'),
    makeRegReceipt('PASS'),
    makeRegReceipt('PASS'),
    makeRegReceipt('PASS'),
  ];
  const patterns = detectRegression(receipts, { passWindow: 5, failWindow: 2 });
  assert.equal(patterns.length, 1);
  assert.ok(!patterns[0].suggestion.includes('SECRET-ID'), 'must not leak artifact ID');
});

test('detectRegression: handles malformed receipts without crash', () => {
  const junk = [null, {}, { verdict: 'FAIL' }, { verdict: 'FAIL', gate_id: 'g', affected_artifacts: null }];
  assert.doesNotThrow(() => detectRegression(junk));
});

// --- composition: all four detectors fire ----------------------------------

test('detectPatterns: receipt stream triggering all 4 detectors returns 4 distinct kinds', () => {
  // Build a stream (newest-first) that satisfies all four detectors at once.
  // We call detectPatterns with explicit opts so window=10 for repeated-fail and
  // cross-skill, while rising-fail and regression use their own defaults passed
  // through opts where needed.
  //
  // Strategy:
  //   positions 0-1  : plan-check FAIL chapter  → regression "fail" window (2)
  //   positions 2-6  : plan-check PASS chapter  → regression "pass" window (5)
  //   positions 7-9  : preflight-run + trident FAIL chapter → cross-skill gets 3 prefixes
  //                    (plan-check from 0, preflight from 7, trident from 8 = within window=10)
  //                    also gives repeated-fail: chapter FAIL at 0,1,7,8,9 → 5 hits
  //   positions 10-29: all FAIL chapter         → rising-fail "recent" window (20, 100% fail)
  //   positions 30-49: all PASS chapter         → rising-fail "prior" window (20, 0% fail)

  const mk = (verdict, gateId) => ({
    schema_version: '1.0', gate_id: gateId, verdict,
    affected_artifacts: [{ type: 'chapter', id: 'cx' }], ts: new Date().toISOString(),
  });

  const stream = [
    mk('FAIL', 'plan-check'),      // 0 — regression fail 1; cross-skill prefix 1
    mk('FAIL', 'plan-check'),      // 1 — regression fail 2
    mk('PASS', 'plan-check'),      // 2 — regression pass 1
    mk('PASS', 'plan-check'),      // 3 — regression pass 2
    mk('PASS', 'plan-check'),      // 4 — regression pass 3
    mk('PASS', 'plan-check'),      // 5 — regression pass 4
    mk('PASS', 'plan-check'),      // 6 — regression pass 5
    mk('FAIL', 'preflight-run'),   // 7 — cross-skill prefix 2; repeated-fail 3rd chapter
    mk('FAIL', 'trident-scan'),    // 8 — cross-skill prefix 3; repeated-fail 4th chapter
    mk('FAIL', 'plan-check'),      // 9 — repeated-fail 5th chapter (still in window=10)
    // prior rising-fail window [10..19]: all PASS → 0% fail rate
    ...Array.from({ length: 10 }, () => mk('PASS', 'plan-check')),
  ];

  // Verify expected rates for rising-fail with window=10 (inherited from opts):
  //   recent [0..9]: FAILs at 0,1,7,8,9 = 5/10 = 50%
  //   prior  [10..19]: 0 FAILs = 0%
  //   rise = 50% - 0% = 50% >= minRise 20% ✓
  // repeated-fail: window=10 → positions 0-9 → 5 chapter FAILs ≥ threshold 3 ✓
  // cross-skill: window=10 → positions 0-9 → prefixes: plan(0,1,9), preflight(7), trident(8) → 3 ✓
  // regression: plan-check+chapter: positions 0,1 FAIL then 2,3,4,5,6 PASS (failWindow=2, passWindow=5) ✓

  const patterns = detectPatterns(stream, { threshold: 3, window: 10 });
  const kinds = patterns.map((p) => p.kind);
  assert.ok(kinds.includes('repeated-fail-on-same-artifact'), `expected repeated-fail, got: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('rising-fail-rate'), `expected rising-fail-rate, got: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('cross-skill-correlation'), `expected cross-skill-correlation, got: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('regression'), `expected regression, got: ${JSON.stringify(kinds)}`);
  assert.equal(new Set(kinds).size, kinds.length, 'all returned kinds must be distinct');
});

// --- leak guard: no suggestion contains ID/UUID patterns -------------------

test('leak guard: no suggestion text from any detector contains ID/UUID patterns', () => {
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const NUMERIC_ID_RE = /SECRET|artifact-\d+|chapter-\d+/;

  const mkR = (verdict, gateId) => {
    const r = receipt(verdict, ['chapter'], gateId);
    r.affected_artifacts[0].id = `chapter-${Math.floor(Math.random() * 999999)}`;
    return r;
  };

  // Build a stream that fires all detectors
  const stream = [
    mkR('FAIL', 'plan-check-aaa'),
    mkR('FAIL', 'preflight-bbb'),
    mkR('FAIL', 'trident-ccc'),
    ...Array.from({ length: 5 }, () => mkR('PASS', 'plan-check-aaa')),
    ...Array.from({ length: 20 }, () => mkR('FAIL', 'plan-check-aaa')),
    ...Array.from({ length: 20 }, () => mkR('PASS', 'plan-check-aaa')),
  ];

  const patterns = detectPatterns(stream, { threshold: 3, window: 10 });
  assert.ok(patterns.length > 0, 'at least one pattern should fire for leak guard to be meaningful');

  for (const p of patterns) {
    const s = p.suggestion ?? '';
    assert.ok(!UUID_RE.test(s), `suggestion contains UUID-like string: ${s}`);
    assert.ok(!NUMERIC_ID_RE.test(s), `suggestion contains numeric ID pattern: ${s}`);
  }
});

// --- pathological / empty / malformed inputs do not crash ------------------

test('all detectors handle null / undefined / empty without crash', () => {
  for (const fn of [detectRisingFailRate, detectCrossSkillCorrelation, detectRegression]) {
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn(undefined));
    assert.doesNotThrow(() => fn([]));
    assert.doesNotThrow(() => fn([null, undefined, 42, {}, { verdict: 'FAIL' }]));
  }
});

test('all detectors return [] on malformed input, not error', () => {
  const junk = [null, {}, { verdict: 123, gate_id: null }, { verdict: 'FAIL', affected_artifacts: 'oops' }];
  assert.deepEqual(detectRisingFailRate(junk), []);
  assert.deepEqual(detectCrossSkillCorrelation(junk), []);
  assert.deepEqual(detectRegression(junk), []);
});
