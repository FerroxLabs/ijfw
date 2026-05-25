// IJFW v1.5.2 -- brain promotion suggester.
//
// Walks per-project db paths and surfaces (subject, predicate, object) triples
// that appear across >= minProjects (default 3) projects. Promotion is ALWAYS
// operator-confirmed -- this module only surfaces candidates.

import Database from 'better-sqlite3';

export function suggestPromotions({ projectDbs, minProjects = 3 } = {}) {
  if (!Array.isArray(projectDbs) || projectDbs.length === 0) return [];
  const tally = new Map();
  for (const entry of projectDbs) {
    const { name, dbPath } = entry;
    let db;
    try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
    catch { continue; }
    try {
      const rows = db.prepare(`
        SELECT DISTINCT subject, predicate, object
        FROM facts
        WHERE valid_to IS NULL
      `).all();
      for (const r of rows) {
        const key = `${r.subject || ''}|${r.predicate || ''}|${r.object || ''}`;
        if (!tally.has(key)) tally.set(key, new Set());
        tally.get(key).add(name);
      }
    } finally { try { db.close(); } catch {} }
  }
  const out = [];
  for (const [key, projects] of tally) {
    if (projects.size < minProjects) continue;
    const [subject, predicate, object] = key.split('|');
    out.push({
      subject, predicate, object,
      projects: [...projects].sort(),
      confidence: projects.size >= 5 ? 'high' : 'medium',
    });
  }
  return out.sort((a, b) => b.projects.length - a.projects.length);
}
