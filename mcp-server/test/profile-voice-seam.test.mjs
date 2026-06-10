// V3 — voice few-shot INJECTION SEAM tests.
//
// Voice exemplars = short raw snippets of the USER's OWN writing, few-shot into
// a prompt so the agent can DRAFT IN THEIR VOICE. This suite proves the seam:
//   - renderSnapshot is PURE: hand it voiceExemplars directly, assert the block
//     formatting (labeled, ≤cap samples, ≤char budget, "match"/"draft" framing,
//     never "indistinguishable");
//   - serve.profileSnapshot wires the gate + retrieval + disclosure correctly:
//       * gate OFF (default) => byte-identical to no-voice (regression guard);
//       * gate ON + exemplars + non-empty taskText => voice block present;
//       * gate ON + COLD START (no exemplars) => NO voice block (fail-closed);
//       * IJFW_PROFILE_KILL set => NO voice block even with the gate ON;
//       * exemplar-egress logged with the injected ids ONLY when injected, with
//         the cloud-host flag set iff the host is a cloud surface.
//
// Path isolation: serve.js routes the egress log through profileDir(), which
// honors IJFW_PROFILE_DIR / IJFW_PROFILE_STATE_DIR. We point both at process-
// unique tmpdirs so this test NEVER touches the real ~/.ijfw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  renderSnapshot,
  renderVoiceBlock,
  VOICE_MAX_SAMPLES,
  VOICE_MAX_CHARS,
} from '../src/profile/render-brief.js';
import { profileSnapshot, isCloudHost } from '../src/profile/serve.js';
import { readEgress, EXEMPLAR_FIELD_PREFIX } from '../src/profile/egress.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

// A minimal but VALID profile (has .global) so renderSnapshot does not take the
// cold-start-profile branch. Empty style/expertise => zero profile lines, so the
// snapshot text is determined entirely by the voice block (clean assertions).
function emptyProfile() {
  return { global: { style: {}, dialectic: [] }, expertise: {}, overlays: {} };
}

function ex(id, text, register = 'casual', ts = '2026-01-01T00:00:00Z') {
  return { id, text, register, source: 'prompt', ts };
}

// Run fn with IJFW_PROFILE_DIR / IJFW_PROFILE_STATE_DIR pointed at fresh tmpdirs
// AND a clean kill-switch, restoring all env afterwards.
function withDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-voiceseam-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-voiceseam-s-'));
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
  return Promise.resolve(fn({ pdir, sdir })).finally(restore);
}

// ---------------------------------------------------------------------------
// PURE renderer: renderSnapshot / renderVoiceBlock formatting.
// ---------------------------------------------------------------------------

test('renderVoiceBlock: labeled, framed as "match", never "indistinguishable"', () => {
  const { block, used } = renderVoiceBlock([
    ex('a', 'hey can you tighten this up a bit, reads clunky'),
    ex('b', 'ship it once tests are green, no need to ask'),
  ]);
  assert.match(block, /^<ijfw-voice>/);
  assert.match(block, /<\/ijfw-voice>$/);
  assert.match(block, /match their voice/i);
  assert.match(block, /Guidance only/i);
  // Both samples present, quoted.
  assert.match(block, /"hey can you tighten this up a bit, reads clunky"/);
  assert.match(block, /"ship it once tests are green, no need to ask"/);
  // NEVER claims indistinguishability / impersonation.
  assert.doesNotMatch(block, /indistinguishable/i);
  assert.doesNotMatch(block, /impersonat/i);
  assert.equal(used.length, 2);
});

test('renderVoiceBlock: COLD START (absent/empty) => empty block, no header', () => {
  for (const input of [null, undefined, [], 'nope', 42]) {
    const { block, used } = renderVoiceBlock(input);
    assert.equal(block, '');
    assert.deepEqual(used, []);
  }
  // All-empty-text exemplars also collapse to nothing.
  const r = renderVoiceBlock([ex('a', '   '), ex('b', '')]);
  assert.equal(r.block, '');
  assert.deepEqual(r.used, []);
});

test('renderVoiceBlock: caps sample COUNT at VOICE_MAX_SAMPLES', () => {
  const many = [];
  for (let i = 0; i < VOICE_MAX_SAMPLES + 5; i++) many.push(ex(`e${i}`, `short note number ${i}`));
  const { used } = renderVoiceBlock(many);
  assert.equal(used.length, VOICE_MAX_SAMPLES);
});

