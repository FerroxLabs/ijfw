// IJFW seed gate -- "should we materialize on-disk content in this directory?"
//
// Single rule, shared across the whole product: IJFW only writes project
// artifacts (the visible `ijfw/` brain layer, AGENTS.md, CLAUDE.md, the
// codebase index, the `.ijfw/project.type` cold scan) into a directory that is
// actually a project. "A project" means it carries a recognized marker (a VCS
// dir, a language manifest) OR the operator explicitly blessed it with
// `ijfw init` (which drops `.ijfw/project`).
//
// Why this exists: session-start hooks fire on EVERY new chat, including
// throwaway scratch dirs and ephemeral "temporary spaces" (e.g. Wayland). The
// old behavior seeded those unconditionally, so a one-shot `print(7*6)` chat
// littered `ijfw/`, AGENTS.md, and CLAUDE.md into a dir the user never meant to
// keep. Memory recall still works in-session for those dirs -- we just don't
// write anything to disk until the dir proves it's a real project.
//
// This is the JS mirror of the bash `ijfw_should_seed` (seed-gate.sh) and the
// indexer's `ijfw_has_project_marker` (scripts/build-codebase-index.sh). The
// three marker lists are kept identical by a drift test
// (test/brain/test-seed-gate-drift.js). Edit all three together or the test
// fails.

import { existsSync, realpathSync } from 'node:fs';
import { join, dirname, parse as parsePath, sep } from 'node:path';
import { homedir } from 'node:os';

// Canonical project-marker list. MUST stay byte-identical (same set) to the
// bash list in seed-gate.sh and the indexer's ijfw_has_project_marker. The
// `.ijfw/project` entry is the `ijfw init` override.
export const PROJECT_MARKERS = Object.freeze([
  '.git',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'tsconfig.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'deno.json',
  'deno.jsonc',
  'mix.exs',
  'Package.swift',
  'requirements.txt',
  '.hg',
  '.svn',
  '.ijfw/project',
]);

// True when `dir` carries any recognized project marker. Pure existence checks;
// never throws.
export function hasProjectMarker(dir) {
  if (!dir || typeof dir !== 'string') return false;
  for (const m of PROJECT_MARKERS) {
    try {
      // `.ijfw/project` is a nested path; join handles both flat and nested.
      if (existsSync(join(dir, ...m.split('/')))) return true;
    } catch {
      // Unreadable candidate -- treat as absent, keep scanning.
    }
  }
  return false;
}

// Resolve the physical path of a directory, falling back to the input on error
// so callers always get a usable string.
function physOf(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

// The full seed decision: refuse the filesystem root, the home directory, and
// any ancestor of home (the issue #16 privacy hole -- seeding /Users or /home
// would walk every user's home), THEN require a project marker.
//
// Returns true only when `dir` is a real, safe project directory to write into.
export function shouldSeedProject(dir) {
  if (!dir || typeof dir !== 'string') return false;
  const phys = physOf(dir);
  if (!phys || phys === sep) return false;

  // A filesystem/drive root is its own parent (covers POSIX '/' and Windows
  // drive roots like 'C:\\').
  const root = parsePath(phys).root;
  if (phys === root) return false;
  if (dirname(phys) === phys) return false;

  // Refuse the home directory and any ancestor of it. Fail closed when home is
  // unresolvable -- we cannot prove the target isn't home, so do not seed.
  let homePhys;
  try {
    homePhys = realpathSync(homedir());
  } catch {
    homePhys = homedir();
  }
  if (!homePhys) return false;
  if (phys === homePhys) return false;
  // phys is an ancestor of home when home lives under phys/.
  if ((homePhys + sep).startsWith(phys + sep)) return false;

  return hasProjectMarker(phys);
}
