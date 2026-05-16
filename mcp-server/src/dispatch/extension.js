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
 */

import {
  installExtension,
  uninstallExtension,
  listExtensions,
} from '../extension-installer.js';

const VALID_SCOPES = new Set(['project', 'org', 'user']);

function parseScope(rawScope, fallback = 'project') {
  return VALID_SCOPES.has(rawScope) ? rawScope : fallback;
}

async function cmdAdd({ args, projectRoot }) {
  const parts = args.split(/\s+/).filter(Boolean);
  const source = parts[0];
  if (!source) return { ok: false, command: 'add', error: 'missing source (npm name, path, or https:// git url)' };
  const scope = parseScope(parts[1]);
  try {
    const r = await installExtension(source, { scope, projectRoot });
    return { ok: !!r.ok, command: 'add', result: r };
  } catch (err) {
    return { ok: false, command: 'add', error: err.message };
  }
}

async function cmdRemove({ args, projectRoot }) {
  const parts = args.split(/\s+/).filter(Boolean);
  const name = parts[0];
  if (!name) return { ok: false, command: 'remove', error: 'missing extension name' };
  const scope = parseScope(parts[1]);
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

export async function extensionDispatch({ command, args = '', projectRoot }) {
  const ctx = { command, args: String(args || ''), projectRoot: String(projectRoot || process.cwd()) };
  switch (command) {
    case 'add': return cmdAdd(ctx);
    case 'list': return cmdList(ctx);
    case 'remove': return cmdRemove(ctx);
    case 'audit': return cmdAudit(ctx);
    default:
      return {
        ok: false,
        command,
        error: `unknown extension command: ${command}. Supported: add | list | remove | audit`,
      };
  }
}
