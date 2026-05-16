/**
 * active-extension-writer.js -- IJFW v1.4.0 W7.1/B2-H-01
 *
 * Writes ~/.ijfw/state/active-extension.json from an extension manifest, and
 * clears it on deactivate. Used by:
 *   - `ijfw_run extension:activate <name>` CLI command
 *   - installExtension when opts.activate is set
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const STATE_PATH_REL = ['.ijfw', 'state', 'active-extension.json'];

function statePath(home) {
  return join(home || homedir(), ...STATE_PATH_REL);
}

/**
 * Write the active-extension state file from a manifest + scope.
 * Validates required fields before write. Atomic write via tmp+rename.
 *
 * @param {{ name: string, permissions: { reads: string[], writes: string[] } }} manifest
 * @param {'project'|'org'|'user'} scope
 * @param {{ homeDir?: string }} [opts]
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function writeActiveExtension(manifest, scope, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'manifest must be an object' };
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    return { ok: false, error: 'manifest.name required' };
  }
  if (!['project', 'org', 'user'].includes(scope)) {
    return { ok: false, error: `invalid scope: ${scope}` };
  }
  if (!manifest.permissions || typeof manifest.permissions !== 'object') {
    return { ok: false, error: 'manifest.permissions required' };
  }
  const reads = Array.isArray(manifest.permissions.reads) ? manifest.permissions.reads : [];
  const writes = Array.isArray(manifest.permissions.writes) ? manifest.permissions.writes : [];
  const out = {
    name: manifest.name,
    scope,
    permissions: { reads, writes },
    activated_at: new Date().toISOString(),
  };
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  const path = statePath(home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
  return { ok: true, path };
}

/**
 * Clear the active-extension state file. Idempotent -- succeeds if file is absent.
 *
 * @param {{ homeDir?: string }} [opts]
 * @returns {Promise<{ ok: boolean, removed: boolean }>}
 */
export async function clearActiveExtension(opts = {}) {
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  try {
    await unlink(statePath(home));
    return { ok: true, removed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, removed: false };
  }
}

/**
 * Read an installed extension's manifest by name. Resolves from project/org/user
 * scope (project first, then org, then user). Used by `extension activate <name>`
 * which doesn't carry the full manifest in args.
 *
 * Scope paths (matching the rest of the codebase):
 *   project: <projectRoot>/.ijfw/extensions/<name>/manifest.json
 *   org:     ~/.ijfw/extensions-org/<name>/manifest.json
 *   user:    ~/.ijfw/extensions-user/<name>/manifest.json
 *
 * @param {string} name
 * @param {string} [projectRoot]
 * @param {{ homeDir?: string }} [opts]
 * @returns {Promise<{ ok: boolean, manifest?: object, scope?: string, path?: string, error?: string }>}
 */
export async function findInstalledManifest(name, projectRoot, opts = {}) {
  if (typeof name !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: 'invalid extension name' };
  }
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  const candidates = [];
  if (projectRoot) {
    candidates.push({ scope: 'project', path: join(projectRoot, '.ijfw', 'extensions', name, 'manifest.json') });
  }
  candidates.push({ scope: 'org', path: join(home, '.ijfw', 'extensions-org', name, 'manifest.json') });
  candidates.push({ scope: 'user', path: join(home, '.ijfw', 'extensions-user', name, 'manifest.json') });

  for (const c of candidates) {
    try {
      const raw = await readFile(c.path, 'utf8');
      const manifest = JSON.parse(raw);
      return { ok: true, manifest, scope: c.scope, path: c.path };
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      if (err instanceof SyntaxError) continue;
    }
  }
  return { ok: false, error: `extension "${name}" not found in project/org/user scope` };
}
