/**
 * test-code-fixer.js — v1.5.0 T27 / G4 unit + e2e suite.
 *
 * Exercises src/recovery/code-fixer.js across:
 *   • 3-tier verify matrix per language (re-read / syntax-check / fallback)
 *   • logic-bug detection heuristic
 *   • triage short-circuits (DEFERRED / STALE)
 *   • full end-to-end: bug → fix → Trident-verify → atomic commit
 *
 * Trident is invoked with a scripted dispatcher (no CLI spawn, no network);
 * the e2e test stands up a real git repo + verifies the commit lands.
 *
 * ESM. zero new deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  STATUS,
  fixFinding,
  fixFindings,
  isLogicBug,
  triage,
  tier2SyntaxCheckCmd,
  verifyTier1,
  verifyTier2,
  verifyTier3,
  runTridentVerify,
  atomicCommit,
  isPathContained,
  runConsensusFix,
  consensusHighFindings,
  DEFAULT_MAX_AUTOFIX_FILES,
  _makeTridentDispatch,
} from './src/recovery/code-fixer.js';
import { symlinkSync } from 'node:fs';

function freshTmp(prefix = 'ijfw-cf-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}
function initRepo() {
  const dir = freshTmp('ijfw-cf-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/* ────────────────────────────── logic-bug heuristic ─────────────────────── */

test('isLogicBug: category=logic-bug → defer', () => {
  const r = isLogicBug({ category: 'logic-bug', description: 'whatever' });
  assert.equal(r.logic, true);
  assert.match(r.reason, /category=logic-bug/);
});

test('isLogicBug: description with "off-by-one" → defer', () => {
  const r = isLogicBug({ category: 'other', description: 'this loop is off-by-one' });
  assert.equal(r.logic, true);
  assert.match(r.reason, /off-by-one/);
});

test('isLogicBug: description with "race condition" → defer', () => {
  const r = isLogicBug({ category: 'other', description: 'classic race condition here' });
  assert.equal(r.logic, true);
});

test('isLogicBug: category=typo → patch (not logic)', () => {
  const r = isLogicBug({ category: 'typo', description: 'misspelling: teh → the' });
  assert.equal(r.logic, false);
});

test('isLogicBug: missing-await without line → defer', () => {
  const r = isLogicBug({ category: 'missing-await', description: 'somewhere' });
  assert.equal(r.logic, true);
  assert.match(r.reason, /missing-await/);
});

test('isLogicBug: malformed input → false (defensive)', () => {
  assert.equal(isLogicBug(null).logic, false);
  assert.equal(isLogicBug(undefined).logic, false);
  assert.equal(isLogicBug('not-an-object').logic, false);
});

/* ────────────────────────────── triage ──────────────────────────────────── */

test('triage: logic bug → proceed:false, status DEFERRED', () => {
  const r = triage({
    file: 'foo.js', category: 'logic-bug',
    description: 'off-by-one', fix: { old_string: 'a', new_string: 'b' },
  });
  assert.equal(r.proceed, false);
  assert.equal(r.status, STATUS.DEFERRED);
  assert.match(r.reason, /logic-bug/);
});

test('triage: no file path → DEFERRED', () => {
  const r = triage({ category: 'typo' });
  assert.equal(r.proceed, false);
  assert.equal(r.status, STATUS.DEFERRED);
});

test('triage: no concrete fix → DEFERRED', () => {
  const r = triage({ file: 'foo.js', category: 'typo' });
  assert.equal(r.proceed, false);
  assert.equal(r.status, STATUS.DEFERRED);
  assert.match(r.reason, /no-concrete-fix/);
});

test('triage: typo with concrete fix → proceed:true', () => {
  const r = triage({
    file: 'foo.js', category: 'typo',
    description: 'misspelling',
    fix: { old_string: 'teh', new_string: 'the' },
  });
  assert.equal(r.proceed, true);
});

/* ────────────────────────────── tier 2 — syntax check ───────────────────── */

