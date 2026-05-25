// IJFW v1.5.2 -- one-shot migration: relocate FACTS_FILE + FACTS_DB_FILE to
// the internal hidden-paths location (Plan A audit F5).
//
// Plan A's lazy MEMORY_DIR refactor (Task 5) intentionally kept FACTS_FILE
// + FACTS_DB_FILE at <contentDir>/memory/ with a TODO comment, because moving
// them required a data migration outside Task 5's scope. F5 does that move:
//
//   .ijfw/memory/facts.jsonl  -> .ijfw/facts.jsonl
//   .ijfw/memory/facts.db     -> .ijfw/index/memory.db
//
// This matches the design contract from Task 3's paths.js: internal paths
// (indexDb, factsJsonl, stateDir, metricsDir, receiptsDir) ALWAYS live under
// .ijfw/, never under the visible ijfw/ content dir. Without this migration
// the post-Task-10 layout would move FACTS into ijfw/memory/ — the opposite
// of where they belong.
//
// Sync, idempotent, atomic (renameSync is a single syscall on POSIX). Runs at
// server startup; safe to call repeatedly. Crash mid-migration leaves either
// the old or the new path populated, never both — operator can re-run
// safely.

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function migrateFactsInternalOnce(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    return { skipped: true, reason: 'no-repo-root' };
  }
  const oldJsonl = join(repoRoot, '.ijfw', 'memory', 'facts.jsonl');
  const newJsonl = join(repoRoot, '.ijfw', 'facts.jsonl');
  const oldDb = join(repoRoot, '.ijfw', 'memory', 'facts.db');
  const newDb = join(repoRoot, '.ijfw', 'index', 'memory.db');

  // Idempotent short-circuit: if EITHER new path exists, treat as migrated.
  // (We don't require both because a partial migration that crashed before
  // the second move would still be detectable on retry, but a fully
  // intentional standalone deployment of just one is operator-territory and
  // we don't second-guess it.)
  if (existsSync(newJsonl) || existsSync(newDb)) {
    // FLAG-7: detect orphans — if a legacy path ALSO exists alongside the
    // new path, surface it so the operator can clean up. Don't move
    // automatically (could overwrite real data); just flag.
    const orphans = [];
    if (existsSync(oldJsonl)) orphans.push(oldJsonl);
    if (existsSync(oldDb)) orphans.push(oldDb);
    return orphans.length > 0
      ? { skipped: true, reason: 'already-migrated', orphans }
      : { skipped: true, reason: 'already-migrated' };
  }

  const moved = [];
  if (existsSync(oldJsonl)) {
    mkdirSync(dirname(newJsonl), { recursive: true });
    renameSync(oldJsonl, newJsonl);
    moved.push({ from: oldJsonl, to: newJsonl });
  }
  if (existsSync(oldDb)) {
    mkdirSync(dirname(newDb), { recursive: true });
    renameSync(oldDb, newDb);
    moved.push({ from: oldDb, to: newDb });
  }
  return { skipped: false, moved };
}
