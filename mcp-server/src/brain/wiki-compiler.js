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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// V155-054 (LOW): a poisoned wiki page on disk could blow up memory during
// compile via the existing-page readFileSync. Refuse compile if the prior
// page is larger than this cap.
const WIKI_PAGE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

import { resolveBrainPaths } from './paths.js';
import { applyTemplate } from './wiki-templates.js';
import { resolveCitations } from './citation-resolver.js';
import { getHistoryWindow } from '../memory/temporal.js';
import { validateSafeRepoPath } from './path-guard.js';
import { withFsLock, lockPathFor } from '../fs-lock.js';

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

export async function compileWikiPage(db, { repoRoot, type, subject } = {}) {
  if (!subject) return { ok: false, error: 'missing-subject' };
  const paths = resolveBrainPaths(repoRoot);
  const slug = slugify(subject);
  const pageDir = join(paths.wikiDir, pluralType(type));
  const pagePath = join(pageDir, `${slug}.md`);

  // F-LENS2-05: enforce containment + reserved-name on the compile target.
  // A symlinked wiki dir or a maliciously-crafted subject (slugify removes
  // most danger, but defense-in-depth) could otherwise direct the atomic
  // rename outside the repo. mkdirSync(pageDir,…) below runs only if guard
  // passes so we never even create a parent directory outside repoRoot.
  const guard = validateSafeRepoPath(repoRoot, pagePath);
  if (!guard.ok) return guard;

  mkdirSync(pageDir, { recursive: true });

  // V155-015 (HIGH): per-page advisory lock now uses the canonical
  // `withFsLock` primitive instead of an isolated openSync('wx') + manual
  // stale recovery. The prior pattern had a stale-reclaim race — process A
  // holds lock, B reads mtime >60s, B unlinks A's lockfile, B opens its own
  // lock, BOTH then rename their .tmp into pagePath. `withFsLock` inherits
  // heartbeat-refresh (`heartbeatMs` < `staleMs`) so a live A always renews
  // before B's stale check fires; a crashed A's lock still ages out cleanly.
  // The wiki-page lock sorts to LOCK_TIERS' tier-99 fallback (unknown path
  // → tail of canonical order), so it never deadlocks against §3 locks.
  return withFsLock(lockPathFor(pagePath), async () => {
    // Read existing AFTER acquiring the lock so we see the freshest committed
    // state (no race with another compile that just landed its rename).
    let existing = '';
    if (existsSync(pagePath)) {
      // V155-054 (LOW): cap the existing-page size to defend against a
      // poisoned wiki page that would otherwise blow up memory + LLM budget
      // during compile. 2 MB is generous — real wiki pages are <100 KB.
      try {
        const st = statSync(pagePath);
        if (st.size > WIKI_PAGE_MAX_BYTES) {
          return {
            ok: false, error: 'page-too-large', pagePath,
            sizeBytes: st.size, maxBytes: WIKI_PAGE_MAX_BYTES,
          };
        }
      } catch { /* statSync race — proceed with read */ }
      existing = readFileSync(pagePath, 'utf8');
    }
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
  });
}
