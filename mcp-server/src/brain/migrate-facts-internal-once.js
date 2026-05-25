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
  // v1.5.2.1 F3: 010 may have already copied facts.{jsonl,db} into the visible
  // layer at ijfw/memory/ before this migration runs. Those copies are NEVER
  // valid as a runtime source — facts always live at the internal paths
  // (paths().factsJsonl / paths().indexDb), and the visible-layer copies will
  // drift on the first write. Flag them so the operator can prune; do NOT
  // delete automatically (could destroy user data in extremis).
  const visibleJsonlOrphan = join(repoRoot, 'ijfw', 'memory', 'facts.jsonl');
  const visibleDbOrphan = join(repoRoot, 'ijfw', 'memory', 'facts.db');

  // Helper to extend the orphans list with any visible-layer facts files.
  const collectVisibleOrphans = (orphans) => {
    if (existsSync(visibleJsonlOrphan)) orphans.push(visibleJsonlOrphan);
    if (existsSync(visibleDbOrphan)) orphans.push(visibleDbOrphan);
    return orphans;
  };

  // Idempotent short-circuit: if EITHER new path exists, treat as migrated.
  // (We don't require both because a partial migration that crashed before
  // the second move would still be detectable on retry, but a fully
  // intentional standalone deployment of just one is operator-territory and
  // we don't second-guess it.)
  if (existsSync(newJsonl) || existsSync(newDb)) {
    // FLAG-7: detect orphans — if a legacy path ALSO exists alongside the
    // new path, surface it so the operator can clean up. Don't move
    // automatically (could overwrite real data); just flag. v1.5.2.1 also
    // detects the visible-layer facts files left by an earlier 010 run.
    const orphans = [];
    if (existsSync(oldJsonl)) orphans.push(oldJsonl);
    if (existsSync(oldDb)) orphans.push(oldDb);
    collectVisibleOrphans(orphans);
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
  // v1.5.2.1 F3: surface visible-layer facts orphans on the success path too,
  // in case 010 ran before 011 on this install. They're still wrong; operator
  // gets the same prune cue.
  const orphans = collectVisibleOrphans([]);
  return orphans.length > 0
    ? { skipped: false, moved, orphans }
    : { skipped: false, moved };
}
