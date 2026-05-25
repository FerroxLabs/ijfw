// index.js -- dispatch extractFile(file) by kind.
import { extractMarkdown } from './markdown.js';
import { extractTranscript } from './transcript.js';
import { extractPdf } from './pdf.js';

/**
 * file: object from scanInbox -- shape { path, name, kind, sizeBytes, mtimeMs }.
 * Returns Promise<{ text, chunks } | { error, ... }>.
 */
export async function extractFile(file) {
  switch (file.kind) {
    case 'markdown':
    case 'text':
      return extractMarkdown(file.path);
    case 'transcript':
      return extractTranscript(file.path);
    case 'pdf':
      return extractPdf(file.path);
    default:
      return { error: 'unsupported-kind', kind: file.kind, path: file.path };
  }
}

export { extractMarkdown, extractTranscript, extractPdf };