test('tier2SyntaxCheckCmd: .js → node --check', () => {
  const spec = tier2SyntaxCheckCmd('/tmp/foo.js');
  assert.equal(spec.cmd, 'node');
  assert.deepEqual(spec.args, ['--check', '/tmp/foo.js']);
});

test('tier2SyntaxCheckCmd: .py → python3 -m py_compile', () => {
  const spec = tier2SyntaxCheckCmd('/tmp/x.py');
  assert.equal(spec.cmd, 'python3');
});

test('tier2SyntaxCheckCmd: .sh → bash -n', () => {
  const spec = tier2SyntaxCheckCmd('/tmp/x.sh');
  assert.equal(spec.cmd, 'bash');
});

test('tier2SyntaxCheckCmd: .json → node -e JSON.parse', () => {
  const spec = tier2SyntaxCheckCmd('/tmp/x.json');
  assert.equal(spec.cmd, 'node');
  assert.equal(spec.args[0], '-e');
});

test('tier2SyntaxCheckCmd: .md → null (SKIP)', () => {
  assert.equal(tier2SyntaxCheckCmd('/tmp/x.md'), null);
});

test('verifyTier2: valid JS file → ok', async () => {
  const dir = freshTmp();
  try {
    const f = join(dir, 'valid.js');
    writeFileSync(f, 'export const x = 1;\n');
    const r = await verifyTier2(f);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, false);
  } finally { cleanup(dir); }
});

test('verifyTier2: broken JS → ok:false, evidence captured', async () => {
  const dir = freshTmp();
  try {
    const f = join(dir, 'broken.js');
    writeFileSync(f, 'const x = ;\n'); // syntax error
    const r = await verifyTier2(f);
    assert.equal(r.ok, false);
    assert.match(r.evidence, /tier-2/);
  } finally { cleanup(dir); }
});

test('verifyTier2: broken JSON → ok:false', async () => {
  const dir = freshTmp();
  try {
    const f = join(dir, 'bad.json');
    writeFileSync(f, '{ this is not json');
    const r = await verifyTier2(f);
    assert.equal(r.ok, false);
  } finally { cleanup(dir); }
});

test('verifyTier2: .md file → skipped', async () => {
  const dir = freshTmp();
  try {
    const f = join(dir, 'x.md');
    writeFileSync(f, '# hi');
    const r = await verifyTier2(f);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  } finally { cleanup(dir); }
});

/* ────────────────────────────── tier 1 — re-read ────────────────────────── */

test('verifyTier1: substring present → ok', async () => {
  const dir = freshTmp();
  try {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'hello world\n');
    const r = await verifyTier1(f, 'hello');
    assert.equal(r.ok, true);
  } finally { cleanup(dir); }
});

test('verifyTier1: substring absent → ok:false', async () => {
  const dir = freshTmp();
  try {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'hello world\n');
    const r = await verifyTier1(f, 'goodbye');
    assert.equal(r.ok, false);
    assert.match(r.evidence, /expected substring not present/);
  } finally { cleanup(dir); }
});

test('verifyTier1: missing file → ok:false', async () => {
  const r = await verifyTier1('/nonexistent/path/x.txt', 'whatever');
  assert.equal(r.ok, false);
});

/* ────────────────────────────── tier 3 — fallback ───────────────────────── */

test('verifyTier3: no package.json + no Makefile → skipped', async () => {
  const dir = freshTmp();
  try {
    const r = await verifyTier3(dir);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  } finally { cleanup(dir); }
});

test('verifyTier3: explicit override echo true → ok', async () => {
  const dir = freshTmp();
  try {
    const r = await verifyTier3(dir, 'true');
    assert.equal(r.ok, true);
    assert.equal(r.skipped, false);
  } finally { cleanup(dir); }
});

test('verifyTier3: explicit override `false` → ok:false', async () => {
  const dir = freshTmp();
  try {
    const r = await verifyTier3(dir, 'false');
    assert.equal(r.ok, false);
    assert.match(r.evidence, /tier-3/);
  } finally { cleanup(dir); }
});

/* ────────────────────────────── trident verify ──────────────────────────── */

