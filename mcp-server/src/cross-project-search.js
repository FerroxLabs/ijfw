// --- cross-project-search: BM25 search across every registered IJFW project ---
//
// Canonical cross-project search surface. The legacy naive-keyword-count
// `searchAcrossProjects` in server.js was removed in v1.5.1 H1.5 (audit
// finding memory-engine.md F-FUN-4) — `scope:'all'` on the MCP search tool
// now routes here. Builds a corpus of (project, source, line) docs from each
// registered project's memory files, hands it to the BM25 ranker in
// search-bm25.js, and returns hits tagged with [project:<basename>].
//
// Pure + injectable. The caller supplies the registry reader and the
// per-project memory reader so this module can be unit-tested without
// touching the home directory.
//
// v1.5.0 audit-H3.4 (memory-engine.md F-SEC-1): registry entries are
// treated as UNTRUSTED. Each entry.path is:
//   1. realpath-resolved (symlinks resolved against the filesystem)
//   2. containment-checked against `allowedRoots` (default: $HOME)
//   3. silently skipped if it escapes the allowed roots OR fails realpath
//   4. logged to stderr ONCE per unique offending raw-path (Set dedup)
// Threat model: a compromised dep / malicious project that writes a
// registry entry pointing at /etc/passwd via a symlink in the user's
// home directory will be caught by step 1+2. Plain `isAbsolute()` was
// the only prior validation and was insufficient.

import { basename, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { searchCorpus } from './search-bm25.js';

// Module-level dedup set for "skipped offender" stderr noise control.
// Keyed by the raw entry.path (the attacker-controlled string) so the same
// malicious entry is reported only once per process lifetime. Exported for
// test reset via `_resetSkipLog()`.
const SKIP_LOG = new Set();

/** Reset the skip-log dedup set. Test-only. */
export function _resetSkipLog() {
  SKIP_LOG.clear();
}

/** Default allowed roots: just the user's home directory.
 *  Tests can pass `opts.allowedRoots` to constrain or widen.
 *  Returned as resolved (realpath'd) absolute paths so containment
 *  comparison is apples-to-apples with the realpath'd entry. */
function defaultAllowedRoots() {
  const roots = [];
  try {
    const home = homedir();
    if (home && typeof home === 'string') {
      // realpath the root itself so /var/root on macOS resolves to
      // /private/var/root (same canonicalization as the entry side).
      try { roots.push(realpathSync(home)); } catch { roots.push(resolve(home)); }
    }
  } catch { /* ignore */ }
  return roots;
}

/** True iff `child` is `root` or a path nested under `root`.
 *  Both inputs are expected to be already-canonical absolute paths.
 *  We compare with a trailing-separator guard so `/home/alice-evil`
 *  is NOT considered inside `/home/alice`. */
function isUnder(child, root) {
  if (!child || !root) return false;
  if (child === root) return true;
  // Use both POSIX and Windows separators defensively. Path normalization
  // has already happened via realpathSync; we just need the boundary check.
  const withPosixSep   = root.endsWith('/')  ? root : root + '/';
  const withWindowsSep = root.endsWith('\\') ? root : root + '\\';
  return child.startsWith(withPosixSep) || child.startsWith(withWindowsSep);
}

/** Resolve + containment check.
 *  Returns the canonical path on success, or null if the entry must be
 *  skipped. On skip, logs to stderr once per unique raw path. */
function safeResolveProjectPath(rawPath, allowedRoots) {
  if (!rawPath || typeof rawPath !== 'string') {
    return _skip(rawPath, 'not-a-string');
  }
  let canonical;
  try {
    // realpathSync resolves symlinks. If the entry points to a symlink
    // chain whose target escapes allowedRoots, this is where we catch it.
    canonical = realpathSync(rawPath);
  } catch {
    // ENOENT / EACCES / ELOOP — entry path doesn't exist or is unreadable.
    // Graceful skip; don't throw (a stale registry shouldn't crash search).
    return _skip(rawPath, 'realpath-failed');
  }
  if (!allowedRoots.some(root => isUnder(canonical, root))) {
    return _skip(rawPath, `escapes-allowed-roots (realpath=${canonical})`);
  }
  return canonical;
}

function _skip(rawPath, reason) {
  const key = String(rawPath || '<null>');
  if (!SKIP_LOG.has(key)) {
    SKIP_LOG.add(key);
    try {
      // Single-line, stderr-only — same posture as the rest of the engine's
      // advisory warnings. Production callers (Claude Code) capture stderr
      // and surface in the dashboard's diagnostics tab.
      process.stderr.write(
        `[ijfw cross-project-search] skipped registry entry: ${reason}: ${key}\n`
      );
    } catch { /* never let a logging failure break search */ }
  }
  return null;
}

// Build a corpus of line-level docs from the provided projects.
//   projects: [{ path, hash?, iso? }]
//   readProjectMemory(path) -> { knowledge, journal, handoff }  (strings)
//   opts.allowedRoots: optional array of canonical absolute roots; entries
//                      whose realpath escapes ALL of them are skipped.
//                      Default: [realpath(homedir())].
// Returns [{ id, text, meta }] where meta carries project + source + lineNo.
export function buildCorpus(projects, readProjectMemory, opts = {}) {
  const allowedRoots = Array.isArray(opts.allowedRoots) && opts.allowedRoots.length
    ? opts.allowedRoots
    : defaultAllowedRoots();
  const docs = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object') continue;
    const canonical = safeResolveProjectPath(entry.path, allowedRoots);
    if (canonical === null) continue;  // skipped (symlink-escape or missing)
    const tag = basename(canonical);
    // Pass the CANONICAL path to the reader, not the raw one — so a reader
    // that joins with `.ijfw/memory/...` walks the canonical tree, not a
    // possibly-spoofed symlink chain.
    const mem = readProjectMemory(canonical) || {};
    for (const [source, content] of Object.entries(mem)) {
      if (typeof content !== 'string' || content.length === 0) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) continue;
        docs.push({
          id: `${tag}:${source}:${i + 1}`,
          text: line,
          meta: { project: tag, projectPath: canonical, source, lineNo: i + 1 },
        });
      }
    }
  }
  return docs;
}

