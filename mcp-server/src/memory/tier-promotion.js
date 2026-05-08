// IJFW v1.3.0 -- D1 tier promotion logic.
//
// Source authority: .planning/1.3.0/D-PILLAR-SPEC.md §1 (tier promotion rules).
//
// Implements the four promotion edges defined in the spec:
//
//   Working   -> Episodic    at SessionEnd boundary (called by D3 hook)
//   Episodic  -> Semantic    when supersession fires in dream cycle
//                            (Jaccard similarity > 0.7 OR explicit
//                             `promote: semantic` tag)
//   Working   -> Procedural  from TaskUpdate completed events with task
//                            duration >= 5 minutes (then dream-cycle
//                            pattern matcher confirms 3+ similar
//                            task->commit chains -- tracked here as
//                            `procedural_candidate` rows; final
//                            confirmation deferred to dream cycle module)
//   Semantic  -> archived    NO promotion in alpha
//
// Each promotion function returns `{ promoted: <int>, errors: [<string>...] }`.
// Errors are caught per-row so one bad source doesn't abort the batch --
// the dream cycle and SessionEnd hook are best-effort consolidation, not
// integrity-critical writes.
//
// Promotions are ADDITIVE: the source row is preserved in place (audit
// trail). The destination row is a NEW INSERT with the new tier_semantic
// label and a `source` pointer referencing the originating record.
//
// Concurrency: each promotion function opens its own write tx via
// db.txn(...) (BEGIN IMMEDIATE) so a SessionEnd consolidation racing a
// dream-cycle scan serialises cleanly through the busy_timeout=5000 +
// RESERVED lock pattern from fts5.js.

import { tokenizeBody, jaccardSimilarity } from './tokenize.js';

// Constants from D-PILLAR-SPEC §1.
const JACCARD_THRESHOLD = 0.7;
const PROCEDURAL_MIN_DURATION_MS = 5 * 60 * 1000;
const PROCEDURAL_PATTERN_MIN_CHAINS = 3;

// Sentinel tier_semantic values. These are the only valid labels; callers
// that filter by tier should use these constants to avoid drift.
export const TIERS = Object.freeze({
  WORKING: 'working',
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
  PROCEDURAL: 'procedural',
  PROCEDURAL_CANDIDATE: 'procedural_candidate',
});

// --- Working -> Episodic ---------------------------------------------------

/**
 * Promote Working tier observations from the just-ended session into a
 * single Episodic summary record. Per D-PILLAR-SPEC §1, this is invoked
 * at SessionEnd boundary by the D3 hook; it is idempotent per session
 * (a session that's already been consolidated is skipped).
 *
 * Strategy:
 *   1. Find Working memory_entries with this session_id.
 *   2. If none, no-op (return promoted: 0).
 *   3. If an Episodic record already exists for this session_id, skip
 *      (idempotency).
 *   4. Otherwise INSERT one new memory_entry with tier_semantic='episodic',
 *      body = concatenated bodies, source = `session:<id>:episodic`,
 *      session_id = same.
 *
 * @param {object} db        better-sqlite3 handle (or compatible)
 * @param {object} opts
 * @param {string} opts.session_id   the just-ended session
 * @returns {{ promoted: number, errors: string[] }}
 */
export function promoteWorkingToEpisodic(db, opts = {}) {
  const errors = [];
  if (!db || typeof db.prepare !== 'function') {
    return { promoted: 0, errors: ['promoteWorkingToEpisodic: invalid db handle'] };
  }
  const session_id = opts.session_id;
  if (typeof session_id !== 'string' || session_id.length === 0) {
    return { promoted: 0, errors: ['promoteWorkingToEpisodic: session_id required'] };
  }

  let promoted = 0;
  try {
    // Idempotency: skip if Episodic for this session already exists.
    const existing = db.prepare(
      `SELECT id FROM memory_entries
        WHERE session_id = ? AND tier_semantic = ? LIMIT 1`
    ).get(session_id, TIERS.EPISODIC);
    if (existing) return { promoted: 0, errors: [] };

    // Working observations for this session.
    const workingRows = db.prepare(
      `SELECT id, body, source FROM memory_entries
        WHERE session_id = ? AND tier_semantic = ?
        ORDER BY created_at ASC`
    ).all(session_id, TIERS.WORKING);

    if (workingRows.length === 0) return { promoted: 0, errors: [] };

    // Concatenate bodies into one Episodic summary. Real D3 hook will
    // call an extract-session-summary helper; this minimal version just
    // joins bodies so the tier transition is exercised end-to-end.
    const summary = workingRows.map(r => r.body).join('\n\n---\n\n');
    const sourcePtr = `session:${session_id}:episodic`;

    const tx = db.txn(() => {
      const stmt = db.prepare(
        `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
         VALUES (?, ?, ?, ?, ?)`
      );
      stmt.run(summary, sourcePtr, session_id, Date.now(), TIERS.EPISODIC);
      promoted = 1;
    });
    tx();
  } catch (err) {
    errors.push(`promoteWorkingToEpisodic: ${err.message}`);
  }

  return { promoted, errors };
}

