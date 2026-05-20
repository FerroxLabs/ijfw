// IJFW v1.5.0 -- A-Mem-style auto-linking on memory store.
//
// On every memory store call (post-dedup, pre-fact-extraction), this module:
//   1. Selects top-k neighbors via body lexical match (production
//      memory_entries has columns id/body/source/session_id/created_at;
//      no title, so neighbor scoring is body-only).
//   2. Asks the LLM (one call, env-gated) to return a JSON payload:
//        classification: "ADD" | "UPDATE" | "NOOP"
//        links:          [{ target }]
//        neighbor_edits: [{ id, add_tags: [...] }]
//   3. Applies the proposal to memory_links / memory_tags atomically.
//
// All steps are gated by llm-call.js env vars (IJFW_AUTOLINK_OFF=1,
// IJFW_AUTOLINK_BUDGET_USD=0, missing API key). When skipped, no writes.
//
// Test injections:
//   { neighborsOnly: true } -> select neighbors, no LLM, no writes
//   { dryProposal: <obj> }  -> skip LLM, apply the supplied proposal
//
// Reference: arxiv 2502.12110 (A-Mem, NeurIPS 2025). This is the
// academically-validated "smarter with use" keystone.

import { llmCall, parseLlmJsonResponse } from '../lib/llm-call.js';

const DEFAULT_TOPK = 5;
const SYSTEM_PROMPT = [
  'You are the IJFW memory auto-linker. Given a NEW MEMORY and TOP-K NEIGHBORS,',
  'return STRICT JSON only (no prose). Schema:',
  '{',
  '  "classification": "ADD" | "UPDATE" | "NOOP",',
  '  "links":           [{ "target": "<lowercase-dash-collapsed-slug>" }],',
  '  "neighbor_edits":  [{ "id": "<neighbor-id>", "add_tags": ["..."] }]',
  '}',
  'classification = UPDATE if the new memory directly supersedes a neighbor.',
  'classification = NOOP if the new memory is fully duplicate.',
  'links = neighbors the new memory should reference (max 3).',
  'neighbor_edits = small tag additions to neighbors (max 2 per neighbor; max 3 total).',
  'NEVER invent neighbors not in TOP-K. NEVER rewrite neighbor body.',
].join('\n');

function selectNeighbors(db, entry, k = DEFAULT_TOPK) {
  // Body-only lexical proximity via tokenized LIKE -- light, deterministic,
  // no FTS dependency. Production memory_entries has no title column.
  //
  // Tokenization: split on non-word chars, filter to tokens >=4 chars
  // (skips stop-words and noise), keep first 3. Build OR-LIKE so we find
  // any neighbor that shares at least one significant token. Ranking is
  // implicit via the LIMIT; if multi-token scoring matters in the future,
  // wrap in a CASE-WHEN sum.
  const tokens = (entry.body || entry.title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 4)
    .slice(0, 3);
  if (tokens.length === 0) return [];

  const orClauses = tokens.map(() => 'body LIKE ?').join(' OR ');
  const params = tokens.map((t) => `%${t}%`);
  let sql = `SELECT CAST(id AS TEXT) AS id, body, source
             FROM memory_entries
             WHERE (${orClauses})`;
  if (entry.id != null) {
    sql += ' AND CAST(id AS TEXT) != ?';
    params.push(String(entry.id));
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(k);
  return db.prepare(sql).all(...params);
}

function applyProposal(db, entry, proposal) {
  const insLink = db.prepare(
    'INSERT OR IGNORE INTO memory_links (from_id, to_target, line) VALUES (?, ?, 0)',
  );
  const insTag = db.prepare(
    'INSERT OR IGNORE INTO memory_tags (memory_id, tag_path, depth) VALUES (?, ?, ?)',
  );
  let linksAdded = 0;
  let neighborTagsAdded = 0;
  const tx = db.transaction(() => {
    for (const l of (proposal.links || []).slice(0, 3)) {
      if (l && typeof l.target === 'string' && l.target) {
        const res = insLink.run(String(entry.id), l.target);
        if (res.changes) linksAdded++;
      }
    }
    let total = 0;
    for (const ne of (proposal.neighbor_edits || []).slice(0, 5)) {
      if (!ne || typeof ne.id !== 'string') continue;
      for (const t of (ne.add_tags || []).slice(0, 2)) {
        if (total >= 3) break;
        if (typeof t === 'string' && t) {
          const path = t.toLowerCase().replace(/^\/+|\/+$/g, '');
          if (!path) continue;
          const res = insTag.run(ne.id, path, path.split('/').length);
          if (res.changes) {
            neighborTagsAdded++;
            total++;
          }
        }
      }
    }
  });
  tx();
  return { links_added: linksAdded, neighbor_tags_added: neighborTagsAdded };
}

export async function autoLink(db, entry, opts = {}) {
  const neighbors = selectNeighbors(db, entry, opts.k || DEFAULT_TOPK);
  if (opts.neighborsOnly) return { skipped: true, neighbors };

  let proposal = opts.dryProposal;
  if (!proposal) {
    const userPayload = JSON.stringify({
      new_memory: { id: String(entry.id), body: entry.body },
      top_k_neighbors: neighbors.map((n) => ({ id: n.id, body: (n.body || '').slice(0, 200) })),
    });
    const llm = await llmCall({
      system: SYSTEM_PROMPT,
      user: userPayload,
      maxTokens: 512,
    });
    if (llm.skipped) {
      return { skipped: true, reason: llm.reason, neighbors };
    }
    try {
      proposal = parseLlmJsonResponse(llm.text);
    } catch (e) {
      return { skipped: true, reason: 'parse_failed', neighbors, error: e.message };
    }
  }
  const applied = applyProposal(db, entry, proposal);
  return { skipped: false, neighbors, proposal, applied };
}

export default { autoLink };
