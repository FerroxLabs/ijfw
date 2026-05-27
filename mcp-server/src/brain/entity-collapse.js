// IJFW v1.5.2 -- brain entity collapse.
//
// canonicalize(s): lowercase + collapsed-whitespace + trim. findCandidateMerges(db)
// surfaces groups of distinct stored subject strings that normalize to the same
// form (e.g. "Jane Doe" / "jane doe" / " Jane  Doe " all collapse
// to "jane doe"). Promotion (actual merge) is operator-confirmed -- this
// module only surfaces candidates.

export function canonicalize(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/\s+/g, ' ');
}

export function findCandidateMerges(db) {
  const rows = db.prepare('SELECT DISTINCT subject FROM facts').all();
  const groups = new Map();
  for (const { subject } of rows) {
    if (subject == null) continue;
    const c = canonicalize(subject);
    if (!c) continue;
    if (!groups.has(c)) groups.set(c, new Set());
    groups.get(c).add(subject);
  }
  const out = [];
  for (const [canonical, set] of groups) {
    if (set.size > 1) out.push({ canonical, variants: [...set].sort() });
  }
  return out.sort((a, b) => a.canonical.localeCompare(b.canonical));
}
