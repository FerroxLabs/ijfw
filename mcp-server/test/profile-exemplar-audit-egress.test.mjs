// V4 — voice-exemplar audit visibility + forget + egress disclosure logging.
//
// Voice exemplars = short raw snippets of the USER's OWN writing, stored locally
// + transiently (V1 exemplar-store) and few-shot into prompts so the agent can
// draft in the user's voice. This slice makes them VISIBLE (listVoiceExemplars,
// with a PII-scrubbed preview), FORGETTABLE (forgetVoiceExemplars, under the
// global lock, purging the egress trail too), and DISCLOSURE-LOGGED (append
// ExemplarEgress, one JSON line per injection, cloud-host flagged distinctly).
//
// Path isolation: the exemplar store, the egress log, and the profile lock ALL
// route through profileDir() / the profile state dir, which honor
// IJFW_PROFILE_DIR / IJFW_PROFILE_STATE_DIR. We point both at process-unique
// tmpdirs so this test NEVER touches the real ~/.ijfw (belt-and-suspenders on
// top of path-policy's test-context auto-tmpdir).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listVoiceExemplars,
  forgetVoiceExemplars,
} from '../src/profile/audit.js';
import {
  appendExemplarEgress,
  readEgress,
  exemplarField,
  EXEMPLAR_FIELD_PREFIX,
} from '../src/profile/egress.js';
import {
  appendExemplar,
  listExemplars,
  exemplarStorePath,
} from '../src/profile/exemplar-store.js';

// ---------------------------------------------------------------------------
// Path-isolated fixture. Mirrors the profile-audit.test.mjs freshDirs pattern.
// ---------------------------------------------------------------------------
function withDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-exaudit-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-exaudit-s-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  return Promise.resolve(fn({ pdir, sdir, lockPath: join(sdir, '.profile.lock') }))
    .finally(() => {
      if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
      if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
      rmSync(pdir, { recursive: true, force: true });
      rmSync(sdir, { recursive: true, force: true });
    });
}

// Seed an exemplar with a deterministic id (id = exemplar::sha8(text)).
function seed({ text, register = 'casual', source = 'prompt', ts }) {
  const rec = {
    id: `exemplar::seed-${text.slice(0, 6).replace(/\W/g, '')}-${ts || ''}`,
    text,
    register,
    source,
    ts: ts || new Date().toISOString(),
  };
  const r = appendExemplar(rec);
  assert.equal(r.ok, true, `seed failed: ${JSON.stringify(r)}`);
  return rec;
}

// --- test-isolation guardrail -------------------------------------------------

test('exemplar store + egress paths are inside the tmp override (never real ~/.ijfw)', async () => {
  await withDirs(({ pdir }) => {
    assert.ok(exemplarStorePath().startsWith(pdir), `store path escaped override: ${exemplarStorePath()}`);
    assert.ok(!exemplarStorePath().includes('/.ijfw/profile'), 'must not resolve to real profile dir');
  });
});

// --- 1. visibility: listVoiceExemplars with scrubbed preview ------------------

test('listVoiceExemplars surfaces every exemplar with a labelled, PII-scrubbed preview', async () => {
  await withDirs(() => {
    seed({ text: 'ship it. no half measures.', register: 'terse', source: 'prompt', ts: '2026-06-01T00:00:00.000Z' });
    seed({ text: 'refactor the merge fold for clarity', register: 'commit', source: 'commit-msg', ts: '2026-06-02T00:00:00.000Z' });

    const rows = listVoiceExemplars();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.id, 'id present');
      assert.ok(['terse', 'casual', 'formal', 'commit', 'doc'].includes(r.register), 'register present');
      assert.ok(['prompt', 'commit-msg'].includes(r.source), 'source present');
      assert.ok(typeof r.ts === 'string' && r.ts, 'ts present');
      assert.ok(typeof r.preview === 'string', 'preview present');
      assert.equal(r.label, 'writing sample used to match your voice', 'human-readable label');
      // The audit row must NOT echo the raw text field back.
      assert.equal(r.text, undefined, 'raw text is not surfaced by the audit row');
    }
  });
});

test('listVoiceExemplars preview scrubs direct PII and caps length to ~80 chars', async () => {
  await withDirs(() => {
    const email = 'reach.me.here@example.com';
    seed({ text: `email me at ${email} about the rollout`, register: 'casual', ts: '2026-06-03T00:00:00.000Z' });
    const long = 'x'.repeat(300);
    seed({ text: long, register: 'doc', ts: '2026-06-04T00:00:00.000Z' });

    const rows = listVoiceExemplars();
    const withEmail = rows.find((r) => r.preview.includes('rollout'));
    assert.ok(withEmail, 'found the email row');
    assert.ok(!withEmail.preview.includes(email), 'email scrubbed from preview');
    assert.ok(!withEmail.preview.includes('@example.com'), 'no email fragment leaks');

    const longRow = rows.find((r) => r.preview.startsWith('x'));
    assert.ok(longRow.preview.length <= 81, `preview capped (was ${longRow.preview.length})`); // 80 + ellipsis
  });
});

test('listVoiceExemplars degrades to [] when the store is empty', async () => {
  await withDirs(() => {
    assert.deepEqual(listVoiceExemplars(), []);
  });
});

// --- 2. egress: disclosure logging -------------------------------------------