// --- Episodic -> Semantic --------------------------------------------------

/**
 * Promote Episodic records to Semantic when supersession criteria are met.
 *
 * Per D-PILLAR-SPEC §1 trigger A (explicit) + trigger B (supersession):
 *   A. If an Episodic record's `source` carries the literal substring
 *      `promote:semantic` (set by user via slash command or skill), promote.
 *   B. If two Episodic records have token-set Jaccard similarity > 0.7,
 *      promote the LATER one to Semantic and leave the earlier as the
 *      audit-trail source row.
 *
 * Promotion writes a new memory_entry with tier_semantic='semantic'. The
 * source pointer references the Episodic row that triggered promotion.
 *
 * Idempotent: skips Episodic records that already have a Semantic
 * counterpart (matched by source pointer `episodic:<id>:semantic`).
 *
 * @param {object} db
 * @returns {{ promoted: number, errors: string[] }}
 */
export function promoteEpisodicToSemantic(db) {
  const errors = [];
  if (!db || typeof db.prepare !== 'function') {
    return { promoted: 0, errors: ['promoteEpisodicToSemantic: invalid db handle'] };
  }

  let promoted = 0;
  try {
    const episodics = db.prepare(
      `SELECT id, body, source, session_id FROM memory_entries
        WHERE tier_semantic = ?
        ORDER BY created_at ASC`
    ).all(TIERS.EPISODIC);

    if (episodics.length === 0) return { promoted: 0, errors: [], superseded: [] };

    // Already-promoted set: every Semantic row whose source pointer
    // matches `episodic:<id>:semantic` shape.
    const semantics = db.prepare(
      `SELECT source FROM memory_entries WHERE tier_semantic = ?`
    ).all(TIERS.SEMANTIC);
    const alreadyPromoted = new Set();
    for (const s of semantics) {
      const m = String(s.source || '').match(/^episodic:(\d+):semantic$/);
      if (m) alreadyPromoted.add(Number(m[1]));
    }

    // Pre-tokenize bodies for Jaccard sweep.
    const tokenized = episodics.map(r => ({
      ...r,
      tokens: tokenizeBody(r.body),
    }));

    // Sweep: trigger A (explicit tag) takes precedence over B
    // (supersession). For B, only consider pairs where the earlier id <
    // the later id; promote the LATER row.
    const toPromote = new Map(); // id -> { source_id, reason }

    // Trigger A.
    for (const r of tokenized) {
      if (alreadyPromoted.has(r.id)) continue;
      const src = String(r.source || '');
      if (src.includes('promote:semantic')) {
        toPromote.set(r.id, { source_id: r.id, reason: 'explicit' });
      }
    }

    // Trigger B.
    for (let i = 0; i < tokenized.length; i++) {
      const a = tokenized[i];
      for (let j = i + 1; j < tokenized.length; j++) {
        const b = tokenized[j];
        if (alreadyPromoted.has(b.id) || toPromote.has(b.id)) continue;
        const sim = jaccardSimilarity(a.tokens, b.tokens);
        if (sim > JACCARD_THRESHOLD) {
          toPromote.set(b.id, { source_id: a.id, reason: `jaccard=${sim.toFixed(3)}` });
        }
      }
    }

    if (toPromote.size === 0) return { promoted: 0, errors: [], superseded: [] };

    // GA-B1: expose the per-promotion record so the dream-cycle runner
    // can walk D4 propagateStale on each freshly-superseded Episodic
    // body. Each entry carries the superseded Episodic row's id +
    // body so the caller can re-extract entities and BFS the symbol
    // graph from there. `reason` echoes the trigger ('explicit' or
    // 'jaccard=<sim>').
    const supersededDetails = [];
    const tx = db.txn(() => {
      const stmt = db.prepare(
        `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
         VALUES (?, ?, ?, ?, ?)`
      );
      const idx = new Map(tokenized.map(r => [r.id, r]));
      for (const [id, info] of toPromote.entries()) {
        const row = idx.get(id);
        if (!row) continue;
        const sourcePtr = `episodic:${id}:semantic`;
        stmt.run(row.body, sourcePtr, row.session_id, Date.now(), TIERS.SEMANTIC);
        promoted++;
        supersededDetails.push({
          id,
          body: row.body,
          session_id: row.session_id,
          source_id: info.source_id,
          reason: info.reason,
        });
      }
    });
    tx();
    return { promoted, errors, superseded: supersededDetails };
  } catch (err) {
    errors.push(`promoteEpisodicToSemantic: ${err.message}`);
  }

  return { promoted, errors, superseded: [] };
}

// --- Working -> Procedural -------------------------------------------------

