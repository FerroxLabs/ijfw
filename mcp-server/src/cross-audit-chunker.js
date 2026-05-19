// r17.1 (item 5) — Chunking strategy for cross-audit on large targets.
//
// Cross-audit's auditors (codex / gemini / claude / etc) all have practical
// input limits well below the 64 KB target cap — and even at the cap, audit
// quality degrades because the model is asked to grade ~20K tokens at once.
// This module splits a large target into overlapping chunks, lets the caller
// audit each chunk independently, then merges + dedupes the findings.
//
// Design choices:
//   - Boundary-aware split: prefers blank-line, then sentence, then word, then
//     character. Audit quality drops sharply when a chunk ends mid-thought.
//   - Overlapping chunks: ~10% overlap so findings near a boundary appear in
//     both neighbors and dedup catches them as a single finding.
//   - Finding shape match: hybrid with the existing finding structure from
//     `printFindings`: { severity, target, finding, action } (severity is
//     'high' | 'medium' | 'low'). Unknown keys preserved.
//   - Dedupe: case-insensitive jaccard over the (target + finding) text. A
//     duplicate threshold of 0.85 is the default; configurable via opts.

const DEFAULT_CHUNK_SIZE = Math.floor(64 * 1024 * 0.9);   // 90% of TARGET_FILE_SIZE_CAP
const DEFAULT_OVERLAP    = Math.floor(64 * 1024 * 0.10);  // 10%
const SEVERITY_RANK      = { high: 3, medium: 2, low: 1 };

/**
 * Split text into overlapping chunks at the best boundary available.
 *
 * @param {string} text                - the text to chunk
 * @param {object} [opts]
 * @param {number} [opts.chunkSize]    - max chars per chunk (default 90% of cap)
 * @param {number} [opts.overlap]      - chars of overlap (default 10% of cap)
 * @returns {Array<{ index: number, start: number, end: number, text: string }>}
 */
export function chunkText(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const chunkSize = Math.max(1024, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  // r17-M1: clamp overlap to <= chunkSize/2 so the advance step is always
  // strictly forward. Without this, opts.chunkSize=500 + default overlap
  // (~6553) would set start to max(start+1, cutEnd - 6553) and the loop
  // would advance one char per iteration on small chunks.
  const overlap   = Math.min(Math.floor(chunkSize / 2), Math.max(0, opts.overlap ?? DEFAULT_OVERLAP));

  // Tiny text: one chunk.
  if (text.length <= chunkSize) {
    return [{ index: 0, start: 0, end: text.length, text }];
  }

  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= chunkSize) {
      chunks.push({ index, start, end: text.length, text: text.slice(start) });
      break;
    }

    // Find the best boundary within [start + chunkSize - 1024, start + chunkSize].
    // We slide LEFT from the nominal end looking for a clean break point.
    const nominalEnd = start + chunkSize;
    const searchFloor = Math.max(start + 1, nominalEnd - 1024);
    let cutEnd = nominalEnd;

    // Prefer blank-line boundary.
    let p = text.lastIndexOf('\n\n', nominalEnd);
    if (p >= searchFloor) {
      cutEnd = p + 2;
    } else {
      // Try sentence-ending punctuation.
      p = Math.max(
        text.lastIndexOf('. ', nominalEnd),
        text.lastIndexOf('! ', nominalEnd),
        text.lastIndexOf('? ', nominalEnd),
        text.lastIndexOf('.\n', nominalEnd),
      );
      if (p >= searchFloor) {
        cutEnd = p + 2;
      } else {
        // Try a single newline.
        p = text.lastIndexOf('\n', nominalEnd);
        if (p >= searchFloor) cutEnd = p + 1;
        // Else fall through to nominal char boundary.
      }
    }

    chunks.push({ index, start, end: cutEnd, text: text.slice(start, cutEnd) });
    index++;
    // Advance with overlap.
    start = Math.max(start + 1, cutEnd - overlap);
  }
  return chunks;
}

