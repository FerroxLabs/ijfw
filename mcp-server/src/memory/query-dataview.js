// IJFW v1.5.0 -- Dataview-grade declarative query for memory_entries.
//
// Supported grammar (v1 — intentionally minimal; expand in v1.6+):
//   tag = #path[/sub]*           prefix-matches memory_tags.tag_path
//   linked_to = "target"         matches memory_links.to_target
//   created_after = <unix-secs>  memory_entries.created_at > N
//   created_before = <unix-secs> memory_entries.created_at < N
//
// Multiple filters AND together via case-insensitive " and ".
// Whitespace-tolerant. Unrecognised clauses are silently skipped
// (caller can inspect parsed.filters for __unrecognised entries).

const CLAUSE_AND = /\s+and\s+/i;
const TAG_RE = /^\s*tag\s*=\s*#?([\w/_-]+)\s*$/i;
const LINKED_RE = /^\s*linked_to\s*=\s*"([^"\n]+)"\s*$/i;
const CREATED_AFTER_RE = /^\s*created_after\s*=\s*(\d+)\s*$/i;
const CREATED_BEFORE_RE = /^\s*created_before\s*=\s*(\d+)\s*$/i;

export function parseDataviewQuery(input) {
  const clauses = String(input || '').split(CLAUSE_AND);
  const out = { filters: [] };
  for (const raw of clauses) {
    const c = raw.trim();
    if (!c) continue;
    let m;
    if ((m = c.match(TAG_RE))) {
      out.tag = m[1].toLowerCase().replace(/^\/+|\/+$/g, '');
      continue;
    }
    if ((m = c.match(LINKED_RE))) {
      out.filters.push({ field: 'linked_to', op: '=', value: m[1] });
      continue;
    }
    if ((m = c.match(CREATED_AFTER_RE))) {
      out.filters.push({ field: 'created_after', op: '=', value: Number(m[1]) });
      continue;
    }
    if ((m = c.match(CREATED_BEFORE_RE))) {
      out.filters.push({ field: 'created_before', op: '=', value: Number(m[1]) });
      continue;
    }
    out.filters.push({ field: '__unrecognised', op: '=', value: c });
  }
  return out;
}

export function runDataviewQuery(db, parsed) {
  const where = [];
  const params = [];
  let join = '';
  if (parsed.tag) {
    join += ' JOIN memory_tags t ON t.memory_id = e.id ';
    where.push('(t.tag_path = ? OR t.tag_path LIKE ?)');
    params.push(parsed.tag, `${parsed.tag}/%`);
  }
  for (const f of parsed.filters) {
    switch (f.field) {
      case 'linked_to':
        join += ' JOIN memory_links l ON l.from_id = e.id ';
        where.push('l.to_target = ?');
        params.push(f.value);
        break;
      case 'created_after':
        where.push('e.created_at > ?');
        params.push(f.value);
        break;
      case 'created_before':
        where.push('e.created_at < ?');
        params.push(f.value);
        break;
      default: /* __unrecognised silently skipped */
    }
  }
  // Note: memory_entries (migration 001 schema) has columns:
  // id (INTEGER PK), body, source, session_id, created_at. No title column.
  // memory_links/_tags/_meta store TEXT memory_id — SQLite coerces across
  // the type boundary at JOIN time (SQLite is permissive without strict FKs).
  const sql = `SELECT DISTINCT e.id, e.body, e.source, e.created_at
               FROM memory_entries e ${join}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY e.created_at DESC`;
  const rows = db.prepare(sql).all(...params);
  return { rows, rowCount: rows.length, parsed, sql };
}

export default { parseDataviewQuery, runDataviewQuery };
