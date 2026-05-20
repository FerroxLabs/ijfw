/**
 * code-fixer.js — v1.5.0 T27 / G4: cross-AI consensus code-fixer loop.
 *
 * Wraps the ijfw-code-fixer agent (claude/agents/ijfw-code-fixer.md, T24) with
 * the flagship Trident-verified per-finding atomic-commit loop. This is Moat
 * #1 of the v1.5.0 gap-closure brief: review → fix → Trident-verify → atomic
 * commit, with crash-safe sentinel recovery on every destructive boundary.
 *
 * Contract (per finding):
 *   1. Triage  — DEFER logic-bugs, ambiguous findings, stale findings.
 *   2. Snapshot — capture pre-edit file content for rollback.
 *   3. Apply   — minimal Edit (`old_string` → `new_string` in target file).
 *   4. Tier-1  — re-read; confirm change landed character-for-character.
 *   5. Tier-2  — per-language syntax check (node/python/bash/json/tsc).
 *   6. Tier-3  — optional fallback (project verify_cmd / package.json test).
 *   7. Trident — run runPhaseEConverge over the edited file; require PASS.
 *   8. Commit  — one atomic commit per finding in the isolated worktree.
 *   ✗  ANY failure rolls back the edit and emits a structured failure record.
 *
 * Worktree lifecycle is delegated to `lib/worktree-recovery.js`'s sentinel
 * pattern — if the process crashes mid-fix the next run prunes the dangling
 * worktree and reports the survivor.
 *
 * Zero new prod deps. ESM. Node ≥18.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, extname, dirname, relative, isAbsolute, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { withRecoverySentinel } from '../lib/worktree-recovery.js';

const execFileAsync = promisify(execFile);

/* ────────────────────────────── status codes ────────────────────────────── */

export const STATUS = Object.freeze({
  VERIFIED:      'VERIFIED',
  DEFERRED:      'DEFERRED',
  STALE:         'STALE',
  VERIFY_FAIL:   'VERIFY_FAIL',
  SYNTAX_FAIL:   'SYNTAX_FAIL',
  FALLBACK_FAIL: 'FALLBACK_FAIL',
  TRIDENT_FAIL:  'TRIDENT_FAIL',
  COMMIT_FAIL:   'COMMIT_FAIL',
});

/* ────────────────────────────── logic-bug heuristic ─────────────────────── */

// Phrases that signal a logic bug a mechanical fixer can't responsibly patch.
// Lifted from the v1.5.0 G4 brief + the ijfw-code-fixer agent's "DO NOT" list.
const LOGIC_BUG_PHRASES = [
  'off-by-one',
  'off by one',
  'incorrect condition',
  'wrong condition',
  'wrong order',
  'wrong logic',
  'race condition',
  'business logic',
  'semantic bug',
  'edge case',
  'intent unclear',
  'may not be correct',
  'might be wrong',
];

/**
 * isLogicBug(finding) — return {logic: boolean, reason: string}.
 *
 * Two-layer check:
 *   1. Explicit category tag (`category: logic-bug`) — exact match.
 *   2. Substring scan of `description` against LOGIC_BUG_PHRASES.
 *
 * Conservative-by-design: false positives are cheap (we defer instead of
 * patching), false negatives are expensive (we patch a real logic bug).
 */
export function isLogicBug(finding) {
  if (!finding || typeof finding !== 'object') {
    return { logic: false, reason: '' };
  }
  const cat = String(finding.category || '').toLowerCase().trim();
  if (cat === 'logic-bug' || cat === 'logic_bug' || cat === 'logic') {
    return { logic: true, reason: `category=${cat}` };
  }
  const desc = String(finding.description || '').toLowerCase();
  for (const phrase of LOGIC_BUG_PHRASES) {
    if (desc.includes(phrase)) {
      return { logic: true, reason: `phrase="${phrase}"` };
    }
  }
  // `missing-await` with no concrete line/range = ambiguous → defer.
  if (cat === 'missing-await' && (!finding.line || !finding.fix)) {
    return { logic: true, reason: 'missing-await without concrete boundary' };
  }
  return { logic: false, reason: '' };
}

