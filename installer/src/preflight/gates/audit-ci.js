// Gate 6: audit-ci -- npm audit with severity gate (fails on high+).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { emitGateResult } from '../../../../mcp-server/src/gate-result.js';

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

  const status = failed.length === 0 ? 'PASS' : 'FAIL';
  const message =
    status === 'PASS'
      ? 'audit-ci: no high/critical vulnerabilities in installer or mcp-server'
      : 'audit-ci: high or critical vulnerabilities found';

  let details;
  if (status === 'PASS') {
    details = runs.map((r) => `${r.dir}: pass`);
  } else {
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
    details = lines.slice(0, 20);
  }

  // Emit canonical gate-result block. Non-fatal: any failure here must not
  // affect the gate's pass/fail decision.
  try {
    const block = await emitGateResult(
      {
        gate: 'preflight:audit-ci',
        status,
        lenses: [],
        affected_artifacts: [],
        accounting: {
          duration_ms: durationMs,
          lenses_invoked: 0,
          cost_usd: null,
        },
        remediation: [],
      },
      ctx && ctx.repoRoot ? { projectRoot: ctx.repoRoot } : {},
    );
    if (typeof block === 'string' && block.length > 0) {
      details = [...details, block];
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    try {
      process.stderr.write(`ijfw: preflight:audit-ci gate-result emit failed: ${msg}\n`);
    } catch {
      /* never crash the gate over a receipt issue */
    }
  }

  return {
    name: 'audit-ci',
    status,
    message,
    details,
    durationMs,
  };
}

export const name = 'audit-ci';
export const severity = 'blocking';
export const parallel = true;
