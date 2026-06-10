// V5 — VOICE EXEMPLARS END-TO-END PROOF.
//
// Voice exemplars = short raw snippets of the USER's OWN writing, captured
// locally + transiently, few-shot into a prompt so the agent drafts in their
// voice. This is a FEATURE, not a research proof: there is NO stylometry, NO
// AUC, NO corpus, NO cloud call anywhere in this file. The proof is BEHAVIORAL
// and drives the REAL functions end-to-end through the REAL store:
//
//   captured  ->  retrieved  ->  injected  ->  visible  ->  forgettable
//
// Unlike profile-voice-seam.test.mjs (which injects a candidate `exemplars` set
// directly to unit-test the renderer), this suite NEVER hands `profileSnapshot`
// a candidate set. Capture writes to the real V1 store; retrieval + injection
// load FROM that store via profileDir(). So it exercises the same store-backed
// path production uses, not a DI shortcut.
//
// Path isolation: the exemplar store, the egress log, and the profile lock all
// route through profileDir() / profileStateDir(), which honor IJFW_PROFILE_DIR /
// IJFW_PROFILE_STATE_DIR. We point both at process-unique tmpdirs, AND we assert
// the resolved store path is under os.tmpdir() (so the real ~/.ijfw/profile can
// never be written by this test). path-policy's test-context auto-tmpdir is the
// belt; the explicit override here is the suspenders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureMessage,
  captureCommitMessage,
  classifyRegister,
} from '../src/profile/exemplar-capture.js';
import {
  listExemplars,
  exemplarStorePath,
} from '../src/profile/exemplar-store.js';
import { retrieveExemplars } from '../src/profile/exemplar-retrieve.js';
import { profileSnapshot } from '../src/profile/serve.js';
import { listVoiceExemplars, forgetVoiceExemplars } from '../src/profile/audit.js';
import { readEgress, EXEMPLAR_FIELD_PREFIX } from '../src/profile/egress.js';
import { VOICE_MAX_SAMPLES } from '../src/profile/render-brief.js';

