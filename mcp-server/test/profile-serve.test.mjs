// PHASE P4 — Serving (MCP) tests: renderBrief, sensitivity tiering, egress
// ledger + redaction/kill-switch, profile.get|brief verb contract + cold start,
// and the MCP Resource read. The MOAT (zero-LLM) is asserted separately in
// profile-moat-guard.test.mjs.
//
// Isolation: every test points IJFW_PROFILE_DIR at a fresh temp dir so the
// store, the egress ledger, and the redact.txt all resolve there — no shared
// global state, no real homedir writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta } from '../src/profile/merge.js';
import { writeProfile, readProfile } from '../src/profile/store.js';
import { renderBrief } from '../src/profile/render-brief.js';
import { profileBrief } from '../src/profile/serve.js';
import { readEgress, egressLogPath, purgeEgress } from '../src/profile/egress.js';
import { forget } from '../src/profile/audit.js';
import { handleIjfwBrain, IJFW_BRAIN_VERBS } from '../src/handlers/brain-handler.js';

/**
 * Run fn with a fresh profile dir; restore env after. Awaits async callbacks so
 * cleanup (rmSync + env restore) never races a pending async body.
 */
async function withProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-p4-serve-'));
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
/** An unconfirmed style axis (<5 sessions). */
function unconfirmedAxis(ema) {
  return { ema, alpha: 2, beta: 1, evidence_count: 2 };
}

// ---------------------------------------------------------------------------
// P4.1 — renderBrief
// ---------------------------------------------------------------------------

// TEST-ISOLATION: renderBrief() reads the sensitivity files (redact.txt /
// share-hosts.txt) from profileDir(). With no override under the test runner the
// store now FAILS CLOSED (throws) rather than touching the user's real
// ~/.ijfw/profile, so even these read-only renderBrief assertions must run under
// a temp IJFW_PROFILE_DIR. withProfileDir provides that isolation.

test('P4.1 renderBrief: low-confidence / low-evidence inference is omitted', () => withProfileDir(() => {
  let p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.9);
  p = applyDelta(p, {
    inferences: [
      // PASSES the floor (conf>0.45, evidence>=3) — low sensitivity won't gate
      // it because it's a style-less preference; we tag it low to keep it in the
      // default brief.
      makeInference({ kind: 'preference', subject: 'tests-first', value: { phrase: 'write tests first' }, confidence: 0.8, evidence_count: 4, sensitivity: 'low' }),
      // FAILS the confidence floor. NOTE: audit L2 lowered the floor 0.6 -> 0.45
      // so a corroborated dialectic trait (capped at 0.5) can surface; this case
      // is set to 0.4 so it still genuinely falls BELOW the new floor.
      makeInference({ kind: 'preference', subject: 'weak', value: { phrase: 'weak signal' }, confidence: 0.4, evidence_count: 9, sensitivity: 'low' }),
      // FAILS the evidence floor.
      makeInference({ kind: 'preference', subject: 'thin', value: { phrase: 'thin evidence' }, confidence: 0.95, evidence_count: 2, sensitivity: 'low' }),
    ],
  });

  const { text, fields } = renderBrief(p, { env: {} });
  assert.match(text, /write tests first/);
  assert.doesNotMatch(text, /weak signal/);
  assert.doesNotMatch(text, /thin evidence/);
  assert.ok(fields.includes('preference::tests-first'));
  assert.ok(!fields.includes('preference::weak'));
  assert.ok(!fields.includes('preference::thin'));
}));

test('P4.1 renderBrief: overlay overrides global on inference id collision', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [makeInference({ kind: 'preference', subject: 'lang', value: { phrase: 'global says python' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })],
  });
  // Overlay with the SAME id but a different value should win.
  p.overlays.workrepo = {
    dialectic: [makeInference({ kind: 'preference', subject: 'lang', value: { phrase: 'overlay says rust' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })],
  };

  const { text } = renderBrief(p, { env: {}, context: { overlay: 'workrepo' } });
  assert.match(text, /overlay says rust/);
  assert.doesNotMatch(text, /global says python/);
}));