test('runTridentVerify: scripted PASS dispatch → passed:true', async () => {
  const dir = freshTmp();
  try {
    const dispatch = _makeTridentDispatch('pass');
    const r = await runTridentVerify({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectRoot: dir,
    });
    assert.equal(r.passed, true);
    assert.equal(r.verdict, 'PASS');
  } finally { cleanup(dir); }
});

test('runTridentVerify: no dispatch → TRIDENT_DISPATCH_MISSING', async () => {
  const r = await runTridentVerify({ commitRange: 'HEAD~1..HEAD' });
  assert.equal(r.passed, false);
  assert.equal(r.verdict, 'TRIDENT_DISPATCH_MISSING');
});

test('runTridentVerify: convergence to PASS after one fail iter → passed:true', async () => {
  const dir = freshTmp();
  try {
    const dispatch = _makeTridentDispatch('fail-then-pass');
    const r = await runTridentVerify({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectRoot: dir,
      maxIterations: 3,
    });
    assert.equal(r.passed, true);
    assert.ok(r.iterations >= 2);
  } finally { cleanup(dir); }
});

/* ────────────────────────────── atomic commit ───────────────────────────── */

test('atomicCommit: stages + commits one file → returns sha', () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'first\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);
    writeFileSync(join(dir, 'a.txt'), 'second\n');
    const r = atomicCommit({
      projectRoot: dir,
      file: join(dir, 'a.txt'),
      finding: { finding_id: 'F1', severity: 'low', description: 'rename' },
    });
    assert.equal(r.ok, true);
    assert.match(r.sha, /^[0-9a-f]{40}$/);
    const log = git(dir, ['log', '--oneline']);
    assert.match(log, /fix\(code-fixer\): F1/);
  } finally { cleanup(dir); }
});

/* ────────────────────────────── end-to-end ──────────────────────────────── */

test('e2e: known bug → fixed → Trident-verified → committed', async () => {
  const dir = initRepo();
  try {
    // Seed a known bug: a JS file with a typo we want corrected.
    const targetPath = join(dir, 'lib.js');
    writeFileSync(targetPath, 'export const greeting = "Helo, world";\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const finding = {
      finding_id: 'F-typo-01',
      file: 'lib.js',
      line: 1,
      severity: 'LOW',
      category: 'typo',
      description: 'misspelling: Helo → Hello',
      fix: { old_string: 'Helo', new_string: 'Hello' },
    };

    const dispatch = _makeTridentDispatch('pass');
    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch,
      commitRange: 'HEAD~1..HEAD',
    });

    assert.equal(result.status, STATUS.VERIFIED, `expected VERIFIED, got ${result.status} (${result.evidence || ''})`);
    assert.equal(result.tier_reached, 'trident');
    assert.match(result.sha || '', /^[0-9a-f]{40}$/);
    // Verify the file content is the post-fix version.
    const final = readFileSync(targetPath, 'utf8');
    assert.match(final, /Hello, world/);
    // Verify the commit landed.
    const log = git(dir, ['log', '--oneline']);
    assert.match(log, /fix\(code-fixer\): F-typo-01/);
    // Verify Trident verdict is recorded.
    assert.equal(result.trident.passed, true);
    assert.equal(result.trident.verdict, 'PASS');
  } finally { cleanup(dir); }
});

test('e2e: logic bug → DEFERRED, no commit', async () => {
  const dir = initRepo();
  try {
    const targetPath = join(dir, 'logic.js');
    writeFileSync(targetPath, 'export const count = 10;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const finding = {
      finding_id: 'F-logic-01',
      file: 'logic.js',
      severity: 'HIGH',
      category: 'logic-bug',
      description: 'count may be off-by-one in the loop bound',
      fix: { old_string: 'const count = 10', new_string: 'const count = 9' },
    };

    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
      commitRange: 'HEAD~1..HEAD',
    });
    assert.equal(result.status, STATUS.DEFERRED);
    assert.match(result.deferred_reason, /logic-bug/);
    // No new commit (still just the initial commit).
    const log = git(dir, ['log', '--oneline']).trim().split('\n');
    assert.equal(log.length, 1);
    // File untouched.
    assert.equal(readFileSync(targetPath, 'utf8'), 'export const count = 10;\n');
  } finally { cleanup(dir); }
});

