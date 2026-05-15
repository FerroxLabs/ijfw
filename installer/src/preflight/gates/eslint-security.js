// Gate 2b: eslint with eslint-plugin-security -- high-signal Node security
// rules that oxlint does not cover (e.g. eval and unsafe regex).
// Uses a temp package dir so eslint and the plugin can resolve each other.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RULES = {
  'security/detect-eval-with-expression': 'error',
  'security/detect-non-literal-require': 'warn',
  'security/detect-pseudoRandomBytes': 'error',
  'security/detect-unsafe-regex': 'error',
};

function formatMessages(results, severity) {
  const out = [];
  for (const file of results) {
    for (const msg of file.messages || []) {
      if (severity === 'error' && msg.severity !== 2) continue;
      if (severity === 'warning' && msg.severity !== 1) continue;
      out.push(`${file.filePath}:${msg.line}:${msg.column} ${msg.severity === 2 ? 'error' : 'warning'} ${msg.ruleId} -- ${msg.message}`);
    }
  }
  return out;
}

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();
  const eslintVer = ctx.versions['eslint'] || 'latest';
  const pluginVer = ctx.versions['eslint-plugin-security'] || 'latest';

  // Create an isolated tmp dir with eslint + plugin installed
  const tmpDir = mkdtempSync(join(tmpdir(), 'ijfw-eslint-security-'));
  try {
    // Write package.json so npm install works
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'eslint-security-runner', version: '1.0.0', type: 'module' }));

    // Install eslint + plugin
    const install = spawnSync(
      'npm',
      ['install', '--no-save', '--silent', `eslint@${eslintVer}`, `eslint-plugin-security@${pluginVer}`],
      { encoding: 'utf8', cwd: tmpDir, timeout: 90_000 },
    );

    if (install.status !== 0) {
      return {
        name: 'eslint-security',
        status: 'WARN',
        message: 'eslint-security: could not install plugin (npm install failed)',
        details: ((install.stdout || '') + (install.stderr || '')).split('\n').filter(Boolean).slice(0, 5),
        durationMs: Date.now() - t0,
      };
    }

    // Write flat config into the repo root so eslint can find files relative to it
    const configContent = `
import security from '${join(tmpDir, 'node_modules', 'eslint-plugin-security', 'index.js').replace(/\\/g, '/')}';
export default [
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    files: ['installer/src/**/*.js', 'mcp-server/src/**/*.js'],
    plugins: { security },
    rules: ${JSON.stringify(RULES)},
  }
];
`;
    const configPath = join(ctx.repoRoot, '.eslint-security-temp.mjs');
    writeFileSync(configPath, configContent, 'utf8');

    const eslintBin = join(tmpDir, 'node_modules', '.bin', 'eslint');

    const res = spawnSync(
      eslintBin,
      ['--no-config-lookup', '--config', configPath, '--format', 'json', 'installer/src/**/*.js', 'mcp-server/src/**/*.js'],
      { encoding: 'utf8', cwd: ctx.repoRoot, timeout: 60_000 },
    );

    const durationMs = Date.now() - t0;
    const output = (res.stdout || '') + (res.stderr || '');
    let results = [];
    try { results = JSON.parse(res.stdout || '[]'); } catch { results = []; }
    const errorCount = results.reduce((sum, file) => sum + (file.errorCount || 0), 0);
    const warningCount = results.reduce((sum, file) => sum + (file.warningCount || 0), 0);

    if (res.status === 0 && errorCount === 0 && warningCount === 0) {
      return {
        name: 'eslint-security',
        status: 'PASS',
        message: 'eslint-security: no security issues',
        details: [],
        durationMs,
      };
    }

    if (errorCount > 0 || res.status === 2) {
      return {
        name: 'eslint-security',
        status: 'FAIL',
        message: `eslint-security: ${errorCount || 'unknown'} security error(s) found`,
        details: (formatMessages(results, 'error').length ? formatMessages(results, 'error') : output.split('\n').filter(Boolean)).slice(0, 30),
        durationMs,
      };
    }

    return {
      name: 'eslint-security',
      status: 'WARN',
      message: `eslint-security: ${warningCount} advisory warning(s)`,
      details: (formatMessages(results, 'warning').length ? formatMessages(results, 'warning') : output.split('\n').filter(Boolean)).slice(0, 30),
      durationMs,
    };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(join(ctx.repoRoot, '.eslint-security-temp.mjs'), { force: true }); } catch { /* best effort */ }
  }
}

export const name = 'eslint-security';
export const severity = 'blocking';
export const parallel = true;
