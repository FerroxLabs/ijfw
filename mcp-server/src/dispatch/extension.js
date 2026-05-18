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
  generatePublisherKeypair,
  addTrustedPublisher,
  removeTrustedPublisher,
  readTrustedPublishers,
  loadPublisherKeypair,
  signRotationToken,
  verifyRotationToken,
} from '../extension-signer.js';
import {
  refreshTrustFromRegistry,
  readCachedRegistry,
  verifyRegistry,
  keygenMeta,
  signRegistry,
  verifyRegistryFile,
  DEFAULT_REGISTRY_URL,
} from '../extension-registry.js';
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
  // W6.2/R5-M-01: only strip a trailing scope token when the input is exactly
  // 2 tokens (`<source> <scope>`). Paths with internal whitespace must be
  // quoted (handled above); a single token is always pure source. This is
  // narrower than W6.1's looksLikePath heuristic, which broke the common
  // `ijfw extension add ./local-pkg user` case. The original Gemini-med
  // case (`/my/project` → source/scope mishandle) is now covered by the
  // single-token path falling through to "no scope".
  if (tokens.length === 2 && VALID_SCOPES.has(last)) {
    return { source: tokens[0], scope: last };
  }
  return { source: tokens.join(' '), scope: undefined };
}

/**
 * Strip recognised flag tokens from an args string and return both the
 * cleaned args and a flags object. Flags are positional-agnostic.
 *
 *   --allow-unsigned      -> opts.allowUnsigned = true
 *   --accept-untrusted    -> opts.acceptUntrusted = true
 *   --activate            -> opts.activate = true
 */
function extractAddFlags(args) {
  const tokens = String(args || '').split(/\s+/).filter(Boolean);
  const flags = { allowUnsigned: false, acceptUntrusted: false, activate: false };
  const keep = [];
  for (const t of tokens) {
    if (t === '--allow-unsigned') { flags.allowUnsigned = true; continue; }
    if (t === '--accept-untrusted') { flags.acceptUntrusted = true; continue; }
    if (t === '--activate') { flags.activate = true; continue; }
    keep.push(t);
  }
  return { args: keep.join(' '), flags };
}

async function cmdAdd({ args, projectRoot }) {
  const { args: stripped, flags } = extractAddFlags(args);
  const { source, scope: rawScope } = parseSourceAndScope(stripped);
  if (!source) return { ok: false, command: 'add', error: 'missing source (npm name, path, or https:// git url)' };
  const scope = parseScope(rawScope);
  try {
    const r = await installExtension(source, {
      scope,
      projectRoot,
      allowUnsigned: flags.allowUnsigned,
      acceptUntrusted: flags.acceptUntrusted,
      activate: flags.activate,
    });
    return { ok: !!r.ok, command: 'add', result: r };
  } catch (err) {
    return { ok: false, command: 'add', error: err.message };
  }
}

async function cmdKeygen({ args }) {
  const authorName = String(args || '').trim();
  if (!authorName) return { ok: false, command: 'keygen', error: 'missing author name' };
  try {
    const kp = await generatePublisherKeypair(authorName);
    return {
      ok: true,
      command: 'keygen',
      result: {
        keyId: kp.keyId,
        publicKey: kp.publicKey,
        dir: kp.dir,
        // private key is on disk at <dir>/private.pem; never echo to log.
      },
    };
  } catch (err) {
    return { ok: false, command: 'keygen', error: err.message };
  }
}

async function cmdTrust({ args }) {
  // Args shape: "<keyId> <publicKeyPemMultiline>"
  // The PEM body almost certainly contains spaces and newlines — accept
  // everything after the first whitespace as the public key.
  const raw = String(args || '');
  const idx = raw.search(/\s/);
  if (idx < 0) return { ok: false, command: 'trust', error: 'usage: trust <keyId> <publicKeyPem>' };
  const keyId = raw.slice(0, idx).trim();
  const publicKey = raw.slice(idx + 1).trim();
  if (!keyId || !publicKey) return { ok: false, command: 'trust', error: 'usage: trust <keyId> <publicKeyPem>' };
  try {
    const r = await addTrustedPublisher(keyId, publicKey);
    return { ok: !!r.ok, command: 'trust', result: r };
  } catch (err) {
    return { ok: false, command: 'trust', error: err.message };
  }
}

