// IJFW v1.5.0 -- Obsidian-grade markdown extractor.
//
// Pulls three structured signals out of memory body text:
//   1. [[wikilinks]]            -> links: [{ target, line }]
//   2. #nested/tags             -> tags:  [{ path, depth }]
//   3. [key:: value] (Dataview) -> meta:  [{ key, value }]
//
// Code fences and inline-code spans are masked before extraction so that
// example syntax never produces fake edges. DB writes happen in
// indexObsidianRelations (idempotent re-index: clears prior rows for the
// memory id before re-inserting).

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
// eslint-disable-next-line security/detect-unsafe-regex -- parses developer-authored markdown notes on local disk; negated [^\]\n] classes bound match to one line per token
const WIKILINK_RE = /\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
const TAG_RE = /(?:^|[^\w&])#([\w/-]+)/g;
const META_RE = /\[([A-Za-z_][\w-]*)::\s*([^\]\n]+?)\]/g;

function maskCode(text) {
  return text
    .replace(FENCE_RE, (m) => ' '.repeat(m.length))
    .replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length));
}

function lineOf(masked, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (masked.charCodeAt(i) === 10) line++;
  return line;
}

function normaliseLinkTarget(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9/_-]/g, '');
}

export function parseObsidian(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { links: [], tags: [], meta: [] };
  }
  const masked = maskCode(text);

  const links = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = normaliseLinkTarget(m[1]);
    if (target) links.push({ target, line: lineOf(masked, m.index) });
  }

  const tagSet = new Map();
  for (const m of masked.matchAll(TAG_RE)) {
    const path = m[1].toLowerCase().replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    const depth = path.split('/').length;
    if (!tagSet.has(path)) tagSet.set(path, { path, depth });
  }

  const meta = [];
  for (const m of masked.matchAll(META_RE)) {
    meta.push({ key: m[1].toLowerCase(), value: m[2].trim() });
  }

  return { links, tags: [...tagSet.values()], meta };
}

export function indexObsidianRelations(db, memoryId, text) {
  const parsed = parseObsidian(text);
  const insLink = db.prepare(
    'INSERT OR IGNORE INTO memory_links (from_id, to_target, line) VALUES (?, ?, ?)',
  );
  const insTag = db.prepare(
    'INSERT OR IGNORE INTO memory_tags (memory_id, tag_path, depth) VALUES (?, ?, ?)',
  );
  const insMeta = db.prepare(
    'INSERT OR IGNORE INTO memory_meta (memory_id, key, value) VALUES (?, ?, ?)',
  );
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM memory_links WHERE from_id=?').run(memoryId);
    db.prepare('DELETE FROM memory_tags WHERE memory_id=?').run(memoryId);
    db.prepare('DELETE FROM memory_meta WHERE memory_id=?').run(memoryId);
    for (const l of parsed.links) insLink.run(memoryId, l.target, l.line);
    for (const t of parsed.tags) insTag.run(memoryId, t.path, t.depth);
    for (const m of parsed.meta) insMeta.run(memoryId, m.key, m.value);
  });
  tx();
  return parsed;
}

// v1.5.1 R5-1.2 -- one-time M1 backfill for memory written during v1.5.0,
// when indexObsidianRelations was NOT wired into the production write path.
// Round-4 Fix-1 (commit 3218812) wired M1+M2 into handleStore/autoIndex but
// forward-only: rows already in memory_entries have empty memory_links /
// memory_tags / memory_meta. This walks EVERY row and re-runs M1 over it.
//
// Safe to run over everything:
//   - free      -- pure markdown parse, zero LLM / network
//   - idempotent-- indexObsidianRelations clears prior aux rows per id before
//                  re-inserting, so a re-run produces identical state
//
// The walk reads ids in batches so a very large memory_entries doesn't pin
// the whole table in memory; each row's indexObsidianRelations call carries
// its own transaction (DELETE-then-INSERT) so a single bad row never aborts
// the rest of the backfill.
//
// Returns { rows, links, tags, meta } -- counts re-indexed across the run.
export function backfillObsidianIndex(db, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('backfillObsidianIndex: db handle is invalid.');
  }
  const batchSize = Math.max(1, opts.batchSize || 500);
  const result = { rows: 0, links: 0, tags: 0, meta: 0, errors: 0 };
  let lastId = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let batch;
    try {
      batch = db
        .prepare(
          'SELECT id, body FROM memory_entries WHERE id > ? ORDER BY id ASC LIMIT ?',
        )
        .all(lastId, batchSize);
    } catch {
      // memory_entries missing (fresh db before migration 001) -- nothing to do.
      break;
    }
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      lastId = row.id;
      if (typeof row.body !== 'string' || row.body.length === 0) continue;
      try {
        const parsed = indexObsidianRelations(db, String(row.id), row.body);
        result.rows += 1;
        result.links += parsed.links.length;
        result.tags += parsed.tags.length;
        result.meta += parsed.meta.length;
      } catch (e) {
        result.errors += 1;
        try {
          console.error(
            '[obsidian] backfill failed for id', row.id, ':', e?.message || e,
          );
        } catch { /* never throw out of the backfill */ }
      }
    }
    if (batch.length < batchSize) break;
  }
  return result;
}

export default { parseObsidian, indexObsidianRelations, backfillObsidianIndex };
