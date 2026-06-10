/**
 * Regression guards for the Wave-4 privacy-review fixes on voice exemplars:
 *   MED-1: exemplarStorePath honors a passed env WITHOUT mutating process.env.
 *   MED-2: the audit preview re-scrubs homedir paths at the boundary, so it can
 *          never echo an OS username even if upstream stored an un-scrubbed path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exemplarStorePath, appendExemplar } from '../src/profile/exemplar-store.js';
import { listVoiceExemplars } from '../src/profile/audit.js';

test('MED-1: exemplarStorePath honors a passed env override without mutating process.env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-voicefix-'));
  const before = process.env.IJFW_PROFILE_DIR;
  // Spread process.env so the override carries the test-context markers the path
  // policy requires before honoring a tmpdir override verbatim (production gates
  // overrides to homedir; test context honors them).
  const p = exemplarStorePath({ ...process.env, IJFW_PROFILE_DIR: dir });
  assert.ok(p.startsWith(dir), `store path should be under the passed override dir: ${p}`);
  // The process-global must be untouched — resolution no longer round-trips
  // through process.env (the old mutation footgun).
  assert.equal(process.env.IJFW_PROFILE_DIR, before, 'process.env.IJFW_PROFILE_DIR must be unchanged');
});

test('MED-2: audit preview scrubs homedir usernames even if stored text was not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-voicefix-'));
  const env = { ...process.env, IJFW_PROFILE_DIR: dir };
  // Seed the store directly (store layer does NOT scrub — that is capture's job),
  // simulating an upstream path that failed to scrub a homedir path.
  appendExemplar(
    {
      id: 'exemplar::deadbeef',
      text: 'I keep my notes in /Users/seansecret/dev and C:\\Users\\seansecret\\work',
      register: 'casual',
      source: 'prompt',
      ts: new Date(0).toISOString(),
    },
    { env, path: exemplarStorePath(env) },
  );
  const rows = listVoiceExemplars({ env, path: exemplarStorePath(env) });
  assert.equal(rows.length, 1);
  const { preview } = rows[0];
  assert.doesNotMatch(preview, /seansecret/, 'preview must not echo the OS username');
  assert.match(preview, /<user>/, 'homedir username segment should be replaced with a placeholder');
});
