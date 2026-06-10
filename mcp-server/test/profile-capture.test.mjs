// PHASE P1 — Capture hardening + anti-poison + anti-drift.
//
// The INPUT side of the cross-system profile bus: turn real sessions into the
// per-session METADATA the P2 heuristic derivation (src/profile/derive-heuristic.js)
// consumes. These tests pin:
//   - METADATA ONLY: the output file NEVER contains raw transcript text (P1.1)
//   - the wire record field names/semantics line up with deriveStyle's inputs
//   - P1.2 profile-influenced sessions are tagged + excluded from re-derivation
//   - P1.3 CI / shared / multi-tenant contexts are quarantined from the GLOBAL profile
//   - P1.4 per-host trust weight + single-session influence cap + asymmetric decay
//   - P1.5 PII / special-category deny-gate BEFORE persist
//   - P1.6 identity partitioning (two OS users -> two identities, no blending)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractMessageMetadata,
  captureMessage,
  flushSession,
  accumulatorPath,
  styleFilePath,
  toDeriveMeta,
  assertNoSpecialCategory,
  detectQuarantine,
  computeIdentity,
  trustWeightForHost,
  cappedDelta,
  asymmetricStep,
  STYLE_DELTA_CAP,
  SPECIAL_CATEGORY_KEYS,
} from '../src/profile/capture.js';
import { deriveStyle, deriveHeuristic } from '../src/profile/derive-heuristic.js';

// A fresh, isolated repo root per test so the .ijfw/ files never collide and
// never touch the developer's real project state.
function freshRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-capture-'));
  return dir;
}