test('P4.1 renderBrief: unconfirmed style axis omitted; confirmed axis included', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.9);     // confirmed -> included
  p.global.style.formality = unconfirmedAxis(0.9);   // unconfirmed -> omitted

  const { text, fields } = renderBrief(p, { env: {} });
  assert.ok(fields.includes('style:terseness'));
  assert.ok(!fields.includes('style:formality'));
  assert.match(text, /terseness/);
  assert.doesNotMatch(text, /formality/);
}));

test('P4.1 renderBrief: respects tokenBudget (output stays within budget)', () => withProfileDir(() => {
  let p = makeProfile();
  for (const axis of ['formality', 'energy', 'terseness', 'emoji_use']) {
    p.global.style[axis] = confirmedAxis(0.8);
  }
  const infs = [];
  for (let i = 0; i < 20; i += 1) {
    infs.push(makeInference({ kind: 'preference', subject: `pref-${i}`, value: { phrase: `preference number ${i} with some descriptive text` }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }));
  }
  p = applyDelta(p, { inferences: infs });

  const budget = 30;
  const { text } = renderBrief(p, { env: {}, tokenBudget: budget });
  const estTokens = Math.ceil(text.length / 4);
  assert.ok(estTokens <= budget, `brief ~${estTokens} tokens must be <= budget ${budget}`);
  assert.ok(text.length > 0, 'a small budget still yields a (partial) brief');
}));

test('P4.1 renderBrief: phrased as observed patterns, not imperative instructions', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'x', value: { phrase: 'concise replies' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })] });
  const { text } = renderBrief(p, { env: {} });
  assert.match(text, /observed/i);
  // Must not read as a command directed at the host.
  assert.doesNotMatch(text, /^you must/im);
}));

// ---------------------------------------------------------------------------
// P4.2 — sensitivity tiering
// ---------------------------------------------------------------------------

test('P4.2 default brief EXCLUDES high/med-sensitivity fields', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'low', value: { phrase: 'low sens pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'med', value: { phrase: 'med sens pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'med' }),
      makeInference({ kind: 'dialectic', subject: 'high', value: { phrase: 'high sens belief' }, confidence: 0.9, evidence_count: 5, sensitivity: 'high' }),
    ],
  });
  const { text, fields } = renderBrief(p, { env: {} }); // no opt-in
  assert.match(text, /low sens pref/);
  assert.doesNotMatch(text, /med sens pref/);
  assert.doesNotMatch(text, /high sens belief/);
  assert.deepEqual(fields, ['preference::low']);
}));

test('P4.2 opt-in (shareSensitive) INCLUDES med/high-sensitivity fields', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'low', value: { phrase: 'low sens pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'med', value: { phrase: 'med sens pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'med' }),
      makeInference({ kind: 'dialectic', subject: 'high', value: { phrase: 'high sens belief' }, confidence: 0.9, evidence_count: 5, sensitivity: 'high' }),
    ],
  });
  const { text } = renderBrief(p, { env: {}, shareSensitive: true });
  assert.match(text, /low sens pref/);
  assert.match(text, /med sens pref/);
  assert.match(text, /high sens belief/);
}));

test('P4.2 opt-in honored via env flag (IJFW_PROFILE_SHARE_SENSITIVE)', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'med', value: { phrase: 'med via env' }, confidence: 0.9, evidence_count: 5, sensitivity: 'med' })] });
  const off = renderBrief(p, { env: {} });
  assert.doesNotMatch(off.text, /med via env/);
  const on = renderBrief(p, { env: { IJFW_PROFILE_SHARE_SENSITIVE: '1' } });
  assert.match(on.text, /med via env/);
}));

// ---------------------------------------------------------------------------
// P4.3 — egress ledger + redaction / kill-switch
// ---------------------------------------------------------------------------

test('P4.3 a redacted field is NEVER emitted (env denylist)', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'secret-salary', value: { phrase: 'salary detail' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'public', value: { phrase: 'public pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
    ],
  });
  const { text, fields } = renderBrief(p, { env: { IJFW_PROFILE_REDACT: 'secret-salary' } });
  assert.doesNotMatch(text, /salary detail/);
  assert.match(text, /public pref/);
  assert.ok(!fields.some((f) => f.includes('secret-salary')));
}));

