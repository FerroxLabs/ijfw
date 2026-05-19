/**
 * override-use-registry.js
 *
 * IJFW v1.4.0 Wave 3 / t14 — Cross-Project Override-Use Registry
 *
 * Per F8: replace SHA256 fingerprint + BM25 search with a STRUCTURED
 * registry. When a user has the same overrides active in N+ projects, the
 * prelude can suggest promoting them to user defaults.
 *
 * Storage: ~/.ijfw/state/override-use.json (kept SEPARATE from
 * active-overrides.json per R12 — different concerns. active-overrides.json
 * tracks per-project state for the resolver; this registry tracks
 * cross-project signal for promotion intelligence and can include
 * project_type and other analytic fields the resolver doesn't need).
 *
 * Shape:
 *   {
 *     "schema_version": "1.0",
 *     "projects": {
 *       "/abs/path/to/project": {
 *         "project_type": "book",
 *         "active_overrides": [
 *           { "preset": "book", "scope": "project",
 *             "applied_at": "ISO-8601" }
 *         ]
 *       }
 *     }
 *   }
 *
 * Zero new prod deps. Built-in Node only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SCHEMA_VERSION = '1.0';

// Maximum path length the registry will accept. Practical limits across the
// supported platforms are PATH_MAX=4096 (Linux), 1024 (macOS), 32767 (Windows
// long-path). 4096 is a comfortable cap that won't reject any real path but
// will reject a flood-of-bytes prompt-injection payload.
const MAX_PROJECT_ROOT_LEN = 4096;

// Unicode tag-block range (U+E0000–U+E007F) — invisible "ASCII Smuggler" code
// points historically used to hide prompt-injection payloads inside text the
// model sees but the human doesn't. Closed at the prelude in H1.4; we also
// reject at registry-write time to prevent contamination at the source.
const UNICODE_TAG_BLOCK_RE = /[\u{E0000}-\u{E007F}]/u;

// ASCII control characters (excluding nothing — \n \r \t \0 etc are ALL
// rejected when present in a path key).
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * F-SEC-4 (HIGH, update-install-trust audit v1.5.0):
 * recordOverrideUse persisted any non-empty string as a project key and that
 * value flows verbatim into the cross-project promote suggestion that lands
 * in the prelude the model reads — a prompt-injection vector.
 *
 * Validate projectRoot is shaped like a real absolute filesystem path with
 * no `..` segments, no control characters, no Unicode tag-block smuggling
 * code points, and within a sane length cap. Returns `{ ok: true }` on pass
 * or `{ ok: false, reason }` on fail. We do NOT throw — the caller in
 * override-resolver.js wraps the registry write in a non-fatal try/catch
 * and we want a structured signal instead of a thrown Error so future
 * callers can surface a clean rejection without try/catch noise.
 *
 * @param {unknown} projectRoot
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ok: false, reason: 'projectRoot must be a non-empty string' };
  }
  if (projectRoot.length > MAX_PROJECT_ROOT_LEN) {
    return {
      ok: false,
      reason: `projectRoot exceeds max length ${MAX_PROJECT_ROOT_LEN}`,
    };
  }
  if (!path.isAbsolute(projectRoot)) {
    return { ok: false, reason: 'projectRoot must be an absolute path' };
  }
  // Reject any `..` segment in the RAW path before normalization. path.normalize
  // would collapse interior `..` (e.g. `/a/../b` -> `/b`) and silently rewrite
  // the registry key, defeating the validation. A real filesystem path passed
  // by override-resolver.js is already canonical, so a `..` is a tampering
  // signal. Split on both POSIX and Windows separators so /a/../b and \a\..\b
  // are both caught regardless of host platform.
  const rawSegments = projectRoot.split(/[\\/]/);
  if (rawSegments.includes('..')) {
    return { ok: false, reason: 'projectRoot must not contain `..` segments' };
  }
  if (CONTROL_CHAR_RE.test(projectRoot)) {
    return {
      ok: false,
      reason: 'projectRoot must not contain control characters',
    };
  }
  if (UNICODE_TAG_BLOCK_RE.test(projectRoot)) {
    return {
      ok: false,
      reason: 'projectRoot must not contain Unicode tag-block characters',
    };
  }
  // Reject prompt-injection / markdown / HTML tokens that are not meaningful
  // in a real path but ARE meaningful when rendered into the prelude. These
  // are not legal in any reasonable filesystem path.
  if (/[<>`]/.test(projectRoot)) {
    return {
      ok: false,
      reason: 'projectRoot must not contain `<`, `>`, or backtick',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Path helpers — read os.homedir()/HOME at call time so tests can swap HOME
// via process.env between calls.
// ---------------------------------------------------------------------------

function homeDir() {
  // os.homedir() honours process.env.HOME on POSIX, which is what the smoke
  // test in the t14 brief assumes. Use os.homedir() to keep cross-platform
  // semantics aligned with the rest of the codebase.
  return os.homedir();
}

function registryPath() {
  return path.join(homeDir(), '.ijfw', 'state', 'override-use.json');
}

function settingsPath() {
  return path.join(homeDir(), '.ijfw', 'state', 'settings.json');
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

async function readRegistry() {
  const p = registryPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { schema_version: SCHEMA_VERSION, projects: {} };
    }
    if (!parsed.projects || typeof parsed.projects !== 'object') {
      parsed.projects = {};
    }
    if (!parsed.schema_version) parsed.schema_version = SCHEMA_VERSION;
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { schema_version: SCHEMA_VERSION, projects: {} };
    }
    if (err instanceof SyntaxError) {
      return { schema_version: SCHEMA_VERSION, projects: {} };
    }
    throw err;
  }
}

async function writeRegistry(state) {
  const p = registryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record (or update) an active override for a project in the registry.
 * Idempotent — re-recording the same (project, preset) updates applied_at
 * rather than duplicating the entry.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` on validation
 * failure. Does NOT throw on bad input — the value flows into the prelude
 * the model reads, so we want every untrusted projectRoot rejected loudly
 * via the return contract instead of via an unhandled Error.
 *
 * @param {string} projectRoot     MUST be an absolute path, no `..`, no
 *                                 control / Unicode tag-block / HTML chars.
 * @param {string} preset
 * @param {string} scope          'base' | 'user' | 'org' | 'project'
 * @param {string} [project_type] auto-detected project type, defaults to
 *                                whatever is already on file or 'unknown'.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function recordOverrideUse(projectRoot, preset, scope, project_type) {
  // F-SEC-4 (HIGH): full path validation on projectRoot before it enters the
  // registry. See validateProjectRoot above for the threat-model rationale.
  const pathCheck = validateProjectRoot(projectRoot);
  if (!pathCheck.ok) {
    return pathCheck;
  }
  if (typeof preset !== 'string' || !preset) {
    return { ok: false, reason: 'preset must be a non-empty string' };
  }
  if (typeof scope !== 'string' || !scope) {
    return { ok: false, reason: 'scope must be a non-empty string' };
  }

  const state = await readRegistry();
  const proj = state.projects[projectRoot] || { active_overrides: [] };
  if (!Array.isArray(proj.active_overrides)) proj.active_overrides = [];
  if (project_type && typeof project_type === 'string') {
    proj.project_type = project_type;
  } else if (!proj.project_type) {
    proj.project_type = 'unknown';
  }

  const appliedAt = new Date().toISOString();
  const existingIdx = proj.active_overrides.findIndex(
    (o) => o && o.preset === preset
  );
  if (existingIdx >= 0) {
    proj.active_overrides[existingIdx] = {
      ...proj.active_overrides[existingIdx],
      preset,
      scope,
      applied_at: appliedAt,
    };
  } else {
    proj.active_overrides.push({ preset, scope, applied_at: appliedAt });
  }
  state.projects[projectRoot] = proj;
  await writeRegistry(state);
  return { ok: true };
}

/**
 * Remove a project's record of having an override active. Leaves the project
 * entry in place with an empty active_overrides array so project_type and
 * any other analytic fields persist for future signal.
 *
 * @param {string} projectRoot
 * @param {string} preset
 */
