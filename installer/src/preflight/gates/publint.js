// Gate 4: publint -- validates package.json bin/exports/shebang.
// Catches missing exec bit, bin targets that don't exist in pack, missing shebangs.

import { spawnSync } from 'node:child_process';

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();
  const ver = ctx.versions['publint'] || 'latest';

  const res = spawnSync(
    'npx',
    ['--yes', `publint@${ver}`, '--strict'],
    { encoding: 'utf8', cwd: ctx.repoRoot + '/installer', timeout: 90_000 },
  );

  const durationMs = Date.now() - t0;
  const output = (res.stdout || '') + (res.stderr || '');
  const lines = output.split('\n').filter(Boolean);

  if (res.status === 0) {
    return {
      name: 'publint',
      status: 'PASS',
      message: 'publint: package.json integrity verified',
      details: [],
      durationMs,
    };
  }

  return {
    name: 'publint',
    status: 'FAIL',
    message: 'publint: package.json issues found',
    details: lines.slice(0, 20),
    durationMs,
  };
}

export const name = 'publint';
export const severity = 'blocking';
export const parallel = true;