/* ────────────────────────────── triage ──────────────────────────────────── */

/**
 * triage(finding) — pre-flight gate. Returns one of:
 *   { proceed: true }                — go ahead and patch
 *   { proceed: false, status, reason } — short-circuit with DEFERRED|STALE
 */
export function triage(finding) {
  if (!finding || typeof finding !== 'object') {
    return { proceed: false, status: STATUS.DEFERRED, reason: 'malformed-finding' };
  }
  if (!finding.file || typeof finding.file !== 'string') {
    return { proceed: false, status: STATUS.DEFERRED, reason: 'no-file-path' };
  }
  // Logic bug → defer (the contract is explicit: humans only).
  const lb = isLogicBug(finding);
  if (lb.logic) {
    return { proceed: false, status: STATUS.DEFERRED, reason: `logic-bug: ${lb.reason}` };
  }
  // Need a concrete edit operation. Either { fix: { old_string, new_string } }
  // or a precise suggested_fix string we can wrap. Without it the fixer is
  // guessing, and guessing is logic-bug territory.
  const fix = finding.fix || finding.suggested_fix;
  if (!fix || (typeof fix === 'object' && (!fix.old_string || fix.new_string === undefined))) {
    return { proceed: false, status: STATUS.DEFERRED, reason: 'no-concrete-fix' };
  }
  return { proceed: true };
}

/* ────────────────────────────── tier 1 — re-read ────────────────────────── */

/**
 * verifyTier1(filePath, newString) — confirm the edit actually landed.
 * Returns { ok: boolean, evidence: string }.
 */
export async function verifyTier1(filePath, newString) {
  try {
    const content = await readFile(filePath, 'utf8');
    if (newString === '' || content.includes(newString)) {
      return { ok: true, evidence: '' };
    }
    return {
      ok: false,
      evidence: `tier-1: expected substring not present in ${filePath}`,
    };
  } catch (err) {
    return { ok: false, evidence: `tier-1: read failed: ${err.message}` };
  }
}

/* ────────────────────────────── tier 2 — syntax check ───────────────────── */

/**
 * tier2SyntaxCheckCmd(filePath) — return the per-language check command, or
 * null if the extension isn't on the supported list (caller SKIPs tier 2).
 *
 * Per ijfw-code-fixer.md contract:
 *   .js/.mjs/.cjs → node --check
 *   .ts/.tsx      → tsc --noEmit --allowJs (only if tsc on PATH; else SKIP)
 *   .py           → python3 -m py_compile
 *   .json         → node -e JSON.parse
 *   .sh/.bash     → bash -n
 *   others        → SKIP
 */
