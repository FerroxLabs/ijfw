/**
 * active-extension-writer.js -- IJFW v1.4.0 W7.1/B2-H-01
 *
 * Writes ~/.ijfw/state/active-extension.json from an extension manifest, and
 * clears it on deactivate. Used by:
 *   - `ijfw_run extension:activate <name>` CLI command
 *   - installExtension when opts.activate is set
 */

import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { resetExtensionQuotas } from './extension-quota-tracker.js';

const STATE_PATH_REL = ['.ijfw', 'state', 'active-extension.json'];

// B18 — stale last-seen-by-<ide>.json files older than this get cleaned on read.
const LAST_SEEN_STALE_MS = 30 * 24 * 60 * 60 * 1000;

// Valid IDE id pattern (matches ide-detect.js). Keep in sync.
const IDE_ID_PATTERN = /^[a-z0-9-]+$/;

function statePath(home) {
  return join(home || homedir(), ...STATE_PATH_REL);
}

function lastSeenPath(home, ideId) {
  return join(home || homedir(), '.ijfw', 'state', `last-seen-by-${ideId}.json`);
}

function stateDir(home) {
  return join(home || homedir(), '.ijfw', 'state');
}

/**
 * Write the active-extension state file from a manifest + scope.
 * Validates required fields before write. Atomic write via tmp+rename.
 *
 * @param {{ name: string, permissions: { reads: string[], writes: string[] } }} manifest
 * @param {'project'|'org'|'user'} scope
 * @param {{ homeDir?: string, ideId?: string|null }} [opts]
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
  const activatedAt = new Date().toISOString();
  // B18: stamp activated_by_ide + activated_by_pid when ideId is provided.
  // Caller (CLI) is responsible for calling detectIde() and threading the
  // value in. When opts.ideId is null/undefined, fields are omitted (so the
  // file stays back-compatible with v1.4.1 readers).
  const ideId = (typeof opts.ideId === 'string' && IDE_ID_PATTERN.test(opts.ideId))
    ? opts.ideId
    : null;
  const out = {
    name: manifest.name,
    scope,
    permissions: { reads, writes },
    activated_at: activatedAt,
  };
  if (ideId) {
    out.activated_by_ide = ideId;
    out.activated_by_pid = process.pid;
  }
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  const path = statePath(home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
  // B16/SEC-M-02: reset quota counters on activate; stamp activated_at so
  // wall_clock_ms can be computed against this activation window.
  try {
    await resetExtensionQuotas(manifest.name, { homeDir: home, activated_at: activatedAt });
  } catch {
    // Quota reset failure must not block activation. Counters will self-heal
    // on next deactivate or the next activate of the same name.
  }
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
  // B16/SEC-M-02: read the active extension name BEFORE unlinking so we can
  // clear its quota counters. Best-effort: if the file is missing or
  // malformed, deactivate still succeeds.
  let extName = null;
  try {
    const raw = await readFile(statePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      extName = parsed.name;
    }
  } catch {
    // ignore — extName stays null
  }
  try {
    await unlink(statePath(home));
    if (extName) {
      try {
        await resetExtensionQuotas(extName, { homeDir: home });
      } catch {
        // best-effort
      }
    }
    return { ok: true, removed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (extName) {
        try {
          await resetExtensionQuotas(extName, { homeDir: home });
        } catch { /* best-effort */ }
      }
      return { ok: true, removed: false };
    }
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
 * @param {{ homeDir?: string, strictShadow?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, manifest?: object, scope?: string, path?: string, error?: string }>}
 */
export async function findInstalledManifest(name, projectRoot, opts = {}) {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded npm name shape; no nested ambiguous repetition
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

  // Collect all found manifests to detect project-scope shadowing.
  const found = [];
  for (const c of candidates) {
    try {
      const raw = await readFile(c.path, 'utf8');
      const manifest = JSON.parse(raw);
      found.push({ scope: c.scope, path: c.path, manifest });
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      if (err instanceof SyntaxError) continue;
    }
  }

  if (found.length === 0) {
    return { ok: false, error: `extension "${name}" not found in project/org/user scope` };
  }

  const winner = found[0];

  // B13.1: warn when project-scope shadows a lower-priority scope entry.
  if (winner.scope === 'project' && found.length > 1) {
    const shadowed = found[1];
    const winnerKeyId = winner.manifest.signature?.keyId ?? '(unsigned)';
    const shadowedKeyId = shadowed.manifest.signature?.keyId ?? '(unsigned)';
    if (opts && opts.strictShadow) {
      return {
        ok: false,
        error: `extension activate: project-scope "${name}" shadows ${shadowed.scope}-scope "${name}" (keyId ${winnerKeyId} vs ${shadowedKeyId}) — refused by strictShadow`,
      };
    }
    process.stderr.write(
      `[ijfw] extension activate: project-scope "${name}" shadows ${shadowed.scope}-scope "${name}" (keyId ${winnerKeyId} vs ${shadowedKeyId}) — using project\n`,
    );
  }

  return { ok: true, manifest: winner.manifest, scope: winner.scope, path: winner.path };
}

// ============================================================================
// B18 — Cross-IDE Conflict Detection
// ============================================================================

/**
 * Write the current IDE's last-seen marker. Best-effort: never throws.
 * Atomic via tmp+rename.
 *
 * @param {string} ideId
 * @param {{ homeDir?: string }} [opts]
 */
