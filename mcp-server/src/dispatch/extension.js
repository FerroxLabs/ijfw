/**
 * dispatch/extension.js
 *
 * IJFW v1.4.0 / W3/t16 — extension colon-namespace dispatch handler.
 *
 * Routes `extension:<command>` from colon-syntax dispatch and
 * `ijfw extension <command>` from the CLI to the W2 extension-installer
 * primitives.
 *
 * Commands:
 *   add <source> [scope]    — install (npm name | local path | https:// git url)
 *   list                    — aggregate extensions across project+org+user scopes
 *   remove <name> [scope]   — uninstall + cleanup
 *   audit                   — registry + per-extension permission summary
 *   deploy-lazy             — (W6/S12) walk ~/.ijfw/extensions-{org,user}/ and
 *                             deploy each registered extension's skills to the
 *                             current project's platform dirs. Fired by the
 *                             session-start hook so org/user-scoped extensions
 *                             become available in every project session.
 */

import {
  installExtension,
  uninstallExtension,
  listExtensions,
} from '../extension-installer.js';
import {
  deployExtensionSkillsToPlatforms,
  deployExtensionToAgentsMd,
} from '../../../installer/src/install-helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VALID_SCOPES = new Set(['project', 'org', 'user']);

function parseScope(rawScope, fallback = 'project') {
  return VALID_SCOPES.has(rawScope) ? rawScope : fallback;
}

/**
 * Parse `<source> [scope]` allowing the source to contain whitespace when
 * wrapped in single or double quotes (paths with spaces, etc.).
 *
 * Rules:
 *   - If args starts with `"` or `'`, source is the body between matching
 *     quotes; whatever follows the close quote is candidate scope.
 *   - Otherwise: if the LAST whitespace-separated token matches the scope
 *     enum (project|org|user), source is the greedy join of everything
 *     before it. Else source is the whole trimmed args (no scope).
 *
 * Returns { source, scope } where scope is the parsed raw token (caller
 * still runs it through parseScope to coerce to default).
 */
function parseSourceAndScope(args) {
  const raw = String(args || '');
  const trimmed = raw.replace(/^\s+/, '');
  if (!trimmed) return { source: '', scope: undefined };

  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const close = trimmed.indexOf(first, 1);
    if (close > 0) {
      const source = trimmed.slice(1, close);
      const rest = trimmed.slice(close + 1).trim();
      const scope = rest.split(/\s+/).filter(Boolean)[0];
      return { source, scope };
    }
    // unmatched quote — fall through to non-quoted parse using the raw text
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { source: '', scope: undefined };
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && VALID_SCOPES.has(last)) {
    return { source: tokens.slice(0, -1).join(' '), scope: last };
  }
  return { source: tokens.join(' '), scope: undefined };
}

async function cmdAdd({ args, projectRoot }) {
  const { source, scope: rawScope } = parseSourceAndScope(args);
  if (!source) return { ok: false, command: 'add', error: 'missing source (npm name, path, or https:// git url)' };
  const scope = parseScope(rawScope);
  try {
    const r = await installExtension(source, { scope, projectRoot });
    return { ok: !!r.ok, command: 'add', result: r };
  } catch (err) {
    return { ok: false, command: 'add', error: err.message };
  }
}

async function cmdRemove({ args, projectRoot }) {
  const { source: name, scope: rawScope } = parseSourceAndScope(args);
  if (!name) return { ok: false, command: 'remove', error: 'missing extension name' };
  const scope = parseScope(rawScope);
  try {
    const r = await uninstallExtension(name, { scope, projectRoot });
    return { ok: !!r.ok, command: 'remove', result: r };
  } catch (err) {
    return { ok: false, command: 'remove', error: err.message };
  }
}

async function cmdList({ projectRoot }) {
  try {
    const r = await listExtensions(projectRoot);
    const extensions = Array.isArray(r) ? r : (r?.extensions ?? []);
    return { ok: true, command: 'list', result: { extensions, count: extensions.length } };
  } catch (err) {
    return { ok: false, command: 'list', error: err.message };
  }
}

async function cmdAudit({ projectRoot }) {
  try {
    const r = await listExtensions(projectRoot);
    const extensions = Array.isArray(r) ? r : (r?.extensions ?? []);
    const summary = extensions.map(e => ({
      name: e.name,
      version: e.version,
      scope: e.scope,
      status: e.status ?? 'active',
      last_trident_verdict: e.last_trident_verdict ?? null,
      permissions: e.manifest?.permissions ?? null,
    }));
    return { ok: true, command: 'audit', result: { summary, count: summary.length } };
  } catch (err) {
    return { ok: false, command: 'audit', error: err.message };
  }
}

/**
 * cmdDeployLazy — W6/S12.
 *
 * Org/user-scoped extensions install to ~/.ijfw/extensions-{org,user}/<name>/
 * but the platform skill dirs are project-local. So the bundled `installExtension`
 * only deploys to platforms for project-scope installs. For org/user scopes,
 * the skill files become available in any given project by way of THIS function,
 * fired by the session-start hook.
 *
 * Walks both scope dirs, reads each extension's manifest.json, and calls the
 * existing platform-deploy helper to copy skills into the current project's
 * platform skill dirs + inject the AGENTS.md fence. Idempotent: re-running is
 * safe (deploy helpers are atomic + AGENTS.md inject is fenced).
 *
 * Errors per-extension are captured in `failed[]` and do NOT abort the rest.
 */
async function cmdDeployLazy({ projectRoot }) {
  const result = { ok: true, command: 'deploy-lazy', result: { deployed: [], failed: [] } };
  const scopeRoots = [
    { scope: 'org',  root: path.join(os.homedir(), '.ijfw', 'extensions-org') },
    { scope: 'user', root: path.join(os.homedir(), '.ijfw', 'extensions-user') },
  ];

  for (const { scope, root } of scopeRoots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue; // scope unused — fine
      result.result.failed.push({ scope, name: null, error: `readdir ${root}: ${err.message}` });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const extDir = path.join(root, name);
      const manifestPath = path.join(extDir, 'manifest.json');
      let manifest;
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        manifest = JSON.parse(raw);
      } catch (err) {
        result.result.failed.push({ scope, name, error: `manifest read: ${err.message}` });
        continue;
      }
      const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
      try {
        const dep = await deployExtensionSkillsToPlatforms(name, skills, projectRoot, {});
        await deployExtensionToAgentsMd(name, skills, projectRoot);
        result.result.deployed.push({ scope, name, version: manifest.version, deployed: dep.deployed?.length ?? 0 });
      } catch (err) {
        result.result.failed.push({ scope, name, error: `deploy: ${err.message}` });
      }
    }
  }
  return result;
}

export async function extensionDispatch({ command, args = '', projectRoot }) {
  const ctx = { command, args: String(args || ''), projectRoot: String(projectRoot || process.cwd()) };
  switch (command) {
    case 'add': return cmdAdd(ctx);
    case 'list': return cmdList(ctx);
    case 'remove': return cmdRemove(ctx);
    case 'audit': return cmdAudit(ctx);
    case 'deploy-lazy': return cmdDeployLazy(ctx);
    default:
      return {
        ok: false,
        command,
        error: `unknown extension command: ${command}. Supported: add | list | remove | audit | deploy-lazy`,
      };
  }
}
