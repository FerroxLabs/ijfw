/**
 * H5.6 — Semantic dedup at ingest time.
 *
 * Competitors (Graphiti, mem0) dedup near-duplicate memories at ingest so a
 * months-old project doesn't accrue 47 nearly-identical "decided to use
 * Postgres" entries. IJFW historically appended on every store, so this
 * module closes the bloat gap.
 *
 * Approach: cheap Jaccard similarity over token sets (same primitive that
 * cross-audit-chunker.mergeFindings uses for finding clustering). Pure JS,
 * zero deps, fully deterministic. No vector model required.
 *
 * Public surface:
 *  - tokenize(text)                          → Set<string>
 *  - jaccard(a, b)                           → number ∈ [0,1]
 *  - findNearDuplicate(content, recent, t?)  → { match, similarity } | null
 *  - readDedupConfig(env?)                   → { enabled, threshold, windowSize }
 *
 * Env knobs (read at call time, NOT cached, so tests can flip per-call):
 *  - IJFW_DEDUP_OFF=1            → disable entirely (returns null always)
 *  - IJFW_DEDUP_THRESHOLD=0.85   → Jaccard cutoff (default 0.85)
 *  - IJFW_DEDUP_WINDOW=50        → look back this many recent memories (default 50)
 */

const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_WINDOW = 50;
// Token floor — strings under this length are noise (no real dedup signal).
const MIN_TOKEN_LEN = 3;

/**
 * tokenize(text)
 *
 * Lowercased word set, dropping tokens shorter than MIN_TOKEN_LEN so things
 * like "a", "is", "to" don't dominate the Jaccard ratio.
 */
export function tokenize(text) {
  if (typeof text !== 'string') return new Set();
  return new Set(
    text.toLowerCase()
        .split(/\W+/)
        .filter(t => t.length >= MIN_TOKEN_LEN)
  );
}

/**
 * jaccard(a, b)
 *
 * Set similarity. Returns 1 when both empty, 0 when only one empty.
 * Matches the convention in cross-audit-chunker.jaccard.
 */
export function jaccard(a, b) {
  const tokA = a instanceof Set ? a : tokenize(a);
  const tokB = b instanceof Set ? b : tokenize(b);
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  const uni = tokA.size + tokB.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * readDedupConfig(env?)
 *
 * Resolve runtime config. Reads process.env unless `env` is supplied (for tests).
 * Threshold is clamped to [0,1]. Window is clamped to [1, 500].
 */
export function readDedupConfig(env = process.env) {
  const enabled = env.IJFW_DEDUP_OFF !== '1' && env.IJFW_DEDUP_OFF !== 'true';
  let threshold = DEFAULT_THRESHOLD;
  if (env.IJFW_DEDUP_THRESHOLD != null && env.IJFW_DEDUP_THRESHOLD !== '') {
    const n = Number(env.IJFW_DEDUP_THRESHOLD);
    if (Number.isFinite(n)) threshold = Math.max(0, Math.min(1, n));
  }
  let windowSize = DEFAULT_WINDOW;
  if (env.IJFW_DEDUP_WINDOW != null && env.IJFW_DEDUP_WINDOW !== '') {
    const n = parseInt(env.IJFW_DEDUP_WINDOW, 10);
    if (Number.isFinite(n) && n > 0) windowSize = Math.max(1, Math.min(500, n));
  }
  return { enabled, threshold, windowSize };
}

/**
 * findNearDuplicate(content, recentMemories, threshold?)
 *
 * Walks the last N (default: full array) recentMemories and returns the
 * first entry whose Jaccard similarity to `content` meets or exceeds
 * `threshold`. Each entry should be `{ id, content, ... }`; we only read
 * `id` and `content`. Returns `null` if nothing matches.
 *
 * Iteration is most-recent-first when callers pass a chronologically-ordered
 * recents array — they should slice the tail and reverse before calling.
 * We don't reorder for them so behavior is predictable.
 *
 * @param {string} content
 * @param {Array<{id:string, content:string}>} recentMemories
 * @param {number} [threshold] — default from readDedupConfig()
 * @returns {{match:{id:string,content:string}, similarity:number} | null}
 */
export function findNearDuplicate(content, recentMemories, threshold) {
  if (typeof content !== 'string' || !content.trim()) return null;
  if (!Array.isArray(recentMemories) || recentMemories.length === 0) return null;
  const cfg = readDedupConfig();
  if (!cfg.enabled) return null;
  const t = (typeof threshold === 'number' && threshold >= 0 && threshold <= 1)
    ? threshold
    : cfg.threshold;

  const tokContent = tokenize(content);
  // Empty token set → no signal. Don't claim dedup.
  if (tokContent.size === 0) return null;

  let best = null;
  for (const mem of recentMemories) {
    if (!mem || typeof mem.content !== 'string') continue;
    const sim = jaccard(tokContent, tokenize(mem.content));
    if (sim >= t) {
      // Short-circuit on first match; callers expect the most-recent
      // matching entry (assuming they pre-ordered).
      return { match: mem, similarity: sim };
    }
    // Track best-effort closest-but-not-quite for diagnostics (unused here).
    if (!best || sim > best.similarity) best = { match: mem, similarity: sim };
  }
  return null;
}