async function cmdUntrust({ args }) {
  const keyId = String(args || '').trim();
  if (!keyId) return { ok: false, command: 'untrust', error: 'missing keyId' };
  try {
    const r = await removeTrustedPublisher(keyId);
    return { ok: !!r.ok, command: 'untrust', result: { removed: r.removed } };
  } catch (err) {
    return { ok: false, command: 'untrust', error: err.message };
  }
}

async function cmdTrusted() {
  try {
    const store = await readTrustedPublishers();
    const publishers = Object.entries(store.publishers || {}).map(([keyId, v]) => ({
      keyId,
      name: v.name ?? null,
      added_at: v.added_at ?? null,
    }));
    return { ok: true, command: 'trusted', result: { publishers, count: publishers.length } };
  } catch (err) {
    return { ok: false, command: 'trusted', error: err.message };
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
      // listExtensions now returns `permissions` and `description` directly
      // on each entry (W6B-1). Reading them at the top level keeps the
      // dispatch independent of the registry's internal manifest shape.
      permissions: e.permissions ?? null,
      description: e.description ?? null,
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
// W6.1/C4-M-01: validate extension dir name at the readdir boundary.
// readdir limits entries to single-segment names (no traversal possible)
// but a hand-placed dir like `Weird Name With Spaces/` would still flow
// through to deployExtensionSkillsToPlatforms which would create
// `ext-Weird Name With Spaces` dirs across every platform.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded npm name shape; no nested ambiguous repetition
const EXTENSION_NAME_PATTERN = /^(@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/;

// W6.2/R5-H-02: scoped extensions live at `<root>/@scope/pkg/` (two-level).
// Flat extensions live at `<root>/pkg/` (one-level). Enumerate both shapes
// and yield canonical `[name, extDir]` pairs.
async function* enumerateExtensions(root, scope, skipped) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    // Non-directory entries are skipped at the top level (incl. symlinks).
    if (!entry.isDirectory()) {
      skipped.push({ scope, name: entry.name, reason: 'not-a-directory' });
      continue;
    }
    if (entry.name.startsWith('@')) {
      // Scoped: recurse one level. Combined name is `@scope/pkg`.
      const scopedRoot = path.join(root, entry.name);
      let inner;
      try {
        inner = await fs.readdir(scopedRoot, { withFileTypes: true });
      } catch {
        skipped.push({ scope, name: entry.name, reason: 'scoped-readdir-failed' });
        continue;
      }
      for (const sub of inner) {
        if (!sub.isDirectory()) {
          skipped.push({ scope, name: `${entry.name}/${sub.name}`, reason: 'not-a-directory' });
          continue;
        }
        const combined = `${entry.name}/${sub.name}`;
        if (!EXTENSION_NAME_PATTERN.test(combined)) {
          skipped.push({ scope, name: combined, reason: 'invalid-extension-name' });
          continue;
        }
        yield [combined, path.join(scopedRoot, sub.name)];
      }
      continue;
    }
    if (!EXTENSION_NAME_PATTERN.test(entry.name)) {
      skipped.push({ scope, name: entry.name, reason: 'invalid-extension-name' });
      continue;
    }
    yield [entry.name, path.join(root, entry.name)];
  }
}

async function cmdDeployLazy({ projectRoot }) {
  const result = { ok: true, command: 'deploy-lazy', result: { deployed: [], failed: [], skipped: [] } };
  const scopeRoots = [
    { scope: 'org',  root: path.join(os.homedir(), '.ijfw', 'extensions-org') },
    { scope: 'user', root: path.join(os.homedir(), '.ijfw', 'extensions-user') },
  ];

  for (const { scope, root } of scopeRoots) {
    try {
      for await (const [name, extDir] of enumerateExtensions(root, scope, result.result.skipped)) {
        await deployOneExtension({ scope, name, extDir, projectRoot, result });
      }
    } catch (err) {
      result.result.failed.push({ scope, name: null, error: `readdir ${root}: ${err.message}` });
    }
  }
  return result;
}

async function deployOneExtension({ scope, name, extDir, projectRoot, result }) {
  const manifestPath = path.join(extDir, 'manifest.json');
  let manifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    result.result.failed.push({ scope, name, error: `manifest read: ${err.message}` });
    return;
  }
  const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
  try {
    // W6.1/R4-H-02: pass the org/user-scope source dir explicitly so the
    // helper reads from `~/.ijfw/extensions-{org,user}/<name>/skills`
    // (or `~/.ijfw/extensions-{org,user}/@scope/pkg/skills` for scoped
    // extensions per W6.2/R5-H-02) instead of the default project path.
    const sourceDir = path.join(extDir, 'skills');
    const dep = await deployExtensionSkillsToPlatforms(name, skills, projectRoot, { sourceDir });
    await deployExtensionToAgentsMd(name, skills, projectRoot);
    result.result.deployed.push({ scope, name, version: manifest.version, deployed: dep.deployed?.length ?? 0 });
  } catch (err) {
    result.result.failed.push({ scope, name, error: `deploy: ${err.message}` });
  }
}

