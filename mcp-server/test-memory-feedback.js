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
