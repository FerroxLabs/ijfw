/**
 * H5.5 — Heuristic fact extraction at ingest time.
 *
 * Competitors (mem0, Zep, Letta) extract structured facts from raw memory at
 * ingest so retrieval can match on subject/predicate/object as well as on raw
 * content. IJFW historically stored raw markdown only -- this module closes
 * that gap without an LLM round-trip.
 *
 * Output shape: array of { subject, predicate, object, confidence } where
 * confidence ∈ [0,1] reflects pattern specificity (anchored patterns score
 * higher than catch-alls). Empty input or no matches → [].
 *
 * Design constraints:
 *  - Zero LLM calls (deterministic, runs inline in handleStore).
 *  - Zero deps -- pure JS regexes over already-sanitized text.
 *  - Conservative: prefer "miss" over false-positive; we'd rather record
 *    nothing than poison the facts.jsonl stream with garbage.
 *  - Output is structural, not semantic -- consumers can post-process.
 */

// Cap per-call output so a 100KB pasted memory doesn't blow up facts.jsonl.
const MAX_FACTS_PER_CALL = 64;
// Cap on each field length so a runaway match doesn't write a 10KB JSON line.
const MAX_FIELD_LEN = 240;

function clean(s) {
  if (typeof s !== 'string') return '';
  // Single-line, trimmed, length-capped. Already sanitized upstream but we
  // still strip newlines so each fact is a single JSONL line at write time.
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LEN);
}

function add(facts, subject, predicate, object, confidence) {
  const s = clean(subject);
  const p = clean(predicate);
  const o = clean(object);
  if (!s || !p || !o) return;
  // Cheap intra-call dedup so the same fact extracted by overlapping patterns
  // doesn't write twice. Keyed on lowercase triple.
  const key = `${s.toLowerCase()}|${p.toLowerCase()}|${o.toLowerCase()}`;
  if (facts._seen.has(key)) return;
  facts._seen.add(key);
  facts.push({ subject: s, predicate: p, object: o, confidence });
}

/**
 * extractFacts(content)
 *
 * @param {string} content - already-sanitized markdown text
 * @returns {Array<{subject:string, predicate:string, object:string, confidence:number}>}
 */
export function extractFacts(content) {
  const facts = [];
  facts._seen = new Set();
  if (typeof content !== 'string' || !content.trim()) {
    return [];
  }

  // Process line-by-line. Many of our patterns are anchored to clause shape,
  // and pasted memories usually have one fact per line. Also split on the
  // " | " separator that sanitizer.js inserts when collapsing newlines --
  // store callers send multi-line markdown, sanitizer flattens it before we
  // see it, so the original line boundaries are encoded as " | ".
  const lines = content.split(/\r?\n|\s\|\s/);
  for (const rawLine of lines) {
    if (facts.length >= MAX_FACTS_PER_CALL) break;
    const line = rawLine.trim();
    if (!line) continue;

    // ---- Pattern: "ship date: <date>" / "release date: <date>" / "due: <date>"
    //              Confidence 0.95 (very specific keyword + colon).
    {
      const m = line.match(/^\s*(ship\s+date|release\s+date|launch\s+date|due\s+date|due|deadline)\s*:\s*(.+)$/i);
      if (m) {
        add(facts, 'project', m[1].toLowerCase().replace(/\s+/g, '_'), m[2], 0.95);
        continue;
      }
    }

    // ---- Pattern: "owner: <name>" / "assignee: <name>" / "lead: <name>"
    //              Confidence 0.95.
    {
      const m = line.match(/^\s*(owner|assignee|lead|maintainer|author)\s*:\s*(.+)$/i);
      if (m) {
        add(facts, 'project', m[1].toLowerCase(), m[2], 0.95);
        continue;
      }
    }

    // ---- Pattern: "<key>: <value>" — generic key/value declarations.
    //              Lower confidence (0.6). Only fires for short, single-token-ish keys
    //              so prose colons ("for example:") don't trip it.
    //              Skips known-noise keys (http, https, file paths).
    {
      const m = line.match(/^\s*([A-Z][A-Za-z0-9_-]{1,30})\s*:\s*(\S.{0,200})$/);
      if (m && !/^https?$/i.test(m[1]) && m[2].length >= 2) {
        add(facts, 'project', m[1].toLowerCase(), m[2], 0.60);
        continue;
      }
    }

    // ---- Pattern: "decided to <verb> [obj]" / "decision: <text>"
    //              Confidence 0.85.
    {
      const m = line.match(/\bdecided\s+to\s+(\w+(?:\s+\S+){0,12})/i);
      if (m) {
        add(facts, 'team', 'decided_to', m[1], 0.85);
        continue;
      }
      const m2 = line.match(/^\s*decision\s*:\s*(.+)$/i);
      if (m2) {
        add(facts, 'team', 'decision', m2[1], 0.90);
        continue;
      }
    }

    // ---- Pattern: "<Name> uses <Tool>" — capitalised subject + uses + capitalised obj.
    //              Confidence 0.80. Both ends Title-Case to avoid matching prose like
    //              "the team uses redis" (which would be too noisy).
    {
      const m = line.match(/\b([A-Z][A-Za-z0-9_-]{1,40}(?:\s+[A-Z][A-Za-z0-9_-]{1,40})?)\s+uses\s+([A-Z][A-Za-z0-9_.+-]{1,40}(?:\s+[A-Za-z0-9_.+-]{1,40})?)/);
      if (m) {
        add(facts, m[1], 'uses', m[2], 0.80);
        continue;
      }
    }

    // ---- Pattern: "<X> is <Y>" — copular sentences, capitalised subject.
    //              Confidence 0.70. Anchor on capital S so we don't extract
    //              "it is fine" / "this is broken" noise.
    //              Cap object phrase at 6 words to keep facts terse.
    {
      const m = line.match(/^\s*([A-Z][A-Za-z0-9_.\-]{1,40}(?:\s+[A-Za-z0-9_.\-]{1,40})?)\s+is\s+((?:[\w-]+(?:\s+[\w-]+){0,5}))[.!?]?\s*$/);
      if (m) {
        // Skip pronouns and bare articles disguised as subjects.
        const subj = m[1];
        if (!/^(It|This|That|There|Here|He|She|They|We|I)$/i.test(subj)) {
          add(facts, subj, 'is', m[2], 0.70);
          continue;
        }
      }
    }
  }

  // Strip the internal _seen marker before returning so JSON.stringify is clean.
  delete facts._seen;
  return facts;
}

/**
 * factToJsonl(fact, meta)
 *
 * Serialize one fact as a JSONL line, adding source metadata (timestamp,
 * memory_id) so the facts stream is self-contained and joinable back to the
 * journal entry it came from.
 */
export function factToJsonl(fact, meta = {}) {
  const line = {
    ts: meta.ts || new Date().toISOString(),
    memory_id: meta.memory_id || null,
    source: meta.source || 'memory_store',
    ...fact,
  };
  return JSON.stringify(line);
}
