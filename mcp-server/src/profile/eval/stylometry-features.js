// stylometry-features.js — PURE, dependency-free feature extractors shared by the
// authorship metric (stylometry.js) and the reference-stats generator
// (tools/build-stylo-reference.mjs). Kept in its own module so BOTH consumers use the
// IDENTICAL tokenization, and so the generator never has to import stylometry.js (which
// imports the generated reference constants — that would be a load-order cycle).
//
// Nothing here references the frozen REF_MEAN/REF_SD. These functions only turn text
// into raw relative-frequency vectors over a given key set. The z-standardization (the
// step that MUST use frozen constants, never recomputed from the scored text) lives in
// stylometry.js::authorVector and is the subject of the anti-recompute guard test.

// Word tokens: lowercase alphanumeric+apostrophe runs.
export function tokenizeWords(text) {
  return (String(text).toLowerCase().match(/[a-z0-9']+/gi) || []);
}

// Whitespace-marked character trigrams: collapse runs of whitespace to a single space
// so word boundaries become part of the trigram signal, then slide a 3-char window.
export function charTrigrams(text) {
  const s = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const out = [];
  for (let i = 0; i + 3 <= s.length; i += 1) out.push(s.slice(i, i + 3));
  return out;
}

// Relative frequency of each function word = count / total words. Returns an array
// aligned to `funcWords`.
export function relFreqFunc(text, funcWords) {
  const w = tokenizeWords(text);
  const n = w.length || 1;
  const counts = Object.create(null);
  for (const x of w) counts[x] = (counts[x] || 0) + 1;
  return funcWords.map((fw) => (counts[fw] || 0) / n);
}

// Relative frequency of each trigram key = count / total trigrams. Returns an array
// aligned to `keys`.
export function relFreqTrigrams(text, keys) {
  const tris = charTrigrams(text);
  const n = tris.length || 1;
  const counts = Object.create(null);
  for (const t of tris) counts[t] = (counts[t] || 0) + 1;
  return keys.map((k) => (counts[k] || 0) / n);
}

// Relative frequency of each punctuation n-gram = occurrences / total chars. Returns an
// array aligned to `keys`. Keys may be multi-char (e.g. '...', '?!').
export function relFreqPunct(text, keys) {
  const s = String(text);
  const denom = s.length || 1;
  return keys.map((k) => {
    let n = 0;
    let idx = 0;
    while ((idx = s.indexOf(k, idx)) !== -1) { n += 1; idx += k.length; }
    return n / denom;
  });
}

// Full trigram count map — used ONLY by the generator to pick the top-K trigram keys
// from the reference corpus. Never used at scoring time.
export function trigramCounts(text) {
  const counts = Object.create(null);
  for (const t of charTrigrams(text)) counts[t] = (counts[t] || 0) + 1;
  return counts;
}

// Split a corpus string into `n` roughly equal word-count chunks (for computing
// per-feature mean/SD ACROSS documents, Burrows's-Delta style).
export function splitChunks(text, n) {
  const w = tokenizeWordsPreservingRaw(text);
  const per = Math.max(1, Math.floor(w.length / n));
  const chunks = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * per;
    const slice = i === n - 1 ? w.slice(start) : w.slice(start, start + per);
    if (slice.length) chunks.push(slice.join(' '));
  }
  return chunks;
}

// Raw whitespace split (keeps punctuation attached) so chunk text still carries
// punctuation for the punct features.
function tokenizeWordsPreservingRaw(text) {
  return String(text).split(/\s+/).filter(Boolean);
}
