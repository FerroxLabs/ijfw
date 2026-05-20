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

export default { parseObsidian, indexObsidianRelations };
