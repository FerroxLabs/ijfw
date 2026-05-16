/**
 * domain-manifest.js
 *
 * IJFW v1.4.0 Wave 3 / t13 — Domain-manifest auto-loading dispatch.
 *
 * Detects project type via the W1/t5 project-type-detector and maps the
 * primary_type to a built-in domain preset (book / campaign), then records
 * the override in ~/.ijfw/state/active-overrides.json by invoking the W1/t6
 * override-resolver's recordActiveOverride() directly. No child-process
 * shell-out — pure in-process dispatch so session-start can fire-and-forget
 * via `( ... & disown )` and the detection completes regardless of hook
 * exit timing.
 *
 * Mapping (intentional; matches t13 spec):
 *   book      -> preset "book"
 *   content   -> preset "book"      (closest narrative match)
 *   business  -> preset "campaign"
 *   design    -> preset "campaign"  (closest match)
 *   software  -> no preset (no-op)
 *   mixed     -> no preset (user must pick explicitly)
 *   unknown   -> no preset (no-op)
 *
 * Contract (per R11 + F11):
 *   - Errors are SWALLOWED. Never throws. Fire-and-forget surface.
 *   - Idempotent. If the preset is already in active_overrides for this
 *     projectRoot it short-circuits and reports loaded:[] with cached:true
 *     semantics through domainManifestStatus.
 *   - Synchronous detect() is called inside an async function so the caller
 *     can `await` without blocking the event loop on the project walk;
 *     session-start backgrounds the entire invocation regardless.
 *
 * Discipline:
 *   - ESM only.
 *   - ASCII only in strings.
 *   - No new prod deps.
 *   - No console output on the happy path (session-start banner stays clean).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { detect } from '../project-type-detector.js';
import { recordActiveOverride } from '../override-resolver.js';

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

// project_type -> preset name (or null for no-op).
const TYPE_TO_PRESET = Object.freeze({
  book: 'book',
  content: 'book',
  business: 'campaign',
  design: 'campaign',
  software: null,
  mixed: null,
  unknown: null,
});

// ---------------------------------------------------------------------------
// State helpers (read-side; recordActiveOverride owns the write-side)
// ---------------------------------------------------------------------------

function activeOverridesPath() {
  return path.join(os.homedir(), '.ijfw', 'state', 'active-overrides.json');
}

async function readActiveOverridesSafe() {
  try {
    const raw = await fs.readFile(activeOverridesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.projects) {
      return { projects: {} };
    }
    return parsed;
  } catch {
    // ENOENT or invalid JSON -> empty state. Never throw from a fire-and-forget path.
    return { projects: {} };
  }
}

function activePresetsForProject(state, projectRoot) {
  const proj = state && state.projects ? state.projects[projectRoot] : null;
  if (!proj || !Array.isArray(proj.active_overrides)) return [];
  return proj.active_overrides
    .filter((o) => o && typeof o.preset === 'string')
    .map((o) => o.preset);
}

// ---------------------------------------------------------------------------
// Project type resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the primary project type. detect() returns an object with both
 * `primary_type` and a `type` alias (per W1/t5 contract). We prefer
 * primary_type; fall back to type; finally fall back to 'unknown'.
 *
 * Wrapped so a thrown detect() (e.g. unreadable root) becomes 'unknown'
 * rather than propagating.
 */
function resolveProjectType(projectRoot) {
  try {
    const result = detect(projectRoot, { resume: false });
    if (!result || typeof result !== 'object') return 'unknown';
    const t = result.primary_type || result.type || 'unknown';
    return typeof t === 'string' ? t : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * domainManifestLoad(projectRoot) -> Promise<{
 *   loaded: string[],            // preset names newly loaded this call
 *   project_type: string,        // primary_type from detect()
 *   duration_ms: number,         // wall-clock duration
 *   error?: string,              // present only on swallowed failure
 * }>
 *
 * Detects project type, maps to a preset, and records the override in
 * ~/.ijfw/state/active-overrides.json if not already active. Idempotent.
 * Fire-and-forget contract: NEVER throws.
 *
 * @param {string} projectRoot
 * @returns {Promise<{loaded: string[], project_type: string, duration_ms: number, error?: string}>}
 */
export async function domainManifestLoad(projectRoot) {
  const t0 = Date.now();
  try {
    const root = String(projectRoot || process.cwd());
    const projectType = resolveProjectType(root);
    const preset = TYPE_TO_PRESET[projectType] || null;

    // No mapping -> nothing to load. Honest empty result.
    if (!preset) {
      return {
        loaded: [],
        project_type: projectType,
        duration_ms: Date.now() - t0,
      };
    }

    // Idempotence check. If this preset is already recorded for this project
    // we skip the write — repeated session-starts must not churn the state file.
    const state = await readActiveOverridesSafe();
    const active = activePresetsForProject(state, root);
    if (active.includes(preset)) {
      return {
        loaded: [],
        project_type: projectType,
        duration_ms: Date.now() - t0,
      };
    }

    // Record the new override. Scope 'project' = auto-attached at the project
    // tier, not the user/org tier. applied_at left to recordActiveOverride()
    // to stamp.
    await recordActiveOverride(root, {
      preset,
      scope: 'project',
    });

    return {
      loaded: [preset],
      project_type: projectType,
      duration_ms: Date.now() - t0,
    };
  } catch (err) {
    // Swallow. Fire-and-forget surface — never let session-start's detached
    // child crash and emit a stderr line into the user's terminal.
    return {
      loaded: [],
      project_type: 'unknown',
      duration_ms: Date.now() - t0,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * domainManifestStatus(projectRoot) -> Promise<{
 *   project_type: string,
 *   active_presets: string[],
 *   cached: boolean,           // true if active_presets non-empty (i.e. a
 *                              //   prior session already auto-loaded one)
 * }>
 *
 * Used by the prelude to surface a single-line "Active domain: book" beat
 * once auto-load has fired at least once. Never throws.
 */
export async function domainManifestStatus(projectRoot) {
  try {
    const root = String(projectRoot || process.cwd());
    const projectType = resolveProjectType(root);
    const state = await readActiveOverridesSafe();
    const active = activePresetsForProject(state, root);
    return {
      project_type: projectType,
      active_presets: active,
      cached: active.length > 0,
    };
  } catch (err) {
    return {
      project_type: 'unknown',
      active_presets: [],
      cached: false,
      error: err && err.message ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test = { TYPE_TO_PRESET, resolveProjectType, activePresetsForProject };
