// IJFW v1.5.2 -- brain wiki compiler (Trident F-B1 + F-F2 enforcement).
//
// compileWikiPage(db, { repoRoot, type, subject }) renders the page from
// structured facts + history + backlinks + sources, runs the result through
// resolveCitations(), and ATOMICALLY writes (.tmp + rename) only if every
// citation resolves. Returns {ok:false, unresolved[]} when any cite is
// dangling -- this is the hallucination defense.
//
// Wiki path: <ijfw|.ijfw>/wiki/<type>s/<slug>.md per the layout sentinel.
// Slug is the subject lowercased + non-alphanum -> '-'.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrainPaths } from './paths.js';
import { applyTemplate } from './wiki-templates.js';
import { resolveCitations } from './citation-resolver.js';
import { getHistoryWindow } from '../memory/temporal.js';

export function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function pluralType(type) {
  // Templates store under <type>s/ -- e.g. type='entity' -> 'entities'.
  if (type === 'entity') return 'entities';
  if (type === 'concept') return 'concepts';
  if (type === 'decision') return 'decisions';
  if (type === 'milestone') return 'milestones';
  return `${type}s`;
}

function queryFacts(db, subject) {
  try {
    return db.prepare(
      'SELECT id, predicate, object, valid_from, valid_to, memory_id, source, confidence FROM facts WHERE subject = ? AND valid_to IS NULL ORDER BY id DESC'
    ).all(subject);
  } catch { return []; }
}

function queryBacklinks(db, target) {
  try {
    return db.prepare(
      `SELECT to_target AS target, COUNT(*) AS count
       FROM memory_links
       WHERE to_target IS NOT NULL AND to_target = ?
       GROUP BY to_target`
    ).all(target);
  } catch { return []; }
}

function querySources(db, subject) {
  // Top-5 memory entries whose body mentions the subject.
  try {
    const rows = db.prepare(
      `SELECT path, kind, COUNT(*) AS mentions
       FROM memory_entries
       WHERE body LIKE ?
       GROUP BY path, kind
       ORDER BY mentions DESC
       LIMIT 5`
    ).all(`%${subject}%`);
    return rows.map((r) => ({ path: r.path, kind: r.kind, mentions: r.mentions }));
  } catch { return []; }
}

export function compileWikiPage(db, { repoRoot, type, subject } = {}) {
  if (!subject) return { ok: false, error: 'missing-subject' };
  const paths = resolveBrainPaths(repoRoot);
  const slug = slugify(subject);
  const pageDir = join(paths.wikiDir, pluralType(type));
  const pagePath = join(pageDir, `${slug}.md`);

  // F8: per-page advisory lock prevents two concurrent compiles for the
  // same subject from interleaving (both read existing → both render →
  // both rename → operator NOTES from the intermediate state could be
  // lost). EEXIST-based exclusive open is portable + atomic.
  mkdirSync(pageDir, { recursive: true });
  const lockPath = pagePath + '.lock';
  let lockFd;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      return { ok: false, error: 'page-locked-by-concurrent-compile', pagePath };
    }
    throw e;
  }

  try {
    // Read existing AFTER acquiring the lock so we see the freshest committed
    // state (no race with another compile that just landed its rename).
    const existing = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
    const facts = queryFacts(db, subject);
    const history = getHistoryWindow(db, subject, null, { limit: 50 });
    const backlinks = queryBacklinks(db, slug);
    const sources = querySources(db, subject);

    const candidate = applyTemplate(type, existing, { subject, facts, history, backlinks, sources });

    const verdict = resolveCitations(db, candidate);
    if (!verdict.ok) {
      return { ok: false, error: 'unresolved-citations', unresolved: verdict.unresolved, pagePath };
    }

    // Atomic write
    const tmp = pagePath + '.tmp';
    writeFileSync(tmp, candidate);
    renameSync(tmp, pagePath);

    return { ok: true, pagePath, factsCount: facts.length, historyRows: history.rows.length };
  } finally {
    try { closeSync(lockFd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}
