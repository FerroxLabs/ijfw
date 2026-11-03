/**
 * test-gemini-manifest-resolution.js -- the ijfw-memory MCP entry in
 * gemini-extension.json must resolve to a real server path and a project
 * root after Gemini CLI expands it.
 *
 * The two expansion steps below mirror google-gemini/gemini-cli
 * (commit 0ac57c0, 2026-11-02):
 *   1. packages/cli/src/config/extensions/variables.ts hydrateString():
 *      /\${(.*?)}/ against { extensionPath, workspacePath, '/', pathSeparator }
 *   2. packages/cli/src/utils/envVarResolver.ts resolveEnvVarsInString():
 *      $VAR, ${VAR}, ${VAR:-default} from process.env; unknown kept literally.
 * This is a simulation of Gemini's documented logic, not a run of Gemini.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(resolve(HERE, '..'), 'gemini', 'extensions', 'ijfw', 'gemini-extension.json');

function hydrateString(str, ctx) {
  return str.replace(/\${(.*?)}/g, (m, k) => (ctx[k] == null ? m : String(ctx[k])));
}
function resolveEnvVarsInString(value, env) {
  return value.replace(/\$(?:(\w+)|{([^}]+?)(?::-([^}]*))?})/g, (m, a, b, d) => {
    const name = a || b || '';
    if (!name) return m;
    if (typeof env[name] === 'string') return env[name];
    if (d !== undefined) return d;
    return m;
  });
}
function geminiResolve(str, { ctx, env }) {
  return resolveEnvVarsInString(hydrateString(str, ctx), env);
}

const HOME = '/Users/test user';
const WORKSPACE = '/Users/test user/dev/my project';
const ctx = { extensionPath: `${HOME}/.gemini/extensions/ijfw`, workspacePath: WORKSPACE, '/': '/', pathSeparator: '/' };

test('server path resolves to ~/.ijfw/mcp-server/src/server.js', () => {
  const entry = JSON.parse(readFileSync(MANIFEST, 'utf8')).mcpServers['ijfw-memory'];
  const arg = geminiResolve(entry.args[0], { ctx, env: { HOME } });
  assert.equal(arg, `${HOME}/.ijfw/mcp-server/src/server.js`);
});

test('IJFW_PROJECT_DIR resolves to the Gemini workspace, even when PWD is unset (GUI launch)', () => {
  const entry = JSON.parse(readFileSync(MANIFEST, 'utf8')).mcpServers['ijfw-memory'];
  const dir = geminiResolve(entry.env.IJFW_PROJECT_DIR, { ctx, env: { HOME } });
  assert.equal(dir, WORKSPACE);
});
