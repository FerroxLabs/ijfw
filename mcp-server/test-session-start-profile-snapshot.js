/**
 * test-session-start-profile-snapshot.js
 *
 * S6 (personalization layer): rules-file snapshot adapter.
 *
 * At SessionStart the hook embeds a SHORT exported profile snapshot
 * (renderSnapshot output: style + expertise bands, NO unapproved preference
 * slugs) into CLAUDE.md -- the rules surface clients that do NOT honor MCP
 * instructions/resources read as the floor. The snapshot is part of the managed
 * block, so it inherits every injection-remediation guarantee:
 *
 *   - appears in a project-scoped CLAUDE.md when inject is ON and a profile
 *     with confirmed style/expertise exists;
 *   - ABSENT under .ijfw/no-inject (the managed block is never written);
 *   - ABSENT outside a project root (cwd == $HOME -> cwd-guard refuses);
 *   - byte-identical no-op on an unchanged second session (no rewrite).
 *
 * The snapshot is rendered from the REAL profile pipeline (store.readProfile ->
 * render-brief.renderSnapshot) via IJFW_PROFILE_DIR pointed at a temp profile,
 * so this exercises the production path, not a mock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeProfile } from './src/profile/schema.js';
import { renderSnapshot } from './src/profile/render-brief.js';
import { writeProfile } from './src/profile/store.js';

/**
 * Persist a profile to <profileDir>/user-profile.md in the store's OWN on-disk
 * format (fenced JSON), via the real writeProfile(). The store resolves its
 * target from process.env.IJFW_PROFILE_DIR, so we set it around the call (and
 * restore it) — this is the only safe way to produce a byte-correct fixture the
 * hook subprocess will then read back.
 */
function persistProfile(profileDir, profile) {
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = profileDir;
  try {
    writeProfile(profile);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prev;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SESSION_START_PATH = path.join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'session-start.sh');
const skipOnWin = process.platform === 'win32' ? 'bash not on Windows runner PATH' : undefined;

const PROFILE_MARKER = '<ijfw-profile>';

function envFor(home, cwd, profileDir, extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: home,
    PWD: cwd,
    IJFW_SKIP_PARSE: '1',
    CLAUDE_PLUGIN_ROOT: '/nonexistent/ijfw-test-plugin-root',
    // Point the profile store at our fixture so the hook's node snippet resolves
    // OUR profile, never the developer's real ~/.ijfw/profile. The hook spawns
    // node in PRODUCTION context (no NODE_TEST_CONTEXT), so resolveOverrideDir
    // only honors IJFW_PROFILE_DIR when it resolves UNDER homedir -- hence the
    // fixture lives at <HOME>/.ijfw/profile (see profileDirFor).
    IJFW_PROFILE_DIR: profileDir,
    ...extra,
  };
}

function runHook(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SESSION_START_PATH], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('exit', () => resolve());
    child.once('error', reject);
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, 30000);
    t.unref();
  });
}

/**
 * Build a profile with a CONFIRMED style axis (evidence_count >= 5) and a
 * BANDED expertise domain (n >= 5), write it to <profileDir>/profile.json in
 * the store's on-disk shape, and return it. We assert via the REAL renderSnapshot
 * that this fixture actually produces a non-empty low-sensitivity snapshot, so a
 * silent schema drift in the fixture can't make the hook tests vacuously pass.
 */
async function writeProfileFixture(profileDir) {
  await fs.mkdir(profileDir, { recursive: true });
  const profile = makeProfile();
  // Confirmed terseness -> "terse" band (ema >= 0.67, evidence_count >= 5).
  profile.global.style.terseness = { ema: 0.9, alpha: 9, beta: 1, evidence_count: 8 };
  // Banded expertise (n >= 5, strong Wilson LB -> expert/proficient).
  profile.expertise = {
    javascript: { n: 12, accepts: 11, wilsonLB: 0.62 },
  };

  // Sanity: the REAL renderSnapshot must emit style + expertise, no preference
  // slugs. forceLowOnly mirrors the hook's passive-read posture. This in-process
  // call runs UNDER the test runner, where the store's redaction-path lookup
  // reads process.env.IJFW_PROFILE_DIR directly (not opts.env) and otherwise
  // throws via the default-path guard -- so we set it on process.env around the
  // call. The hook subprocess gets the same override via its spawn env instead.
  const prevDir = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = profileDir;
  let snap;
  try {
    snap = renderSnapshot(profile, { forceLowOnly: true });
  } finally {
    if (prevDir === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prevDir;
  }
  assert.ok(snap.text && snap.text.includes('style.terseness'), 'fixture must yield a confirmed style line');
  assert.ok(snap.text.includes('expertise.javascript'), 'fixture must yield a banded expertise line');

  // Persist in the store's real on-disk shape (user-profile.md, fenced JSON) so
  // the hook subprocess reads it back via readProfile().
  persistProfile(profileDir, profile);
  return { profile, snapshotText: snap.text };
}

// The profile fixture MUST live under the test HOME: the hook spawns node in
// production context, where resolveOverrideDir only honors IJFW_PROFILE_DIR when
// it resolves under homedir(). <HOME>/.ijfw/profile satisfies that (and the
// uid-ownership check, since we create it ourselves).
function profileDirFor(home) {
  return path.join(home, '.ijfw', 'profile');
}

async function mkHomeAndProject(tag) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `ijfw-${tag}-home-`));
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `ijfw-${tag}-proj-`));
  await fs.mkdir(path.join(project, '.ijfw'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }));
  const profileDir = profileDirFor(home);
  return { home, project, profileDir };
}