test('e2e: stale finding (file gone) → STALE', async () => {
  const dir = initRepo();
  try {
    const finding = {
      finding_id: 'F-stale-01',
      file: 'never-existed.js',
      severity: 'LOW',
      category: 'typo',
      description: 'fix me',
      fix: { old_string: 'a', new_string: 'b' },
    };
    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(result.status, STATUS.STALE);
  } finally { cleanup(dir); }
});

test('e2e: tier-2 syntax fail → SYNTAX_FAIL + rollback', async () => {
  const dir = initRepo();
  try {
    const targetPath = join(dir, 'broken-after.js');
    // Pre-fix content is valid. The fix string breaks the syntax → tier 2 catches.
    writeFileSync(targetPath, 'export const x = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const finding = {
      finding_id: 'F-syntax-01',
      file: 'broken-after.js',
      severity: 'LOW',
      category: 'style',
      description: 'rename x to y',
      // Malformed replacement deliberately breaks the file (`= (((;` is a hard
      // parse error even under node's lenient `--check` parser).
      fix: { old_string: 'export const x = 1;', new_string: 'const x = (((;' },
    };
    const before = readFileSync(targetPath, 'utf8');
    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(result.status, STATUS.SYNTAX_FAIL);
    assert.equal(result.tier_reached, 2);
    // File was rolled back to the pre-edit content.
    assert.equal(readFileSync(targetPath, 'utf8'), before);
    // No commit landed.
    const log = git(dir, ['log', '--oneline']).trim().split('\n');
    assert.equal(log.length, 1);
  } finally { cleanup(dir); }
});

test('e2e: tier-3 fallback fail → FALLBACK_FAIL + rollback', async () => {
  const dir = initRepo();
  try {
    const targetPath = join(dir, 'app.js');
    writeFileSync(targetPath, 'export const greeting = "Hello";\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const finding = {
      finding_id: 'F-fb-01',
      file: 'app.js',
      severity: 'LOW',
      category: 'style',
      description: 'rename',
      fix: { old_string: '"Hello"', new_string: '"Hi"' },
    };
    const before = readFileSync(targetPath, 'utf8');
    // verifyCmd `false` always exits non-zero — simulates a project test
    // that the new edit "broke". tier-2 passes (.js syntactically valid),
    // tier-3 catches it.
    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
      verifyCmd: 'false',
    });
    assert.equal(result.status, STATUS.FALLBACK_FAIL);
    assert.equal(result.tier_reached, 3);
    // Rollback.
    assert.equal(readFileSync(targetPath, 'utf8'), before);
  } finally { cleanup(dir); }
});

test('e2e: Trident divergence → TRIDENT_FAIL + rollback', async () => {
  const dir = initRepo();
  try {
    const targetPath = join(dir, 'divergent.js');
    writeFileSync(targetPath, 'export const a = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const finding = {
      finding_id: 'F-tri-01',
      file: 'divergent.js',
      severity: 'LOW',
      category: 'style',
      description: 'tweak constant',
      fix: { old_string: 'const a = 1', new_string: 'const a = 2' },
    };
    const before = readFileSync(targetPath, 'utf8');
    const dispatch = _makeTridentDispatch('fail');
    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch,
      maxConvergeIter: 3,
    });
    assert.equal(result.status, STATUS.TRIDENT_FAIL);
    assert.equal(result.tier_reached, 'trident');
    // Trident verdict surfaced.
    assert.notEqual(result.trident.verdict, 'PASS');
    // Rollback.
    assert.equal(readFileSync(targetPath, 'utf8'), before);
    // No commit.
    const log = git(dir, ['log', '--oneline']).trim().split('\n');
    assert.equal(log.length, 1);
  } finally { cleanup(dir); }
});

