// ijfw preflight -- entry point. Parses argv, loads gates, runs pipeline.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreflight } from './preflight/runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`
ijfw preflight -- 11-gate quality pipeline

USAGE
  ijfw preflight [options]

OPTIONS
  --json        Emit machine-readable JSON (for CI consumption)
  --fail-fast   Stop after the first blocking gate failure
  --help, -h    Show this help

GATES (in execution order)
  1.  shellcheck        Shell lint (POSIX, unbound vars)       [blocking]
  2.  oxlint            JS/TS fast lint                        [blocking]
  3.  eslint-security   Security-focused ESLint rules          [blocking]
  4.  psscriptanalyzer  PowerShell lint (CI: windows-latest)   [blocking]
  5.  publint           package.json bin/exports integrity     [blocking]
  6.  gitleaks          Secret scan                            [blocking]
  7.  audit-ci          npm audit, fails on high+              [blocking]
  8.  knip              Dead code detection                    [advisory]
  9.  license-check     Production dep license check           [advisory]
  10. pack-smoke        npm pack -> install -> binary --help   [blocking]
  11. upgrade-smoke     Plugin-key wiring verification         [blocking]

EXIT CODES
  0  All blocking gates passed (advisory warnings may exist)
  1  One or more blocking gates failed

SLO
  Warm cache: <=90s  Cold cache: <=240s (both printed at end)
`);
}

function loadVersions(repoRoot) {
  // Look in repo root first, then .ijfw/ as fallback
  const candidates = [
    join(repoRoot, 'preflight-versions.json'),
    join(repoRoot, '.ijfw', 'preflight-versions.json'),
  ];
  for (const f of candidates) {
    if (existsSync(f)) {
      try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* try next */ }
    }
  }
  return {};
}

function parseArgs(argv) {
  const out = { json: false, failFast: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === '--json') out.json = true;
    else if (a === '--fail-fast') out.failFast = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

export async function runPreflightCommand(argv, repoRoot) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const versions = loadVersions(repoRoot);

  /** @type {import('./preflight/types.js').PreflightCtx} */
  const ctx = {
    repoRoot,
    versions,
    json: args.json,
    failFast: args.failFast,
  };

  // Import all gates (static imports so bundler can inline them)
  const shellcheck = await import('./preflight/gates/shellcheck.js');
  const oxlint = await import('./preflight/gates/oxlint.js');
  const eslintSecurity = await import('./preflight/gates/eslint-security.js');
  const psscriptanalyzer = await import('./preflight/gates/psscriptanalyzer.js');
  const publint = await import('./preflight/gates/publint.js');
  const gitleaks = await import('./preflight/gates/gitleaks.js');
  const auditCi = await import('./preflight/gates/audit-ci.js');
  const knip = await import('./preflight/gates/knip.js');
  const licenseCheck = await import('./preflight/gates/license-check.js');
  const packSmoke = await import('./preflight/gates/pack-smoke.js');
  const upgradeSmoke = await import('./preflight/gates/upgrade-smoke.js');

  /** @type {import('./preflight/types.js').Gate[]} */
  const gates = [
    shellcheck,
    oxlint,
    eslintSecurity,
    psscriptanalyzer,
    publint,
    gitleaks,
    auditCi,
    knip,
    licenseCheck,
    packSmoke,
    upgradeSmoke,
  ];

  const report = await runPreflight(gates, ctx);

  process.exit(report.outcome === 'pass' ? 0 : 1);
}

function defaultRepoRoot() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'mcp-server'))) return dir;
    const next = resolve(dir, '..');
    if (next === dir) break;
    dir = next;
  }
  return process.cwd();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPreflightCommand(process.argv, defaultRepoRoot());
}
