// IJFW v1.5.2 -- brain context injection (wiki -> prelude).
//
// buildContextInjection(repoRoot, {mode, topN, charBudget}) returns a wrapped
// markdown block containing the top-N most-recently-touched wiki pages
// truncated per charBudget. Empty string when mode='never' (the default) or
// when no wiki pages exist.
//
// Wired into handlePrelude (server.js) when env.IJFW_BRAIN_INJECT === 'auto'
// | 'always'. Best-effort: never breaks prelude on failure.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrainPaths } from './paths.js';

const WIKI_TYPES = ['concepts', 'entities', 'decisions', 'milestones'];
const DEFAULT_TOP_N = 3;
const DEFAULT_CHAR_BUDGET = 600;

function listWikiPages(wikiDir) {
  const out = [];
  for (const t of WIKI_TYPES) {
    const typeDir = join(wikiDir, t);
    if (!existsSync(typeDir)) continue;
    let entries;
    try { entries = readdirSync(typeDir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const p = join(typeDir, name);
      try {
        const s = statSync(p);
        out.push({ path: p, mtimeMs: s.mtimeMs, type: t, slug: name.replace(/\.md$/, '') });
      } catch { /* skip unreadable */ }
    }
  }
  return out;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > max * 0.7) return slice.slice(0, lastSpace) + '...';
  return slice + '...';
}

export function buildContextInjection(repoRoot, { mode = 'auto', topN = DEFAULT_TOP_N, charBudget = DEFAULT_CHAR_BUDGET } = {}) {
  if (mode === 'never') return '';
  const paths = resolveBrainPaths(repoRoot);
  const pages = listWikiPages(paths.wikiDir);
  if (pages.length === 0) return '';
  pages.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = pages.slice(0, topN);
  const blocks = [];
  for (const page of top) {
    let body;
    try { body = readFileSync(page.path, 'utf8'); } catch { continue; }
    blocks.push(`### ${page.type}/${page.slug}\n\n${truncate(body, charBudget)}`);
  }
  if (blocks.length === 0) return '';
  return `\n\n--- Recently relevant from your brain ---\n\n${blocks.join('\n\n')}\n\n--- end brain context ---\n`;
}