// Normalize finding shape — accept {severity, finding, target, action} OR
// {severity, message} OR raw strings; coerce to a common shape.
// v1.5.0 wire-W4: widened the field-name fallback chain to cover the field
// names auditors actually emit. Trident r19 dropped 100% of finding text to
// "(no detail)" because the lens responses used `description`/`issue`/`detail`
// rather than `finding`/`message`/`text`. r20 captures them properly.
function normaliseFinding(raw) {
  if (typeof raw === 'string') {
    return { severity: 'medium', finding: raw, target: '', action: '' };
  }
  if (!raw || typeof raw !== 'object') return null;
  return {
    severity: String(raw.severity || 'medium').toLowerCase(),
    finding:  String(
      raw.finding || raw.message || raw.text || raw.description ||
      raw.issue || raw.detail || raw.details || raw.note || raw.summary || ''
    ),
    target:   String(
      raw.target || raw.location || raw.path || raw.file ||
      raw.where || raw.line || ''
    ),
    action:   String(
      raw.action || raw.fix || raw.recommendation ||
      raw.suggestion || raw.remediation || ''
    ),
    // preserve unknown keys for printers that want them
    _extra: raw,
  };
}

// Jaccard similarity on lowercased word sets. Cheap, deterministic, gives
// "are these two findings essentially the same?" for free.
function jaccard(a, b) {
  const tokA = new Set(String(a).toLowerCase().split(/\W+/).filter(t => t.length > 2));
  const tokB = new Set(String(b).toLowerCase().split(/\W+/).filter(t => t.length > 2));
  if (tokA.size === 0 && tokB.size === 0) return 1;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  const uni = tokA.size + tokB.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Merge findings from per-chunk audits. Dedupes near-duplicates (Jaccard ≥
 * threshold) and keeps the max severity from each cluster.
 *
 * @param {Array<{ chunkIndex: number, findings: Array }>} perChunkResults
 * @param {object} [opts]
 * @param {number} [opts.dedupeThreshold]  - Jaccard threshold (default 0.85)
 * @returns {Array}  - merged + deduped findings, sorted high→low severity
 */
export function mergeFindings(perChunkResults, opts = {}) {
  const threshold = opts.dedupeThreshold ?? 0.85;
  const flat = [];
  for (const r of perChunkResults || []) {
    const chunkIndex = typeof r.chunkIndex === 'number' ? r.chunkIndex : null;
    const findings = Array.isArray(r.findings) ? r.findings : [];
    for (const raw of findings) {
      const n = normaliseFinding(raw);
      if (n) flat.push({ ...n, chunkIndex });
    }
  }
  if (flat.length === 0) return [];

  // Cluster by jaccard. Each cluster's representative is the first member;
  // we keep the MAX severity across the cluster and record `clusterSize`.
  const clusters = [];
  for (const f of flat) {
    const key = `${f.target} ${f.finding}`;
    let placed = false;
    for (const c of clusters) {
      const repKey = `${c.target} ${c.finding}`;
      if (jaccard(key, repKey) >= threshold) {
        c._members.push(f);
        if ((SEVERITY_RANK[f.severity] || 0) > (SEVERITY_RANK[c.severity] || 0)) {
          c.severity = f.severity;
        }
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ ...f, _members: [f] });
  }

  // Stamp clusterSize + clusterChunks for printers + sort by severity desc.
  for (const c of clusters) {
    c.clusterSize = c._members.length;
    c.clusterChunks = [...new Set(c._members.map(m => m.chunkIndex).filter(i => i !== null))];
    delete c._members;
  }
  clusters.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
  return clusters;
}

// Constants exported so consumers + tests can reference the same defaults.
export const CHUNKER_DEFAULTS = { chunkSize: DEFAULT_CHUNK_SIZE, overlap: DEFAULT_OVERLAP, dedupeThreshold: 0.85 };
