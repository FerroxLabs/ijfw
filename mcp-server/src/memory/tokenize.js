// IJFW v1.3.0 -- shared tokenization + Jaccard similarity for tier-promotion.
//
// Source authority: .planning/1.3.0/D-PILLAR-SPEC.md section 1 (Episodic ->
// Semantic supersession trigger B uses token-set Jaccard > 0.7).
//
// Zero-deps, deterministic. Lowercases, strips non-word chars, drops
// length-1 tokens (noise) and a small English stopword set so common
// glue words don't dominate similarity scores.

// Stopword list -- tiny on purpose. Anything bigger drifts toward
// language-specific behaviour; the goal is to remove glue, not to do NLP.
//
// v1.5.0 audit-LOW-memory-#16: code-shorthand stopwords. Memories in this
// project are code-heavy; without these, generic JS keywords (function, class,
// const, etc.) saturate the BM25 IDF curve and out-rank actually-discriminative
// terms. Keeping the list narrow (JS-flavoured plus a handful of universals)
// preserves the language-agnostic spirit while killing the worst noise.
const STOPWORDS = new Set([
  // English glue
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they',
  'so', 'if', 'then', 'than', 'do', 'did', 'does',
  // Code shorthand -- JS/TS keywords that dominate IDF in code-heavy memory.
  'function', 'class', 'const', 'let', 'var', 'export', 'import', 'return',
  'await', 'async',
]);

/**
 * Tokenize a body string into a Set of normalised tokens.
 *
 * - Lowercases.
 * - Splits on non-word characters.
 * - Drops empty / length-1 tokens.
 * - Drops stopwords.
 *
 * @param {string} body
 * @returns {Set<string>}
 */
export function tokenizeBody(body) {
  if (typeof body !== 'string' || body.length === 0) return new Set();
  const out = new Set();
  for (const tok of body.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (tok.length <= 1) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Jaccard similarity between two token sets:
 *   |A intersect B| / |A union B|
 *
 * Returns 0 when both sets are empty. Bounded [0.0, 1.0].
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccardSimilarity(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  // Iterate the smaller set for efficiency.
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (big.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export default { tokenizeBody, jaccardSimilarity };