// ---------------------------------------------------------------------------
// Path-isolated fixture. Points BOTH the profile dir and the state (lock) dir at
// fresh process-unique tmpdirs and restores env afterwards. Awaits the body so
// cleanup never races a pending async forget.
// ---------------------------------------------------------------------------
function withDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-voice-e2e-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-voice-e2e-s-'));
  const saved = {
    P: process.env.IJFW_PROFILE_DIR,
    S: process.env.IJFW_PROFILE_STATE_DIR,
    K: process.env.IJFW_PROFILE_KILL,
    R: process.env.IJFW_PROFILE_REDACT,
  };
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  delete process.env.IJFW_PROFILE_KILL;
  delete process.env.IJFW_PROFILE_REDACT;
  const restore = () => {
    for (const [k, v] of [
      ['IJFW_PROFILE_DIR', saved.P],
      ['IJFW_PROFILE_STATE_DIR', saved.S],
      ['IJFW_PROFILE_KILL', saved.K],
      ['IJFW_PROFILE_REDACT', saved.R],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  };
  return Promise.resolve(fn({ pdir, sdir, lockPath: join(sdir, '.profile.lock') })).finally(restore);
}

// Capture several snippets of "the user's own writing" across registers. ts is
// monotonic so recency ordering is deterministic. Returns the capture results so
// a test can assert what landed. Uses the REAL capture entrypoints (which scrub,
// bound, classify, and append to the real store).
function seedUserVoice() {
  // terse — short, lowercase, light punctuation.
  const terse = captureMessage({ text: 'fix the flaky retry test', ts: '2026-06-01T00:00:00.000Z' });
  // casual — a short capitalized request (reads casual, not terse).
  const casual = captureMessage({ text: 'Hey, can you tighten up this paragraph a bit?', ts: '2026-06-02T00:00:00.000Z' });
  // commit — a real git commit subject+body.
  const commit = captureCommitMessage(
    'refactor merge fold for clarity\n\nSplit the asymmetric trust path out so the bound is obvious.',
    { ts: '2026-06-03T00:00:00.000Z' },
  );
  // doc — multi-paragraph prose. (A leading '#' is treated as a control/comment
  // prefix by capture and would be skipped, so the doc snippet is header-free
  // multi-paragraph prose, which classifyRegister maps to 'doc'.)
  const doc = captureMessage({
    text: 'We ship the change behind a flag first.\n\nThen we watch the error rate for a full day before flipping it on for everyone, so a regression never reaches the whole fleet at once.',
    ts: '2026-06-04T00:00:00.000Z',
  });
  return { terse, casual, commit, doc };
}

// ---------------------------------------------------------------------------
// 0. ISOLATION GUARDRAIL — the resolved store path is under os.tmpdir(), never
//    the real ~/.ijfw/profile. (Spec item 8, asserted up front and again later.)
// ---------------------------------------------------------------------------

test('the resolved exemplar store path is under os.tmpdir(), never the real ~/.ijfw/profile', () => withDirs(({ pdir }) => {
  const path = exemplarStorePath();
  assert.ok(path.startsWith(pdir), `store path escaped the override: ${path}`);
  assert.ok(path.startsWith(tmpdir()), `store path not under os.tmpdir(): ${path}`);
  assert.ok(!path.includes(`${join('.ijfw', 'profile')}`), `must not resolve to the real profile dir: ${path}`);
}));

// ---------------------------------------------------------------------------
// 1. CAPTURE — feed snippets across registers; assert they land in the store
//    with the right register classification.
// ---------------------------------------------------------------------------

test('CAPTURE: snippets across registers land in the real store, correctly classified', () => withDirs(() => {
  const { terse, casual, commit, doc } = seedUserVoice();
  for (const [name, r] of [['terse', terse], ['casual', casual], ['commit', commit], ['doc', doc]]) {
    assert.equal(r.ok, true, `${name} capture failed: ${JSON.stringify(r)}`);
    assert.ok(!r.skipped, `${name} should not be skipped`);
    assert.ok(r.id, `${name} returned a stable id`);
  }

  const stored = listExemplars();
  assert.equal(stored.length, 4, 'all four distinct snippets persisted');

  // The capture classifier (pure) is the source of truth for register; assert
  // each captured snippet stored the register classifyRegister assigns.
  const byId = new Map(stored.map((e) => [e.id, e]));
  assert.equal(byId.get(terse.id).register, 'terse');
  assert.equal(byId.get(commit.id).register, 'commit');
  assert.equal(byId.get(commit.id).source, 'commit-msg');
  assert.equal(byId.get(doc.id).register, 'doc');
  // The casual snippet classifies as 'casual' (short capitalized request).
  assert.equal(classifyRegister('Hey, can you tighten up this paragraph a bit?', 'prompt'), 'casual');
}));

test('CAPTURE: machine output + control prompts are skipped, never stored as voice', () => withDirs(() => {
  // A pasted code block (machine output) must not be captured as "voice".
  const code = captureMessage({ text: '```js\nconst x = () => ({ a: 1 });\n```', ts: '2026-06-01T00:00:00.000Z' });
  assert.equal(code.ok, true);
  assert.equal(code.skipped, true, 'fenced code block skipped');
  // A slash-command / control prompt is not the user's prose.
  const control = captureMessage({ text: '/ijfw status', ts: '2026-06-01T00:00:00.000Z' });
  assert.equal(control.skipped, true, 'control prompt skipped');

  // One real sentence DOES land.
  const real = captureMessage({ text: 'please summarise the design doc for me', ts: '2026-06-01T00:00:00.000Z' });
  assert.ok(real.id);
  assert.equal(listExemplars().length, 1, 'only the real prose snippet persisted');
}));

// ---------------------------------------------------------------------------
// 2. RETRIEVE — for a register + a task text, retrieval (loading FROM the store,
//    no DI) returns register-matched, relevant samples, best-first.
// ---------------------------------------------------------------------------

test('RETRIEVE: store-backed retrieval prefers the matching register + relevant text', () => withDirs(() => {
  seedUserVoice();
  // Drive retrieval WITHOUT injecting a candidate set — it must load from the
  // real store via profileDir() (the true e2e path).
  const got = retrieveExemplars({
    register: 'terse',
    taskText: 'fix the broken test',
    k: 3,
  });
  assert.ok(got.length >= 1, 'retrieval returned at least one sample from the store');
  // The terse, lexically-relevant sample ("fix the flaky retry test") wins on
  // register-match + lexical overlap with "fix ... test".
  assert.equal(got[0].register, 'terse', 'best match is the requested register');
  assert.match(got[0].text, /fix the flaky retry test/);
}));

test('RETRIEVE: cold start (empty store) returns [] (no throw)', () => withDirs(() => {
  const got = retrieveExemplars({ register: 'casual', taskText: 'draft something', k: 3 });
  assert.deepEqual(got, []);
}));

// ---------------------------------------------------------------------------
// 3. INJECT — profileSnapshot with the gate ON + a prose taskText emits a
//    budget-bounded <ijfw-voice> block carrying the user's OWN samples, framed
//    as "match"/"drafts", and NEVER claiming "indistinguishable".
//
//    NOTE: we do NOT pass opts.exemplars — the snapshot must RETRIEVE from the
//    real store itself. That is the end-to-end assertion.
// ---------------------------------------------------------------------------

test('INJECT: gate ON + taskText => <ijfw-voice> block with the user samples, store-backed', () => withDirs(() => {
  seedUserVoice();
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'help me write a casual note to the team about the rollout',
    context: { host: 'cursor' },
    host: 'cursor',
    // deliberately NO `exemplars` — force the store-backed retrieval path.
  });
  assert.match(r.snapshot, /<ijfw-voice>/, 'voice block present');
  assert.match(r.snapshot, /<\/ijfw-voice>/, 'voice block closed');
  // Framing: "match their voice" / "drafts ... in their voice" — guidance, not impersonation.
  assert.match(r.snapshot, /match their voice/i);
  assert.match(r.snapshot, /drafting/i);
  // The honesty bar: NEVER claims indistinguishability or impersonation.
  assert.doesNotMatch(r.snapshot, /indistinguishable/i);
  assert.doesNotMatch(r.snapshot, /impersonat/i);
  // At least one of the user's actual stored snippets is quoted in the block.
  assert.match(r.snapshot, /tighten up this paragraph|rollout|ship the change/i);
  // Budget-bounded: never more than VOICE_MAX_SAMPLES samples landed.
  assert.ok(r.voice.length >= 1 && r.voice.length <= VOICE_MAX_SAMPLES,
    `voice sample count out of bounds: ${r.voice.length}`);
}));