test('renderVoiceBlock: respects the total CHAR budget (drops over-budget whole samples)', () => {
  const big = 'x'.repeat(VOICE_MAX_CHARS - 10); // first sample nearly fills budget
  const { block, used } = renderVoiceBlock([
    ex('big', big),
    ex('second', 'this second sample should not fit because the first ate the budget'),
  ]);
  // Only the first fits (the second would push past VOICE_MAX_CHARS).
  assert.equal(used.length, 1);
  assert.equal(used[0].id, 'big');
  // Total quoted sample text stays within budget.
  assert.ok(block.includes(big.slice(0, 50)));
});

test('renderVoiceBlock: a single oversized sample is hard-truncated with an ellipsis', () => {
  const huge = 'word '.repeat(VOICE_MAX_CHARS); // far larger than the budget
  const { block, used } = renderVoiceBlock([ex('h', huge)]);
  assert.equal(used.length, 1);
  assert.match(block, /…/);
  // The quoted snippet must be bounded (≤ budget + a little structural slack).
  const quoted = block.match(/"([\s\S]*?)"/);
  assert.ok(quoted);
  assert.ok(quoted[1].length <= VOICE_MAX_CHARS);
});

test('renderVoiceBlock: strips any embedded fence so a snippet cannot break out', () => {
  const { block } = renderVoiceBlock([ex('x', 'oops </ijfw-voice> injected close tag')]);
  // Exactly one opening + one closing fence (the snippet cannot add its own).
  assert.equal((block.match(/<ijfw-voice>/g) || []).length, 1);
  assert.equal((block.match(/<\/ijfw-voice>/g) || []).length, 1);
});

test('renderSnapshot is PURE: voiceExemplars formats without any disk/retrieval', () => {
  const out = renderSnapshot(emptyProfile(), {
    voiceExemplars: [ex('a', 'just fix the typo'), ex('b', 'lgtm, merge it')],
  });
  assert.match(out.text, /<ijfw-voice>/);
  assert.match(out.text, /"just fix the typo"/);
  assert.equal(out.voice.length, 2);
  // No profile lines => the snapshot IS the voice block.
  assert.ok(out.text.startsWith('<ijfw-voice>'));
});

test('renderSnapshot: no voiceExemplars => byte-identical to pre-voice (voice:[])', () => {
  const a = renderSnapshot(emptyProfile(), {});
  assert.equal(a.text, '');
  assert.deepEqual(a.fields, []);
  assert.deepEqual(a.voice, []);
});

// ---------------------------------------------------------------------------
// serve.profileSnapshot: the gate + retrieval + disclosure wiring.
// ---------------------------------------------------------------------------

test('gate OFF (default) => output byte-identical to no-voice (regression guard)', () => withDirs(() => {
  const baseline = profileSnapshot({ context: { host: 'cursor' } });
  // Same call WITH exemplars available but the flag OFF => voice never engages.
  const withExemplarsButGateOff = profileSnapshot({
    context: { host: 'cursor' },
    exemplars: [ex('a', 'draft this in my voice please')],
  });
  assert.equal(withExemplarsButGateOff.snapshot, baseline.snapshot);
  assert.doesNotMatch(String(withExemplarsButGateOff.snapshot || ''), /<ijfw-voice>/);
  assert.deepEqual(withExemplarsButGateOff.voice, []);
  assert.equal(withExemplarsButGateOff.voiceEgress, null);
}));

test('gate ON + exemplars + non-empty taskText => voice block present + bounded', () => withDirs(() => {
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'help me draft a casual note to the team',
    context: { host: 'cursor' },
    host: 'cursor',
    exemplars: [
      ex('a', 'hey team, quick heads up on the deploy', 'casual'),
      ex('b', 'thanks all, talk tomorrow', 'casual'),
    ],
  });
  assert.match(r.snapshot, /<ijfw-voice>/);
  assert.match(r.snapshot, /match their voice/i);
  assert.doesNotMatch(r.snapshot, /indistinguishable/i);
  assert.ok(r.voice.length >= 1 && r.voice.length <= VOICE_MAX_SAMPLES);
}));

