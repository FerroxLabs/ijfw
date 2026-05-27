// markdown.js -- markdown + text extractor (chunk on blank-line boundaries).
import { readFileSync, statSync } from 'node:fs';

const DEFAULT_MAX_CHARS = 3000;
// V155-067 (v1.5.5): default file-size cap. Inbox files come from
// user-droppable `dump/inbox/`; a multi-GB drop would OOM the dream cycle
// during `readFileSync('utf8')`. Cap at 10 MB — well above any reasonable
// hand-written brief or transcript. Caller can override (and `scanInbox`
// already records `sizeBytes` so the candidate filter can pre-skip).
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export function chunkAtBlankLines(text, maxChars = DEFAULT_MAX_CHARS) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  for (const p of paragraphs) {
    const candidate = cur ? cur + '\n\n' + p : p;
    if (candidate.length <= maxChars) { cur = candidate; continue; }
    if (cur) chunks.push(cur);
    if (p.length <= maxChars) { cur = p; continue; }
    // single paragraph exceeds maxChars — hard-split on chars
    for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
    cur = '';
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function extractMarkdown(
  filePath,
  { maxChars = DEFAULT_MAX_CHARS, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {},
) {
  // V155-067 (v1.5.5): pre-stat + size cap. statSync is cheap and lets us
  // surface a structured `error` for oversized files instead of hitting the
  // OOM during readFileSync.
  let st;
  try { st = statSync(filePath); }
  catch (e) {
    return { text: '', chunks: [], error: 'stat-failed', message: e?.message || String(e) };
  }
  if (typeof maxFileBytes === 'number' && st.size > maxFileBytes) {
    return {
      text: '',
      chunks: [],
      error: 'file-too-large',
      sizeBytes: st.size,
      capBytes: maxFileBytes,
    };
  }
  const text = readFileSync(filePath, 'utf8');
  return { text, chunks: chunkAtBlankLines(text, maxChars) };
}
