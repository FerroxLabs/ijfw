// IJFW v1.3.0 -- D3 dream-cycle staleness wiring (GA fix-wave GA-B1).
//
// Source authority: PRD-v2 section 9 Pillar D D4 + .planning/1.3.0/D-PILLAR-SPEC.md
// section 2 (cascading staleness propagation) + GA fix-wave finding GA-B1.
//
// PROBLEM (pre-fix-wave): the dream-cycle runner calls D1's
// promoteEpisodicToSemantic to fire the Episodic -> Semantic supersession,
// but then stops. propagateStale (D4) ships as a primitive with full
// grader coverage and zero production callers. End-to-end the chain
//   Working -> Episodic -> Semantic (supersession) -> propagateStale
// does not fire.
//
// FIX: this module is invoked by mcp-server/src/dream/runner.mjs after
// promoteEpisodicToSemantic returns a non-empty `superseded` array. For
// each superseded Episodic body:
//   1. Re-extract entities (D2 extractEntities) from the body.
//   2. Open the compute db (where kg_nodes / kg_edges live).
//   3. Acquire .graph-write.lock for the propagation window.
//   4. For each clean entity, look up kg_nodes by (kind, name).
//   5. Call propagateStale on each found id.
//   6. Aggregate the per-supersession envelopes into a single summary.
//
// LOCK: .graph-write.lock is acquired ONCE for the whole batch so we
// don't thrash the lock file for every node lookup. propagateStale
// itself does not acquire (per its module header) -- the caller owns
// the window.
//
// FAILURE: every step is wrapped so a single bad supersession can't
// abort the dream cycle. The runner is best-effort consolidation, not
// integrity-critical work.

import { extractEntities } from '../compute/extract.js';
import { propagateStale } from '../compute/staleness.js';
import { propagateStaleMemory } from '../memory/staleness.js';
import { acquireGraphWriteLock } from '../compute/graph-lock.js';
import { openDb as openComputeDb, closeDb as closeComputeDb } from '../compute/fts5.js';
import { openDb as openMemoryDb, closeDb as closeMemoryDb } from '../memory/fts5.js';

/**
 * propagateStaleForSupersessions({ projectRoot, supersededEntries, log }) -> summary
 *
 * Walks each superseded Episodic record:
 *   - extractEntities(body) -> entity list
 *   - filter clean entities (redacted=0)
 *   - for each, query kg_nodes by (kind, name) for an existing id
 *   - propagateStale(db, id) under a held .graph-write.lock
 *
 * Returns:
 *   {
 *     superseded_count: number,        // input length
 *     entities_resolved: number,       // total clean entities mapped to kg_nodes
 *     nodes_propagated: number,        // total propagateStale invocations that fired
 *     flagged_total: number,           // sum of envelope.flagged_count across calls
 *     errors: string[],                // accumulated swallowed errors (for log)
 *   }
 *
 * `log(msg)` is the runner's log helper (best-effort, never throws). If
 * absent, defaults to a no-op so this module is safe to call from
 * non-runner contexts (e.g. unit tests).
 */