test('e2e: skipTrident + skipCommit → returns VERIFIED at tier 3', async () => {
  const dir = initRepo();
  try {
    const targetPath = join(dir, 'unit.js');
    writeFileSync(targetPath, 'const v = 1;\n');
    const result = await fixFinding({
      finding: {
        finding_id: 'F-unit-01',
        file: 'unit.js',
        severity: 'LOW',
        category: 'style',
        description: 'flip',
        fix: { old_string: 'v = 1', new_string: 'v = 2' },
      },
      projectRoot: dir,
      skipTrident: true,
      skipCommit: true,
    });
    assert.equal(result.status, STATUS.VERIFIED);
    assert.equal(result.tier_reached, 3);
    assert.equal(result.sha, undefined);
    // File was actually edited (because we don't roll back on success).
    assert.match(readFileSync(targetPath, 'utf8'), /v = 2/);
  } finally { cleanup(dir); }
});

test('e2e: batch — mixed verified + deferred + stale → summary tallies', async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const findings = [
      {
        finding_id: 'OK',
        file: 'a.js', category: 'typo', severity: 'LOW',
        description: 'flip', fix: { old_string: 'a = 1', new_string: 'a = 2' },
      },
      {
        finding_id: 'LOGIC',
        file: 'a.js', category: 'logic-bug', severity: 'HIGH',
        description: 'race condition in foo',
        fix: { old_string: 'x', new_string: 'y' },
      },
      {
        finding_id: 'GONE',
        file: 'nope.js', category: 'typo', severity: 'LOW',
        description: 'missing', fix: { old_string: 'x', new_string: 'y' },
      },
    ];
    const { results, summary } = await fixFindings(findings, {
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(results.length, 3);
    assert.equal(summary.verified, 1);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.stale, 1);
  } finally { cleanup(dir); }
});

/* ────────────────────────────── recovery sentinel ───────────────────────── */

test('recovery: commit-sentinel directory exists after a successful fix', async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'r.js'), 'const r = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const finding = {
      finding_id: 'F-rec-01',
      file: 'r.js',
      severity: 'LOW',
      category: 'typo',
      description: 'flip',
      fix: { old_string: 'r = 1', new_string: 'r = 2' },
    };
    const result = await fixFinding({
      finding,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(result.status, STATUS.VERIFIED);
    // Sentinel directory exists; on success, no stale sentinels remain.
    const sentinelDir = join(dir, '.planning', 'worktree-recovery');
    assert.equal(existsSync(sentinelDir), true);
    const { readdirSync } = await import('node:fs');
    const remaining = readdirSync(sentinelDir).filter(n => n.startsWith('.worktree-recovery-pending.'));
    assert.equal(remaining.length, 0, 'no stale sentinels after successful commit');
  } finally { cleanup(dir); }
});

/* ───────────────── R5-1.10: auto-fix safety boundary ─────────────────────── */

// --- path containment (isPathContained unit) ---

test('isPathContained: file inside root → ok', () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'inside.js'), 'x\n');
    const r = isPathContained(join(dir, 'inside.js'), dir);
    assert.equal(r.ok, true);
  } finally { cleanup(dir); }
});

test('isPathContained: absolute path outside root → refused', () => {
  const dir = initRepo();
  try {
    const r = isPathContained('/etc/passwd', dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /escapes project root/);
  } finally { cleanup(dir); }
});

test('isPathContained: ../ traversal escaping root → refused', () => {
  const dir = initRepo();
  try {
    const r = isPathContained('../../../../tmp/evil.js', dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /escapes project root/);
  } finally { cleanup(dir); }
});

test('isPathContained: sibling dir impersonation → refused', () => {
  // `<root>-evil` must NOT count as inside `<root>`.
  const dir = initRepo();
  try {
    const sibling = `${dir}-evil`;
    mkdirSync(sibling, { recursive: true });
    try {
      const r = isPathContained(join(sibling, 'x.js'), dir);
      assert.equal(r.ok, false);
    } finally { cleanup(sibling); }
  } finally { cleanup(dir); }
});

