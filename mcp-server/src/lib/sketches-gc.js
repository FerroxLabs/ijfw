// sketches-gc.js -- v1.5.0 audit-MED-design-#9.
//
// Auto-archive sketches older than N days from .planning/sketches/ to
// .planning/sketches/.archive/.  Idempotent.  Zero deps.  Pure stdlib.
//
// Design notes:
//   - "Sketches" are throwaway HTML mockups under .planning/sketches/<name>/.
//     Without GC they accumulate indefinitely -- the audit MED.
//   - Default age: 30 days (configurable via opts.maxAgeMs).
//   - Archive layout: .planning/sketches/.archive/<original-name>/.  If a name
//     collision happens (re-archived twice), suffix with timestamp.
//   - mtime is used (not ctime) -- editing a sketch keeps it fresh.
//   - Walks ONE level deep.  Each top-level entry under sketches/ is either a
//     directory (a sketch) or a stray file (also archived).
//   - Returns {archived: [{from, to}], skipped: [{path, reason}], scannedAt}.
//
// Used by:
//   - `ijfw run sketches-gc [--root <dir>] [--max-age-days <n>] [--dry-run]`
//     via cross-orchestrator-cli.js
//   - Any cron / hook that wants a maintenance pass.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Run a GC pass over a sketches directory.
 *
 * @param {object} opts
 * @param {string} [opts.root]         Sketches root.  Default: .planning/sketches relative to cwd.
 * @param {number} [opts.maxAgeMs]     Max age in ms.  Default: 30 days.
 * @param {number} [opts.maxAgeDays]   Convenience -- overrides maxAgeMs when set.
 * @param {boolean} [opts.dryRun]      When true, return the plan but do not move anything.
 * @param {Date}   [opts.now]          Reference "now" -- injected for tests.
 * @returns {{archived: Array<{from:string,to:string,ageDays:number}>, skipped: Array<{path:string,reason:string}>, scannedAt:string, archiveDir:string, root:string}}
 */
export function runSketchesGc(opts = {}) {
  const root = opts.root || join(process.cwd(), '.planning', 'sketches');
  const now = opts.now instanceof Date ? opts.now : new Date();
  const maxAgeMs =
    typeof opts.maxAgeDays === 'number'
      ? opts.maxAgeDays * MS_PER_DAY
      : typeof opts.maxAgeMs === 'number'
        ? opts.maxAgeMs
        : DEFAULT_MAX_AGE_DAYS * MS_PER_DAY;
  const dryRun = opts.dryRun === true;

  const archived = [];
  const skipped = [];
  const archiveDir = join(root, '.archive');
  const scannedAt = now.toISOString();

  if (!existsSync(root)) {
    return { archived, skipped, scannedAt, archiveDir, root };
  }

  // Ensure archive dir exists (unless dry-run, then we just record intent).
  if (!dryRun && !existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true, mode: 0o755 });
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { archived, skipped: [{ path: root, reason: `readdir-failed: ${e.code || e.message}` }], scannedAt, archiveDir, root };
  }

  for (const entry of entries) {
    const name = entry.name;
    // Skip the archive dir itself + dotfiles (hidden state, READMEs, etc.).
    if (name === '.archive') continue;
    if (name.startsWith('.')) {
      skipped.push({ path: join(root, name), reason: 'dotfile' });
      continue;
    }
    const src = join(root, name);
    let st;
    try {
      st = statSync(src);
    } catch (e) {
      skipped.push({ path: src, reason: `stat-failed: ${e.code || e.message}` });
      continue;
    }
    const ageMs = now.getTime() - st.mtimeMs;
    if (ageMs < maxAgeMs) {
      skipped.push({ path: src, reason: `fresh (age ${Math.round(ageMs / MS_PER_DAY)}d)` });
      continue;
    }

    // Resolve destination.  Collision -> suffix with timestamp.
    let dest = join(archiveDir, name);
    if (existsSync(dest)) {
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      dest = join(archiveDir, `${name}.${stamp}`);
    }

    if (dryRun) {
      archived.push({ from: src, to: dest, ageDays: Math.round(ageMs / MS_PER_DAY) });
      continue;
    }

    try {
      renameSync(src, dest);
      archived.push({ from: src, to: dest, ageDays: Math.round(ageMs / MS_PER_DAY) });
    } catch (e) {
      skipped.push({ path: src, reason: `rename-failed: ${e.code || e.message}` });
    }
  }

  return { archived, skipped, scannedAt, archiveDir, root };
}

/**
 * Human-readable summary of a GC result -- one line per category.
 * @param {ReturnType<typeof runSketchesGc>} result
 */
export function formatGcResult(result) {
  const lines = [];
  lines.push(`sketches-gc -- scanned ${result.root} at ${result.scannedAt}`);
  lines.push(`  archived: ${result.archived.length}`);
  for (const a of result.archived) {
    lines.push(`    ${basename(a.from)}  (${a.ageDays}d)  ->  ${a.to}`);
  }
  lines.push(`  skipped:  ${result.skipped.length}`);
  for (const s of result.skipped) {
    lines.push(`    ${basename(s.path)}  -- ${s.reason}`);
  }
  return lines.join('\n');
}
