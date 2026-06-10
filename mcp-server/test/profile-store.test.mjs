// P0.2 + P0.3 — Store paths (homedir, namespacing-exempt) + atomic read/write
// with backup + symlink guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  profileDir,
  profilePath,
  backupPath,
  readProfile,
  writeProfile,
} from '../src/profile/store.js';
import { makeProfile, parseProfile, makeInference } from '../src/profile/schema.js';
import { homedirProfileDefault } from '../src/profile/path-policy.js';

function withTmpProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-profile-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P0.2 path resolution ---

test('profileDir AUTO-ISOLATES under test context with no override (anti-leak), and the production default is homedir-rooted (not CWD)', () => {
  // TEST-ISOLATION LEAK FIX: under a test runner, profileDir() with NO override
  // must resolve to an os.tmpdir() scratch dir — NEVER the real ~/.ijfw/profile
  // — otherwise a test that forgot IJFW_PROFILE_DIR silently writes into the
  // user's real homedir (the exact bug this fix closes). We prove the isolation
  // here without ever touching the real homedir.
  const prev = process.env.IJFW_PROFILE_DIR;
  delete process.env.IJFW_PROFILE_DIR;
  try {
    const got = profileDir();
    assert.ok(
      !got.startsWith(join(homedir(), '.ijfw')),
      `no-override profileDir() must NOT resolve under the real ~/.ijfw — got ${got}`,
    );
    assert.ok(got.startsWith(tmpdir()), `expected an os.tmpdir() scratch dir, got ${got}`);
  } finally {
    if (prev !== undefined) process.env.IJFW_PROFILE_DIR = prev;
  }

  // The PRODUCTION default (non-test context) is still homedir-rooted, never
  // CWD/repo-root. We assert the resolved PATH via a simulated production env —
  // no write happens, so this creates nothing under the real homedir.
  const dir = homedirProfileDefault(['.ijfw', 'profile'], { NODE_ENV: 'production' });
  assert.ok(dir.startsWith(homedir()), `expected under homedir, got ${dir}`);
  assert.ok(/profile/.test(dir));
  assert.ok(!dir.startsWith(process.cwd()) || homedir().startsWith(process.cwd()) === false
    || dir.startsWith(homedir()));
});

test('profileDir honors IJFW_PROFILE_DIR override (for tests)', () => {
  withTmpProfileDir((dir) => {
    assert.equal(profileDir(), dir);
    assert.equal(profilePath(), join(dir, 'user-profile.md'));
  });
});

test('profile path is CWD-independent and never collides with project memory', () => {
  withTmpProfileDir((dir) => {
    const a = profilePath();
    const origCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      assert.equal(profilePath(), a, 'path stable across chdir');
    } finally {
      process.chdir(origCwd);
    }
    // project memory lives at <repo>/.ijfw/memory — the profile must not be
    // under any project .ijfw/memory tree.
    assert.ok(!/\.ijfw[\\/]memory[\\/]/.test(a));
    assert.ok(!a.includes(join('.ijfw', 'memory')));
  });
});

// --- P0.3 atomic write + read ---

test('writeProfile then readProfile round-trips through disk', () => {
  withTmpProfileDir(() => {
    const p = makeProfile();
    p.global.dialectic.push(makeInference({ kind: 'trait', subject: 'x', value: 'y', confidence: 0.5 }));
    const w = writeProfile(p);
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.ok(existsSync(profilePath()));
    const r = readProfile();
    assert.equal(r.ok, true);
    assert.deepEqual(r.profile, p);
  });
});

test('readProfile on a missing file returns a default profile, not an error', () => {
  withTmpProfileDir(() => {
    const r = readProfile();
    assert.equal(r.ok, true);
    assert.equal(r.created, true, 'flagged as freshly created');
    assert.ok(r.profile.schema_version);
  });
});

