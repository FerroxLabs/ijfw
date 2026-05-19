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

import { basename } from 'node:path';
import { searchCorpus } from './search-bm25.js';

// Build a corpus of line-level docs from the provided projects.
//   projects: [{ path, hash?, iso? }]
//   readProjectMemory(path) -> { knowledge, journal, handoff }  (strings)
// Returns [{ id, text, meta }] where meta carries project + source + lineNo.
export function buildCorpus(projects, readProjectMemory) {
  const docs = [];
  for (const entry of projects) {
    const tag = basename(entry.path);
    const mem = readProjectMemory(entry.path) || {};
    for (const [source, content] of Object.entries(mem)) {
      if (typeof content !== 'string' || content.length === 0) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) continue;
        docs.push({
          id: `${tag}:${source}:${i + 1}`,
          text: line,
          meta: { project: tag, projectPath: entry.path, source, lineNo: i + 1 },
        });
      }
    }
  }
  return docs;
}

// Run a BM25-ranked search across the corpus produced from `projects`.
// Returns [{ content, source, line, project, score, snippet }], capped at limit.
export function crossProjectSearch(query, projects, readProjectMemory, opts = {}) {
  const limit = clamp(opts.limit, 1, 50, 10);
  if (!query || typeof query !== 'string') return [];

  const docs = buildCorpus(projects, readProjectMemory);
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
