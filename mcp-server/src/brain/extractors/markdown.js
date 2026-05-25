// markdown.js -- markdown + text extractor (chunk on blank-line boundaries).
import { readFileSync } from 'node:fs';

const DEFAULT_MAX_CHARS = 3000;

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

export function extractMarkdown(filePath, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const text = readFileSync(filePath, 'utf8');
  return { text, chunks: chunkAtBlankLines(text, maxChars) };
}
