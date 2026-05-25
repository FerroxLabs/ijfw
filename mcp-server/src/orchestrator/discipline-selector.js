/**
 * discipline-selector.js — pure functions to pick and load a project-discipline
 * template body for the DISCIPLINE AGENTS.md marker block.
 *
 * Two exports:
 *
 *   selectDisciplineTemplate(projectType)
 *     Synchronous. Returns the template body string (utf-8) for the given
 *     project type, or an empty string for `unknown` / `mixed`. Throws a
 *     TypeError when projectType is null or undefined. Resolves template
 *     paths relative to this module, using the same fileURLToPath + dirname
 *     pattern as merge-block-aware.js.
 *
 *   detectProjectTypeFromRepo(repoRoot)
 *     Synchronous, deterministic. Inspects the repo root directory to infer
 *     project type. Priority order:
 *       (a) .ijfw/memory/brief.md frontmatter `type` key — highest fidelity,
 *           set explicitly by the user or brainstorm-LOCK hook.
 *       (b) Well-known file/dir signals — cheap existsSync probes, no glob.
 *     Returns one of: 'code' | 'narrative' | 'business' | 'design' |
 *                     'research' | 'unknown'
 *
 * No deps beyond node:fs and node:path (Node >=18, ESM).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Module-relative template root
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Root of the ijfw-agents-md templates directory, resolved relative to this
 * module. Same anchor pattern used by merge-block-aware.js for DEFAULT_TEMPLATE.
 */
const TEMPLATES_DIR = join(
  __dirname,
  '..', '..', '..', 'claude', 'skills', 'ijfw-agents-md', 'templates',
);

// ---------------------------------------------------------------------------
// Valid project types
// ---------------------------------------------------------------------------

/** All recognized project type codes (non-empty body returned for these). */
const TYPED_CODES = new Set(['code', 'narrative', 'business', 'design', 'research']);

/** Project types that legitimately produce an empty template body. */
const EMPTY_BODY_CODES = new Set(['unknown', 'mixed']);

// ---------------------------------------------------------------------------
// selectDisciplineTemplate
// ---------------------------------------------------------------------------

/**
 * Return the template body string for `projectType`.
 *
 * @param {string} projectType  one of: code | narrative | business | design |
 *                              research | unknown | mixed
 * @returns {string}  template body (utf-8). Empty string for unknown/mixed.
 * @throws {TypeError}  when projectType is null or undefined.
 * @throws {Error}      when the template file is absent for a typed project.
 */
export function selectDisciplineTemplate(projectType) {
  if (projectType === null || projectType === undefined) {
    throw new TypeError(
      'selectDisciplineTemplate: projectType must be a string (got null/undefined)',
    );
  }

  const type = String(projectType).trim().toLowerCase();

  if (EMPTY_BODY_CODES.has(type)) {
    // Marker present, body intentionally empty -- skip the file read.
    return '';
  }

  if (!TYPED_CODES.has(type)) {
    // Unrecognized type string -- treat as empty rather than throwing, to
    // match the graceful-degradation philosophy of populateDisciplineBlock.
    return '';
  }

  const templatePath = join(TEMPLATES_DIR, `discipline-${type}.md`);
  if (!existsSync(templatePath)) {
    throw new Error(
      `selectDisciplineTemplate: template file missing for type "${type}" at ${templatePath}`,
    );
  }

  return readFileSync(templatePath, 'utf8');
}

// ---------------------------------------------------------------------------
// detectProjectTypeFromRepo -- frontmatter + file-signal fallback
// ---------------------------------------------------------------------------

/**
 * Inline frontmatter parser -- minimal, zero deps.
 * Reads only the `type` key from the first YAML fence (--- ... ---).
 *
 * Mirrors parseFrontmatter in mcp-server/src/memory/reader.js.
 *
 * @param {string} raw  file contents
 * @returns {string|null}  value of `type` key, or null if absent
 */
function extractTypeFromFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^type:\s*(.+)/i);
    if (kv) return kv[1].trim().toLowerCase();
  }
  return null;
}

/**
 * Return true if any direct child entry name of `dir` satisfies `predicate`.
 * Best-effort: returns false on any readdir error.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {boolean}
 */
function hasDirEntryMatching(dir, predicate) {
  try {
    const entries = readdirSync(dir);
    return entries.some(predicate);
  } catch {
    return false;
  }
}

/**
 * Detect the project type from a repository root.
 *
 * Priority:
 *   (a) .ijfw/memory/brief.md frontmatter `type` key -- set by brainstorm-LOCK.
 *   (b) Well-known file/dir signals via existsSync (no glob, cheap).
 *
 * Signal table (first match wins within each tier):
 *   code:      package.json | tsconfig.json | Cargo.toml | go.mod |
 *              *.csproj | pyproject.toml | setup.py | Gemfile
 *   narrative: chapters/ dir | manuscript/ dir
 *   business:  pitch-deck* | business-plan* | *.numbers
 *   design:    figma-* | *.sketch | design-system/ dir
 *   research:  research/ dir | notebooks/ dir | *.ipynb
 *   unknown:   fallback
 *
 * @param {string} repoRoot  absolute path to repository root
 * @returns {'code'|'narrative'|'business'|'design'|'research'|'unknown'}
 */
export function detectProjectTypeFromRepo(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    return 'unknown';
  }

  // (a) Brief.md frontmatter -- highest fidelity
  const briefPath = join(repoRoot, '.ijfw', 'memory', 'brief.md');
  if (existsSync(briefPath)) {
    try {
      const raw = readFileSync(briefPath, 'utf8');
      const type = extractTypeFromFrontmatter(raw);
      if (type && (TYPED_CODES.has(type) || EMPTY_BODY_CODES.has(type))) {
        return /** @type {any} */ (type);
      }
    } catch {
      // Brief read failure is non-fatal -- fall through to file signals.
    }
  }

  // (b) File-signal fallback -- existsSync only, no glob.
  // --- code signals ---
  const CODE_FILES = [
    'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod',
    'pyproject.toml', 'setup.py', 'Gemfile',
  ];
  for (const f of CODE_FILES) {
    if (existsSync(join(repoRoot, f))) return 'code';
  }
  // *.csproj -- project-named file; scan root dir entries.
  if (hasDirEntryMatching(repoRoot, (n) => n.endsWith('.csproj'))) return 'code';

  // --- narrative signals ---
  if (
    existsSync(join(repoRoot, 'chapters')) ||
    existsSync(join(repoRoot, 'manuscript'))
  ) return 'narrative';

  // --- business signals ---
  if (
    hasDirEntryMatching(repoRoot, (n) => n.startsWith('pitch-deck')) ||
    hasDirEntryMatching(repoRoot, (n) => n.startsWith('business-plan')) ||
    hasDirEntryMatching(repoRoot, (n) => n.endsWith('.numbers'))
  ) return 'business';

  // --- design signals ---
  if (
    hasDirEntryMatching(repoRoot, (n) => n.startsWith('figma-')) ||
    hasDirEntryMatching(repoRoot, (n) => n.endsWith('.sketch')) ||
    existsSync(join(repoRoot, 'design-system'))
  ) return 'design';

  // --- research signals ---
  if (
    existsSync(join(repoRoot, 'research')) ||
    existsSync(join(repoRoot, 'notebooks')) ||
    hasDirEntryMatching(repoRoot, (n) => n.endsWith('.ipynb'))
  ) return 'research';

  return 'unknown';
}