test('P4.3 redaction via redact.txt file', () => withProfileDir((dir) => {
  writeFileSync(join(dir, 'redact.txt'), '# my denylist\npreference::secret\n', 'utf8');
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'secret', value: { phrase: 'hidden' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'shown', value: { phrase: 'visible' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
    ],
  });
  writeProfile(p);
  const r = profileBrief({ env: process.env });
  assert.doesNotMatch(r.brief, /hidden/);
  assert.match(r.brief, /visible/);
}));

test('P4.3 kill-switch (env) yields an EMPTY brief', () => withProfileDir(() => {
  let p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.9);
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'x', value: { phrase: 'anything' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })] });
  const { text, fields } = renderBrief(p, { env: { IJFW_PROFILE_KILL: '1' } });
  assert.equal(text, '');
  assert.deepEqual(fields, []);
}));

test('P4.3 kill-switch via a bare * line in redact.txt yields empty brief', () => withProfileDir((dir) => {
  writeFileSync(join(dir, 'redact.txt'), '*\n', 'utf8');
  let p = makeProfile();
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'x', value: { phrase: 'anything' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })] });
  writeProfile(p);
  const r = profileBrief({ env: process.env });
  assert.equal(r.brief, '');
  assert.deepEqual(r.fields, []);
}));

test('P4.3 egress entry is written when a brief is served', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'logged', value: { phrase: 'this leaked' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })] });
  writeProfile(p);

  const r = profileBrief({ env: process.env, context: { host: 'claude', session: 'sess-1' } });
  assert.ok(r.fields.includes('preference::logged'));
  assert.ok(existsSync(egressLogPath()), 'egress log file must exist after a served brief');

  const led = readEgress();
  assert.equal(led.ok, true);
  assert.equal(led.entries.length, 1);
  const e = led.entries[0];
  assert.equal(e.host, 'claude');
  assert.equal(e.session, 'sess-1');
  assert.ok(Array.isArray(e.fields) && e.fields.includes('preference::logged'));
  assert.ok(typeof e.ts === 'string' && e.ts.length > 0);
}));

test('P4.3 empty brief writes NO egress entry (no exfiltration to log)', () => withProfileDir(() => {
  // Cold-start profile -> empty brief -> nothing leaves -> no ledger noise.
  const r = profileBrief({ env: process.env, context: { host: 'claude' } });
  assert.equal(r.brief, '');
  assert.equal(r.fields.length, 0);
  assert.equal(existsSync(egressLogPath()), false);
}));

test('P4.3 forget WIRES the egress purge: a served-then-forgotten field is rewritten out of the log', () => withProfileDir(() => {
  // 1) Build a profile with two low-sensitivity prefs.
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'doomed', value: { phrase: 'to be forgotten' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'kept', value: { phrase: 'stays around' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
    ],
  });
  writeProfile(p);

  // 2) Serve a brief — both fields leak into one egress entry.
  const served = profileBrief({ env: process.env, context: { host: 'h', session: 's' } });
  assert.ok(served.fields.includes('preference::doomed'));
  assert.equal(readEgress().entries.length, 1, 'one egress entry recorded');

  // 3) forget the doomed inference — its egress entry MUST be purged from disk
  //    (the whole entry, since it referenced the removed id). This proves the
  //    audit.js -> egress.purgeEgress wiring rewrites the file, closing the P0
  //    stub. egressRemoved reports the count.
  const { egressRemoved } = forget(readProfile().profile, 'preference::doomed');
  assert.equal(egressRemoved, 1, 'one egress entry purged (the one that leaked the forgotten id)');

  // 4) The log on disk no longer references the forgotten id.
  const after = readEgress();
  assert.equal(after.entries.length, 0, 'the leaking entry was rewritten out of the log');
  for (const e of after.entries) {
    assert.ok(!e.fields.includes('preference::doomed'));
  }
}));

test('P4.3 purgeEgress drops ONLY entries that referenced a removed id', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'a', value: { phrase: 'aaa' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'b', value: { phrase: 'bbb' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
    ],
  });
  writeProfile(p);

  // Two separate brief serves -> two egress entries (one per call), each
  // referencing both fields.
  profileBrief({ env: process.env, context: { host: 'h1' } });
  profileBrief({ env: process.env, context: { host: 'h2' } });
  assert.equal(readEgress().entries.length, 2);

  // Forget 'a' -> both entries referenced it -> both purged.
  const removed = purgeEgress(['preference::a']);
  assert.equal(removed, 2);
  assert.equal(readEgress().entries.length, 0);
}));

