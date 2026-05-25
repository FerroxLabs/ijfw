// IJFW v1.5.2 -- brain dump inbox scanner.
//
// scanInbox(dir) walks the inbox dir at depth-0 ONLY (no recursion into
// subdirs, no dotfiles), classifies each regular file into one of the
// supported kinds, and returns metadata for the dream-cycle to extract.
//
// Subdirs are reserved for future use (e.g., per-source folders); the dump
// pipeline treats them as opaque and skips them.

import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

function classify(name) {
  if (name.includes('.transcript.')) return 'transcript';
  const ext = extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'text';
  return 'unknown';
}

export function scanInbox(inboxDir) {
  let entries;
  try {
    entries = readdirSync(inboxDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const p = join(inboxDir, e.name);
      const s = statSync(p);
      return {
        path: p,
        name: e.name,
        kind: classify(e.name),
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      };
    })
    .filter((f) => f.kind !== 'unknown');
}

export { classify };
