// --- project discovery for `ijfw import <tool> --all` ---
//
// Given a source memory store (claude-mem SQLite), this module answers:
//   "Which projects does the store reference, and where do they live on disk?"
//
// Sources consulted:
//   1. claude-mem's own `project` column (authoritative for what to import)
//   2. ~/.claude/projects/ (Claude Code's project directory -- path-encoded)
//   3. Common dev parents: ~/dev, ~/Code, ~/projects, ~/repos, ~/work, ~/src
//
// Output shape (from buildProjectPlan):
//   {
//     source: '/path/to/claude-mem.db',
//     matched:    [{ project, path, entryCount, confidence, evidence }],
//     ambiguous:  [{ project, candidates: [{path, confidence, evidence}], entryCount }],
//     unmatched:  [{ project, entryCount }],
//   }

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const DEV_PARENTS = ['dev', 'Code', 'code', 'projects', 'repos', 'work', 'src'];

// Decode Claude Code's path-encoded project directory name back to an absolute
// path. Example: "-Users-alice-dev-pip" -> "/Users/alice/dev/pip".
// Encoding replaces `/` with `-`. Leading `-` becomes leading `/`.
// Caveat: directories with literal `-` in their name become ambiguous on
// decode; we verify by checking whether the decoded path exists.
export function decodeClaudeProjectDir(name) {
  if (!name || typeof name !== 'string') return null;
  // Leading `-` -> leading `/`. Other `-` -> `/`.
  // We return the most likely decoding (all `-` as `/`). Caller verifies.
  const decoded = '/' + name.replace(/^-+/, '').replace(/-/g, '/');
  return decoded;
}

// Returns a flat list of absolute project paths Claude Code has worked in.
// Only includes paths that still exist on disk.
export function discoverKnownProjectPaths({ home = homedir() } = {}) {
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];
  let entries;
  try { entries = readdirSync(projectsDir); } catch { return []; }
  const paths = [];
  for (const name of entries) {
    const decoded = decodeClaudeProjectDir(name);
    if (!decoded) continue;
    try {
      if (existsSync(decoded) && statSync(decoded).isDirectory()) {
        paths.push(decoded);
      }
    } catch { /* skip */ }
  }
  return paths;
}

// Returns paths like ~/dev/*, ~/Code/*, etc. -- immediate children of common
// dev parents that exist on disk. Helps catch projects Claude Code hasn't
// touched yet.
export function discoverDevParentPaths({ home = homedir() } = {}) {
  const paths = [];
  for (const parent of DEV_PARENTS) {
    const dir = join(home, parent);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      try {
        if (statSync(abs).isDirectory()) paths.push(abs);
      } catch { /* skip */ }
    }
  }
  return paths;
}

// Score how well a claude-mem project name matches a disk path.
// Returns { confidence: 0..1, evidence: string } or null.
//   1.0  -- exact basename match
//   0.9  -- normalized match (lowercase, strip punctuation)
//   0.8  -- normalized prefix/suffix (claude-mem name starts or ends with path basename)
//   0.7  -- contains match (one name contains the other, len >= 4)
//   null -- no match
function scoreMatch(projectName, diskPath) {
  if (!projectName || !diskPath) return null;
  const pn = String(projectName);
  const dn = basename(diskPath);

  if (pn === dn) return { confidence: 1.0, evidence: 'exact basename match' };

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pnN = norm(pn);
  const dnN = norm(dn);
  if (!pnN || !dnN) return null;
  if (pnN === dnN) return { confidence: 0.9, evidence: 'normalized match' };

  if (pnN.startsWith(dnN) || dnN.startsWith(pnN) ||
      pnN.endsWith(dnN) || dnN.endsWith(pnN)) {
    if (Math.min(pnN.length, dnN.length) >= 4) {
      return { confidence: 0.8, evidence: 'normalized prefix/suffix' };
    }
  }

  // Also handle cases where claude-mem stores a full path as project
  // (some claude-mem versions do this).
  if (pn.includes('/') && pn.endsWith('/' + dn)) {
    return { confidence: 1.0, evidence: 'path suffix match' };
  }

  if (pnN.length >= 4 && dnN.length >= 4) {
    if (pnN.includes(dnN) || dnN.includes(pnN)) {
      return { confidence: 0.7, evidence: 'substring match' };
    }
  }

  return null;
}

// Build a candidate list of disk paths for a given claude-mem project name.
// Sorted by confidence descending.
export function matchProjectToPaths(projectName, knownPaths) {
  const matches = [];
  for (const p of knownPaths) {
    const score = scoreMatch(projectName, p);
    if (score) matches.push({ path: p, ...score });
  }
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

// Read distinct project values from claude-mem. Also returns entry counts.
// Returns Map<projectName, count>.
export async function readClaudeMemProjects(dbPath) {
  let sqliteMod;
  try {
    sqliteMod = await import('node:sqlite');
  } catch {
    throw new Error(
      'claude-mem discovery needs Node 22.5+ for built-in SQLite.'
    );
  }
  const { DatabaseSync } = sqliteMod;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Check that the project column exists -- schema varies across versions.
    const cols = db.prepare('PRAGMA table_info(observations)').all();
    const hasProject = cols.some((c) => c.name === 'project');
    if (!hasProject) {
      // No project column -- everything goes to a single "unknown" bucket.
      const total = db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
      return new Map([[null, total]]);
    }
    const rows = db
      .prepare(`SELECT COALESCE(project, '') as project, COUNT(*) as n
                  FROM observations
                  GROUP BY project
                  ORDER BY n DESC`)
      .all();
    const map = new Map();
    for (const r of rows) {
      const key = r.project ? String(r.project) : null;
      map.set(key, r.n);
    }
    return map;
  } finally {
    db.close();
  }
}

// Top-level planner. Returns the full plan for --all mode.
export async function buildProjectPlan({ dbPath, home = homedir() } = {}) {
  const projects = await readClaudeMemProjects(dbPath);
  const knownPaths = [
    ...new Set([
      ...discoverKnownProjectPaths({ home }),
      ...discoverDevParentPaths({ home }),
    ]),
  ];

  const matched = [];
  const ambiguous = [];
  const unmatched = [];

  for (const [projectName, count] of projects.entries()) {
    if (!projectName) {
      unmatched.push({ project: '(no project tag)', entryCount: count });
      continue;
    }
    const candidates = matchProjectToPaths(projectName, knownPaths);
    if (candidates.length === 0) {
      unmatched.push({ project: projectName, entryCount: count });
      continue;
    }
    const top = candidates[0];
    const highConfidence = candidates.filter((c) => c.confidence >= 0.9);
    // Single high-confidence match = auto-matched. Two or more high-confidence
    // matches = ambiguous, ask the user.
    if (highConfidence.length === 1) {
      matched.push({
        project: projectName,
        path: top.path,
        entryCount: count,
        confidence: top.confidence,
        evidence: top.evidence,
      });
    } else if (highConfidence.length > 1) {
      ambiguous.push({
        project: projectName,
        entryCount: count,
        candidates: highConfidence,
      });
    } else {
      // Only low-confidence matches -- treat as ambiguous so user can decide
      // or route to global archive.
      ambiguous.push({
        project: projectName,
        entryCount: count,
        candidates: candidates.slice(0, 3),
      });
    }
  }

  return {
    source: dbPath,
    matched,
    ambiguous,
    unmatched,
    totalEntries: [...projects.values()].reduce((a, b) => a + b, 0),
  };
}

// For tests.
export const _internal = { scoreMatch, decodeClaudeProjectDir };