/**
 * Promote Working tier observations into a procedural_candidate (and on
 * pattern match, into Procedural) per D-PILLAR-SPEC §1.
 *
 * Caller provides a TaskUpdate event:
 *   { task_id, status, start_ts, end_ts, body, session_id, commit_tags? }
 *
 * Behaviour:
 *   - status !== 'completed' OR duration < 5min -> no-op
 *   - status === 'completed' AND duration >= 5min:
 *       1. INSERT procedural_candidate row with body = TaskUpdate.body and
 *          source = `task:<task_id>:procedural_candidate`
 *       2. Look back at recent procedural_candidates with same session_id
 *          family / similar body (Jaccard > 0.7 against the candidate set);
 *          if 3+ similar chains found, promote the candidate (and matched
 *          older candidates) to Procedural with a composite source
 *          pointer.
 *
 * The pattern-match promotion is intentionally simple in alpha: token-set
 * similarity, no LLM-side semantics. The dream cycle module is free to
 * call promoteWorkingToProcedural many times; idempotency is enforced by
 * source pointer uniqueness on each insert.
 *
 * @param {object} db
 * @param {object} taskUpdate
 * @returns {{ promoted: number, errors: string[] }}
 */
export function promoteWorkingToProcedural(db, taskUpdate = {}) {
  const errors = [];
  if (!db || typeof db.prepare !== 'function') {
    return { promoted: 0, errors: ['promoteWorkingToProcedural: invalid db handle'] };
  }

  const status = String(taskUpdate.status || '');
  if (status !== 'completed') return { promoted: 0, errors: [] };

  const start = Number(taskUpdate.start_ts || 0);
  const end = Number(taskUpdate.end_ts || 0);
  const duration = end - start;
  if (!Number.isFinite(duration) || duration < PROCEDURAL_MIN_DURATION_MS) {
    return { promoted: 0, errors: [] };
  }

  const task_id = taskUpdate.task_id || '';
  const session_id = taskUpdate.session_id || null;
  const body = String(taskUpdate.body || '');
  if (!task_id || !body) {
    return { promoted: 0, errors: ['promoteWorkingToProcedural: task_id and body required'] };
  }

  let promoted = 0;
  try {
    const candidatePtr = `task:${task_id}:procedural_candidate`;

    // Idempotency: if this task already has a candidate row, don't
    // double-write.
    const existing = db.prepare(
      `SELECT id FROM memory_entries WHERE source = ? LIMIT 1`
    ).get(candidatePtr);

    const tx = db.txn(() => {
      if (!existing) {
        const stmt = db.prepare(
          `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
           VALUES (?, ?, ?, ?, ?)`
        );
        stmt.run(body, candidatePtr, session_id, Date.now(), TIERS.PROCEDURAL_CANDIDATE);
        promoted++;
      }

      // Pattern match: find existing candidates and check similarity.
      // Promote if 3+ similar chains.
      const candidates = db.prepare(
        `SELECT id, body, source FROM memory_entries
          WHERE tier_semantic = ?
          ORDER BY created_at ASC`
      ).all(TIERS.PROCEDURAL_CANDIDATE);

      const myTokens = tokenizeBody(body);
      let similarCount = 0;
      const matchedIds = [];
      for (const c of candidates) {
        const sim = jaccardSimilarity(myTokens, tokenizeBody(c.body));
        if (sim > JACCARD_THRESHOLD) {
          similarCount++;
          matchedIds.push(c.id);
        }
      }

      if (similarCount >= PROCEDURAL_PATTERN_MIN_CHAINS) {
        // Confirmed Procedural. Write a new row with composite source
        // pointer, leaving candidates in place as audit trail.
        const proceduralPtr =
          `procedural:from-candidates:${matchedIds.join(',')}`;
        // Idempotency: don't double-promote the same candidate set.
        const already = db.prepare(
          `SELECT id FROM memory_entries WHERE source = ? LIMIT 1`
        ).get(proceduralPtr);
        if (!already) {
          const stmt2 = db.prepare(
            `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
             VALUES (?, ?, ?, ?, ?)`
          );
          stmt2.run(body, proceduralPtr, session_id, Date.now(), TIERS.PROCEDURAL);
          promoted++;
        }
      }
    });
    tx();
  } catch (err) {
    errors.push(`promoteWorkingToProcedural: ${err.message}`);
  }

  return { promoted, errors };
}

// --- Semantic -> archived (alpha no-op) ------------------------------------

/**
 * Per D-PILLAR-SPEC §1: no promotion in alpha. Function exists so callers
 * that wire up the four-edge state machine don't get an undefined-import
 * error; returns a no-op shape consistent with the others.
 */
export function promoteSemanticToArchived(_db) {
  return { promoted: 0, errors: [] };
}

export default {
  TIERS,
  promoteWorkingToEpisodic,
  promoteEpisodicToSemantic,
  promoteWorkingToProcedural,
  promoteSemanticToArchived,
};
