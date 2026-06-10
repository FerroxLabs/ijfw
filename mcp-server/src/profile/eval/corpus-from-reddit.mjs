// corpus-from-reddit.mjs — Gate B v2 corpus ingest. PURE local transform: takes a RAW
// single-subreddit dump already on disk and emits the {id,docs} corpus loadRealPersonas
// wants PLUS a disjoint same-register foreigner pool. NO network is ever touched — the
// operator fetches/exports the subreddit separately (do not redistribute the corpus).
//
// EXPECTED RAW INPUT SCHEMA (single subreddit ⇒ same register by construction):
//   A local file at `dumpPath`, either:
//     (a) JSONL — one JSON object per line, OR
//     (b) JSON  — a top-level array of objects, OR { posts:[...] } / { data:[...] }.
//   Each object must carry an author handle + a text body. Field names are flexible:
//     author : `author` | `author_fullname` | `user` | `username`
//     body   : `body` | `selftext` | `text` | `title`+`selftext` (concatenated)
//   Rows with a deleted/removed/bot/empty author are DROPPED. Single-subreddit input is
//   assumed (the same-register guarantee the wrong-target control relies on); a `subreddit`
//   field, if present, is NOT cross-checked here — keep one subreddit per file.
//
// FAIL-CLOSED: an author below minDocsPerAuthor or below minTokensPerAuthor is DROPPED
// (never padded); if fewer than nPersonaAuthors + nForeignAuthors qualify, ingest THROWS.
// Never evaluate the downstream gate on an underpowered slice — ingest more, don't loosen.

import fs from 'node:fs';
import { tokenizeWords } from './stylometry-features.js';

export const REDDIT_DEFAULTS = Object.freeze({
  nPersonaAuthors: 60,      // headline confirmatory N
  nForeignAuthors: 60,      // same-register foreigner pool (disjoint from personas)
  minDocsPerAuthor: 2,      // need ≥2 docs for a disjoint train/test split downstream
  minTokensPerAuthor: 1800, // train(1200)+test(600) floors of real-personas, with headroom
  minBodyChars: 40,         // drop near-empty bodies before counting docs
  seed: 1,
});

const DELETED_AUTHORS = new Set(['[deleted]', '[removed]', 'automoderator', 'deleted', 'removed', '']);

// FNV-1a → uint32. Deterministic, content-independent ordering key (mirrors real-personas).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickAuthor(r) {
  return String(r.author ?? r.user ?? r.username ?? r.author_fullname ?? '').trim();
}
function pickBody(r) {
  if (typeof r.body === 'string' && r.body.trim()) return r.body;
  if (typeof r.selftext === 'string' && (r.title || r.selftext).trim()) {
    return [r.title, r.selftext].filter(Boolean).join('\n').trim();
  }
  if (typeof r.text === 'string' && r.text.trim()) return r.text;
  if (typeof r.title === 'string' && r.title.trim()) return r.title;
  return '';
}

// Parse a local dump (JSONL or JSON array / {posts|data:[...]}). THROWS on missing/unreadable.
export function parseDump(dumpPath) {
  let raw;
  try {
    raw = fs.readFileSync(dumpPath, 'utf8');
  } catch (e) {
    throw new Error(`cannot read dump ${dumpPath}: ${e.code || e.message}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`empty dump ${dumpPath}`);
  // JSON array or object first (cheap to detect by first non-space char).
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (parsed) {
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.posts)) return parsed.posts;
      if (Array.isArray(parsed.data)) return parsed.data;
      // a single object on one line is not a valid corpus
    }
  }
  // JSONL: one object per line, tolerant of blank lines.
  const rows = [];
  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      // skip an unparseable line rather than abort the whole ingest
    }
  }
  if (!rows.length) throw new Error(`no parseable rows in dump ${dumpPath}`);
  return rows;
}

// groupByAuthor(rows, cfg) → [{ id, docs:[...] }] for authors clearing the floors. Deleted/
// bot/empty authors and near-empty bodies are dropped. Stable order: by author handle.
export function groupByAuthor(rows, cfg = REDDIT_DEFAULTS) {
  const c = { ...REDDIT_DEFAULTS, ...cfg };
  const byAuthor = new Map();
  for (const r of rows) {
    const author = pickAuthor(r);
    if (DELETED_AUTHORS.has(author.toLowerCase())) continue;
    const body = pickBody(r);
    if (!body || body.length < c.minBodyChars) continue;
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(body);
  }
  const out = [];
  for (const [id, docs] of byAuthor) {
    if (docs.length < c.minDocsPerAuthor) continue;
    const tokens = docs.reduce((s, d) => s + tokenizeWords(d).length, 0);
    if (tokens < c.minTokensPerAuthor) continue;
    out.push({ id, docs });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ingestRedditCorpus(dumpPath, opts) → { corpus, foreigners, stats }.
//   corpus     — nPersonaAuthors qualifying authors (the {id,docs} loadRealPersonas wants)
//   foreigners — nForeignAuthors DISJOINT qualifying authors (same-register pool; same file
//                ⇒ same subreddit ⇒ same register by construction)
// Selection + partition are a pure function of `seed` and author identity — NEVER of any
// style distance (selection-bias guard, mirrors real-personas). THROWS if too few qualify.
export function ingestRedditCorpus(dumpPath, opts = {}) {
  const cfg = { ...REDDIT_DEFAULTS, ...opts };
  const rows = parseDump(dumpPath);
  const qualifying = groupByAuthor(rows, cfg);

  const need = cfg.nPersonaAuthors + cfg.nForeignAuthors;
  if (qualifying.length < need) {
    throw new Error(
      `too few qualifying authors: ${qualifying.length} < ${need} `
      + `(personas ${cfg.nPersonaAuthors} + foreigners ${cfg.nForeignAuthors}); ingest more — do not underpower`,
    );
  }

  // Seeded deterministic order, independent of content/style distance.
  const ordered = [...qualifying].sort((a, b) => {
    const ha = fnv1a(`${cfg.seed}:${a.id}`);
    const hb = fnv1a(`${cfg.seed}:${b.id}`);
    return ha - hb || (a.id < b.id ? -1 : 1);
  });

  const corpus = ordered.slice(0, cfg.nPersonaAuthors);
  const foreigners = ordered.slice(cfg.nPersonaAuthors, cfg.nPersonaAuthors + cfg.nForeignAuthors);

  return {
    corpus,
    foreigners,
    stats: {
      totalRows: rows.length,
      qualifyingAuthors: qualifying.length,
      personaAuthors: corpus.length,
      foreignAuthors: foreigners.length,
      minDocsPerAuthor: cfg.minDocsPerAuthor,
      minTokensPerAuthor: cfg.minTokensPerAuthor,
    },
  };
}

export const __test = { fnv1a, pickAuthor, pickBody };
export default { ingestRedditCorpus, groupByAuthor, parseDump, REDDIT_DEFAULTS };
