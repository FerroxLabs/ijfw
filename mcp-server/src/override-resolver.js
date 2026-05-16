/**
 * override-resolver.js
 *
 * IJFW v1.4.0 Wave 1 / t6 — Deployment-Time Override Resolver
 *
 * Resolves base SKILL.md + 4-tier override chain (base presets -> user -> org
 * -> project, last-write-wins per section) into a merged skill body, and
 * deploys that merged body into every present platform skill dir under
 * projectRoot.
 *
 * Resolution is deployment-time. No runtime interception. Platform agents
 * read SKILL.md from their own dir at use time and have no idea overrides
 * happened.
 *
 * Section-fenced merge format:
 *   override file body:
 *     <!-- ijfw-override: rubric -->
 *     ... override content ...
 *     <!-- ijfw-override-end -->
 *
 *   base skill body:
 *     <!-- ijfw-override-target: rubric -->
 *     ... original content (replaced) ...
 *     <!-- ijfw-override-target-end -->
 *
 * If a section has no matching target in the base body, the override section
 * is skipped with a console.warn — non-fatal so a single stale override does
 * not break deploy.
 *
 * Zero new prod deps. Built-in Node only.
 */

import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  BUILTIN_PRESETS,
  MAX_EXTENDS_DEPTH,
  SKILL_NAME_PATTERN,
  validateOverrideManifest,
  detectCircularExtends,
} from './override-manifest-schema.js';
import {
  recordOverrideUse,
  removeOverrideUse,
} from './override-use-registry.js';

// ---------------------------------------------------------------------------
// Platform discovery
// ---------------------------------------------------------------------------

/**
 * Return the set of platform skill dirs that currently exist under
 * projectRoot. Used by deployResolvedSkill to know which platforms to write
 * the merged body into.
 *
 * TODO(W2b/t11): replace this with an exported helper from
 * installer/src/install-helpers.js once that module exposes a canonical
 * platform-list getter. Until then this on-disk probe is the contract.
 *
 * @param {string} projectRoot
 * @returns {string[]} absolute paths to existing platform skill dirs
 */
