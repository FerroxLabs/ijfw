// IJFW v1.5.2 -- brain dump inbox scanner.
//
// scanInbox(dir) walks the inbox dir at depth-0 ONLY (no recursion into
// subdirs, no dotfiles), classifies each regular file into one of the
// supported kinds, and returns metadata for the dream-cycle to extract.
//
// Subdirs are reserved for future use (e.g., per-source folders); the dump
// pipeline treats them as opaque and skips them.

import { readdirSync, statSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
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

/**
 * writeManifest -- write the per-file receipt as <processed>/<name>.manifest.json
 * atomically via .tmp+rename. Must be called BEFORE commitProcessed so a crash
 * between manifest-write and inbox-rename leaves the file as an orphan in
 * inbox/ (reprocessable on next cycle) -- never a half-state.
 */
export function writeManifest(processedDir, fileName, payload) {
  const final = manifestPath(processedDir, fileName);
  const tmp = final + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, final);
}

/**
 * commitProcessed -- atomically move <inbox>/<name> -> <processed>/<name>.
 * Same-filesystem rename = atomic. Idempotent: silently succeeds if file
 * already at destination and source is gone.
 */
export function commitProcessed(inboxDir, processedDir, fileName) {
  const src = join(inboxDir, fileName);
  const dst = join(processedDir, fileName);
  if (!existsSync(src) && existsSync(dst)) return; // already committed (recovery no-op)
  renameSync(src, dst);
}

/**
 * isProcessed -- true iff the manifest exists for this file. The manifest is
 * the source of truth for "this file completed" -- the inbox->processed rename
 * is a cleanup step after the manifest is written.
 */
export function isProcessed(processedDir, fileName) {
  return existsSync(manifestPath(processedDir, fileName));
}

export function readManifest(processedDir, fileName) {
  return JSON.parse(readFileSync(manifestPath(processedDir, fileName), 'utf8'));
}

function manifestPath(processedDir, fileName) {
  return join(processedDir, `${fileName}.manifest.json`);
}