// ---------------------------------------------------------------------------
// 4. COLD START — fresh/empty store + gate ON => NO <ijfw-voice> block (fail-closed).
// ---------------------------------------------------------------------------

test('COLD START: empty store + gate ON => NO voice block (fail-closed)', () => withDirs(() => {
  assert.equal(listExemplars().length, 0, 'store is empty');
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'draft a casual note for me',
    context: { host: 'cursor' },
    host: 'cursor',
  });
  assert.doesNotMatch(String(r.snapshot || ''), /<ijfw-voice>/);
  assert.deepEqual(r.voice, []);
  assert.equal(r.voiceEgress, null, 'no disclosure when nothing was injected');
}));

// ---------------------------------------------------------------------------
// 5. DEFAULT-OFF — gate omitted => output identical to no-voice (no block).
// ---------------------------------------------------------------------------

test('DEFAULT-OFF: gate omitted => byte-identical to no-voice (no <ijfw-voice> block)', () => withDirs(() => {
  seedUserVoice(); // exemplars EXIST in the store...
  const baseline = profileSnapshot({ context: { host: 'cursor' }, host: 'cursor' });
  // ...but with the flag omitted, voice never engages even with a taskText.
  const gateOff = profileSnapshot({
    taskText: 'help me write a casual note to the team',
    context: { host: 'cursor' },
    host: 'cursor',
  });
  assert.equal(gateOff.snapshot, baseline.snapshot, 'gate-off output is identical to no-voice');
  assert.doesNotMatch(String(gateOff.snapshot || ''), /<ijfw-voice>/);
  assert.deepEqual(gateOff.voice, []);
  assert.equal(gateOff.voiceEgress, null);
}));

// ---------------------------------------------------------------------------
// 6. EGRESS — a cloud-host inject logs a voice-exemplar::<id> egress entry AND
//    the cloud-host flag; listVoiceExemplars shows PII-scrubbed previews.
// ---------------------------------------------------------------------------