export function getPlatformSkillDirs(projectRoot) {
  const candidates = [
    'claude/skills',
    'codex/skills',
    'gemini/extensions/ijfw/skills',
    'cursor/skills',
    'windsurf/skills',
    'copilot/skills',
    'hermes/skills',
    'wayland/skills',
    'shared/skills',
    'universal/skills',
  ];
  const out = [];
  for (const rel of candidates) {
    const abs = path.join(projectRoot, rel);
    try {
      const st = statSync(abs);
      if (st && st.isDirectory()) out.push(abs);
    } catch {
      // ignore — dir doesn't exist
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Guard skill identifiers against path traversal and unexpected characters.
 *
 * `skill` flows directly into path.join for both base body reads under
 * shared/skills/<skill>/SKILL.md and per-platform deploy targets. An attacker
 * (or buggy dispatch arg) passing "../../../etc/passwd" would escape the
 * shared/skills/ boundary. Reject anything that doesn't match the same
 * kebab-case pattern the override manifest schema enforces.
 *
 * @param {string} skill
 * @param {string} fnName  caller name for the error message
 */
function assertValidSkillName(skill, fnName) {
  if (typeof skill !== 'string' || !SKILL_NAME_PATTERN.test(skill)) {
    throw new Error(
      `${fnName}: invalid skill name ${JSON.stringify(skill)} — must match ${SKILL_NAME_PATTERN}`
    );
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Ordered override file paths for a skill. Caller filters out non-existent
 * ones. Order is base presets -> user -> org -> project; resolveSkill applies
 * them in that order so project wins.
 *
 * NOTE: base preset paths are resolved INSIDE resolveSkill from the
 * manifests' `extends:` fields. resolveOverridePaths returns the
 * user/org/project trio plus a placeholder slot for base presets (which the
 * caller ignores).
 *
 * @param {string} skill
 * @param {string} projectRoot
 * @returns {Array<string|null>} 4 paths in tier order (base-preset slot is null)
 */
export function resolveOverridePaths(skill, projectRoot) {
  const home = os.homedir();
  return [
    null, // base preset paths are computed dynamically by resolveSkill
    path.join(home, '.ijfw', 'user-overrides', skill, 'override.md'),
    path.join(home, '.ijfw', 'org-overrides', skill, 'override.md'),
    path.join(projectRoot, '.ijfw', 'skill-overrides', skill, 'override.md'),
  ];
}

function presetOverridePath(preset) {
  return path.join(os.homedir(), '.ijfw', 'overrides', 'presets', `${preset}.md`);
}

// ---------------------------------------------------------------------------
// YAML frontmatter parsing (minimal)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(raw) {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { manifest: {}, body: raw };
  const head = m[1];
  const body = raw.slice(m[0].length);
  const manifest = {};
  for (const lineRaw of head.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    manifest[key] = value;
  }
  return { manifest, body };
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

/**
 * Read + parse + validate one override file.
 * Returns null if the file does not exist (ENOENT).
 * Throws if the manifest is structurally invalid — callers can decide whether
 * to swallow.
 *
 * @param {string} filePath
 * @returns {Promise<{manifest: object, body: string} | null>}
 */
export async function loadOverrideFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const { manifest, body } = parseFrontmatter(raw);
  const { valid, errors } = validateOverrideManifest(manifest);
  if (!valid) {
    throw new Error(
      `Invalid override manifest at ${filePath}: ${errors.join('; ')}`
    );
  }
  return { manifest, body };
}

// ---------------------------------------------------------------------------
// Section merge
// ---------------------------------------------------------------------------

const SECTION_BLOCK_RE = /<!--\s*ijfw-override:\s*([a-z][a-z0-9-]*)\s*-->([\s\S]*?)<!--\s*ijfw-override-end\s*-->/g;

function targetRegex(section) {
  // Match the corresponding target block in the base body. section name is
  // already constrained by SECTION_BLOCK_RE to [a-z0-9-]+ so no special
  // chars, but escape defensively anyway.
  const safe = section.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(
    `<!--\\s*ijfw-override-target:\\s*${safe}\\s*-->[\\s\\S]*?<!--\\s*ijfw-override-target-end\\s*-->`
  );
}

/**
 * Apply an override file's section blocks onto a base skill body. Returns a
 * new string. Missing targets emit a console.warn and are skipped.
 *
 * @param {string} baseSkillBody
 * @param {{manifest: object, body: string}} overrideFile
 * @returns {string}
 */
export function applyOverride(baseSkillBody, overrideFile) {
  if (!overrideFile) return baseSkillBody;
  let out = baseSkillBody;
  const body = overrideFile.body || '';
  SECTION_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_BLOCK_RE.exec(body)) !== null) {
    const section = m[1];
    const inner = m[2];
    const tre = targetRegex(section);
    if (!tre.test(out)) {
      console.warn(
        `[ijfw override-resolver] override section "${section}" has no matching <!-- ijfw-override-target: ${section} --> ... <!-- ijfw-override-target-end --> in base body — skipping (manifest: ${JSON.stringify(overrideFile.manifest)})`
      );
      continue;
    }
    // Replace the target block with a fresh wrapped section so the next tier
    // can also override it.
    const replacement = `<!-- ijfw-override-target: ${section} -->${inner}<!-- ijfw-override-target-end -->`;
    out = out.replace(tre, () => replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full resolution
// ---------------------------------------------------------------------------

/**
 * Read base SKILL.md -> walk tier chain (base presets -> user -> org ->
 * project) -> return merged body string. Missing base skill returns ''
 * (graceful — keeps deploy from crashing on a typo'd skill name).
 *
 * ## Active-overrides wiring (S6)
 *
 * `ijfw override add <preset>` records the chosen preset in
 * `~/.ijfw/state/active-overrides.json` for the current project but does NOT
 * write an `extends: [<preset>]` line into any override file. resolveSkill
 * therefore consults that state file on every resolution and treats the
 * recorded presets as an IMPLICIT extends chain — programmatically
 * equivalent to the user having written `extends: [book, academic, ...]` in
 * a project-tier override.
 *
 * Algorithm:
 *   1. Read active-overrides for projectRoot. Extract the preset list.
 *   2. Append any presets explicitly named via `extends:` in user/org/project
 *      override files (preserving the existing project-first ordering).
 *   3. Recursively load every preset (and the presets they extend) under the
 *      same MAX_EXTENDS_DEPTH and cycle guards.
 *   4. Apply order: deepest-first preset DFS -> user -> org -> project.
 *
 * The implicit and explicit lists share the same downstream pipeline, so a
 * preset that appears via both routes is only loaded/applied once.
 *
 * @param {string} skill
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
export async function resolveSkill(skill, projectRoot) {
  assertValidSkillName(skill, 'resolveSkill');
  const basePath = path.join(projectRoot, 'shared', 'skills', skill, 'SKILL.md');
  let baseBody = '';
  try {
    baseBody = await fs.readFile(basePath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    return '';
  }

  const [, userPath, orgPath, projectPath] = resolveOverridePaths(skill, projectRoot);

  // Load the three non-preset tiers first so we know which presets are
  // referenced via `extends:`.
  const userFile = await loadOverrideFile(userPath);
  const orgFile = await loadOverrideFile(orgPath);
  const projectFile = await loadOverrideFile(projectPath);

  // Collect referenced presets in project-first order so the project's
  // extends list wins on ordering ambiguity. We still apply ALL referenced
  // presets before any user/org/project overrides so later tiers can override
  // preset content.
  const presetOrder = [];

  // S6: implicit extends from active-overrides state. This is what
  // `ijfw override add book` records; consulting it here is what makes the
  // command actually take effect at deploy time.
  const activePresets = await readActiveOverridesForProject(projectRoot);
  for (const p of activePresets) {
    if (typeof p === 'string' && !presetOrder.includes(p)) presetOrder.push(p);
  }

  for (const f of [projectFile, orgFile, userFile]) {
    if (!f || !f.manifest) continue;
    const ext = f.manifest.extends;
    if (!ext) continue;
    const list = Array.isArray(ext) ? ext : [ext];
    for (const p of list) {
      if (typeof p === 'string' && !presetOrder.includes(p)) presetOrder.push(p);
    }
  }

  // Build preset graph and load every preset (and any preset they extend).
  // presetGraph is a Map<presetName, {extends: string[]}> so it satisfies
  // detectCircularExtends's .get() contract.
  const presetGraph = new Map();
  const loadedPresets = new Map();

  async function loadPresetRecursive(preset, depth) {
    if (depth > MAX_EXTENDS_DEPTH) {
      throw new Error(
        `[ijfw override-resolver] extends chain exceeded MAX_EXTENDS_DEPTH=${MAX_EXTENDS_DEPTH} at "${preset}"`
      );
    }
    if (loadedPresets.has(preset)) return;
    const pf = await loadOverrideFile(presetOverridePath(preset));
    loadedPresets.set(preset, pf); // may be null
    const parents = [];
    if (pf && pf.manifest && pf.manifest.extends) {
      const ext = pf.manifest.extends;
      const list = Array.isArray(ext) ? ext : [ext];
      for (const p of list) if (typeof p === 'string') parents.push(p);
    }
    presetGraph.set(preset, { extends: parents });
    for (const p of parents) {
      await loadPresetRecursive(p, depth + 1);
    }
  }

  for (const p of presetOrder) {
    if (!presetGraph.has(p)) presetGraph.set(p, { extends: [] });
    await loadPresetRecursive(p, 1);
  }

  // Cycle check.
  for (const start of presetGraph.keys()) {
    const { circular, chain } = detectCircularExtends(presetGraph, start);
    if (circular) {
      throw new Error(
        `[ijfw override-resolver] circular extends detected: ${chain.join(' -> ')}`
      );
    }
  }

  // Apply order: deepest-extends preset first -> ... -> shallow presets ->
  // user -> org -> project. Use a post-order DFS so a preset's parents are
  // applied before the preset itself.
  const applyOrder = [];
  const visited = new Set();
  function dfs(p) {
    if (visited.has(p)) return;
    visited.add(p);
    const node = presetGraph.get(p);
    for (const parent of (node && node.extends) || []) dfs(parent);
    applyOrder.push(p);
  }
  for (const p of presetOrder) dfs(p);

  let merged = baseBody;
  for (const preset of applyOrder) {
    const pf = loadedPresets.get(preset);
    if (pf) merged = applyOverride(merged, pf);
  }
  if (userFile) merged = applyOverride(merged, userFile);
  if (orgFile) merged = applyOverride(merged, orgFile);
  if (projectFile) merged = applyOverride(merged, projectFile);

  return merged;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

async function atomicWrite(targetPath, contents) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  // Unique suffix per writer: two parallel deploys of the same skill would
  // otherwise collide on a shared `${targetPath}.tmp` and one would clobber
  // the other mid-write before the rename. pid + 4 bytes of randomness keeps
  // the suffix unique across threads and processes.
  const tmp = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, targetPath);
}

/**
 * Resolve `skill` and write the merged body to every present platform skill
 * dir under projectRoot. Atomic per platform (tmp + rename). Failures on one
 * platform are recorded in `failed[]` but do not abort the others.
 *
 * @param {string} skill
 * @param {string} projectRoot
 * @param {object} [opts]  reserved — currently unused (W2b will wire dry-run,
 *                         explicit platform list, etc.)
 * @returns {Promise<{deployed: Array<{platform: string, path: string}>, failed: Array<{platform: string, path: string, error: string}>}>}
 */
export async function deployResolvedSkill(skill, projectRoot, opts = {}) {
  assertValidSkillName(skill, 'deployResolvedSkill');
  const merged = await resolveSkill(skill, projectRoot);
  const platformDirs = getPlatformSkillDirs(projectRoot);
  const deployed = [];
  const failed = [];

  for (const platformDir of platformDirs) {
    const target = path.join(platformDir, skill, 'SKILL.md');
    try {
      await atomicWrite(target, merged);
      deployed.push({ platform: platformDir, path: target });
    } catch (err) {
      failed.push({
        platform: platformDir,
        path: target,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return { deployed, failed };
}

// ---------------------------------------------------------------------------
// Active overrides state file
// ---------------------------------------------------------------------------

function activeOverridesPath() {
  return path.join(os.homedir(), '.ijfw', 'state', 'active-overrides.json');
}

async function readActiveOverrides() {
  const p = activeOverridesPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.projects) {
      return { projects: {} };
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return { projects: {} };
    if (err instanceof SyntaxError) return { projects: {} };
    throw err;
  }
}

/**
 * S6 wiring helper. Read the active-overrides state file and return the
 * ordered list of preset names recorded for `projectRoot`. Order is the
 * insertion order in active_overrides[] (which is the order the user ran
 * `ijfw override add ...`). Resolver-visible failures are swallowed and
 * mapped to []: a missing/corrupt state file must never block deploy.
 *
 * @param {string} projectRoot
 * @returns {Promise<string[]>}
 */
async function readActiveOverridesForProject(projectRoot) {
  let state;
  try {
    state = await readActiveOverrides();
  } catch {
    return [];
  }
  const proj = state && state.projects && state.projects[projectRoot];
  if (!proj || !Array.isArray(proj.active_overrides)) return [];
  const out = [];
  for (const entry of proj.active_overrides) {
    if (!entry || typeof entry !== 'object') continue;
    const preset = entry.preset;
    if (typeof preset !== 'string') continue;
    if (out.includes(preset)) continue;
    out.push(preset);
  }
  return out;
}

async function writeActiveOverrides(state) {
  const p = activeOverridesPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Same collision concern as atomicWrite above — two concurrent
  // recordActiveOverride calls could clobber each other's tmp file.
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/**
 * Record an active override for a project. Override shape:
 *   { preset: string, scope: 'base'|'user'|'org'|'project', applied_at?: string }
 * If an entry with the same preset+scope already exists, its applied_at is
 * updated.
 *
 * @param {string} projectRoot
 * @param {{preset: string, scope: string, applied_at?: string}} override
 */
export async function recordActiveOverride(projectRoot, override) {
  if (!override || typeof override !== 'object') {
    throw new Error('recordActiveOverride: override must be an object');
  }
  if (!override.preset || !override.scope) {
    throw new Error('recordActiveOverride: override must have preset and scope');
  }
  const state = await readActiveOverrides();
  const proj = state.projects[projectRoot] || { active_overrides: [] };
  if (!Array.isArray(proj.active_overrides)) proj.active_overrides = [];
  const appliedAt = override.applied_at || new Date().toISOString();
  const existingIdx = proj.active_overrides.findIndex(
    (o) => o && o.preset === override.preset && o.scope === override.scope
  );
  if (existingIdx >= 0) {
    proj.active_overrides[existingIdx] = {
      ...proj.active_overrides[existingIdx],
      ...override,
      applied_at: appliedAt,
    };
  } else {
    proj.active_overrides.push({
      preset: override.preset,
      scope: override.scope,
      applied_at: appliedAt,
    });
  }
  state.projects[projectRoot] = proj;
  await writeActiveOverrides(state);

  // t14: mirror into the cross-project override-use registry so the prelude
  // can suggest promote-to-user-defaults when the same set lights up across
  // N+ projects. Lazy-import project-type-detector to dodge the cold-scan
  // module weight when the resolver is only ever called for a single skill.
  try {
    let projectType = 'unknown';
    try {
      const detector = await import('./project-type-detector.js');
      const r = await detector.detect(projectRoot);
      if (r && typeof r.primary_type === 'string') projectType = r.primary_type;
      else if (r && typeof r.type === 'string') projectType = r.type;
    } catch {
      // detect() may throw on cold-scan stalls or missing dirs; the registry
      // accepts 'unknown' and we can backfill later.
    }
    await recordOverrideUse(projectRoot, override.preset, override.scope, projectType);
  } catch (err) {
    // A registry failure must NEVER fail the resolver write. Log to stderr so
    // the dashboard's log tail surfaces it without breaking the deploy flow.
    console.warn(
      `[ijfw override-resolver] override-use-registry record failed (non-fatal): ${err && err.message ? err.message : err}`
    );
  }
}

/**
 * Remove all active-override entries for a project whose preset matches.
 * Idempotent — missing entry is a no-op.
 *
 * @param {string} projectRoot
 * @param {string} preset
 */
export async function removeActiveOverride(projectRoot, preset) {
  const state = await readActiveOverrides();
  const proj = state.projects[projectRoot];
  if (!proj || !Array.isArray(proj.active_overrides)) {
    // Still try the cross-project registry — it may have stale entries even
    // when the per-project state file is missing.
    try {
      await removeOverrideUse(projectRoot, preset);
    } catch (err) {
      console.warn(
        `[ijfw override-resolver] override-use-registry remove failed (non-fatal): ${err && err.message ? err.message : err}`
      );
    }
    return;
  }
  proj.active_overrides = proj.active_overrides.filter(
    (o) => !(o && o.preset === preset)
  );
  state.projects[projectRoot] = proj;
  await writeActiveOverrides(state);

  // t14: keep the cross-project registry in sync.
  try {
    await removeOverrideUse(projectRoot, preset);
  } catch (err) {
    console.warn(
      `[ijfw override-resolver] override-use-registry remove failed (non-fatal): ${err && err.message ? err.message : err}`
    );
  }
}

// ---------------------------------------------------------------------------
// Re-exports for caller convenience
// ---------------------------------------------------------------------------

export { BUILTIN_PRESETS, MAX_EXTENDS_DEPTH };
