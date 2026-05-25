/**
 * Memory reader -- unified 5-tier reader.
 * Tier 1: Claude auto-memory  ~/.claude/projects/<slug>/memory/**\/*.md
 * Tier 2: Project .ijfw/memory  <cwd>/.ijfw/memory/**\/*.md
 * Tier 3: Session records  <cwd>/.ijfw/sessions/*.md
 * Tier 4: Global observations  ~/.ijfw/observations.jsonl (summarized)
 * Tier 5: Global handoff  ~/.ijfw/HANDOFF.md if exists
 *
 * Each file gets a `tier` field: "Auto-memory" / "Project" / "Sessions" / "Global" / "Handoff"
 * Zero deps: node:fs, node:path, node:os only.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { homedir } from 'node:os';

const HOME         = homedir();
const IJFW_DIR     = join(HOME, '.ijfw');
const CLAUDE_PROJS = join(HOME, '.claude', 'projects');
const PREVIEW_CHARS = 300;

/** Parse YAML-style frontmatter (key: value lines between --- fences). */
function parseFrontmatter(raw) {
  const fm = { title: null, description: null, type: null };
  const stripped = String(raw).replace(/^﻿/, '').replace(/^\s+/, '');
  const m  = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return fm;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key === 'title')       fm.title       = kv[2].trim();
    if (key === 'description') fm.description = kv[2].trim();
    if (key === 'type')        fm.type        = kv[2].trim();
  }
  return fm;
}

/** Walk dir recursively collecting .md files, max depth 4. */
function walkMd(dir, base, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const results = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...walkMd(full, base, depth + 1));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      results.push({ full, rel: relative(base, full) });
    }
  }
  return results;
}