async function writeLastSeen(ideId, opts = {}) {
  if (!ideId || typeof ideId !== 'string' || !IDE_ID_PATTERN.test(ideId)) return;
  if (ideId === 'unknown') return;
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  const path = lastSeenPath(home, ideId);
  try {
    await mkdir(dirname(path), { recursive: true });
    const body = JSON.stringify({ ide: ideId, last_seen_at: new Date().toISOString() }, null, 2) + '\n';
    const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, body, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  } catch {
    // best-effort
  }
}

/**
 * Read another IDE's last-seen marker. Returns null on any read error or
 * missing file.
 *
 * @param {string} ideId
 * @param {{ homeDir?: string }} [opts]
 * @returns {Promise<{ ide: string, last_seen_at: string }|null>}
 */
async function readLastSeen(ideId, opts = {}) {
  if (!ideId || !IDE_ID_PATTERN.test(ideId)) return null;
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  try {
    const raw = await readFile(lastSeenPath(home, ideId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.last_seen_at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Scan ~/.ijfw/state/ for last-seen-by-<ide>.json files older than 30 days
 * and unlink them. Best-effort: never throws. Returns the number removed.
 *
 * @param {{ homeDir?: string, now?: number }} [opts]
 * @returns {Promise<number>}
 */
async function cleanupStaleLastSeen(opts = {}) {
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  let removed = 0;
  let entries;
  try {
    entries = await readdir(stateDir(home));
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith('last-seen-by-') || !entry.endsWith('.json')) continue;
    const full = join(stateDir(home), entry);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs > LAST_SEEN_STALE_MS) {
        await unlink(full);
        removed++;
      }
    } catch {
      // best-effort
    }
  }
  return removed;
}

/**
 * Detect divergence between the IDE that wrote active.json and the current IDE.
 *
 * Semantics:
 *   - active.json missing OR no activated_by_ide field (pre-v1.4.3) → not divergent
 *   - active.activated_by_ide === current_ide → not divergent
 *   - active.activated_by_ide !== current_ide AND current_ide has a last-seen
 *     file AND active.activated_at is OLDER than current_ide's last_seen_at →
 *     divergent (this IDE was here before; a different IDE has since taken over
 *     stale state)
 *   - otherwise → not divergent (legitimate cross-IDE hand-off)
 *
 * Side effects:
 *   - writes current_ide's last-seen marker
 *   - cleans up stale last-seen files (>30 days)
 *
 * @param {{ homeDir?: string, currentIde?: string, now?: number }} [opts]
 * @returns {Promise<{ divergent: boolean, last_writer: string|null, current_ide: string, age_seconds: number|null, reason?: string }>}
 */
export async function detectCrossIdeDivergence(opts = {}) {
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  // Lazy import to avoid a hard module dependency cycle in test scaffolds.
  let currentIde = opts.currentIde;
  if (!currentIde) {
    try {
      const { detectIde } = await import('./ide-detect.js');
      currentIde = detectIde();
    } catch {
      currentIde = 'unknown';
    }
  }

  // Best-effort stale cleanup on every divergence check.
  await cleanupStaleLastSeen({ homeDir: home, now });

  // Read active.json. Missing or unreadable → not divergent.
  let active;
  try {
    const raw = await readFile(statePath(home), 'utf8');
    active = JSON.parse(raw);
  } catch {
    return { divergent: false, last_writer: null, current_ide: currentIde, age_seconds: null, reason: 'no active extension' };
  }

  // Pre-v1.4.3 active.json — silently no-divergence.
  if (!active || typeof active !== 'object' || typeof active.activated_by_ide !== 'string') {
    return { divergent: false, last_writer: null, current_ide: currentIde, age_seconds: null, reason: 'pre-v1.4.3 active.json' };
  }

  const lastWriter = active.activated_by_ide;
  const activatedAtMs = typeof active.activated_at === 'string' ? Date.parse(active.activated_at) : NaN;
  const ageSeconds = Number.isFinite(activatedAtMs) ? Math.max(0, Math.floor((now - activatedAtMs) / 1000)) : null;

  // Write our own last-seen marker (best-effort; we ARE the current IDE).
  if (currentIde !== 'unknown') {
    await writeLastSeen(currentIde, { homeDir: home });
  }

  if (lastWriter === currentIde) {
    return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'same ide' };
  }

  // If current_ide is 'unknown', divergence detection is disabled.
  if (currentIde === 'unknown') {
    return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'detection disabled' };
  }

  // Look up the current IDE's previous last-seen, if any.
  const seen = await readLastSeen(currentIde, { homeDir: home });
  if (!seen) {
    // Current IDE has no prior history → legitimate first-time hand-off.
    return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'first-time current ide' };
  }
  const seenMs = Date.parse(seen.last_seen_at);
  if (!Number.isFinite(seenMs) || !Number.isFinite(activatedAtMs)) {
    return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'unparseable timestamps' };
  }

  // Divergent when: this IDE was here BEFORE another IDE took over the slot.
  if (activatedAtMs > seenMs) {
    return { divergent: true, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'foreign ide took over after current ide was here' };
  }

  // active was written BEFORE current ide's last_seen — current ide already
  // saw a different writer earlier; treat as non-divergent (already observed).
  return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'current ide observed handoff already' };
}

// Internal helpers exported for tests only.
export const __testing = Object.freeze({
  writeLastSeen,
  readLastSeen,
  cleanupStaleLastSeen,
  LAST_SEEN_STALE_MS,
});
