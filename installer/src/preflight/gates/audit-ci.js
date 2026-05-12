// Gate 6: audit-ci -- npm audit with severity gate (fails on high+).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();
  const ver = ctx.versions['audit-ci'] || 'latest';
  const configPath = join(ctx.repoRoot, '.audit-ci.jsonc');

  const packageDirs = ['installer', 'mcp-server'];
  const runs = packageDirs.map((dir) => {
    const res = spawnSync(
      'npx',
      ['--yes', `audit-ci@${ver}`, '--config', configPath],
      {
        encoding: 'utf8',
        cwd: join(ctx.repoRoot, dir),
        timeout: 60_000,
      },
    );
    return { dir, status: res.status, output: (res.stdout || '') + (res.stderr || '') };
  });

  const durationMs = Date.now() - t0;
  const failed = runs.filter((r) => r.status !== 0);

  if (failed.length === 0) {
    return {
      name: 'audit-ci',
      status: 'PASS',
      message: 'audit-ci: no high/critical vulnerabilities in installer or mcp-server',
      details: runs.map((r) => `${r.dir}: pass`),
      durationMs,
    };
  }

  const lines = [];
  for (const r of failed) {
    lines.push(`${r.dir}: audit failed`);
    lines.push(...r.output.split('\n').filter(Boolean).slice(0, 10));
  }

  return {
    name: 'audit-ci',
    status: 'FAIL',
    message: 'audit-ci: high or critical vulnerabilities found',
    details: lines.slice(0, 20),
    durationMs,
  };
}

export const name = 'audit-ci';
export const severity = 'blocking';
export const parallel = true;