// === B6: Registry commands ================================================

async function cmdTrustRegistry({ args }) {
  const url = args.trim() || DEFAULT_REGISTRY_URL;
  try {
    const r = await refreshTrustFromRegistry(url);
    if (!r.ok) return { ok: false, command: 'trust-registry', error: r.error };
    const lines = [];
    if (r.fromCache) {
      lines.push('(loaded from cache — network unavailable)');
    } else if (r.diff) {
      for (const kid of r.diff.added) lines.push(`+ added: ${kid}`);
      for (const kid of r.diff.removed) lines.push(`- removed (revoked): ${kid}`);
      for (const kid of r.diff.unchanged) lines.push(`  unchanged: ${kid}`);
      for (const kid of r.diff.rejected) lines.push(`! rejected: ${kid}`);
      if (lines.length === 0) lines.push('registry applied — no changes');
    }
    for (const w of (r.warnings || [])) lines.push(`[warn] ${w}`);
    return { ok: true, command: 'trust-registry', result: { url, diff: r.diff, fromCache: r.fromCache, lines } };
  } catch (err) {
    return { ok: false, command: 'trust-registry', error: err.message };
  }
}

async function cmdRegistryStatus() {
  try {
    const cached = await readCachedRegistry();
    if (!cached.registry) {
      return { ok: true, command: 'registry-status', result: { cached: false, message: 'no cached registry' } };
    }
    const ageMs = cached.cachedAt ? Date.now() - cached.cachedAt : null;
    const ageHours = ageMs !== null ? (ageMs / 3600000).toFixed(1) : null;
    const body = JSON.stringify(cached.registry);
    const sizeBytes = Buffer.byteLength(body, 'utf8');
    const sigStatus = verifyRegistry(body);
    return {
      ok: true,
      command: 'registry-status',
      result: {
        cached: true,
        stale: cached.stale,
        cached_at: cached.cachedAt ? new Date(cached.cachedAt).toISOString() : null,
        age_hours: ageHours,
        size_bytes: sizeBytes,
        signature_valid: sigStatus.valid,
        signature_reason: sigStatus.reason,
        publisher_count: Object.keys(cached.registry.publishers || {}).length,
        revoked_count: (cached.registry.revoked || []).length,
      },
    };
  } catch (err) {
    return { ok: false, command: 'registry-status', error: err.message };
  }
}

async function cmdKeygenMeta({ args }) {
  const author = args.trim();
  if (!author) return { ok: false, command: 'keygen-meta', error: 'missing author name; usage: keygen-meta <author>' };
  try {
    const r = await keygenMeta(author);
    return {
      ok: true,
      command: 'keygen-meta',
      result: { keyId: r.keyId, publicKey: r.publicKey, dir: r.dir },
    };
  } catch (err) {
    return { ok: false, command: 'keygen-meta', error: err.message };
  }
}

async function cmdSignRegistry({ args }) {
  const registryPath = args.trim();
  if (!registryPath) return { ok: false, command: 'sign-registry', error: 'missing path; usage: sign-registry <path>' };
  try {
    const r = await signRegistry(registryPath);
    return r.ok
      ? { ok: true, command: 'sign-registry', result: { path: registryPath } }
      : { ok: false, command: 'sign-registry', error: r.error };
  } catch (err) {
    return { ok: false, command: 'sign-registry', error: err.message };
  }
}