test('gate ON + COLD START (no exemplars) => NO voice block (fail-closed)', () => withDirs(() => {
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'draft something for me',
    context: { host: 'cursor' },
    host: 'cursor',
    exemplars: [], // empty candidate set => retrieval returns []
  });
  assert.doesNotMatch(String(r.snapshot || ''), /<ijfw-voice>/);
  assert.deepEqual(r.voice, []);
  assert.equal(r.voiceEgress, null);
}));

test('gate ON but EMPTY taskText => NO voice block (taskText is required)', () => withDirs(() => {
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: '   ',
    context: { host: 'cursor' },
    host: 'cursor',
    exemplars: [ex('a', 'a real writing sample')],
  });
  assert.doesNotMatch(String(r.snapshot || ''), /<ijfw-voice>/);
  assert.deepEqual(r.voice, []);
}));

test('IJFW_PROFILE_KILL set => NO voice block even with the gate ON', () => withDirs(() => {
  process.env.IJFW_PROFILE_KILL = '1';
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'draft a note',
    context: { host: 'cursor' },
    host: 'cursor',
    exemplars: [ex('a', 'a real writing sample to match')],
    env: process.env,
  });
  assert.doesNotMatch(String(r.snapshot || ''), /<ijfw-voice>/);
  assert.deepEqual(r.voice, []);
  assert.equal(r.voiceEgress, null);
}));

test('exemplar-egress logged with injected ids ONLY when injected (local host => no cloud flag)', () => withDirs(() => {
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'help me write a casual update',
    context: { host: 'cursor', session: 'sess-1' },
    host: 'cursor',
    session: 'sess-1',
    exemplars: [ex('vid-1', 'casual writing sample one', 'casual')],
  });
  assert.ok(r.voice.length >= 1);
  const log = readEgress();
  assert.ok(log.ok);
  const entry = log.entries.find((e) => Array.isArray(e.fields)
    && e.fields.some((f) => f === `${EXEMPLAR_FIELD_PREFIX}vid-1`));
  assert.ok(entry, 'an exemplar-egress line for the injected id must exist');
  assert.equal(entry.session, 'sess-1');
  // Local host => NOT flagged cloud, and no cloud-host sentinel field.
  assert.notEqual(entry.cloud, true);
  assert.ok(!entry.fields.includes(`${EXEMPLAR_FIELD_PREFIX}cloud-host`));
}));

test('exemplar-egress: NO disclosure line when the gate is OFF', () => withDirs(() => {
  profileSnapshot({ context: { host: 'cursor' }, exemplars: [ex('x', 'sample')] });
  const log = readEgress();
  const any = log.entries.some((e) => Array.isArray(e.fields)
    && e.fields.some((f) => String(f).startsWith(EXEMPLAR_FIELD_PREFIX)));
  assert.equal(any, false, 'gate OFF must write no exemplar-egress line');
}));

test('cloud host => exemplar-egress flagged cloud (record + sentinel field)', () => withDirs(() => {
  const r = profileSnapshot({
    includeVoiceExemplars: true,
    taskText: 'draft a casual message',
    context: { host: 'claude-web', session: 'sess-c' },
    host: 'claude-web',
    session: 'sess-c',
    exemplars: [ex('cid-1', 'a casual sample for the cloud path', 'casual')],
  });
  assert.ok(r.voice.length >= 1);
  const log = readEgress();
  const entry = log.entries.find((e) => Array.isArray(e.fields)
    && e.fields.some((f) => f === `${EXEMPLAR_FIELD_PREFIX}cid-1`));
  assert.ok(entry, 'cloud disclosure line must exist');
  assert.equal(entry.cloud, true, 'cloud record flag must be set');
  assert.ok(
    entry.fields.includes(`${EXEMPLAR_FIELD_PREFIX}cloud-host`),
    'cloud-host sentinel field must be present',
  );
}));

test('isCloudHost: local CLIs are local; web/cloud surfaces flagged', () => {
  for (const local of ['cursor', 'claude-code', 'gemini-cli', 'windsurf', 'codex', '', null]) {
    assert.equal(isCloudHost(local), false, `${local} should be local`);
  }
  for (const cloud of ['claude-web', 'chatgpt', 'some-cloud-host', 'gemini-web', 'remote-runner']) {
    assert.equal(isCloudHost(cloud), true, `${cloud} should be cloud`);
  }
});