test('isPathContained: symlink inside root pointing outside → refused', () => {
  const dir = initRepo();
  const outside = freshTmp('ijfw-cf-outside-');
  try {
    writeFileSync(join(outside, 'target.js'), 'const evil = 1;\n');
    const linkPath = join(dir, 'link.js');
    try {
      symlinkSync(join(outside, 'target.js'), linkPath);
    } catch {
      // Symlink creation can fail on some platforms (Windows w/o privilege);
      // skip gracefully — the absolute/traversal cases still prove the guard.
      return;
    }
    const r = isPathContained(linkPath, dir);
    assert.equal(r.ok, false, 'symlink escaping the root must be refused');
  } finally { cleanup(dir); cleanup(outside); }
});

test('isPathContained: not-yet-existing file inside root → ok (creating fix)', () => {
  const dir = initRepo();
  try {
    const r = isPathContained(join(dir, 'subdir', 'new-file.js'), dir);
    assert.equal(r.ok, true);
  } finally { cleanup(dir); }
});

// --- path containment (fixFinding refuses out-of-root) ---

test('fixFinding: out-of-root file (absolute) → OUT_OF_ROOT, file untouched', async () => {
  const dir = initRepo();
  const outside = freshTmp('ijfw-cf-outside-');
  try {
    const victim = join(outside, 'victim.js');
    writeFileSync(victim, 'const secret = 1;\n');
    git(dir, ['add', '.']);
    const finding = {
      finding_id: 'ESCAPE-ABS',
      file: victim, // absolute path OUTSIDE the audited project root
      category: 'typo', severity: 'HIGH', description: 'flip',
      fix: { old_string: 'secret = 1', new_string: 'secret = 2' },
    };
    const r = await fixFinding({
      finding, projectRoot: dir, dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(r.status, STATUS.OUT_OF_ROOT);
    assert.match(r.evidence, /refused/);
    // The out-of-root file must be byte-identical — never written.
    assert.equal(readFileSync(victim, 'utf8'), 'const secret = 1;\n');
  } finally { cleanup(dir); cleanup(outside); }
});

test('fixFinding: out-of-root file (../ traversal) → OUT_OF_ROOT', async () => {
  const dir = initRepo();
  try {
    const finding = {
      finding_id: 'ESCAPE-REL',
      file: '../../../../tmp/escape.js',
      category: 'typo', severity: 'HIGH', description: 'flip',
      fix: { old_string: 'a', new_string: 'b' },
    };
    const r = await fixFinding({
      finding, projectRoot: dir, dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(r.status, STATUS.OUT_OF_ROOT);
  } finally { cleanup(dir); }
});

// --- change cap ---

test('fixFindings: change cap stops after N files + reports remainder', async () => {
  const dir = initRepo();
  try {
    // 5 fixable files, but cap at 2 → only 2 get touched, 3 → CAP_REACHED.
    const findings = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `f${i}.js`), `const v = ${i};\n`);
      findings.push({
        finding_id: `CAP-${i}`,
        file: `f${i}.js`, category: 'typo', severity: 'HIGH',
        description: 'flip', fix: { old_string: `v = ${i}`, new_string: `v = ${i + 10}` },
      });
    }
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    const { results, summary, capped, filesTouched, maxAutoFixFiles } =
      await fixFindings(findings, {
        projectRoot: dir,
        dispatch: _makeTridentDispatch('pass'),
        maxAutoFixFiles: 2,
      });
    assert.equal(maxAutoFixFiles, 2);
    assert.equal(capped, true, 'cap should have been hit');
    assert.equal(filesTouched, 2, 'exactly 2 distinct files touched');
    assert.equal(summary.verified, 2);
    assert.equal(summary.cap_reached, 3, '3 findings short-circuited by the cap');
    // The capped findings carry the CAP_REACHED status + an explanatory reason.
    const cappedRecs = results.filter(r => r.status === STATUS.CAP_REACHED);
    assert.equal(cappedRecs.length, 3);
    assert.match(cappedRecs[0].evidence, /change cap reached/);
    // Files 2,3,4 were never written — still at their original content.
    for (const i of [2, 3, 4]) {
      assert.equal(readFileSync(join(dir, `f${i}.js`), 'utf8'), `const v = ${i};\n`);
    }
  } finally { cleanup(dir); }
});

test('fixFindings: default change cap is DEFAULT_MAX_AUTOFIX_FILES', async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);
    const { maxAutoFixFiles } = await fixFindings([], {
      projectRoot: dir, dispatch: _makeTridentDispatch('pass'),
    });
    assert.equal(maxAutoFixFiles, DEFAULT_MAX_AUTOFIX_FILES);
    assert.equal(DEFAULT_MAX_AUTOFIX_FILES, 10);
  } finally { cleanup(dir); }
});

