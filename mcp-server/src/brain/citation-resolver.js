// IJFW v1.5.2 -- brain citation resolver (Trident F-B1).
//
// Parses [mem:N] / [fact:N] tokens from markdown candidate pages produced
// by the wiki compiler. Resolves each id against the live db. The compiler
// rejects the whole page if ANY citation is unresolved -- prevents the LLM
// from inventing plausible citation ids that don't actually exist.

const CITE_RE = /\[(mem|fact):(\d+)\]/g;

export function parseCitations(md) {
  if (typeof md !== 'string') return [];
  const out = [];
  for (const m of md.matchAll(CITE_RE)) {
    out.push({ kind: m[1], id: parseInt(m[2], 10) });
  }
  return out;
}

export function resolveCitations(db, md) {
  const cites = parseCitations(md);
  if (cites.length === 0) return { ok: true, cites: [], unresolved: [] };
  const memIds = [...new Set(cites.filter((c) => c.kind === 'mem').map((c) => c.id))];
  const factIds = [...new Set(cites.filter((c) => c.kind === 'fact').map((c) => c.id))];
  const memPresent = new Set();
  if (memIds.length > 0) {
    const placeholders = memIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id FROM memory_entries WHERE id IN (${placeholders})`).all(...memIds);
    for (const r of rows) memPresent.add(r.id);
  }
  const factPresent = new Set();
  if (factIds.length > 0) {
    const placeholders = factIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id FROM facts WHERE id IN (${placeholders})`).all(...factIds);
    for (const r of rows) factPresent.add(r.id);
  }
  const unresolved = cites.filter((c) =>
    (c.kind === 'mem' && !memPresent.has(c.id)) ||
    (c.kind === 'fact' && !factPresent.has(c.id))
  );
  return { ok: unresolved.length === 0, cites, unresolved };
}
