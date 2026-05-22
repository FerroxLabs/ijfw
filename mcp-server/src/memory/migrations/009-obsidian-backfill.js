// IJFW v1.5.1 -- memory migration 009: M1 obsidian-index backfill.
//
// Source authority: Trident r5 finding 1.2 (HIGH).
//
// Round-4 Fix-1 (commit 3218812) wired M1 (Obsidian wikilink/tag/meta
// indexing -- indexObsidianRelations) and M2 (A-Mem auto-linking -- autoLink)
// into the production memory-write path (handleStore, search.js#autoIndex).
// But the fix is forward-only: every memory_entries row written during
// v1.5.0 -- when M1/M2 were bypassed -- has empty memory_links / memory_tags
// / memory_meta. An existing user upgrading to v1.5.1 got auto-linking +
// wikilink indexing only on NEW entries; their accumulated memory stayed
// un-indexed.
//
// This migration runs a ONE-TIME M1 backfill: it walks every existing
// memory_entries row and runs indexObsidianRelations over its body. M1 is:
//   - free       -- pure markdown parse, zero LLM / network / cost
//   - idempotent -- indexObsidianRelations does DELETE-then-INSERT per id,
//                   so re-applying produces identical aux rows
// which is exactly what makes it safe to run inside a schema migration: it
// runs once (user_version gates re-application), deterministically, and a
// crash rolls the whole txn back to user_version 8.
//
// M2 (autoLink) is NOT backfilled here -- it makes one LLM call per row and
// can cost real money over a large memory. M2 backfill is opt-in via the
// `ijfw memory reindex --m2` CLI verb, which is budget-gated (respects
// IJFW_AUTOLINK_BUDGET_USD / IJFW_AUTOLINK_OFF / IJFW_AUTOLINK_BACKFILL).
//
// Ordering: migration 001 creates memory_entries; migration 006 creates
// memory_links / memory_tags / memory_meta. Both run before 009, so by the
// time up() executes the source table and the three aux tables all exist.
//
// Crash safety: the migration runner wraps up() in BEGIN IMMEDIATE.
// backfillObsidianIndex's per-row indexObsidianRelations opens a nested
// SQLite transaction (savepoint) -- valid inside the outer txn -- and the
// whole thing rolls back to user_version 8 on any failure.

import { backfillObsidianIndex } from '../obsidian-parser.js';

export const VERSION = 9;
export const DESCRIPTION =
  'memory v1.5.1 -- one-time M1 obsidian-index backfill for pre-fix rows (Trident r5 1.2)';

export function up(db) {
  // backfillObsidianIndex tolerates a missing memory_entries table (returns
  // zero counts) so a brand-new db that jumps straight to v9 is a clean
  // no-op -- there are no pre-fix rows to backfill on a fresh install.
  backfillObsidianIndex(db);
}

export default { version: VERSION, description: DESCRIPTION, up };
