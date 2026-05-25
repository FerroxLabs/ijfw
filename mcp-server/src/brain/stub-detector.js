// IJFW v1.5.2 -- brain stub detector.
//
// A "stub" is a wikilink target with N+ incoming references but no actual
// wiki page at ijfw/wiki/<type>s/<slug>.md. Surfaces gaps the operator may
// want to fill. Checks both visible ijfw/ and legacy .ijfw/ paths during
// the v1->v2 transition.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WIKI_TYPES = ['concepts', 'entities', 'decisions', 'milestones'];

function pageExistsAnywhere(repoRoot, target) {
  for (const t of WIKI_TYPES) {
    if (existsSync(join(repoRoot, 'ijfw', 'wiki', t, `${target}.md`))) return true;
    if (existsSync(join(repoRoot, '.ijfw', 'wiki', t, `${target}.md`))) return true;
  }
  return false;
}

export function detectStubs(db, repoRoot, { minIncomingLinks = 3 } = {}) {
  const rows = db.prepare(`
    SELECT to_target AS target, COUNT(*) AS incomingLinks
    FROM memory_links
    WHERE to_target IS NOT NULL AND to_target != ''
    GROUP BY to_target
    HAVING COUNT(*) >= ?
  `).all(minIncomingLinks);
  return rows
    .filter((r) => !pageExistsAnywhere(repoRoot, r.target))
    .map((r) => ({ target: r.target, incomingLinks: r.incomingLinks }))
    .sort((a, b) => b.incomingLinks - a.incomingLinks);
}
