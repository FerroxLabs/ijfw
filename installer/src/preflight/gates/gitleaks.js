// Gate 5: gitleaks -- secret scan.
// gitleaks is a system binary (not an npm package).
// Falls back to WARN with install hint if absent.

import { spawnSync } from 'node:child_process';

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();

  // Check binary availability
  const which = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (which.status === null || which.error) {
    // Fail-closed in CI: the workflows install gitleaks explicitly, so a
    // missing binary there means the secret scan silently never ran (a
    // runner-image change must not be able to disable the only pre-publish
    // secret scan). Locally a missing binary stays a WARN with install hint.
    const inCI = process.env.CI === 'true' || process.env.CI === '1';
    return {
      name: 'gitleaks',
      status: inCI ? 'FAIL' : 'WARN',
      message: inCI
        ? 'gitleaks not installed in CI -- secret scan is mandatory; the workflow must install gitleaks'
        : 'gitleaks not installed -- brew install gitleaks / https://github.com/gitleaks/gitleaks',
      details: ['Secret scan skipped. Install gitleaks to enable this gate.'],
      durationMs: Date.now() - t0,
    };
  }

  // `--no-git` scans the working tree as raw files and does NOT honor
  // .gitignore, so it walks node_modules + dist too. A full-tree scan of this
  // repo reads ~95 MB and takes ~30-35s on a dev machine -- the prior 30s
  // spawn timeout sat right on that boundary and would intermittently kill a
  // CLEAN scan mid-flight, reporting a false FAIL (a fresh `npm install` that
  // grows node_modules was enough to tip it over). The scan itself is correct;
  // it just needs headroom. 120s is generous for both local and CI runners.
  // (False-positive findings inside node_modules/dist are separately suppressed
  // by the build-dir allowlist in .gitleaks.toml.)
  const res = spawnSync(
    'gitleaks',
    // issue #27: `--redact` masks the literal secret VALUE in the -v output.
    // Without it, a real finding's plaintext (`Secret: ghp_...`) was captured
    // into the FAIL `details` below, serialized into preflight-report.json, and
    // uploaded as a public-repo CI artifact (14-30d retention) -- so the scanner
    // that flags a leak became its own amplifier, persisting the plaintext for
    // weeks after a dev scrubbed it from history. --redact keeps the finding's
    // location/rule/line (value shown as REDACTED), preserving the gate's
    // diagnostic value without leaking the secret.
    ['detect', '--no-git', '--source', ctx.repoRoot, '--gitleaks-ignore-path', '.gitleaksignore', '--redact', '-v', '--exit-code', '1'],
    { encoding: 'utf8', cwd: ctx.repoRoot, timeout: 120_000 },
  );

  const durationMs = Date.now() - t0;

  if (res.status === 0) {
    return {
      name: 'gitleaks',
      status: 'PASS',
      message: 'gitleaks: no secrets detected',
      details: [],
      durationMs,
    };
  }

  const lines = ((res.stdout || '') + (res.stderr || '')).split('\n').filter(Boolean);
  return {
    name: 'gitleaks',
    status: 'FAIL',
    message: 'gitleaks: potential secrets detected',
    details: lines.slice(0, 30),
    durationMs,
  };
}

export const name = 'gitleaks';
export const severity = 'blocking';
export const parallel = true;