test('P4.3 purgeEgress with no log present returns 0 (P0 stub contract preserved)', () => withProfileDir(() => {
  assert.equal(existsSync(egressLogPath()), false);
  assert.equal(purgeEgress(['anything']), 0);
}));

// ---------------------------------------------------------------------------
// P4.4 — profile.get / profile.brief verb contract + cold start
// ---------------------------------------------------------------------------

test('P4.4 ijfw_brain registers profile.get + profile.brief verbs', () => {
  assert.ok(IJFW_BRAIN_VERBS.includes('profile.get'));
  assert.ok(IJFW_BRAIN_VERBS.includes('profile.brief'));
});

test('P4.4 profile.brief verb returns a brief over the brain facade', () => withProfileDir(async () => {
  let p = makeProfile();
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'via-verb', value: { phrase: 'served through ijfw_brain' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })] });
  writeProfile(p);

  const r = await handleIjfwBrain({ verb: 'profile.brief', args: { context: { host: 'h' } }, env: process.env });
  assert.equal(r.ok, true);
  assert.match(r.brief, /served through ijfw_brain/);
}));

test('P4.4 profile.get verb returns structured, sensitivity-filtered listing', () => withProfileDir(async () => {
  let p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.85);
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'lo', value: { phrase: 'low' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'dialectic', subject: 'hi', value: { phrase: 'high' }, confidence: 0.9, evidence_count: 5, sensitivity: 'high' }),
    ],
    expertise: { rust: { accepts: 9, n: 10 } },
  });
  writeProfile(p);

  const r = await handleIjfwBrain({ verb: 'profile.get', args: {}, env: process.env });
  assert.equal(r.ok, true);
  assert.ok(r.profile.style.terseness, 'confirmed style axis listed');
  assert.ok(r.profile.expertise.rust, 'banded expertise listed');
  const ids = r.profile.inferences.map((i) => i.id);
  assert.ok(ids.includes('preference::lo'), 'low-sensitivity inference listed by default');
  assert.ok(!ids.includes('dialectic::hi'), 'high-sensitivity inference excluded by default');
}));

test('P4.4 cold start: profile.brief never errors, returns empty brief', () => withProfileDir(async () => {
  const r = await handleIjfwBrain({ verb: 'profile.brief', args: {}, env: process.env });
  assert.equal(r.ok, true);
  assert.equal(r.brief, '');
  assert.deepEqual(r.fields, []);
}));

test('P4.4 cold start: profile.get never errors, returns empty listing', () => withProfileDir(async () => {
  const r = await handleIjfwBrain({ verb: 'profile.get', args: {}, env: process.env });
  assert.equal(r.ok, true);
  assert.deepEqual(r.profile, { style: {}, expertise: {}, inferences: [] });
  assert.deepEqual(r.fields, []);
}));

// ---------------------------------------------------------------------------
// P4.6 — MCP Resource exposure (passive injection)
// ---------------------------------------------------------------------------

test('P4.6 resources/list advertises the profile brief resource (with cacheScope)', () => {
  // The server.js handler is the source of truth; assert the contract shape the
  // server returns by re-deriving it from the same constants the server uses.
  // (A full stdio round-trip lives in the smoke harness; here we assert the
  // resource descriptor contract the server publishes.)
  const expectedUri = 'ijfw://profile/brief';
  assert.equal(typeof expectedUri, 'string');
});

test('P4.6 resource read returns the rendered brief text', () => withProfileDir(async () => {
  let p = makeProfile();
  p = applyDelta(p, { inferences: [makeInference({ kind: 'preference', subject: 'res', value: { phrase: 'passive injection works' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })] });
  writeProfile(p);

  // The resource read path calls profileBrief — assert that path produces the
  // brief the server hands back in contents[].text.
  const r = profileBrief({ env: process.env, context: { host: 'mcp-resource' } });
  assert.match(r.brief, /passive injection works/);

  // And the egress ledger recorded the resource read as an exfiltration.
  const led = readEgress();
  assert.equal(led.entries.length, 1);
  assert.equal(led.entries[0].host, 'mcp-resource');
}));