export function tier2SyntaxCheckCmd(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return { cmd: 'node', args: ['--check', filePath] };
    case '.json':
      return {
        cmd: 'node',
        args: [
          '-e',
          `JSON.parse(require('fs').readFileSync(${JSON.stringify(filePath)},'utf8'))`,
        ],
      };
    case '.py':
      return { cmd: 'python3', args: ['-m', 'py_compile', filePath] };
    case '.sh':
    case '.bash':
      return { cmd: 'bash', args: ['-n', filePath] };
    case '.ts':
    case '.tsx': {
      // Only if tsc on PATH. The agent contract says SKIP when absent.
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tsc'], {
        encoding: 'utf8',
      });
      if (which.status === 0 && which.stdout.trim()) {
        return { cmd: 'tsc', args: ['--noEmit', '--allowJs', filePath] };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * verifyTier2(filePath) — per-language syntax check. Returns one of:
 *   { ok: true,  skipped: false }
 *   { ok: true,  skipped: true  }     — extension not on the list
 *   { ok: false, evidence: string }   — syntax error captured
 */
export async function verifyTier2(filePath) {
  const spec = tier2SyntaxCheckCmd(filePath);
  if (!spec) return { ok: true, skipped: true };
  try {
    await execFileAsync(spec.cmd, spec.args, { timeout: 15_000 });
    return { ok: true, skipped: false };
  } catch (err) {
    const stderr = err.stderr || err.stdout || err.message || '';
    return {
      ok: false,
      evidence: `tier-2 (${spec.cmd}): ${String(stderr).split('\n').slice(0, 5).join('\n')}`,
    };
  }
}

/* ────────────────────────────── tier 3 — fallback project verify ────────── */

/**
 * resolveProjectVerifyCmd(projectRoot, verifyCmdOverride) — pick the verify
 * command. Priority: explicit override → package.json.scripts.test → Makefile
 * `test:` target → null (caller SKIPs tier 3).
 */
async function resolveProjectVerifyCmd(projectRoot, verifyCmdOverride) {
  if (verifyCmdOverride && typeof verifyCmdOverride === 'string' && verifyCmdOverride.trim()) {
    return verifyCmdOverride.trim();
  }
  // package.json.scripts.test
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) {
        return 'npm test --silent';
      }
    } catch { /* swallow malformed package.json */ }
  }
  // Makefile test target
  const mkPath = join(projectRoot, 'Makefile');
  if (existsSync(mkPath)) {
    try {
      const mk = await readFile(mkPath, 'utf8');
      if (/^test\s*:/m.test(mk)) return 'make test';
    } catch { /* swallow */ }
  }
  return null;
}

/**
 * verifyTier3(projectRoot, verifyCmdOverride) — run the project's documented
 * verify command. Returns one of:
 *   { ok: true,  skipped: false }
 *   { ok: true,  skipped: true }       — no command discovered
 *   { ok: false, evidence: string }    — first 20 lines of failure output
 */
export async function verifyTier3(projectRoot, verifyCmdOverride) {
  const cmd = await resolveProjectVerifyCmd(projectRoot, verifyCmdOverride);
  if (!cmd) return { ok: true, skipped: true };
  // Run the command via `sh -c` so script lines like `npm test --silent` work
  // verbatim. Timeout is generous (5 min) because real test suites can be slow.
  return new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { cwd: projectRoot, timeout: 5 * 60_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, skipped: false });
      const blob = String(stderr || stdout || err.message || '');
      const evidence = blob.split('\n').slice(0, 20).join('\n');
      resolve({ ok: false, evidence: `tier-3 (${cmd}): ${evidence}` });
    });
  });
}

/* ────────────────────────────── trident verify ──────────────────────────── */

/**
 * runTridentVerify({ commitRange, dispatch, projectRoot, lenses }) — wrap
 * cross-orchestrator's runPhaseEConverge with the code-fixer's PASS-required
 * contract. The verdict shape from runPhaseEConverge is:
 *   { verdict: 'PASS' | 'consensus_failed' | ..., iterations, findings, ... }
 *
 * The fixer only commits on `verdict === 'PASS'`. Anything else rolls back.
 *
 * `dispatch` is injectable (and required) so tests can drive scripted lens
 * responses without spawning the real codex/gemini/claude CLIs.
 */
export async function runTridentVerify({
  commitRange,
  dispatch,
  projectRoot,
  lenses,
  maxIterations = 3,
}) {
  if (typeof dispatch !== 'function') {
    return {
      verdict: 'TRIDENT_DISPATCH_MISSING',
      passed: false,
      evidence: 'no dispatch function supplied',
    };
  }
  // Lazy-import to keep this module loadable in environments where
  // cross-orchestrator's transitive deps (state-sdk, receipts) aren't wired.
  // Test fixtures can always supply a custom `dispatch`, so the orchestrator
  // call works against scripted lens responses with no real CLI spawn.
  const { runPhaseEConverge } = await import('../cross-orchestrator.js');
  const result = await runPhaseEConverge({
    commitRange: commitRange || 'HEAD~1..HEAD',
    dispatch,
    lenses: Array.isArray(lenses) && lenses.length ? lenses : undefined,
    maxIterations,
    projectRoot,
    projectDir: projectRoot,
  });
  return {
    verdict: result.verdict,
    passed: result.verdict === 'PASS',
    iterations: result.iterations,
    evidence: result.verdict === 'PASS' ? '' : `trident: verdict=${result.verdict}`,
    raw: result,
  };
}