function readLines(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// P1.1 — metadata-only capture.
// ---------------------------------------------------------------------------

test('P1.1 extractMessageMetadata emits ONLY counts — never the message text', () => {
  const secret = 'My SSN is 123-45-6789 and I really love using emoji 🚀🔥 in code blocks';
  const text = `${secret}\n\`\`\`js\nconst x = 1;\n\`\`\`\nPlease kindly review, thank you.`;
  const meta = extractMessageMetadata(text);

  // Shape: numeric metadata only.
  assert.equal(typeof meta.chars, 'number');
  assert.equal(typeof meta.emojis, 'number');
  assert.equal(typeof meta.hasCode, 'boolean');
  assert.equal(typeof meta.formalityHits, 'number');

  // CRITICAL: no VALUE anywhere may carry the raw text. (We check values, not
  // keys — a field named e.g. `emojis` legitimately contains the substring
  // "emoji"; what must never appear is message CONTENT.)
  const values = JSON.stringify(Object.values(meta));
  assert.ok(!values.includes('123-45-6789'), 'metadata leaked the SSN');
  assert.ok(!values.includes('SSN'), 'metadata leaked message words');
  assert.ok(!values.includes('love'), 'metadata leaked message words');
  assert.ok(!values.includes('const x'), 'metadata leaked code text');
  // Every value is a primitive number/boolean — never a string of content.
  for (const v of Object.values(meta)) {
    assert.ok(typeof v === 'number' || typeof v === 'boolean', 'metadata value must be a primitive count');
  }

  // Sanity: it actually measured something.
  assert.ok(meta.chars > 0);
  assert.ok(meta.emojis >= 2, 'should count the two emoji');
  assert.equal(meta.hasCode, true, 'should detect the fenced code block');
  assert.ok(meta.formalityHits >= 1, '"please"/"thank you"/"kindly" are formality markers');
});

test('P1.1 captureMessage + flushSession writes the contract record with NO transcript text', () => {
  const root = freshRoot();
  try {
    const secret = 'CONFIDENTIAL-TRANSCRIPT-MARKER-9f3a do not leak me';
    captureMessage({ sessionId: 's1', text: `${secret} please`, cwd: root, env: {}, ts: 1000 });
    captureMessage({ sessionId: 's1', text: 'k thx 🙂', cwd: root, env: {}, ts: 6000 });

    const res = flushSession({ sessionId: 's1', cwd: root, env: {}, ts: 10000 });
    assert.equal(res.ok, true);

    const file = styleFilePath(root);
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('CONFIDENTIAL-TRANSCRIPT-MARKER-9f3a'), 'transcript text leaked to disk');
    assert.ok(!raw.includes('do not leak me'), 'transcript text leaked to disk');

    const rows = readLines(file);
    assert.equal(rows.length, 1, 'exactly one record per session');
    const rec = rows[0];
    // Contract field names (WIRING CONTRACT).
    for (const k of ['ts', 'session_id', 'host', 'avg_msg_chars', 'emoji_rate',
      'code_block_ratio', 'formality_markers', 'turn_cadence_s', 'msg_count']) {
      assert.ok(Object.prototype.hasOwnProperty.call(rec, k), `missing contract field ${k}`);
    }
    assert.equal(rec.session_id, 's1');
    assert.equal(rec.msg_count, 2);
    assert.ok(rec.avg_msg_chars > 0);
    // formality_markers + code_block_ratio are [0,1] (what deriveStyle consumes directly).
    assert.ok(rec.formality_markers >= 0 && rec.formality_markers <= 1);
    assert.ok(rec.code_block_ratio >= 0 && rec.code_block_ratio <= 1);
    assert.ok(rec.emoji_rate >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1.1 the wire record maps onto deriveStyle inputs (semantics line up)', () => {
  const root = freshRoot();
  try {
    captureMessage({ sessionId: 's1', text: 'short', cwd: root, env: {}, ts: 0 });
    captureMessage({ sessionId: 's1', text: 'terse 🔥', cwd: root, env: {}, ts: 3000 });
    flushSession({ sessionId: 's1', cwd: root, env: {}, ts: 5000 });
    const rec = readLines(styleFilePath(root))[0];

    // The adapter renames wire fields -> exactly the names deriveStyle reads.
    const meta = toDeriveMeta(rec);
    assert.ok('avg_msg_chars' in meta);
    assert.ok('emoji_per_msg' in meta, 'emoji_rate -> emoji_per_msg');
    assert.ok('turn_cadence_per_min' in meta, 'turn_cadence_s -> turn_cadence_per_min');
    assert.ok('formality_markers' in meta);
    assert.ok('code_block_ratio' in meta);

    // deriveStyle accepts it and returns full-weight observations for present axes.
    const style = deriveStyle(meta);
    for (const axis of ['formality', 'energy', 'terseness', 'emoji_use']) {
      assert.ok(style[axis], `missing axis ${axis}`);
      assert.ok(style[axis].sample >= 0 && style[axis].sample <= 1);
      assert.equal(style[axis].weight, 1, `${axis} should be observed (full weight)`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1.2 — tag profile-influenced sessions; exclude from re-derivation.
// ---------------------------------------------------------------------------

test('P1.2 a brief-injected session is tagged profile_influenced and excluded from re-derivation', () => {
  const root = freshRoot();
  try {
    // A normal message, then a message that fired with a profile brief injected.
    captureMessage({ sessionId: 's1', text: 'normal message here', cwd: root, env: {}, ts: 0 });
    captureMessage({ sessionId: 's1', text: 'terse', cwd: root, env: {}, ts: 2000, profileInjected: true });
    flushSession({ sessionId: 's1', cwd: root, env: {}, ts: 4000 });

    const rec = readLines(styleFilePath(root))[0];
    assert.equal(rec.profile_influenced, true, 'session must be flagged once any message had a brief injected');

    // A clean session is NOT flagged.
    const root2 = freshRoot();
    captureMessage({ sessionId: 's2', text: 'clean', cwd: root2, env: {}, ts: 0 });
    flushSession({ sessionId: 's2', cwd: root2, env: {}, ts: 1000 });
    const clean = readLines(styleFilePath(root2))[0];
    assert.notEqual(clean.profile_influenced, true, 'clean session must not be flagged');
    rmSync(root2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1.3 — context quarantine (CI / shared / multi-tenant) -> no GLOBAL contribution.
// ---------------------------------------------------------------------------

test('P1.3 CI environment quarantines the session from the GLOBAL profile', () => {
  const root = freshRoot();
  try {
    const ciEnv = { CI: 'true', GITHUB_ACTIONS: 'true' };
    captureMessage({ sessionId: 's1', text: 'build step output', cwd: root, env: ciEnv, ts: 0 });
    flushSession({ sessionId: 's1', cwd: root, env: ciEnv, ts: 1000 });
    const rec = readLines(styleFilePath(root))[0];
    assert.equal(rec.global_eligible, false, 'CI must be refused a global contribution');
    assert.ok(rec.quarantine_reason, 'a reason must be recorded');
    assert.match(String(rec.quarantine_reason), /ci/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1.3 detectQuarantine flags CI, shared, and multi-tenant signals; clean local passes', () => {
  // Clean local dev: eligible.
  assert.equal(detectQuarantine({ env: {}, cwd: '/Users/dev/project' }).quarantined, false);
  // CI vars.
  assert.equal(detectQuarantine({ env: { GITLAB_CI: 'true' }, cwd: '/x' }).quarantined, true);
  assert.equal(detectQuarantine({ env: { JENKINS_URL: 'http://ci' }, cwd: '/x' }).quarantined, true);
  // Shared / multi-tenant path heuristics.
  assert.equal(detectQuarantine({ env: {}, cwd: '/tmp/runner/work/repo' }).quarantined, true);
  assert.equal(detectQuarantine({ env: {}, cwd: '/var/lib/jenkins/workspace/x' }).quarantined, true);
});

// ---------------------------------------------------------------------------
// P1.4 — per-host trust weight + single-session influence cap + asymmetric decay.
// ---------------------------------------------------------------------------

test('P1.4 a single session cannot move an axis past the delta cap', () => {
  // An extreme observation (sample 1.0) against a neutral prior 0.5 must be
  // clamped so |applied - prior| <= STYLE_DELTA_CAP, regardless of weight.
  const prior = 0.5;
  const extreme = 1.0;
  const moved = cappedDelta(prior, extreme, { weight: 1, trust: 1 });
  assert.ok(Math.abs(moved - prior) <= STYLE_DELTA_CAP + 1e-9,
    `single session moved ${Math.abs(moved - prior)} > cap ${STYLE_DELTA_CAP}`);
  // And it moved in the right direction.
  assert.ok(moved > prior);
});

test('P1.4 a contradicting signal adapts faster than a confirming one (asymmetric decay)', () => {
  const current = 0.8; // axis currently believes "high"
  // A confirming sample (also high) and a contradicting sample (low), same magnitude of evidence.
  const confirmStep = asymmetricStep(current, 0.9); // same side -> small move
  const contradictStep = asymmetricStep(current, 0.1); // opposite side -> larger move per unit
  // Normalize by the raw gap so we compare RATE, not distance.
  const confirmRate = Math.abs(confirmStep - current) / Math.abs(0.9 - current);
  const contradictRate = Math.abs(contradictStep - current) / Math.abs(0.1 - current);
  assert.ok(contradictRate > confirmRate,
    `contradiction rate ${contradictRate} must exceed confirmation rate ${confirmRate}`);
});

test('P1.4 contradiction converges within N sessions', () => {
  // Start convinced of 0.9; feed a contradicting 0.1 each session. Must cross 0.5 within N.
  let v = 0.9;
  const N = 8;
  let crossed = -1;
  for (let i = 0; i < N; i++) {
    v = asymmetricStep(v, 0.1);
    if (crossed < 0 && v < 0.5) crossed = i + 1;
  }
  assert.ok(crossed > 0 && crossed <= N, `did not cross within ${N} sessions (final ${v})`);
});

test('P1.4 trust weight is per-host and bounded (0,1]', () => {
  const a = trustWeightForHost('claude-code');
  const b = trustWeightForHost('unknown-host-xyz');
  assert.ok(a > 0 && a <= 1);
  assert.ok(b > 0 && b <= 1);
  // A known/first-party host is trusted at least as much as an unknown one.
  assert.ok(a >= b);
  // Deterministic.
  assert.equal(trustWeightForHost('claude-code'), a);
});

// ---------------------------------------------------------------------------
// P1.5 — PII / special-category deny-gate BEFORE persist.
// ---------------------------------------------------------------------------

test('P1.5 assertNoSpecialCategory refuses special-category attributes', () => {
  // Each special-category key must be refused.
  for (const key of SPECIAL_CATEGORY_KEYS) {
    const res = assertNoSpecialCategory({ [key]: 'whatever' });
    assert.equal(res.ok, false, `special-category key ${key} must be refused`);
    assert.equal(res.refused, key);
  }
  // Interaction-STYLE attributes are allowed (that is what we DO store).
  const ok = assertNoSpecialCategory({ avg_msg_chars: 40, emoji_rate: 0.5, formality_markers: 0.3 });
  assert.equal(ok.ok, true);
});

test('P1.5 flushSession refuses to persist a record carrying a special-category attribute', () => {
  const root = freshRoot();
  try {
    captureMessage({ sessionId: 's1', text: 'hello', cwd: root, env: {}, ts: 0 });
    // An attacker/caller tries to smuggle a special-category attribute into the record.
    const res = flushSession({
      sessionId: 's1', cwd: root, env: {}, ts: 1000,
      extraAttributes: { religion: 'x' },
    });
    assert.equal(res.ok, false, 'must refuse to persist');
    assert.match(String(res.code || res.error || ''), /special|pii|denied/i);
    // Nothing was written.
    assert.equal(readLines(styleFilePath(root)).length, 0, 'no record may be persisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1.6 — identity partitioning + shared-machine stance.
// ---------------------------------------------------------------------------

test('P1.6 two OS users produce two distinct profile identities (no blending)', () => {
  const idA = computeIdentity({ env: { USER: 'alice' } });
  const idB = computeIdentity({ env: { USER: 'bob' } });
  assert.ok(idA.identity);
  assert.ok(idB.identity);
  assert.notEqual(idA.identity, idB.identity, 'distinct OS users must not share an identity');
  // Salted: the identity is not the raw username.
  assert.notEqual(idA.identity, 'alice');
  // Deterministic for the same user.
  assert.equal(computeIdentity({ env: { USER: 'alice' } }).identity, idA.identity);
});

test('P1.6 the flushed record carries the per-identity binding', () => {
  const root = freshRoot();
  try {
    captureMessage({ sessionId: 's1', text: 'hi', cwd: root, env: { USER: 'alice' }, ts: 0 });
    flushSession({ sessionId: 's1', cwd: root, env: { USER: 'alice' }, ts: 1000 });
    const rec = readLines(styleFilePath(root))[0];
    assert.ok(rec.identity, 'record must bind to an identity');
    assert.equal(rec.identity, computeIdentity({ env: { USER: 'alice' } }).identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1.6 an ambiguous shared machine refuses GLOBAL contribution', () => {
  // No resolvable OS user + a shared-machine signal => global ineligible, but
  // session-local capture still proceeds (we do not lose the data, we just
  // refuse to merge it into the cross-machine global profile).
  const root = freshRoot();
  try {
    captureMessage({ sessionId: 's1', text: 'hi', cwd: root, env: { IJFW_SHARED_MACHINE: '1' }, ts: 0 });
    flushSession({ sessionId: 's1', cwd: root, env: { IJFW_SHARED_MACHINE: '1' }, ts: 1000 });
    const rec = readLines(styleFilePath(root))[0];
    assert.equal(rec.global_eligible, false, 'ambiguous shared machine must refuse global contribution');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: capture -> derive (P1 output feeds P2 input cleanly).
// ---------------------------------------------------------------------------

test('E2E captured record drives deriveHeuristic, and influenced sessions are excludable', () => {
  const root = freshRoot();
  try {
    // A real local dev session: a resolvable OS user, no CI signals.
    const devEnv = { USER: 'devuser' };
    captureMessage({ sessionId: 's1', text: 'please kindly proceed', cwd: root, env: devEnv, ts: 0 });
    captureMessage({ sessionId: 's1', text: 'thanks 🙏', cwd: root, env: devEnv, ts: 4000 });
    flushSession({ sessionId: 's1', cwd: root, env: devEnv, ts: 8000 });
    const rec = readLines(styleFilePath(root))[0];

    // The dream/derive stage filters out profile_influenced records, then derives.
    const eligible = [rec].filter((r) => r.profile_influenced !== true && r.global_eligible !== false);
    assert.equal(eligible.length, 1);
    const delta = deriveHeuristic({ metadata: toDeriveMeta(eligible[0]), sessionId: rec.session_id, host: rec.host });
    assert.ok(delta.style, 'a clean captured session yields a style delta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