// Run a BM25-ranked search across the corpus produced from `projects`.
// Returns [{ content, source, line, project, score, snippet }], capped at limit.
//   opts.allowedRoots: forwarded to buildCorpus (see above).
//   opts.limit: 1..50, default 10.
export function crossProjectSearch(query, projects, readProjectMemory, opts = {}) {
  const limit = clamp(opts.limit, 1, 50, 10);
  if (!query || typeof query !== 'string') return [];

  const docs = buildCorpus(projects, readProjectMemory, opts);
  if (docs.length === 0) return [];

  const hits = searchCorpus(query, docs, { limit });
  return hits.map((h) => ({
    content: `[project:${h.meta.project}] ${h.snippet || ''}`.trim(),
    source: `${h.meta.source}@${h.meta.project}`,
    project: h.meta.project,
    projectPath: h.meta.projectPath,
    line: h.meta.lineNo,
    score: Math.round(h.score * 1000) / 1000,
    snippet: h.snippet,
  }));
}

function clamp(n, lo, hi, dflt) {
  const v = Number.isFinite(n) ? n | 0 : dflt;
  return Math.min(hi, Math.max(lo, v));
}

// Render a portfolio-findings markdown doc from per-project audit results.
//   results: [{ project, path, status, findings, error? }]
//     status: 'ok' | 'failed' | 'skipped'
//     findings: free-form string (per-project audit stdout)
// Returns a markdown body. Section per project, summary table on top.
export function aggregatePortfolioFindings(results, { rule, startedAt, finishedAt } = {}) {
  const total  = results.length;
  const okN    = results.filter(r => r.status === 'ok').length;
  const failN  = results.filter(r => r.status === 'failed').length;
  const skipN  = results.filter(r => r.status === 'skipped').length;

  const head = [
    `# Portfolio audit -- ${rule || '(rule unspecified)'}`,
    '',
    `- Projects audited: ${okN} / ${total}  (failed: ${failN}, skipped: ${skipN})`,
    startedAt  ? `- Started:  ${startedAt}`  : null,
    finishedAt ? `- Finished: ${finishedAt}` : null,
    '',
    '## Summary',
    '',
    '| Project | Status | Notes |',
    '|---------|--------|-------|',
    ...results.map(r => `| ${r.project} | ${r.status} | ${(r.error || firstLine(r.findings) || '').replace(/\|/g, '\\|')} |`),
    '',
    '## Per-project findings',
    '',
  ].filter(Boolean);

  const bodies = results.map(r => [
    `### ${r.project}  (${r.path})`,
    '',
    `**Status:** ${r.status}`,
    r.error ? `**Error:** ${r.error}` : null,
    '',
    '```',
    (r.findings || '(no output)').trim(),
    '```',
    '',
  ].filter(Boolean).join('\n'));

  return head.join('\n') + bodies.join('\n');
}

function firstLine(s) {
  if (!s) return '';
  const idx = s.indexOf('\n');
  return idx < 0 ? s.trim() : s.slice(0, idx).trim();
}