export async function removeOverrideUse(projectRoot, preset) {
  const state = await readRegistry();
  const proj = state.projects[projectRoot];
  if (!proj || !Array.isArray(proj.active_overrides)) return;
  proj.active_overrides = proj.active_overrides.filter(
    (o) => !(o && o.preset === preset)
  );
  // Intentionally do NOT delete state.projects[projectRoot] — see jsdoc.
  state.projects[projectRoot] = proj;
  await writeRegistry(state);
}

/**
 * Find every project that has `preset` recorded as active.
 *
 * @param {string} preset
 * @returns {Promise<Array<{project: string, project_type: string, applied_at: string}>>}
 */
export async function findProjectsWithOverride(preset) {
  const state = await readRegistry();
  const out = [];
  for (const [project, entry] of Object.entries(state.projects || {})) {
    if (!entry || !Array.isArray(entry.active_overrides)) continue;
    // F-SEC-4 (HIGH) defense-in-depth: legacy registries written before
    // v1.5.1 validation could contain unsafe keys. Refuse to surface them.
    if (!validateProjectRoot(project).ok) continue;
    const hit = entry.active_overrides.find(
      (o) => o && o.preset === preset
    );
    if (hit) {
      out.push({
        project,
        project_type: entry.project_type || 'unknown',
        applied_at: hit.applied_at,
      });
    }
  }
  return out;
}