test('snapshot appears in a project-scoped CLAUDE.md when inject is ON and a profile exists', { skip: skipOnWin }, async () => {
  const { home, project, profileDir } = await mkHomeAndProject('snap-on');
  await writeProfileFixture(profileDir);

  await runHook(project, envFor(home, project, profileDir));

  const claudeMd = path.join(project, 'CLAUDE.md');
  assert.ok(existsSync(claudeMd), 'default project should inject a CLAUDE.md');
  const content = await fs.readFile(claudeMd, 'utf8');
  assert.ok(content.includes(PROFILE_MARKER), 'CLAUDE.md must carry the <ijfw-profile> snapshot stanza');
  // The actual derived bands must be present -- not just the wrapper tag.
  assert.ok(content.includes('style.terseness'), 'snapshot must include the confirmed style band');
  assert.ok(content.includes('expertise.javascript'), 'snapshot must include the banded expertise');
  // And the stanza lives INSIDE the managed block so opt-out / byte-skip own it.
  const startIdx = content.indexOf('<!-- IJFW-MEMORY-START');
  const endIdx = content.indexOf('<!-- IJFW-MEMORY-END');
  const profIdx = content.indexOf(PROFILE_MARKER);
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'managed markers must be present');
  assert.ok(profIdx > startIdx && profIdx < endIdx, 'snapshot stanza must sit inside the managed block');
});

test('snapshot does NOT leak preference slugs (style + expertise only)', { skip: skipOnWin }, async () => {
  const { home, project, profileDir } = await mkHomeAndProject('snap-noprefs');
  await fs.mkdir(profileDir, { recursive: true });
  const profile = makeProfile();
  profile.global.style.terseness = { ema: 0.9, alpha: 9, beta: 1, evidence_count: 8 };
  // Add a dialectic/preference trait that MUST NOT surface in the snapshot
  // (renderSnapshot omits preference slugs unless explicitly opted in -- the
  // hook never opts in).
  profile.global.dialectic = [
    { slug: 'prefers-tabs-over-spaces', confidence: 0.9, evidence_count: 9, sensitivity: 'low' },
  ];
  persistProfile(profileDir, profile);

  await runHook(project, envFor(home, project, profileDir));

  const content = await fs.readFile(path.join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(content.includes(PROFILE_MARKER), 'snapshot stanza should still render (style is confirmed)');
  assert.ok(!content.includes('prefers-tabs-over-spaces'), 'no unapproved preference slug may appear in the rules surface');
});

test('snapshot is ABSENT under .ijfw/no-inject', { skip: skipOnWin }, async () => {
  const { home, project, profileDir } = await mkHomeAndProject('snap-noinj');
  await writeProfileFixture(profileDir);
  await fs.writeFile(path.join(project, '.ijfw', 'no-inject'), '');

  await runHook(project, envFor(home, project, profileDir));

  // no-inject suppresses the whole managed block -> no CLAUDE.md at all here.
  assert.ok(!existsSync(path.join(project, 'CLAUDE.md')), 'no-inject must not author a CLAUDE.md (and thus no snapshot)');
});

test('snapshot is ABSENT under IJFW_NO_INJECT=1', { skip: skipOnWin }, async () => {
  const { home, project, profileDir } = await mkHomeAndProject('snap-noinjenv');
  await writeProfileFixture(profileDir);

  await runHook(project, envFor(home, project, profileDir, { IJFW_NO_INJECT: '1' }));

  assert.ok(!existsSync(path.join(project, 'CLAUDE.md')), 'IJFW_NO_INJECT=1 must suppress the snapshot write');
});

test('snapshot is ABSENT outside a project root (cwd == $HOME -> cwd-guard refuses)', { skip: skipOnWin }, async () => {
  // Run with cwd == HOME so the cwd-guard refuses any CLAUDE.md authoring -- the
  // global-config-bleed vector the injection-remediation posture closes.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-snap-homecwd-'));
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  const profileDir = profileDirFor(home);
  await writeProfileFixture(profileDir);

  await runHook(home, envFor(home, home, profileDir));

  assert.ok(!existsSync(path.join(home, 'CLAUDE.md')), 'cwd-guard must refuse a $HOME-root CLAUDE.md (no global snapshot bleed)');
});

test('byte-identical no-op: an unchanged snapshot is NOT rewritten on the next session', { skip: skipOnWin }, async () => {
  const { home, project, profileDir } = await mkHomeAndProject('snap-byteskip');
  await writeProfileFixture(profileDir);
  const claudeMd = path.join(project, 'CLAUDE.md');
  const env = envFor(home, project, profileDir);

  // Run 1: writes CLAUDE.md with the snapshot stanza.
  await runHook(project, env);
  const after1 = await fs.readFile(claudeMd, 'utf8');
  assert.ok(after1.includes(PROFILE_MARKER), 'run 1 should write the snapshot stanza');

  // Pin mtime to the past; a no-op rewrite would bump it to ~now.
  const PINNED = 1_000_000_000; // 2001-09-09
  utimesSync(claudeMd, PINNED, PINNED);

  // Run 2: profile unchanged -> block unchanged -> must skip the write.
  await runHook(project, env);

  const mtimeMs = statSync(claudeMd).mtimeMs;
  assert.ok(
    mtimeMs < 1_100_000_000_000,
    `CLAUDE.md was rewritten on an unchanged second session (mtime moved to ${new Date(mtimeMs).toISOString()}). ` +
      'The byte-identical skip must cover the snapshot stanza too.',
  );
  const after2 = await fs.readFile(claudeMd, 'utf8');
  assert.equal(after2, after1, 'content (incl. snapshot) must be unchanged across the skipped write');
});
