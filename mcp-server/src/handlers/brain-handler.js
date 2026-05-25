// IJFW v1.5.2 -- brain MCP verb dispatcher.
//
// handleIjfwBrain({ verb, args, db, repoRoot }) routes the 4 Plan-A brain
// verbs that live inside the 13/13-capped MCP tool set.  All four verbs are
// folded into existing tools (ijfw_memory_recall for think/links, ijfw_wiki
// for wiki.*, ijfw_conflict_resolve for conflict.*) -- this module is the
// pure-logic layer that can be unit/integration-tested without the MCP
// transport layer.
//
// Verbs implemented here:
//   wiki.get          -- read a compiled wiki page by slug
//   wiki.compile      -- force-compile a wiki page for a given subject/type
//   conflict.resolve  -- close superseded facts, declare a winner

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrainPaths } from '../brain/paths.js';
import { compileWikiPage, slugify } from '../brain/wiki-compiler.js';

// --------------------------------------------------------------------------
// wiki.get
// --------------------------------------------------------------------------
function handleWikiGet({ args, db, repoRoot }) {
  const { slug, type = 'entity' } = args || {};
  if (!slug) return { ok: false, error: 'missing-slug' };
  const paths = resolveBrainPaths(repoRoot);
  const pluralMap = { entity: 'entities', concept: 'concepts', decision: 'decisions', milestone: 'milestones' };
  const dir = pluralMap[type] ?? `${type}s`;
  const pagePath = join(paths.wikiDir, dir, `${slug}.md`);
  if (!existsSync(pagePath)) return { ok: false, error: 'not-found', slug };
  const markdown = readFileSync(pagePath, 'utf8');
  return { ok: true, slug, type, markdown, pagePath };
}

// --------------------------------------------------------------------------
// wiki.compile
// --------------------------------------------------------------------------
function handleWikiCompile({ args, db, repoRoot }) {
  const { subject, type = 'entity' } = args || {};
  if (!subject) return { ok: false, error: 'missing-subject' };
  return compileWikiPage(db, { repoRoot, type, subject });
}

// --------------------------------------------------------------------------
// conflict.resolve
// --------------------------------------------------------------------------
// Closes all (subject, predicate) rows whose id !== winnerId by setting
// valid_to = now.  Returns { ok, winnerId, supersededIds }.
function handleConflictResolve({ args, db }) {
  const { subject, predicate, winnerId } = args || {};
  if (!subject || !predicate || winnerId == null) {
    return { ok: false, error: 'missing-args' };
  }
  let rows;
  try {
    rows = db.prepare(
      'SELECT id FROM facts WHERE subject = ? AND predicate = ? AND valid_to IS NULL AND id != ?'
    ).all(subject, predicate, winnerId);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (rows.length === 0) return { ok: true, winnerId, supersededIds: [] };
  const now = new Date().toISOString();
  const update = db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?');
  const txn = db.transaction((ids) => { for (const id of ids) update.run(now, id); });
  txn(rows.map((r) => r.id));
  return { ok: true, winnerId, supersededIds: rows.map((r) => r.id) };
}

// --------------------------------------------------------------------------
// Public dispatcher
// --------------------------------------------------------------------------
export async function handleIjfwBrain({ verb, args, db, repoRoot } = {}) {
  switch (verb) {
    case 'wiki.get':     return handleWikiGet({ args, db, repoRoot });
    case 'wiki.compile': return handleWikiCompile({ args, db, repoRoot });
    case 'conflict.resolve': return handleConflictResolve({ args, db });
    default: return { ok: false, error: `unknown-verb:${verb}` };
  }
}
