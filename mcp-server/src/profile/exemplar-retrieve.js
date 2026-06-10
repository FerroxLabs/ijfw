// V2 — exemplar retrieval (voice exemplars feature).
//
// ZERO-LLM serve path ("the moat"). This module ranks the user's OWN real
// writing samples (exemplars) so the agent can few-shot draft in their voice.
// It MUST NOT import any LLM / network / embedder module. Pure ranking only:
//   register-match boost  +  lexical similarity (BM25)  +  recency tiebreak.
//
// Exemplar record contract (shared with the store, V1):
//   { id, text, register: 'terse'|'casual'|'formal'|'commit'|'doc',
//     source: 'prompt'|'commit-msg', ts: ISO-string }

import { createRequire } from 'node:module';
import { searchCorpus } from '../search-bm25.js';

// V1's store (exemplar-store.js → listExemplars) is built in parallel and is
// only needed when the caller does NOT inject a candidate set. We therefore
// load it LAZILY (synchronous require-of-ESM, stable in Node ≥22): a static
// import would couple this module's load-time to V1's build order, and would
// crash the zero-LLM serve path before V1 lands. The injected-exemplars path
// (and every test that uses it) stays fully decoupled from the store.
const require = createRequire(import.meta.url);
function loadFromStore() {
  try {
    const mod = require('./exemplar-store.js');
    if (mod && typeof mod.listExemplars === 'function') return mod.listExemplars();
  } catch {
    /* store not available yet — treat as cold-start (empty set). */
  }
  return [];
}

// Blend weights. Register match dominates (we want same-register voice first),
// lexical relevance is the primary tiebreak among same-register candidates,
// recency is a gentle final nudge so newer writing wins on equal footing.
const W_REGISTER = 1.0;
const W_LEXICAL = 0.6;
const W_RECENCY = 0.1;

// Parse an ISO timestamp to epoch millis; non-parseable → 0 (treated oldest).
function tsMillis(ts) {
  if (typeof ts !== 'string' || !ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

// Map each candidate's ts into a [0,1] recency factor relative to the set.
// Newest → 1, oldest → 0. A single distinct ts (or none) → 0 for all, so
// recency never perturbs an otherwise-tied ordering arbitrarily.
function recencyFactors(exemplars) {
  const millis = exemplars.map((e) => tsMillis(e.ts));
  let min = Infinity;
  let max = -Infinity;
  for (const m of millis) {
    if (m < min) min = m;
    if (m > max) max = m;
  }
  const span = max - min;
  const out = new Map();
  for (let i = 0; i < exemplars.length; i++) {
    out.set(exemplars[i].id, span > 0 ? (millis[i] - min) / span : 0);
  }
  return out;
}

/**
 * Return up to `k` exemplars most relevant to the current drafting task,
 * best-first. Deterministic: equal inputs → identical ordering.
 *
 * @param {object}   args
 * @param {string}  [args.register]   Target register to prefer (strong boost).
 * @param {string}  [args.taskText]   Current drafting task text (lexical signal).
 * @param {number}  [args.k=3]        Max exemplars to return.
 * @param {Array}   [args.exemplars]  Candidate set (DI); if null, loads via store.
 * @param {object}  [args.env]        Env (unused here; kept for interface parity).
 * @returns {Array} ranked exemplars (the original records), best-first.
 */
export function retrieveExemplars({
  register,
  taskText,
  k = 3,
  exemplars = null,
  env = process.env, // eslint-disable-line no-unused-vars -- interface parity
} = {}) {
  // Load candidates if not injected. listExemplars returns NEWEST-first.
  let candidates = Array.isArray(exemplars) ? exemplars : loadFromStore();
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // Defensive copy so we never mutate the caller's / store's array.
  candidates = candidates.filter((e) => e && typeof e === 'object');
  if (candidates.length === 0) return [];

  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
  if (limit === 0) return [];

  const query = typeof taskText === 'string' ? taskText.trim() : '';

  // Lexical scores via the repo's pure BM25 primitive over in-memory docs.
  // Normalize to [0,1] within this candidate set so the lexical contribution
  // is bounded and comparable to the register boost regardless of corpus size.
  const lexical = new Map();
  if (query) {
    const docs = candidates.map((e) => ({
      id: e.id,
      text: typeof e.text === 'string' ? e.text : '',
      meta: null,
    }));
    // limit = full set so every candidate that scores > 0 is captured.
    const hits = searchCorpus(query, docs, { limit: docs.length });
    let maxScore = 0;
    for (const h of hits) if (h.score > maxScore) maxScore = h.score;
    if (maxScore > 0) {
      for (const h of hits) lexical.set(h.id, h.score / maxScore);
    }
  }

  const recency = recencyFactors(candidates);

  const scored = candidates.map((e) => {
    const registerMatch = register && e.register === register ? 1 : 0;
    const lex = lexical.get(e.id) ?? 0;
    const rec = recency.get(e.id) ?? 0;
    const score = W_REGISTER * registerMatch + W_LEXICAL * lex + W_RECENCY * rec;
    return { e, score };
  });

  // Deterministic ordering: composite score desc, then newer ts, then id asc.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const tb = tsMillis(b.e.ts);
    const ta = tsMillis(a.e.ts);
    if (tb !== ta) return tb - ta;
    const ia = String(a.e.id);
    const ib = String(b.e.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });

  return scored.slice(0, limit).map((s) => s.e);
}