test('fixFindings: maxAutoFixFiles clamped to the 50 ceiling', async () => {
  const dir = initRepo();
  try {
    const { maxAutoFixFiles } = await fixFindings([], {
      projectRoot: dir, dispatch: _makeTridentDispatch('pass'),
      maxAutoFixFiles: 9999,
    });
    assert.equal(maxAutoFixFiles, 50, 'an absurd cap is clamped to the ceiling');
  } finally { cleanup(dir); }
});

// --- runConsensusFix end-to-end with both guards ---

test('runConsensusFix: consensus HIGHs respect change cap', async () => {
  const dir = initRepo();
  try {
    const findings = [];
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `c${i}.js`), `const v = ${i};\n`);
      findings.push({
        file: `c${i}.js`, severity: 'high', category: 'typo',
        description: `consensus issue ${i}`,
        fix: { old_string: `v = ${i}`, new_string: `v = ${i + 100}` },
      });
    }
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    // Build a perIteration shape where 2 lenses agree on all 4 HIGHs.
    const perIteration = [{
      lensResults: [
        { lens: 'codex', findings },
        { lens: 'gemini', findings },
      ],
    }];
    const r = await runConsensusFix({
      perIteration,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
      maxAutoFixFiles: 2,
      skipTrident: true,
    });
    assert.equal(r.triggered, true);
    assert.equal(r.consensusCount, 4);
    assert.equal(r.capped, true);
    assert.equal(r.filesTouched, 2);
    assert.equal(r.maxAutoFixFiles, 2);
    assert.equal(r.summary.cap_reached, 2);
  } finally { cleanup(dir); }
});

test('runConsensusFix: out-of-root consensus finding refused, never written', async () => {
  const dir = initRepo();
  const outside = freshTmp('ijfw-cf-outside-');
  try {
    const victim = join(outside, 'victim.js');
    writeFileSync(victim, 'const x = 1;\n');
    const escaping = {
      file: victim, severity: 'high', category: 'typo',
      description: 'escaping consensus finding',
      fix: { old_string: 'x = 1', new_string: 'x = 2' },
    };
    const perIteration = [{
      lensResults: [
        { lens: 'codex', findings: [escaping] },
        { lens: 'gemini', findings: [escaping] },
      ],
    }];
    const r = await runConsensusFix({
      perIteration,
      projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
      skipTrident: true,
    });
    assert.equal(r.triggered, true);
    assert.equal(r.summary.out_of_root, 1);
    // The out-of-root victim is untouched.
    assert.equal(readFileSync(victim, 'utf8'), 'const x = 1;\n');
  } finally { cleanup(dir); cleanup(outside); }
});

test('runConsensusFix: dryRun reports without writing', async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'd.js'), 'const d = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);
    const finding = {
      file: 'd.js', severity: 'high', category: 'typo',
      description: 'dry run finding',
      fix: { old_string: 'd = 1', new_string: 'd = 2' },
    };
    const perIteration = [{
      lensResults: [
        { lens: 'codex', findings: [finding] },
        { lens: 'gemini', findings: [finding] },
      ],
    }];
    const r = await runConsensusFix({
      perIteration, projectRoot: dir,
      dispatch: _makeTridentDispatch('pass'),
      dryRun: true, skipTrident: true,
    });
    assert.equal(r.triggered, true);
    // dry-run defers without writing — file content unchanged.
    assert.equal(readFileSync(join(dir, 'd.js'), 'utf8'), 'const d = 1;\n');
  } finally { cleanup(dir); }
});