/** Build a file entry from a path + tier label. */
function buildEntry(full, rel, tier) {
  try {
    const st  = statSync(full);
    const raw = readFileSync(full, 'utf8');
    const fm  = parseFrontmatter(raw);

    let title = fm.title;
    if (!title) {
      const hm = raw.match(/^#\s+(.+)/m);
      title = hm ? hm[1].trim() : basename(full, '.md');
    }

    const body    = raw.replace(/^---[\s\S]*?---\r?\n/, '').trimStart();
    const preview = body.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();

    return {
      path: full,
      relpath: rel,
      title,
      description: fm.description || null,
      type: fm.type || null,
      preview,
      last_modified: st.mtimeMs,
      size: st.size,
      tier,
    };
  } catch {
    return null;
  }
}

/** Map a project dir path to its Claude project slug. */
function pathToSlug(projectPath) {
  // Claude uses the absolute path with / replaced by -. On Windows the path
  // is C:\\Users\\... -- strip the drive letter and replace both separator
  // styles so the slug is a flat dir name that round-trips with mkdirSync.
  return projectPath.replace(/^[A-Z]:/i, '').replace(/[\\/]/g, '-');
}

/** Find the Claude project slug for a repo root by matching path-based slug. */
function findClaudeSlug(repoRoot) {
  if (!repoRoot || !existsSync(CLAUDE_PROJS)) return null;
  const slug = pathToSlug(repoRoot);
  const candidate = join(CLAUDE_PROJS, slug);
  if (existsSync(candidate)) return slug;
  // Try reading all slugs for a suffix match
  try {
    const slugs = readdirSync(CLAUDE_PROJS, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    // Match by resolved path suffix
    const normalized = repoRoot.replace(/\/$/, '');
    for (const s of slugs) {
      if (normalized.endsWith(s.replace(/-/g, '/').replace(/^\//, ''))) return s;
    }
    return slugs.find(s => s === slug) || null;
  } catch {
    return null;
  }
}

/**
 * Tier 1: Claude auto-memory files for the current project.
 */
function readTier1(repoRoot) {
  const slug = findClaudeSlug(repoRoot);
  if (!slug) return [];
  const memDir = join(CLAUDE_PROJS, slug, 'memory');
  if (!existsSync(memDir)) return [];
  return walkMd(memDir, memDir)
    .map(({ full, rel }) => buildEntry(full, rel, 'Auto-memory'))
    .filter(Boolean);
}

/**
 * Tier 2: Project .ijfw/memory files.
 * Reads both ~/.ijfw/memory (global project memory) and <repoRoot>/.ijfw/memory.
 */
function readTier2(repoRoot) {
  const dirs = [];
  if (repoRoot) dirs.push(join(repoRoot, '.ijfw', 'memory'));
  const globalMem = join(IJFW_DIR, 'memory');
  if (existsSync(globalMem)) dirs.push(globalMem);

  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const entries = walkMd(dir, dir)
      .map(({ full, rel }) => buildEntry(full, rel, 'Project'))
      .filter(Boolean);
    // Deduplicate by path
    for (const e of entries) {
      if (!files.find(f => f.path === e.path)) files.push(e);
    }
  }
  return files;
}

/**
 * Tier 3: Session records -- .md files in <repoRoot>/.ijfw/sessions/.
 */
function readTier3(repoRoot) {
  if (!repoRoot) return [];
  const sessDir = join(repoRoot, '.ijfw', 'sessions');
  if (!existsSync(sessDir)) return [];
  return walkMd(sessDir, sessDir)
    .map(({ full, rel }) => buildEntry(full, rel, 'Sessions'))
    .filter(Boolean);
}

/**
 * Tier 4: Global observations -- summarizes ~/.ijfw/observations.jsonl.
 * Returns synthetic entries grouped by platform.
 */
function readTier4() {
  const obsPath = join(IJFW_DIR, 'observations.jsonl');
  if (!existsSync(obsPath)) return [];
  try {
    const lines = readFileSync(obsPath, 'utf8').split('\n').filter(Boolean);
    const total = lines.length;
    if (!total) return [];
    const st = statSync(obsPath);
    // Count by platform for recall counts
    const platformCounts = {};
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const p = obj.platform || 'unknown';
        platformCounts[p] = (platformCounts[p] || 0) + 1;
      } catch {}
    }
    const platformSummary = Object.entries(platformCounts)
      .map(([p, c]) => `${p}: ${c}`)
      .join(', ');
    return [{
      path: obsPath,
      relpath: 'observations.jsonl',
      title: `Global observations (${total} events)`,
      description: platformSummary || null,
      type: 'observations',
      preview: `${total} observation events across ${Object.keys(platformCounts).length} platforms. ${platformSummary}`,
      last_modified: st.mtimeMs,
      size: st.size,
      tier: 'Global',
      count: total,
    }];
  } catch {
    return [];
  }
}

/**
 * Tier 5: Global HANDOFF.md.
 */
function readTier5() {
  const handoffPath = join(IJFW_DIR, 'HANDOFF.md');
  if (!existsSync(handoffPath)) return [];
  const entry = buildEntry(handoffPath, 'HANDOFF.md', 'Handoff');
  return entry ? [entry] : [];
}

/**
 * List all memory files across all 5 tiers.
 * @param {string|null} repoRoot
 * @param {string|null} tierFilter - filter to one tier label (optional)
 * @returns {{ files: Array, total: number, root: string|null, tiers: Object }}
 */
export function listMemoryFiles(repoRoot, tierFilter = null) {
  const t1 = readTier1(repoRoot);
  const t2 = readTier2(repoRoot);
  const t3 = readTier3(repoRoot);
  const t4 = readTier4();
  const t5 = readTier5();

  const all = [...t1, ...t2, ...t3, ...t4, ...t5];

  // Compute per-tier counts before filtering
  const tiers = {
    'Auto-memory': t1.length,
    'Project':     t2.length,
    'Sessions':    t3.length,
    'Global':      t4.length,
    'Handoff':     t5.length,
  };

  let files = all;
  if (tierFilter) {
    files = all.filter(f => f.tier === tierFilter);
  }

  // Sort by most recently modified within each tier grouping
  files.sort((a, b) => b.last_modified - a.last_modified);

  // Use the first non-null path as the security root for /api/memory/file
  const root = repoRoot || IJFW_DIR;

  return { files, total: files.length, root, tiers };
}

/** List all known projects by scanning ~/.claude/projects/. */
export function listKnownProjects() {
  if (!existsSync(CLAUDE_PROJS)) return [];
  try {
    const entries = readdirSync(CLAUDE_PROJS, { withFileTypes: true })
      .filter(e => e.isDirectory());
    return entries.map(e => {
      const slug = e.name;
      const memDir = join(CLAUDE_PROJS, slug, 'memory');
      let lastActivity = null;
      let memCount = 0;
      try {
        const st = statSync(join(CLAUDE_PROJS, slug));
        lastActivity = new Date(st.mtimeMs).toISOString();
      } catch {}
      if (existsSync(memDir)) {
        try { memCount = readdirSync(memDir).filter(n => n.endsWith('.md')).length; } catch {}
      }
      // Convert slug back to path (best-effort)
      const projectPath = slug.replace(/-/g, '/').replace(/^\//, '/');
      return { slug, projectPath, lastActivity, memCount };
    }).sort((a, b) => (b.lastActivity || '') > (a.lastActivity || '') ? 1 : -1);
  } catch {
    return [];
  }
}

/** Resolve a "legacy" single-root for backward compat with /api/memory/file security check. */
export function resolveMemoryRoot(repoRoot) {
  if (repoRoot) {
    const local = join(repoRoot, '.ijfw', 'memory');
    if (existsSync(local)) return local;
  }
  const global = join(IJFW_DIR, 'memory');
  if (existsSync(global)) return global;
  return null;
}

/** Read raw body of a single memory file. Returns null if unreadable. */
export function readMemoryFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