export async function propagateStaleForSupersessions({ projectRoot, supersededEntries, log }) {
  const summary = {
    superseded_count: 0,
    entities_resolved: 0,
    nodes_propagated: 0,
    flagged_total: 0,
    flagged_compute: 0,
    flagged_memory: 0,
    errors: [],
  };

  const logger = typeof log === 'function' ? log : () => {};
  const entries = Array.isArray(supersededEntries) ? supersededEntries : [];
  summary.superseded_count = entries.length;
  if (entries.length === 0) return summary;
  if (typeof projectRoot !== 'string' || !projectRoot) {
    summary.errors.push('propagateStaleForSupersessions: projectRoot required');
    return summary;
  }

  let computeDb = null;
  let memDb = null;
  let lock = null;
  try {
    computeDb = await openComputeDb(projectRoot);
    if (!hasGraphTables(computeDb)) {
      logger('propagateStaleForSupersessions: kg_nodes table absent (compute migrations not run); skip');
      return summary;
    }
    // GA real fix-wave F2: also open memory db so we can propagate to
    // memory_entries.stale_candidate. Open is best-effort -- a missing
    // memory db (fresh project, dream cycle running before any memory
    // ingest) just means no memory rows exist yet to flag, which is
    // fine. Keep going with compute-only propagation in that case.
    try {
      memDb = await openMemoryDb(projectRoot);
    } catch (err) {
      logger(`propagateStaleForSupersessions: memory db open skipped (${err && err.message ? err.message : err}); compute-only propagation`);
      memDb = null;
    }
    lock = acquireGraphWriteLock(projectRoot, { waitMs: 5000 });
  } catch (err) {
    summary.errors.push(`propagateStaleForSupersessions: setup failed (${err && err.message ? err.message : err})`);
    if (lock) { try { lock.released(); } catch { /* ignore */ } }
    if (computeDb) { try { closeComputeDb(computeDb); } catch { /* ignore */ } }
    if (memDb) { try { closeMemoryDb(memDb); } catch { /* ignore */ } }
    return summary;
  }

  try {
    const lookupNode = computeDb.prepare(
      `SELECT id, redacted FROM kg_nodes WHERE kind = ? AND name = ?`
    );
    for (const sup of entries) {
      const body = sup && typeof sup.body === 'string' ? sup.body : '';
      if (!body) continue;
      let entities;
      try {
        entities = extractEntities(body, { minMentions: 1 });
      } catch (err) {
        summary.errors.push(`extractEntities for episodic id=${sup.id}: ${err && err.message ? err.message : err}`);
        continue;
      }
      if (!entities || entities.length === 0) continue;

      // Map each clean entity to a kg_node id; redacted entities are
      // skipped (they never seed kg_nodes per D-PILLAR-SPEC section 3).
      const nodeIds = new Set();
      for (const ent of entities) {
        if (ent.redacted) continue;
        try {
          const row = lookupNode.get(ent.kind, ent.name);
          if (!row) continue;
          if (Number(row.redacted) === 1) continue;
          nodeIds.add(Number(row.id));
        } catch (err) {
          summary.errors.push(`lookupNode ${ent.kind}:${ent.name}: ${err && err.message ? err.message : err}`);
        }
      }
      summary.entities_resolved += nodeIds.size;
      if (nodeIds.size === 0) continue;

      // Fire propagateStale on each resolved kg_node id. Each call
      // walks BFS depth_cap=2 and flags downstream observations on
      // BOTH the compute store (raw + compiled) AND the memory store
      // (memory_entries.stale_candidate). Pre-F2 only the compute side
      // ran; the memory column existed but was never written.
      for (const id of nodeIds) {
        try {
          const env = propagateStale(computeDb, id);
          summary.nodes_propagated++;
          summary.flagged_compute += Number(env.flagged_count || 0);
          summary.flagged_total += Number(env.flagged_count || 0);
        } catch (err) {
          summary.errors.push(`propagateStale id=${id}: ${err && err.message ? err.message : err}`);
        }
        // GA real fix-wave F2: memory-side propagation. Walks the same
        // compute kg BFS frontier but writes to memory_entries.
        if (memDb) {
          try {
            const memEnv = propagateStaleMemory(memDb, computeDb, id);
            summary.flagged_memory += Number(memEnv.flagged_count || 0);
            summary.flagged_total += Number(memEnv.flagged_count || 0);
          } catch (err) {
            summary.errors.push(`propagateStaleMemory id=${id}: ${err && err.message ? err.message : err}`);
          }
        }
      }
    }
  } finally {
    if (lock) { try { lock.released(); } catch { /* best-effort */ } }
    if (computeDb) { try { closeComputeDb(computeDb); } catch { /* best-effort */ } }
    if (memDb) { try { closeMemoryDb(memDb); } catch { /* best-effort */ } }
  }

  logger(`propagateStaleForSupersessions: superseded=${summary.superseded_count} entities=${summary.entities_resolved} nodes=${summary.nodes_propagated} flagged=${summary.flagged_total} (compute=${summary.flagged_compute} memory=${summary.flagged_memory}) errors=${summary.errors.length}`);
  return summary;
}

// --- helpers --------------------------------------------------------------

function hasGraphTables(db) {
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_nodes'`
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

export const __test = { hasGraphTables };

export default { propagateStaleForSupersessions };