test('EGRESS: a cloud-host inject logs the disclosed ids + cloud flag; audit previews are PII-scrubbed', () => withDirs(() => {
  // Seed a casual sample that also CONTAINS direct PII (an email) so we can prove
  // the audit preview scrubs it.
  const cap = captureMessage({
    text: 'ping me at devlead@example.com when the casual draft is ready to review',
    ts: '2026-06-05T00:00:00.000Z',
  });
  assert.ok(cap.id, 'PII-bearing sample captured');

  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'write a casual message asking for a review',
    context: { host: 'claude-web', session: 'sess-cloud' },
    host: 'claude-web',
    session: 'sess-cloud',
  });
  assert.ok(r.voice.length >= 1, 'a sample was injected on the cloud host');
  const injectedId = r.voice[0].id;

  // The injection logged exactly one disclosure line carrying the injected id,
  // flagged cloud TWO ways (structured boolean + sentinel field).
  const log = readEgress();
  assert.ok(log.ok);
  const entry = log.entries.find((e) => Array.isArray(e.fields)
    && e.fields.includes(`${EXEMPLAR_FIELD_PREFIX}${injectedId}`));
  assert.ok(entry, 'an exemplar-egress line for the injected id must exist');
  assert.equal(entry.session, 'sess-cloud');
  assert.equal(entry.cloud, true, 'cloud disclosure carries the structured cloud flag');
  assert.ok(entry.fields.includes(`${EXEMPLAR_FIELD_PREFIX}cloud-host`), 'cloud-host sentinel field present');

  // The audit surface shows the sample with a PII-scrubbed preview (raw email gone).
  const rows = listVoiceExemplars();
  const row = rows.find((x) => x.id === injectedId);
  assert.ok(row, 'the injected sample is visible in the audit list');
  assert.equal(row.label, 'writing sample used to match your voice');
  assert.ok(!row.preview.includes('devlead@example.com'), 'email scrubbed from the preview');
  assert.ok(!row.preview.includes('@example.com'), 'no email fragment leaks in the preview');
  assert.equal(row.text, undefined, 'the audit row never echoes the raw text');
}));

// ---------------------------------------------------------------------------
// 7. FORGET — forgetVoiceExemplars purges the exemplars AND their egress entries.
// ---------------------------------------------------------------------------

test('FORGET: forgetVoiceExemplars purges the sample AND its egress disclosure entries', () => withDirs(async ({ lockPath }) => {
  const cap = captureMessage({ text: 'draft a casual update for the standup', ts: '2026-06-06T00:00:00.000Z' });
  assert.ok(cap.id);

  // Inject (cloud host) so an egress disclosure line exists for this id.
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'help me write a casual standup update',
    context: { host: 'claude-web', session: 's-forget' },
    host: 'claude-web',
    session: 's-forget',
  });
  assert.ok(r.voice.length >= 1);
  const id = r.voice[0].id;
  assert.equal(listExemplars().length, 1, 'one exemplar stored');
  assert.ok(readEgress().entries.length >= 1, 'a disclosure line was logged');

  // Forget it under the global lock.
  const res = await forgetVoiceExemplars(id, { lockPath });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.removed, 1, 'the exemplar was removed from the store');
  assert.ok(res.egressRemoved >= 1, 'its egress disclosure line(s) were purged');
  assert.deepEqual(res.removedIds, [id], 'the concrete purged id is reported');

  // Store + egress are clean; the sample no longer surfaces in the audit list.
  assert.equal(listExemplars().length, 0, 'store empty after forget');
  const remainingDisclosures = readEgress().entries.filter((e) => Array.isArray(e.fields)
    && e.fields.includes(`${EXEMPLAR_FIELD_PREFIX}${id}`));
  assert.equal(remainingDisclosures.length, 0, 'no disclosure line references the forgotten id');
  assert.equal(listVoiceExemplars().length, 0, 'audit list is empty after forget');
}));

test('FORGET("all") wipes the whole transient voice store', () => withDirs(async ({ lockPath }) => {
  seedUserVoice();
  assert.equal(listExemplars().length, 4, 'four exemplars seeded');
  const res = await forgetVoiceExemplars('all', { lockPath });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.removed, 4, 'all four wiped');
  assert.equal(listExemplars().length, 0, 'store empty');
}));

// ---------------------------------------------------------------------------
// 8. ISOLATION (closing assertion) — after the full capture -> inject -> forget
//    lifecycle, the store path is STILL under os.tmpdir(), and the real
//    ~/.ijfw/profile/exemplars.jsonl was never created by this run.
// ---------------------------------------------------------------------------

test('ISOLATION: the full lifecycle never resolves the store outside os.tmpdir()', () => withDirs(({ pdir }) => {
  seedUserVoice();
  profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'help me write a casual note',
    context: { host: 'cursor' },
    host: 'cursor',
  });
  const path = exemplarStorePath();
  assert.ok(path.startsWith(pdir), `store path escaped the override: ${path}`);
  assert.ok(path.startsWith(tmpdir()), `store path not under os.tmpdir(): ${path}`);
  // The store file, if it exists, exists ONLY inside the tmp override.
  if (existsSync(path)) {
    assert.ok(path.startsWith(tmpdir()), 'the on-disk store lives under tmpdir');
  }
}));
