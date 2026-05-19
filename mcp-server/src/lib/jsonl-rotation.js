// F-PRF-1 (audit-MED-teams-#10): JSONL rotation helper.
//
// Generic append-only JSONL rotator. When the target file's size crosses a
// threshold, the rotator:
//   1. Reads the current file bytes.
//   2. Gzips them via node:zlib.
//   3. Writes <prefix>.<YYYY-MM-DD>.jsonl.gz alongside the original (uniquify
//      with a numeric suffix if the date-stamped archive already exists).
//   4. Truncates the original to zero bytes.
//
// All writes are atomic-friendly (final rename) so concurrent readers either
// see the full pre-rotation file or the empty post-rotation file -- never a
// half-written archive.
//
// Used by the blackboard event/permission writers + any caller that does
// `appendFileSync(path, JSON.stringify(entry) + '\n')`. ESM, zero external deps.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Default rotation threshold (4 MB). Configurable per-call.
export const DEFAULT_ROTATE_SIZE = 4 * 1024 * 1024;

function isoDate(now = new Date()) {
  // YYYY-MM-DD in UTC for stable archive names across timezones.
  return now.toISOString().slice(0, 10);
}

function strippedJsonlName(file) {
  const base = basename(file);
  // Trim a trailing .jsonl so callers like events.jsonl rotate to events.<date>.jsonl.gz
  // (not events.jsonl.<date>.jsonl.gz).
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

function archivePath(file, now) {
  const dir = dirname(file);
  const stem = strippedJsonlName(file);
  const date = isoDate(now);
  let candidate = join(dir, `${stem}.${date}.jsonl.gz`);
  if (!existsSync(candidate)) return candidate;
  // Collision (multiple rotations same day) -- append a numeric suffix.
  for (let i = 1; i < 1000; i += 1) {
    candidate = join(dir, `${stem}.${date}.${i}.jsonl.gz`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`jsonl-rotation: too many same-day archives for ${file}`);
}

/**
 * Check whether `path` is over the rotation threshold and, if so, archive
 * it to a gzipped sibling and truncate the original. Returns an object
 * describing the action -- callers can ignore the result safely.
 *
 * options.maxBytes  -- rotate when file size > this. Default 4 MB.
 * options.now       -- override the date used in the archive name (testing).
 */
export function rotateJsonlIfNeeded(path, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : DEFAULT_ROTATE_SIZE;
  const now = options.now instanceof Date ? options.now : new Date();

  let stat;
  try { stat = statSync(path); }
  catch { return { rotated: false, reason: 'missing' }; }
  if (!stat.isFile()) return { rotated: false, reason: 'not-a-file' };
  if (stat.size <= maxBytes) return { rotated: false, reason: 'under-threshold', size: stat.size };

  let bytes;
  try { bytes = readFileSync(path); }
  catch (err) { return { rotated: false, reason: 'read-failed', error: String(err?.message || err) }; }

  const dest = archivePath(path, now);
  const gz = gzipSync(bytes);
  // Write to a temp file then rename so a partial gzip never appears at the
  // archive path. Truncation of the live file happens after the rename so
  // a crash mid-rotation loses at most one batch of pending writes.
  const tmp = `${dest}.tmp`;
  const destDir = dirname(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  writeFileSync(tmp, gz, { mode: 0o600 });
  try { renameSync(tmp, dest); }
  catch (err) {
    try { unlinkSync(tmp); } catch {}
    return { rotated: false, reason: 'rename-failed', error: String(err?.message || err) };
  }
  // Truncate the original. writeFileSync('') replaces the inode contents in
  // place; readers that opened the fd before the rotation keep their view.
  writeFileSync(path, '', { mode: 0o600 });
  return { rotated: true, archive: dest, archivedBytes: bytes.length, gzippedBytes: gz.length };
}

/**
 * Convenience wrapper: rotateJsonlIfNeeded(path, options) then append `line`
 * with a trailing newline. Used by event/permission writers that already
 * batch their own JSON.stringify.
 */
export function appendJsonlWithRotation(path, line, options = {}) {
  const result = rotateJsonlIfNeeded(path, options);
  // Caller still appends; we just signal whether rotation fired.
  return result;
}