/**
 * Find projects whose recorded override SET is similar (Jaccard) to
 * currentOverrides above threshold. Excludes opts.excludeProject if given.
 *
 * @param {string[]} currentOverrides  preset names
 * @param {number}   [threshold=0.5]
 * @param {{excludeProject?: string}} [opts]
 * @returns {Promise<Array<{project: string, project_type: string, overrides: string[], similarity: number}>>}
 */
export async function findProjectsWithSimilarOverrideSet(
  currentOverrides,
  threshold = 0.5,
  opts = {}
) {
  if (!Array.isArray(currentOverrides) || currentOverrides.length === 0) {
    return [];
  }
  const exclude = opts && typeof opts.excludeProject === 'string'
    ? opts.excludeProject
    : null;
  const current = new Set(currentOverrides);
  const state = await readRegistry();
  const out = [];
  for (const [project, entry] of Object.entries(state.projects || {})) {
    if (exclude && project === exclude) continue;
    if (!entry || !Array.isArray(entry.active_overrides)) continue;
    // F-SEC-4 (HIGH) defense-in-depth: legacy registries written before
    // v1.5.1 validation could contain unsafe keys that would flow into the
    // promote suggestion text and the prelude. Refuse to surface them.
    if (!validateProjectRoot(project).ok) continue;
    const theirs = new Set(
      entry.active_overrides
        .filter((o) => o && typeof o.preset === 'string')
        .map((o) => o.preset)
    );
    if (theirs.size === 0) continue;
    let intersection = 0;
    for (const p of current) if (theirs.has(p)) intersection += 1;
    const union = new Set([...current, ...theirs]).size;
    const similarity = union === 0 ? 0 : intersection / union;
    if (similarity >= threshold) {
      out.push({
        project,
        project_type: entry.project_type || 'unknown',
        overrides: Array.from(theirs),
        similarity,
      });
    }
  }
  // Sort highest similarity first for deterministic prelude output.
  out.sort((a, b) => b.similarity - a.similarity || a.project.localeCompare(b.project));
  return out;
}

/**
 * Compose a promote-to-user-defaults suggestion when N+ projects share the
 * current project's override set. Returns null if the threshold is not met.
 *
 * Threshold is configurable via ~/.ijfw/state/settings.json
 * `override_promote_min_matches` (default 3) or opts.minMatches.
 *
 * @param {string}   currentProjectRoot
 * @param {string[]} currentOverrides
 * @param {{minMatches?: number, threshold?: number}} [opts]
 * @returns {Promise<null | {message: string, projects: string[], suggestion: string}>}
 */
export async function getPromoteSuggestion(currentProjectRoot, currentOverrides, opts = {}) {
  if (!Array.isArray(currentOverrides) || currentOverrides.length === 0) {
    return null;
  }
  const state = await readRegistry();
  const projectCount = Object.keys(state.projects || {}).length;
  if (projectCount < 2) return null;

  const settings = await readSettings();
  const configuredMin = Number.isInteger(settings.override_promote_min_matches)
    ? settings.override_promote_min_matches
    : null;
  const minMatches = Number.isInteger(opts.minMatches)
    ? opts.minMatches
    : (configuredMin ?? 3);
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.5;

  const matches = await findProjectsWithSimilarOverrideSet(
    currentOverrides,
    threshold,
    { excludeProject: currentProjectRoot }
  );
  if (matches.length < minMatches) return null;

  const presetList = currentOverrides.slice().sort().join(', ');
  const presetArgs = currentOverrides.slice().sort().join(' ');
  const message =
    `You have [${presetList}] active in ${matches.length} other projects. ` +
    `Consider promoting to user defaults so new projects pick them up automatically.`;
  return {
    message,
    projects: matches.map((m) => m.project),
    suggestion: `ijfw override promote --scope user ${presetArgs}`,
  };
}

// Test seam — internal-only, do not import in production code.
export const __test = {
  registryPath,
  settingsPath,
  readRegistry,
  writeRegistry,
  validateProjectRoot,
  MAX_PROJECT_ROOT_LEN,
};