async function cmdVerifyRegistry({ args }) {
  const registryPath = args.trim();
  if (!registryPath) return { ok: false, command: 'verify-registry', error: 'missing path; usage: verify-registry <path>' };
  try {
    const r = await verifyRegistryFile(registryPath);
    return {
      ok: r.ok,
      command: 'verify-registry',
      result: { path: registryPath, valid: r.valid, reason: r.reason },
    };
  } catch (err) {
    return { ok: false, command: 'verify-registry', error: err.message };
  }
}

// === B8: Key rotation + revocation =========================================

/**
 * rotate-keys <oldKeyId> <newKeyId> [--out <file>]
 *
 * Loads both keypairs from ~/.ijfw/keys/<keyId>/, produces a rotation token
 * signed by the old private key, writes JSON to --out or stdout.
 */
async function cmdRotateKeys({ args }) {
  const tokens = String(args || '').split(/\s+/).filter(Boolean);

  // Extract --out flag
  let outFile = null;
  const keep = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--out' && tokens[i + 1]) {
      outFile = tokens[i + 1];
      i++;
    } else {
      keep.push(tokens[i]);
    }
  }

  const [oldKeyId, newKeyId] = keep;
  if (!oldKeyId || !newKeyId) {
    return { ok: false, command: 'rotate-keys', error: 'usage: rotate-keys <oldKeyId> <newKeyId> [--out <file>]' };
  }

  const oldKp = await loadPublisherKeypair(oldKeyId);
  if (!oldKp) return { ok: false, command: 'rotate-keys', error: `old keypair not found: ${oldKeyId}` };

  const newKp = await loadPublisherKeypair(newKeyId);
  if (!newKp) return { ok: false, command: 'rotate-keys', error: `new keypair not found: ${newKeyId}` };

  let token;
  try {
    token = signRotationToken(oldKp.privateKey, newKp.publicKey);
  } catch (err) {
    return { ok: false, command: 'rotate-keys', error: `sign failed: ${err.message}` };
  }

  const json = JSON.stringify(token, null, 2) + '\n';

  if (outFile) {
    try {
      await fs.writeFile(path.resolve(outFile), json, 'utf8');
    } catch (err) {
      return { ok: false, command: 'rotate-keys', error: `write failed: ${err.message}` };
    }
    return { ok: true, command: 'rotate-keys', result: { token, out: path.resolve(outFile) } };
  }

  return { ok: true, command: 'rotate-keys', result: { token } };
}

/**
 * verify-rotation-token <file>
 *
 * Reads a rotation token JSON, looks up the old public key from the local
 * trusted-publishers store (or ~/.ijfw/keys/<oldKeyId>/public.pem as fallback),
 * calls verifyRotationToken, prints verdict.
 */
async function cmdVerifyRotationToken({ args }) {
  const filePath = String(args || '').trim();
  if (!filePath) {
    return { ok: false, command: 'verify-rotation-token', error: 'usage: verify-rotation-token <file>' };
  }

  let raw;
  try {
    raw = await fs.readFile(path.resolve(filePath), 'utf8');
  } catch (err) {
    return { ok: false, command: 'verify-rotation-token', error: `read failed: ${err.message}` };
  }

  let token;
  try {
    token = JSON.parse(raw);
  } catch (err) {
    return { ok: false, command: 'verify-rotation-token', error: `JSON parse failed: ${err.message}` };
  }

  const oldKeyId = token && token.old_key_id;
  if (!oldKeyId) {
    return { ok: false, command: 'verify-rotation-token', error: 'token missing old_key_id' };
  }

  // Look up old public key: trusted-publishers store first, then key-dir fallback.
  let oldPublicKey = null;
  const store = await readTrustedPublishers();
  const entry = store.publishers && store.publishers[oldKeyId];
  if (entry && entry.publicKey) {
    oldPublicKey = entry.publicKey;
  } else {
    // Fallback: key may be on disk even if not in trust store (already revoked).
    const kp = await loadPublisherKeypair(oldKeyId);
    if (kp) oldPublicKey = kp.publicKey;
  }

  if (!oldPublicKey) {
    return { ok: false, command: 'verify-rotation-token', error: `old public key not found for keyId: ${oldKeyId}` };
  }

  const verdict = verifyRotationToken(token, oldPublicKey);
  return {
    ok: verdict.valid,
    command: 'verify-rotation-token',
    result: {
      valid: verdict.valid,
      reason: verdict.reason,
      old_key_id: token.old_key_id,
      new_key_id: token.new_key_id,
    },
  };
}