test('appendExemplarEgress writes ONE line carrying the disclosed exemplar ids', async () => {
  await withDirs(() => {
    const res = appendExemplarEgress({ ids: ['exemplar::aaa', 'exemplar::bbb'], host: 'claude', session: 's1' });
    assert.equal(res.ok, true, JSON.stringify(res));

    const log = readEgress();
    assert.equal(log.ok, true);
    assert.equal(log.entries.length, 1, 'exactly one egress line');
    const e = log.entries[0];
    assert.equal(e.host, 'claude');
    assert.equal(e.session, 's1');
    assert.ok(e.fields.includes(exemplarField('exemplar::aaa')), 'first id encoded');
    assert.ok(e.fields.includes(exemplarField('exemplar::bbb')), 'second id encoded');
    assert.ok(e.fields.every((f) => f.startsWith(EXEMPLAR_FIELD_PREFIX)), 'all fields namespaced');
    assert.equal(e.cloud, undefined, 'local disclosure carries no cloud flag');
  });
});

test('appendExemplarEgress with no ids is a no-op (no contentless line written)', async () => {
  await withDirs(() => {
    const res = appendExemplarEgress({ ids: [], host: 'claude', session: 's1' });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
    const log = readEgress();
    assert.equal(log.entries.length, 0, 'nothing written');
  });
});

test('cloud-host disclosure is flagged distinctly from a local disclosure', async () => {
  await withDirs(() => {
    appendExemplarEgress({ ids: ['exemplar::local'], host: 'claude', session: 's1', cloudHost: false });
    appendExemplarEgress({ ids: ['exemplar::sentto'], host: 'remote-llm', session: 's2', cloudHost: true });

    const log = readEgress();
    assert.equal(log.entries.length, 2);
    const local = log.entries.find((e) => e.fields.includes(exemplarField('exemplar::local')));
    const cloud = log.entries.find((e) => e.fields.includes(exemplarField('exemplar::sentto')));

    // Structured boolean: clean, machine-glanceable.
    assert.equal(local.cloud, undefined, 'local entry NOT marked cloud');
    assert.equal(cloud.cloud, true, 'cloud entry marked cloud:true');
    // Sentinel field: survives even a fields-only / raw-grep audit.
    assert.ok(cloud.fields.includes(`${EXEMPLAR_FIELD_PREFIX}cloud-host`), 'cloud sentinel field present');
    assert.ok(!local.fields.includes(`${EXEMPLAR_FIELD_PREFIX}cloud-host`), 'local has no cloud sentinel');
  });
});

// --- 3. forget removes exemplars AND purges their egress entries --------------

test('forgetVoiceExemplars by id removes the exemplar', async () => {
  await withDirs(async ({ lockPath }) => {
    const keep = seed({ text: 'keep this voice sample', ts: '2026-06-01T00:00:00.000Z' });
    const drop = seed({ text: 'drop this voice sample', ts: '2026-06-02T00:00:00.000Z' });

    const res = await forgetVoiceExemplars(drop.id, { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.removed, 1, 'one exemplar removed (V1 count)');

    const ids = listExemplars().map((e) => e.id);
    assert.ok(!ids.includes(drop.id), 'dropped exemplar gone');
    assert.ok(ids.includes(keep.id), 'kept exemplar survives');
  });
});

test('forgetting an exemplar purges its egress disclosure entries', async () => {
  await withDirs(async ({ lockPath }) => {
    const a = seed({ text: 'alpha writing sample', ts: '2026-06-01T00:00:00.000Z' });
    const b = seed({ text: 'beta writing sample', ts: '2026-06-02T00:00:00.000Z' });

    // Disclose both into prompts (separate lines), b also to a cloud host.
    appendExemplarEgress({ ids: [a.id], host: 'claude', session: 's1' });
    appendExemplarEgress({ ids: [b.id], host: 'remote', session: 's2', cloudHost: true });
    appendExemplarEgress({ ids: [a.id, b.id], host: 'claude', session: 's3' });
    assert.equal(readEgress().entries.length, 3, 'three disclosure lines');

    const res = await forgetVoiceExemplars(a.id, { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    // Two entries referenced `a` (s1 and the combined s3) → both dropped.
    assert.equal(res.egressRemoved, 2, 'every egress line referencing the forgotten id is purged');
    assert.deepEqual(res.removedIds, [a.id], 'the concrete purged id is reported');

    const remaining = readEgress().entries;
    assert.equal(remaining.length, 1, 'only the b-only disclosure survives');
    assert.ok(remaining[0].fields.includes(exemplarField(b.id)), 'surviving line is the b disclosure');
    assert.ok(!remaining.some((e) => e.fields.includes(exemplarField(a.id))), 'no trace of the forgotten id');
  });
});

test('forgetVoiceExemplars("all") wipes the store and purges all matching egress', async () => {
  await withDirs(async ({ lockPath }) => {
    const a = seed({ text: 'one', ts: '2026-06-01T00:00:00.000Z' });
    const b = seed({ text: 'two', ts: '2026-06-02T00:00:00.000Z' });
    appendExemplarEgress({ ids: [a.id], host: 'claude', session: 's1' });
    appendExemplarEgress({ ids: [b.id], host: 'claude', session: 's2' });

    const res = await forgetVoiceExemplars('all', { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.removed, 2, 'both exemplars wiped');
    assert.equal(res.egressRemoved, 2, 'both disclosure lines purged');
    assert.equal(listExemplars().length, 0, 'store empty');
    assert.equal(readEgress().entries.length, 0, 'egress empty');
  });
});

test('forgetVoiceExemplars on a non-matching pattern removes nothing and purges nothing', async () => {
  await withDirs(async ({ lockPath }) => {
    const a = seed({ text: 'present sample', ts: '2026-06-01T00:00:00.000Z' });
    appendExemplarEgress({ ids: [a.id], host: 'claude', session: 's1' });

    const res = await forgetVoiceExemplars('no-such-id-or-substring-zzz', { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.removed, 0, 'nothing removed');
    assert.equal(res.egressRemoved, 0, 'nothing purged');
    assert.equal(listExemplars().length, 1, 'exemplar intact');
    assert.equal(readEgress().entries.length, 1, 'egress intact');
  });
});
