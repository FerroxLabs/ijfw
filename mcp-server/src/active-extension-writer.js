/**
 * active-extension-writer.js -- IJFW v1.4.0 W7.1/B2-H-01
 *
 * Writes ~/.ijfw/state/active-extension.json from an extension manifest, and
 * clears it on deactivate. Used by:
 *   - `ijfw_run extension:activate <name>` CLI command
 *   - installExtension when opts.activate is set
 *
 * v1.5.0 T10 — Migrated to the state-SDK. The legacy
 * `writeFile`/`rename`/`unlink` direct-write path is replaced by a call to
 * `query('extension.set-active', ...)`. The state-SDK is the single mutation
 * surface for `~/.ijfw/state/active-extension.json`; this writer now adapts
 * the SDK's verb-returns to the writer's `{ok, path, error}` /
 * `{ok, removed}` external API so every existing caller keeps working without
 * change (`extension-installer.js`, `dispatch/active-cli.js`,
 * `dispatch/extension.js`, the test suite).
 *
 * Side-effects retained verbatim from the v1.4.0/W7.1 contract:
 *   - quota counters are reset on activate (B16/SEC-M-02) and clear (B16) via
 *     `resetExtensionQuotas` — best-effort, never blocks the verb result.
 *   - B18 cross-IDE last-seen / divergence detection (`detectCrossIdeDivergence`)
 *     stays as-is — it is a read-only consumer of the homedir state file and
 *     does not need the SDK.
 *   - `findInstalledManifest` stays as-is — it reads project/org/user-scope
 *     manifest.json files; it is a read of installed extensions, not a write
 *     to the homedir state file, so it is outside the state-SDK surface.
 */

import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { resetExtensionQuotas } from './extension-quota-tracker.js';
// v1.5.0 audit-LOW-update-#13: shared tmp-suffix helper.
import { tmpSuffix } from './lib/tmp-suffix.js';
// v1.5.0 T10: route the canonical write/clear of ~/.ijfw/state/active-extension.json
// through the state-SDK verb.
import { query } from './orchestrator/state-sdk.js';

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
 * Pick a state-SDK projectRoot to satisfy the verb's `ctx.projectRoot`
 * requirement. The writer's external callers don't carry a project root
 * (extension activation is a homedir-scoped operation), so we fall back to
 * `process.cwd()`. The SDK uses this only for the intent-journal lock path
 * (`<projectRoot>/.ijfw/state/intent-journal.jsonl`) — it never mutates any
 * project file under it. opts.projectRoot, when supplied, takes precedence.
 */
function pickProjectRoot(opts) {
  if (opts && typeof opts.projectRoot === 'string' && opts.projectRoot.length > 0) {
    return opts.projectRoot;
  }
  return process.cwd();
}

/**
 * Write the active-extension state file from a manifest + scope.
 * Validates required fields before write. Atomic write via the state-SDK
 * `extension.set-active` verb (tmp+rename via atomic-io).
 *
 * @param {{ name: string, permissions: { reads: string[], writes: string[] }, quotas?: object }} manifest
 * @param {'project'|'org'|'user'} scope
 * @param {{ homeDir?: string, ideId?: string|null, projectRoot?: string }} [opts]
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function writeActiveExtension(manifest, scope, opts = {}) {
  // Validation — external API contract (returns ok:false, never throws).
  // Mirrors the pre-v1.5.0 behavior so every existing caller keeps the same
  // error-handling shape. The SDK verb would throw on the same inputs; the
  // adapter catches that downstream too, but explicit pre-checks give the
  // historical error messages.
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

  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());

  // B18: stamp activated_by_ide + activated_by_pid when ideId is provided.
  // Caller (CLI) is responsible for calling detectIde() and threading the
  // value in. When opts.ideId is null/undefined or invalid, fields are
  // omitted (so the file stays back-compatible with v1.4.1 readers).
  const ideId = (typeof opts.ideId === 'string' && IDE_ID_PATTERN.test(opts.ideId))
    ? opts.ideId
    : null;

  // Normalize permissions + quotas in the manifest payload so the SDK verb
  // sees the exact shape it expects. The verb itself filters quotas to
  // positive integers — we leave that filtering to it (single writer rule).
  const reads = Array.isArray(manifest.permissions.reads) ? manifest.permissions.reads : [];
  const writes = Array.isArray(manifest.permissions.writes) ? manifest.permissions.writes : [];
  const verbManifest = {
    name: manifest.name,
    permissions: { reads, writes },
  };
  if (
    manifest.quotas !== undefined &&
    manifest.quotas !== null &&
    typeof manifest.quotas === 'object' &&
    !Array.isArray(manifest.quotas)
  ) {
    verbManifest.quotas = manifest.quotas;
  }

  const payload = {
    manifest: verbManifest,
    scope,
    homeDir: home,
  };
  if (ideId) {
    payload.activated_by_ide = ideId;
    payload.activated_by_pid = process.pid;
  }

  let result;
  try {
    result = await query('extension.set-active', payload, {
      projectRoot: pickProjectRoot(opts),
      homeDir: home,
    });
  } catch (err) {
    // The SDK verb throws on protocol violations. Surface as the writer's
    // {ok:false, error} contract so callers don't have to learn a new shape.
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (!result || result.ok !== true) {
    return { ok: false, error: 'state-sdk extension.set-active returned non-ok' };
  }

  // Recover the activated_at timestamp the SDK stamped so we can pass it to
  // resetExtensionQuotas (parity with the legacy writer's wall_clock_ms window).
  // Best-effort: if the read fails, omit activated_at and the tracker resets
  // counters without the window stamp.
  let activatedAt;
  try {
    const raw = await readFile(result.path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.activated_at === 'string') {
      activatedAt = parsed.activated_at;
    }
  } catch { /* best-effort */ }

  // B16/SEC-M-02: reset quota counters on activate; stamp activated_at so
  // wall_clock_ms can be computed against this activation window.
  try {
    await resetExtensionQuotas(manifest.name, { homeDir: home, activated_at: activatedAt });
  } catch {
    // Quota reset failure must not block activation. Counters will self-heal
    // on next deactivate or the next activate of the same name.
  }

  return { ok: true, path: result.path };
}