/* ────────────────────────────── git helpers ─────────────────────────────── */

function git(cwd, args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) {
    const err = new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * atomicCommit({ projectRoot, file, finding }) — stage the one edited file +
 * commit. Per-finding atomicity is the wrapping-loop guarantee from the agent
 * contract; bundling defeats the rollback story.
 *
 * Returns { ok: boolean, sha?: string, evidence?: string }.
 */
export function atomicCommit({ projectRoot, file, finding }) {
  try {
    // Explicit-file stage; never `git add -A` (catches stray edits).
    const rel = isAbsolute(file) ? relative(projectRoot, file) : file;
    git(projectRoot, ['add', '--', rel]);
    const id = finding.finding_id || finding.id || 'unknown';
    const sev = (finding.severity || 'unknown').toUpperCase();
    const desc = String(finding.description || '').split('\n')[0].slice(0, 120);
    const msg = `fix(code-fixer): ${id} [${sev}] ${desc}`.trim();
    git(projectRoot, ['commit', '-m', msg]);
    const sha = git(projectRoot, ['rev-parse', 'HEAD']).stdout.trim();
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, evidence: err.message };
  }
}

/* ────────────────────────────── apply + rollback ────────────────────────── */

/**
 * applyEdit(filePath, fix) — one minimal substitution, captures pre-edit
 * content for rollback. Supports the two fix shapes the contract recognises:
 *   { old_string, new_string }  — exact substring substitution
 *   string                      — interpreted as the new full content (rare)
 */
async function applyEdit(filePath, fix) {
  const before = await readFile(filePath, 'utf8');
  let after;
  if (typeof fix === 'object' && fix.old_string !== undefined) {
    if (!before.includes(fix.old_string)) {
      return { ok: false, evidence: 'old_string not found in file', before };
    }
    // Exactly-one occurrence guarantee — same rule the Edit tool uses.
    const occurrences = before.split(fix.old_string).length - 1;
    if (occurrences > 1 && !fix.replace_all) {
      return { ok: false, evidence: `old_string occurs ${occurrences}×; ambiguous`, before };
    }
    after = fix.replace_all
      ? before.split(fix.old_string).join(fix.new_string)
      : before.replace(fix.old_string, fix.new_string);
  } else if (typeof fix === 'string') {
    after = fix;
  } else {
    return { ok: false, evidence: 'unsupported fix shape', before };
  }
  if (after === before) {
    return { ok: false, evidence: 'edit was a no-op (after === before)', before };
  }
  await writeFile(filePath, after, 'utf8');
  return { ok: true, before, after };
}