test('writeProfile keeps a .bak backup of the previous good content', () => {
  withTmpProfileDir(() => {
    const p1 = makeProfile();
    p1.expertise.rust = { wilsonLB: 0.6, n: 9, accepts: 7 };
    writeProfile(p1);
    const p2 = makeProfile();
    p2.expertise.ts = { wilsonLB: 0.4, n: 6, accepts: 3 };
    writeProfile(p2);
    assert.ok(existsSync(backupPath()), '.bak exists after second write');
    const bak = parseProfile(readFileSync(backupPath(), 'utf8'));
    assert.deepEqual(bak.expertise, p1.expertise, 'backup holds the PREVIOUS profile');
  });
});

test('writeProfile does not write through a symlinked .bak destination', () => {
  // Regression: the primary write path guards the target against symlink-swap,
  // but the backup copy must guard its DESTINATION too. A pre-planted
  // user-profile.md.bak symlink → arbitrary-file overwrite when we back up the
  // prior good content. Guard the backup destination, not just the source.
  withTmpProfileDir(() => {
    // First write establishes a real primary (so the next write triggers backup).
    const p1 = makeProfile();
    p1.expertise.rust = { wilsonLB: 0.6, n: 9, accepts: 7 };
    const w1 = writeProfile(p1);
    assert.equal(w1.ok, true, JSON.stringify(w1));

    // Pre-plant the .bak path as a symlink to an outside sentinel file.
    const outside = join(tmpdir(), `ijfw-bak-sentinel-${Date.now()}.txt`);
    writeFileSync(outside, 'do not clobber me via .bak', 'utf8');
    // Ensure no real .bak exists from the first write before we swap in a link.
    rmSync(backupPath(), { force: true });
    symlinkSync(outside, backupPath());

    // Second write triggers the backup copy of the prior good content.
    const p2 = makeProfile();
    p2.expertise.ts = { wilsonLB: 0.4, n: 6, accepts: 3 };
    const w2 = writeProfile(p2);
    assert.equal(w2.ok, true, 'primary write still succeeds; backup is best-effort');

    // The outside sentinel must be UNTOUCHED — the backup copy must not have
    // followed the symlink and overwritten it with profile content.
    assert.equal(readFileSync(outside, 'utf8'), 'do not clobber me via .bak',
      'symlinked .bak destination must not be written through');
  });
});

test('corrupt primary file is recovered from .bak', () => {
  withTmpProfileDir(() => {
    const good = makeProfile();
    good.expertise.go = { wilsonLB: 0.5, n: 8, accepts: 5 };
    writeProfile(good);
    // second write so a .bak is created from the good content
    const good2 = makeProfile();
    good2.expertise.go = { wilsonLB: 0.55, n: 9, accepts: 6 };
    writeProfile(good2);
    // now corrupt the primary
    writeFileSync(profilePath(), 'GARBAGE — no json block', 'utf8');
    const r = readProfile();
    assert.equal(r.ok, true);
    assert.equal(r.recovered, true, 'flagged as recovered from backup');
    // recovered content is the last good backup (good, not good2 — good2 was the
    // corrupted primary; .bak held good)
    assert.deepEqual(r.profile.expertise, good.expertise);
  });
});

test('writeProfile refuses a symlinked target (symlink guard)', () => {
  withTmpProfileDir((dir) => {
    const outside = join(dir, 'outside-secret.md');
    writeFileSync(outside, 'do not clobber me', 'utf8');
    // make the profile path a symlink pointing at the outside file
    symlinkSync(outside, profilePath());
    const p = makeProfile();
    const w = writeProfile(p);
    assert.equal(w.ok, false, 'write must refuse symlinked target');
    assert.match(String(w.code || w.message || ''), /symlink|ELOOP|EEXIST/i);
    // the outside file must be untouched
    assert.equal(readFileSync(outside, 'utf8'), 'do not clobber me');
  });
});

test('readProfile refuses a symlinked target (symlink guard)', () => {
  withTmpProfileDir((dir) => {
    const outside = join(dir, 'evil.md');
    writeFileSync(outside, '---\nschema_version: 1\n---\n\n```json\n{"pwned":true}\n```\n', 'utf8');
    symlinkSync(outside, profilePath());
    const r = readProfile();
    assert.equal(r.ok, false, 'read must refuse symlinked target');
  });
});