/**
 * Clear the active-extension state file. Idempotent -- succeeds if file is absent.
 *
 * @param {{ homeDir?: string, projectRoot?: string }} [opts]
 * @returns {Promise<{ ok: boolean, removed: boolean }>}
 */
export async function clearActiveExtension(opts = {}) {
  const home = opts && opts.homeDir ? opts.homeDir : (process.env.HOME || homedir());

  // B16/SEC-M-02: read the active extension name BEFORE clearing so we can
  // reset its quota counters. Best-effort: if the file is missing or
  // malformed, deactivate still succeeds.
  let extName = null;
  const wasPresent = existsSync(statePath(home));
  try {
    const raw = await readFile(statePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      extName = parsed.name;
    }
  } catch {
    // ignore — extName stays null
  }

  // Drive the canonical clear through the SDK verb (manifest:null is the
  // documented clear semantics — see STATE-SDK-CONTRACT.md §7).
  // The verb is idempotent on an absent file (best-effort unlink).
  let verbOk = false;
  try {
    const r = await query('extension.set-active', {
      manifest: null,
      // The verb requires a valid scope. 'project' is a safe sentinel — the
      // clear branch does not consult `scope` for any state-file content
      // (clear unlinks the file unconditionally). Any of the three valid
      // values would work.
      scope: 'project',
      homeDir: home,
    }, {
      projectRoot: pickProjectRoot(opts),
      homeDir: home,
    });
    verbOk = !!(r && r.ok);
  } catch {
    verbOk = false;
  }

  // Always reset quota counters if we know the ext name, regardless of
  // whether the verb succeeded or the file was present — mirrors the
  // legacy writer's ENOENT-tolerant best-effort reset.
  if (extName) {
    try {
      await resetExtensionQuotas(extName, { homeDir: home });
    } catch { /* best-effort */ }
  }

  if (verbOk) {
    return { ok: true, removed: wasPresent };
  }
  return { ok: false, removed: false };
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
    // v1.5.0 audit-LOW-update-#13: tmpSuffix() replaces inline randomBytes call.
    const tmp = `${path}.tmp.${tmpSuffix({ bytes: 4, includePid: false })}`;
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

  // CRITICAL ORDERING: read prior last-seen BEFORE overwriting it. Otherwise
  // the divergence comparison degrades to "now vs activated_at" which is
  // always non-divergent.
  let priorSeen = null;
  if (lastWriter !== currentIde && currentIde !== 'unknown') {
    priorSeen = await readLastSeen(currentIde, { homeDir: home });
  }

  // Now write our own last-seen marker (best-effort; we ARE the current IDE).
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

  if (!priorSeen) {
    // Current IDE has no prior history → legitimate first-time hand-off.
    return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'first-time current ide' };
  }
  const seenMs = Date.parse(priorSeen.last_seen_at);
  if (!Number.isFinite(seenMs) || !Number.isFinite(activatedAtMs)) {
    return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'unparseable timestamps' };
  }

  // Design rule (per B18 spec):
  //   divergent iff active.activated_by_ide != currentIde
  //                AND active.activated_at < currentIde.last_seen
  //
  // Reading: the slot says some other IDE wrote it, but the current IDE has
  // a more recent last-seen — i.e., the current IDE has been touching state
  // more recently than the write, yet a different IDE's name is on it. Stale
  // cross-IDE state divergence.
  if (activatedAtMs < seenMs) {
    return { divergent: true, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'stale active.json: current ide last-seen is more recent than active.activated_at' };
  }

  // active was written AFTER current ide's last_seen — legitimate hand-off
  // (another IDE took over while current was away).
  return { divergent: false, last_writer: lastWriter, current_ide: currentIde, age_seconds: ageSeconds, reason: 'legitimate handoff: foreign ide wrote after current ide was last here' };
}

// Internal helpers exported for tests only.
export const __testing = Object.freeze({
  writeLastSeen,
  readLastSeen,
  cleanupStaleLastSeen,
  LAST_SEEN_STALE_MS,
});
