// Gate 6: audit-ci -- npm audit with severity gate (fails on high+).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function parseAuditReport(output) {
  const start = output.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

function highCriticalCount(report) {
  const vulns = report?.metadata?.vulnerabilities || {};
  return Number(vulns.high || 0) + Number(vulns.critical || 0);
}

function vulnerableNames(report) {
  const out = [];
  for (const [name, vuln] of Object.entries(report?.vulnerabilities || {})) {
    const severity = String(vuln?.severity || '').toLowerCase();
    if (severity === 'high' || severity === 'critical') out.push(`${name}: ${severity}`);
  }
  return out;
}

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();
  const packageDirs = ['installer', 'mcp-server'];
  const runs = packageDirs.map((dir) => {
    const res = spawnSync(
      'npm',
      ['audit', '--audit-level=high', '--json'],
      {
        encoding: 'utf8',
        cwd: join(ctx.repoRoot, dir),
        timeout: 60_000,
      },
    );
    const output = (res.stdout || '') + (res.stderr || '');
    const report = parseAuditReport(output);
    const highCritical = highCriticalCount(report);
    return { dir, status: res.status, output, report, highCritical };
  });

  const durationMs = Date.now() - t0;
  const failed = runs.filter((r) => !r.report || r.highCritical > 0);

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
    if (!r.report) {
      lines.push(`${r.dir}: audit report unavailable`);
      lines.push(...r.output.split('\n').filter(Boolean).slice(0, 10));
      continue;
    }
    lines.push(`${r.dir}: ${r.highCritical} high/critical advisory item(s)`);
    lines.push(...vulnerableNames(r.report).slice(0, 10));
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