async function cmdActivate({ args, projectRoot }) {
  const name = args && args.trim();
  if (!name) return { ok: false, command: 'activate', error: 'missing extension name; usage: activate <name>' };
  try {
    const { findInstalledManifest, writeActiveExtension } = await import('../active-extension-writer.js');
    const lookup = await findInstalledManifest(name, projectRoot);
    if (!lookup.ok) return { ok: false, command: 'activate', error: lookup.error };
    const result = await writeActiveExtension(lookup.manifest, lookup.scope);
    if (!result.ok) return { ok: false, command: 'activate', error: result.error };
    return { ok: true, command: 'activate', result: { name, scope: lookup.scope, path: result.path } };
  } catch (err) {
    return { ok: false, command: 'activate', error: err.message };
  }
}

async function cmdDeactivate() {
  try {
    const { clearActiveExtension } = await import('../active-extension-writer.js');
    const r = await clearActiveExtension();
    return { ok: r.ok, command: 'deactivate', result: { removed: r.removed } };
  } catch (err) {
    return { ok: false, command: 'deactivate', error: err.message };
  }
}

// v1.4.3 Phase D — CLI module registry. Each module exports the frozen
// { handlers, subcommandHelp } shape; we union their handlers into a single
// lookup and consult it BEFORE the legacy switch, so new --ide / --backend /
// quota / federation subcommands take precedence.
let _v143Handlers = null;
async function loadV143Handlers() {
  if (_v143Handlers !== null) return _v143Handlers;
  const [registry, signer, quota, active, wave] = await Promise.all([
    import('./registry-cli.js'),
    import('./signer-cli.js'),
    import('./quota-cli.js'),
    import('./active-cli.js'),
    import('./wave-cli.js'),  // v1.4.4 N9 — wave-status / wave-list
  ]);
  _v143Handlers = Object.assign(
    Object.create(null),
    registry.handlers || {},
    signer.handlers || {},
    quota.handlers || {},
    active.handlers || {},
    wave.handlers || {},
  );
  return _v143Handlers;
}

export async function extensionDispatch({ command, args = '', projectRoot }) {
  const ctx = { command, args: String(args || ''), projectRoot: String(projectRoot || process.cwd()) };

  // v1.4.3 Phase D — CLI modules take precedence over legacy switch.
  const handlers = await loadV143Handlers();
  if (typeof handlers[command] === 'function') {
    try {
      const r = await handlers[command](ctx.args, ctx);
      if (r && r.ok === false) {
        return { ok: false, command, error: r.error || 'unknown error' };
      }
      return { ok: true, command, result: r };
    } catch (err) {
      return { ok: false, command, error: err && err.message ? err.message : String(err) };
    }
  }

  switch (command) {
    case 'add': return cmdAdd(ctx);
    case 'list': return cmdList(ctx);
    case 'remove': return cmdRemove(ctx);
    case 'audit': return cmdAudit(ctx);
    case 'deploy-lazy': return cmdDeployLazy(ctx);
    case 'keygen': return cmdKeygen(ctx);
    case 'trust': return cmdTrust(ctx);
    case 'untrust': return cmdUntrust(ctx);
    case 'trusted': return cmdTrusted(ctx);
    case 'activate': return cmdActivate(ctx);
    case 'deactivate': return cmdDeactivate(ctx);
    case 'trust-registry': return cmdTrustRegistry(ctx);
    case 'registry-status': return cmdRegistryStatus(ctx);
    case 'keygen-meta': return cmdKeygenMeta(ctx);
    case 'sign-registry': return cmdSignRegistry(ctx);
    case 'verify-registry': return cmdVerifyRegistry(ctx);
    case 'rotate-keys': return cmdRotateKeys(ctx);
    case 'verify-rotation-token': return cmdVerifyRotationToken(ctx);
    default:
      return {
        ok: false,
        command,
        error: `unknown extension command: ${command}. Supported: add | list | remove | audit | deploy-lazy | keygen | trust | untrust | trusted | activate | deactivate | trust-registry | registry-status | keygen-meta | sign-registry | verify-registry | rotate-keys | verify-rotation-token`,
      };
  }
}
