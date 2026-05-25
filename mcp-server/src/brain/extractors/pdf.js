// pdf.js -- lazy pdf-parse wrapper. pdf-parse is NOT a hard dependency;
// returns { error } gracefully when the dep is missing.

import { readFileSync } from 'node:fs';

export async function extractPdf(filePath) {
  let pdfParse;
  try {
    // pdf-parse exposes its parser as the default export of its CJS module.
    const mod = await import('pdf-parse');
    pdfParse = mod.default || mod;
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(e.message || '')) {
      return { error: 'pdf-parse-not-installed', filePath };
    }
    throw e;
  }
  try {
    const buf = readFileSync(filePath);
    const parsed = await pdfParse(buf);
    const text = parsed && typeof parsed.text === 'string' ? parsed.text : '';
    // Chunk on form-feed (PDF page break) when present, else fall back to blank-line chunking.
    const { chunkAtBlankLines } = await import('./markdown.js');
    const pageChunks = text.includes('\f')
      ? text.split('\f').map((p) => p.trim()).filter(Boolean)
      : chunkAtBlankLines(text);
    return { text, chunks: pageChunks };
  } catch (e) {
    return { error: 'pdf-parse-failed', message: e.message, filePath };
  }
}
