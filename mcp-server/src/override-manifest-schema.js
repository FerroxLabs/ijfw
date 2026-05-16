/**
 * override-manifest-schema.js
 *
 * IJFW v1.4.0 Wave 0 / t2 — Override Manifest Schema
 *
 * Overrides are section-fenced markdown patches applied to base IJFW skills
 * at DEPLOYMENT time (never runtime). The resolver merges base + tier chain
 * and writes the result to every platform skill dir.
 *
 * File format (.ijfw/skill-overrides/project/<skill>/override.md):
 *   ---
 *   extends: [book, academic-style]
 *   scope: project
 *   skill: ijfw-critique
 *   ---
 *
 *   <!-- ijfw-override: rubric -->
 *   ... section body ...
 *   <!-- ijfw-override-end -->
 *
 * 4-tier resolution (last-write-wins, project has final say per R4):
 *   1. base presets   ~/.ijfw/overrides/presets/
 *   2. user           ~/.ijfw/user-overrides/
 *   3. org            ~/.ijfw/org-overrides/
 *   4. project        .ijfw/skill-overrides/
 *
 * `extends:` chain depth-limited to 5; circular chains rejected.
 *
 * Hand-rolled validator. Zero new prod deps.
 */

export const SCHEMA_VERSION = '1.0';

/**
 * Ordered list. Earlier scopes are overridden by later ones (last-write-wins).
 * Project always has final precedence over org > user > base presets.
 */
export const OVERRIDE_SCOPES = Object.freeze(['base', 'user', 'org', 'project']);

export const BUILTIN_PRESETS = Object.freeze([
  'book',
  'campaign',
  'academic',
  'screenplay',
]);

export const MAX_EXTENDS_DEPTH = 5;

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Section fence markers used by the resolver. */
export const OVERRIDE_OPEN_FENCE = /<!--\s*ijfw-override:\s*([a-z][a-z0-9-]*)\s*-->/g;
export const OVERRIDE_CLOSE_FENCE = /<!--\s*ijfw-override-end\s*-->/;

function isString(v) {
  return typeof v === 'string';
}

function isNonNullObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * validateOverrideManifest(obj) — validates the YAML frontmatter portion of
 * an override file (parsed into an object). The body (section fences) is
 * validated by the resolver, not here.
 *
 * @param {unknown} obj
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateOverrideManifest(obj) {
  const errors = [];

  if (!isNonNullObject(obj)) {
    return { valid: false, errors: ['root: must be an object'] };
  }

  // scope (required)
  if (!OVERRIDE_SCOPES.includes(obj.scope)) {
    errors.push(
      `scope: must be one of ${OVERRIDE_SCOPES.join('|')}, got ${JSON.stringify(obj.scope)}`,
    );
  }

  // skill (required)
  if (!isString(obj.skill) || !SKILL_NAME_PATTERN.test(obj.skill)) {
    errors.push(
      `skill: must be a kebab-case identifier matching ${SKILL_NAME_PATTERN}`,
    );
  }

  // extends (optional, array of preset names)
  if (obj.extends !== undefined) {
    if (!Array.isArray(obj.extends)) {
      errors.push('extends: must be an array of preset name strings (or omitted)');
    } else {
      obj.extends.forEach((p, i) => {
        if (!isString(p) || !PRESET_NAME_PATTERN.test(p)) {
          errors.push(
            `extends[${i}]: must be a kebab-case preset name, got ${JSON.stringify(p)}`,
          );
        }
      });
      // Self-reference check (cycle detection across files is the resolver's job;
      // this just blocks the trivially obvious case).
      if (isString(obj.skill) && obj.extends.includes(obj.skill)) {
        errors.push(`extends: must not include own skill "${obj.skill}" (circular)`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * detectCircularExtends(graph, start, seen) — detects cycles in the extends
 * graph. Resolver passes a Map<presetName, manifest>; we walk recursively.
 *
 * Exported for use by the resolver (t6) and by tests (t18).
 *
 * @param {Map<string, {extends?: string[]}>} graph
 * @param {string} start
 * @param {Set<string>} [seen]
 * @param {number} [depth]
 * @returns {{circular: boolean, chain: string[]}}
 */
export function detectCircularExtends(graph, start, seen = new Set(), depth = 0) {
  if (depth > MAX_EXTENDS_DEPTH) {
    return { circular: true, chain: [...seen, start, '...(depth-exceeded)'] };
  }
  if (seen.has(start)) {
    return { circular: true, chain: [...seen, start] };
  }
  const m = graph.get(start);
  if (!m || !Array.isArray(m.extends) || m.extends.length === 0) {
    return { circular: false, chain: [...seen, start] };
  }
  const next = new Set(seen);
  next.add(start);
  for (const parent of m.extends) {
    const r = detectCircularExtends(graph, parent, next, depth + 1);
    if (r.circular) return r;
  }
  return { circular: false, chain: [...next, start] };
}
