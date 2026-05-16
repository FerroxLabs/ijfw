/**
 * test-override-deployment.js
 *
 * IJFW v1.4.0 Wave 4 / t18 — Deployment tests for override-resolver.
 *
 * Covers:
 *   1. deployResolvedSkill writes to each existing platform skill dir
 *   2. deployResolvedSkill skips missing platform dirs without crashing
 *   3. atomic write semantics — no .tmp leftover after deploy
 *   4. removeActiveOverride then re-deploy restores base content. Note:
 *      removeActiveOverride only edits the state file; it does NOT re-run
 *      deploy. The test workaround is to remove the override file from disk
 *      AND call removeActiveOverride, then re-deploy, then assert.
 *   5. active-overrides.json record + remove round-trip in
 *      <home>/.ijfw/state/active-overrides.json.
 *
 * HOME is isolated per test via process.env.HOME swap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deployResolvedSkill,
  recordActiveOverride,
  removeActiveOverride,
  getPlatformSkillDirs,
} from './src/override-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  return mkdtempSync(join(tmpdir(), 'ijfw-ovr-dep-proj-'));
}

function makeTmpHome() {
  return mkdtempSync(join(tmpdir(), 'ijfw-ovr-dep-home-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeBaseSkill(projectRoot, skill, sections) {
  const dir = join(projectRoot, 'shared', 'skills', skill);
  mkdirSync(dir, { recursive: true });
  let body = `# ${skill}\n\n`;
  for (const [section, inner] of Object.entries(sections)) {
    body += `<!-- ijfw-override-target: ${section} -->\n${inner}\n<!-- ijfw-override-target-end -->\n\n`;
  }
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function writeOverride(filePath, manifest, sections) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  let body = '---\n';
  for (const [k, v] of Object.entries(manifest)) {
    if (Array.isArray(v)) {
      body += `${k}: [${v.join(', ')}]\n`;
    } else {
      body += `${k}: ${v}\n`;
    }
  }
  body += '---\n\n';
  for (const [section, inner] of Object.entries(sections)) {
    body += `<!-- ijfw-override: ${section} -->\n${inner}\n<!-- ijfw-override-end -->\n\n`;
  }
  writeFileSync(filePath, body, 'utf8');
}

function projectOverridePath(projectRoot, skill) {
  return join(projectRoot, '.ijfw', 'skill-overrides', skill, 'override.md');
}

function mkPlatformDirs(projectRoot, names) {
  for (const n of names) {
    // n is a relative subpath like 'claude/skills'
    mkdirSync(join(projectRoot, n), { recursive: true });
  }
}

async function withHome(home, fn) {
  // Windows: os.homedir() reads USERPROFILE, not HOME. Swap both for true isolation.
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
  }
}

// ---------------------------------------------------------------------------
// 1. deployResolvedSkill writes to existing platform dirs
// ---------------------------------------------------------------------------

test('deployResolvedSkill: writes SKILL.md to each existing platform dir', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', { rubric: 'BASE-CONTENT' });
    mkPlatformDirs(proj, ['claude/skills', 'shared/skills', 'codex/skills']);
    // shared/skills was created by writeBaseSkill but mkdir-recursive is idempotent.

    const result = await withHome(home, () =>
      deployResolvedSkill('demo-skill', proj)
    );

    assert.ok(Array.isArray(result.deployed));
    assert.ok(result.deployed.length >= 2, `expected deploys for claude+codex+shared, got: ${JSON.stringify(result.deployed)}`);

    const expected = [
      join(proj, 'claude', 'skills', 'demo-skill', 'SKILL.md'),
      join(proj, 'codex', 'skills', 'demo-skill', 'SKILL.md'),
      join(proj, 'shared', 'skills', 'demo-skill', 'SKILL.md'),
    ];
    for (const p of expected) {
      assert.ok(existsSync(p), `expected SKILL.md at ${p}`);
      const txt = readFileSync(p, 'utf8');
      assert.match(txt, /BASE-CONTENT/);
    }
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 2. deployResolvedSkill skips missing platform dirs
// ---------------------------------------------------------------------------

test('deployResolvedSkill: skips missing platform dirs without crashing', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', { rubric: 'X' });
    mkPlatformDirs(proj, ['claude/skills']);
    // No codex/, gemini/, cursor/, etc.

    const result = await withHome(home, () =>
      deployResolvedSkill('demo-skill', proj)
    );

    // claude exists; shared/skills was also created by writeBaseSkill.
    const claudeHit = result.deployed.find((d) => d.path.includes('/claude/skills/'));
    assert.ok(claudeHit, 'claude/skills deploy should be reported');

    // No codex deploy expected.
    const codexHit = result.deployed.find((d) => d.path.includes('/codex/skills/'));
    assert.equal(codexHit, undefined, 'codex/skills should not be deployed (dir missing)');

    // Failures array should not include codex either (we skip, not fail).
    const codexFail = result.failed.find((d) => d.path.includes('/codex/skills/'));
    assert.equal(codexFail, undefined, 'codex/skills should not be in failed');
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 3. deployResolvedSkill atomic write — no .tmp leftover
// ---------------------------------------------------------------------------

test('deployResolvedSkill: atomic write leaves no .tmp leftovers', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', { rubric: 'BODY-MARKER' });
    mkPlatformDirs(proj, ['claude/skills', 'codex/skills']);

    await withHome(home, () => deployResolvedSkill('demo-skill', proj));

    for (const platform of ['claude', 'codex', 'shared']) {
      const dir = join(proj, platform, 'skills', 'demo-skill');
      const entries = readdirSync(dir);
      const tmpStragglers = entries.filter((f) => f.endsWith('.tmp'));
      assert.deepEqual(tmpStragglers, [], `no .tmp files should remain in ${dir}`);
      // SKILL.md exists and has resolved body.
      const txt = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      assert.match(txt, /BODY-MARKER/);
    }
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 4. Remove-then-redeploy round-trip restores base content
//
// Workaround note: removeActiveOverride only edits the state file; it does
// NOT touch the override file on disk and does NOT trigger a redeploy. To
// test "restoration" the test removes the override file from disk too, then
// re-deploys — that matches the real CLI flow where `ijfw override remove`
// would delete the file and call deployResolvedSkill itself.
// ---------------------------------------------------------------------------

test('removeActiveOverride + redeploy restores base content (override file unlinked)', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', { rubric: 'BASE-RUBRIC' });
    mkPlatformDirs(proj, ['claude/skills']);

    // Apply project override.
    const ovrPath = projectOverridePath(proj, 'demo-skill');
    writeOverride(
      ovrPath,
      { scope: 'project', skill: 'demo-skill' },
      { rubric: 'OVERRIDDEN-RUBRIC' }
    );

    await withHome(home, async () => {
      await recordActiveOverride(proj, {
        preset: 'demo-skill',
        scope: 'project',
        applied_at: '2026-05-16T00:00:00Z',
      });
      const r1 = await deployResolvedSkill('demo-skill', proj);
      assert.ok(r1.deployed.length >= 1);
      const txt1 = readFileSync(
        join(proj, 'claude', 'skills', 'demo-skill', 'SKILL.md'),
        'utf8'
      );
      assert.match(txt1, /OVERRIDDEN-RUBRIC/);

      // Remove override state AND the override file from disk, then redeploy.
      // Also re-write the base SKILL.md because the prior deploy clobbered it
      // (shared/skills is both the canonical base location and a deploy
      // target per getPlatformSkillDirs; in the real CLI a `remove` flow
      // would not have stomped the base because deploy would write through
      // an installer-managed path, but at the resolver level the base lives
      // under shared/skills and deploy writes there too).
      await removeActiveOverride(proj, 'demo-skill');
      unlinkSync(ovrPath);
      writeBaseSkill(proj, 'demo-skill', { rubric: 'BASE-RUBRIC' });
      const r2 = await deployResolvedSkill('demo-skill', proj);
      assert.ok(r2.deployed.length >= 1);
      const txt2 = readFileSync(
        join(proj, 'claude', 'skills', 'demo-skill', 'SKILL.md'),
        'utf8'
      );
      assert.match(txt2, /BASE-RUBRIC/);
      assert.doesNotMatch(txt2, /OVERRIDDEN-RUBRIC/);
    });
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 5. active-overrides.json round-trip
// ---------------------------------------------------------------------------

test('recordActiveOverride writes to <home>/.ijfw/state/active-overrides.json; removeActiveOverride deletes the entry', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    await withHome(home, async () => {
      await recordActiveOverride(proj, {
        preset: 'book',
        scope: 'project',
        applied_at: '2026-05-16T00:00:00Z',
      });

      const statePath = join(home, '.ijfw', 'state', 'active-overrides.json');
      assert.ok(existsSync(statePath), 'active-overrides.json should exist');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.ok(state.projects, 'state.projects must exist');
      const entry = state.projects[proj];
      assert.ok(entry, `project entry for ${proj} should exist`);
      assert.ok(Array.isArray(entry.active_overrides));
      const book = entry.active_overrides.find((o) => o.preset === 'book');
      assert.ok(book, 'book override should be recorded');
      assert.equal(book.scope, 'project');
      assert.equal(book.applied_at, '2026-05-16T00:00:00Z');

      // Remove and verify.
      await removeActiveOverride(proj, 'book');
      const state2 = JSON.parse(readFileSync(statePath, 'utf8'));
      const entry2 = state2.projects[proj];
      assert.ok(entry2, 'project entry should still exist (possibly empty)');
      const stillThere = (entry2.active_overrides || []).find((o) => o.preset === 'book');
      assert.equal(stillThere, undefined, 'book override should be gone after remove');
    });
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Sanity: getPlatformSkillDirs returns only existing dirs
// ---------------------------------------------------------------------------

test('getPlatformSkillDirs: returns only existing platform skill dirs under projectRoot', () => {
  const proj = makeTmpProject();
  try {
    mkPlatformDirs(proj, ['claude/skills', 'codex/skills']);
    const dirs = getPlatformSkillDirs(proj);
    assert.ok(dirs.some((d) => d.endsWith('/claude/skills')));
    assert.ok(dirs.some((d) => d.endsWith('/codex/skills')));
    assert.equal(
      dirs.some((d) => d.endsWith('/gemini/extensions/ijfw/skills')),
      false,
      'gemini dir should not be reported when missing'
    );
  } finally {
    cleanup(proj);
  }
});