async function rollback(filePath, originalContent) {
  try {
    await writeFile(filePath, originalContent, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ────────────────────────────── main entry point ────────────────────────── */

/**
 * fixFinding({ finding, projectRoot, dispatch, verifyCmd, dryRun, lenses,
 *              commitRange, maxConvergeIter, skipTrident, skipCommit })
 *
 * The flagship loop. Returns a structured record:
 *   {
 *     status: STATUS.*,
 *     tier_reached: 1 | 2 | 3 | 'trident' | 'commit' | 'n/a',
 *     finding_id, file, evidence?, sha?, trident?
 *   }
 *
 * `dispatch` is required for Trident verify; tests inject scripted responses.
 * `skipTrident` is for unit-test-only flows that exercise the 3-tier matrix
 * in isolation; production callers MUST run Trident.
 *
 * `skipCommit` is for dry-run / unit-test flows; production callers MUST
 * commit (the recovery-sentinel is wrapped around the commit boundary).
 */
export async function fixFinding({
  finding,
  projectRoot,
  dispatch,
  verifyCmd,
  dryRun = false,
  lenses,
  commitRange,
  maxConvergeIter = 3,
  skipTrident = false,
  skipCommit = false,
} = {}) {
  const findingId = finding?.finding_id || finding?.id || 'unknown';
  const base = { finding_id: findingId, file: finding?.file };

  // 1. triage
  const t = triage(finding);
  if (!t.proceed) {
    return { ...base, status: t.status, tier_reached: 'n/a', deferred_reason: t.reason };
  }

  // 2. confirm target exists + snapshot
  const filePath = isAbsolute(finding.file)
    ? finding.file
    : resolvePath(projectRoot || process.cwd(), finding.file);
  if (!existsSync(filePath)) {
    return { ...base, status: STATUS.STALE, tier_reached: 'n/a',
             evidence: `target file does not exist: ${filePath}` };
  }

  if (dryRun) {
    return { ...base, status: STATUS.DEFERRED, tier_reached: 'n/a',
             deferred_reason: 'dry-run' };
  }

  // 3. apply
  const fix = finding.fix || finding.suggested_fix;
  const edit = await applyEdit(filePath, fix);
  if (!edit.ok) {
    return { ...base, status: STATUS.VERIFY_FAIL, tier_reached: 1, evidence: edit.evidence };
  }
  const originalContent = edit.before;
  const expectedNewString = typeof fix === 'object' ? fix.new_string : null;

  // 4. tier 1 — re-read
  const t1 = await verifyTier1(
    filePath,
    expectedNewString !== null && expectedNewString !== undefined ? expectedNewString : '',
  );
  if (!t1.ok) {
    await rollback(filePath, originalContent);
    return { ...base, status: STATUS.VERIFY_FAIL, tier_reached: 1, evidence: t1.evidence };
  }

  // 5. tier 2 — syntax check (per-language)
  const t2 = await verifyTier2(filePath);
  if (!t2.ok) {
    await rollback(filePath, originalContent);
    return { ...base, status: STATUS.SYNTAX_FAIL, tier_reached: 2, evidence: t2.evidence };
  }

  // 6. tier 3 — fallback project verify
  // Only run if tier 2 passed (or skipped). If tier 2 was non-skipped + passed
  // we still run tier 3 as a deeper net.
  const t3 = await verifyTier3(projectRoot || process.cwd(), verifyCmd);
  if (!t3.ok) {
    await rollback(filePath, originalContent);
    return { ...base, status: STATUS.FALLBACK_FAIL, tier_reached: 3, evidence: t3.evidence };
  }

  // 7. trident verify
  let tridentRec = null;
  if (!skipTrident) {
    const trident = await runTridentVerify({
      commitRange,
      dispatch,
      projectRoot: projectRoot || process.cwd(),
      lenses,
      maxIterations: maxConvergeIter,
    });
    tridentRec = {
      verdict: trident.verdict,
      iterations: trident.iterations,
      passed: trident.passed,
    };
    if (!trident.passed) {
      await rollback(filePath, originalContent);
      return {
        ...base,
        status: STATUS.TRIDENT_FAIL,
        tier_reached: 'trident',
        evidence: trident.evidence,
        trident: tridentRec,
      };
    }
  }

  // 8. atomic commit (sentinel-wrapped — the destructive crash window).
  if (skipCommit) {
    return {
      ...base,
      status: STATUS.VERIFIED,
      tier_reached: skipTrident ? 3 : 'trident',
      trident: tridentRec,
    };
  }

  try {
    const sentinelData = {
      op: 'code-fixer-commit',
      finding_id: findingId,
      file: filePath,
      worktreePath: projectRoot, // re-used for surface compat with recoverPending
    };
    const commitRes = await withRecoverySentinel(
      sentinelData,
      async () => atomicCommit({ projectRoot, file: filePath, finding }),
      projectRoot || process.cwd(),
    );
    if (!commitRes.ok) {
      await rollback(filePath, originalContent);
      return {
        ...base,
        status: STATUS.COMMIT_FAIL,
        tier_reached: 'commit',
        evidence: commitRes.evidence,
        trident: tridentRec,
      };
    }
    return {
      ...base,
      status: STATUS.VERIFIED,
      tier_reached: skipTrident ? 3 : 'trident',
      sha: commitRes.sha,
      trident: tridentRec,
    };
  } catch (err) {
    // Sentinel remains on disk for next-run recovery (worktree-recovery.js).
    await rollback(filePath, originalContent);
    return {
      ...base,
      status: STATUS.COMMIT_FAIL,
      tier_reached: 'commit',
      evidence: `sentinel-wrapped commit threw: ${err.message}`,
      sentinel_path: err.sentinelPath,
      trident: tridentRec,
    };
  }
}

/* ────────────────────────────── batch runner ────────────────────────────── */

/**
 * fixFindings(findings, opts) — sequential per-finding atomic loop.
 *
 * Sequential is intentional: each fix mutates the same worktree HEAD and
 * the Trident step needs a stable commit range. Parallel fixes would shred
 * the atomicity guarantee.
 *
 * Returns { results: Array<fixFinding-record>, summary: { verified, deferred,
 *           stale, verify_fail, syntax_fail, fallback_fail, trident_fail,
 *           commit_fail } }.
 */
export async function fixFindings(findings, opts = {}) {
  const results = [];
  const summary = {
    verified: 0, deferred: 0, stale: 0,
    verify_fail: 0, syntax_fail: 0, fallback_fail: 0,
    trident_fail: 0, commit_fail: 0,
  };
  for (const finding of (findings || [])) {
    // eslint-disable-next-line no-await-in-loop -- sequential is the contract
    const r = await fixFinding({ ...opts, finding });
    results.push(r);
    const k = String(r.status || '').toLowerCase();
    if (k in summary) summary[k] += 1;
  }
  return { results, summary };
}

/* ────────────────────────────── test helpers ────────────────────────────── */

/**
 * _makeTridentDispatch — convenience builder for unit + e2e tests.
 *
 * Mode 'pass'      → every lens returns PASS, empty findings, first iter.
 * Mode 'fail-then-pass' → first iter FAIL on one lens, second PASS.
 * Mode 'fail'      → every iter has codex FAIL; convergence stalls.
 *
 * Production callers MUST inject a real lens dispatcher. This is exported
 * (underscore-prefixed) only for the test harness.
 */
export function _makeTridentDispatch(mode = 'pass') {
  const scripts = {
    pass: () => ({ verdict: 'PASS', findings: [] }),
  };
  if (mode === 'pass') {
    return async ({ lens }) => ({ lens, ...scripts.pass() });
  }
  if (mode === 'fail-then-pass') {
    return async ({ lens, iteration }) => {
      if (lens === 'codex' && iteration === 1) {
        return { lens, verdict: 'FAIL', findings: [{ severity: 'high', text: 'demo' }] };
      }
      return { lens, verdict: 'PASS', findings: [] };
    };
  }
  if (mode === 'fail') {
    let counter = 0;
    return async ({ lens }) => {
      counter += 1;
      if (lens === 'codex') {
        return { lens, verdict: 'FAIL', findings: [{ severity: 'high', text: `t-${counter}` }] };
      }
      return { lens, verdict: 'PASS', findings: [{ text: `c-${counter}` }] };
    };
  }
  throw new Error(`_makeTridentDispatch: unknown mode "${mode}"`);
}

/**
 * _freshTmpRoot(prefix) — mkdtemp helper for tests; returns absolute path.
 */
export async function _freshTmpRoot(prefix = 'ijfw-code-fixer-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function _cleanupTmpRoot(root) {
  try { await rm(root, { recursive: true, force: true }); } catch { /* swallow */ }
}
