// --- Trident audit dispatcher (C9.7) ---
//
// Orchestrates a 3-lens Trident audit with degraded-mode handling:
//
//   3/3 live -> full Trident, can produce PASS verdict.
//   2/3 live -> CONDITIONAL verdict possible; never auto-PASS.
//   1/3 live -> single-lens degraded; returns WARN/FLAG only. NEVER PASS.
//   0/3 live -> offline; throws DegradedTridentError unconditionally.
//
// Release-blocker gates (publish, tag, deploy) MUST pass `accept_degraded:
// true` to bypass single-lens guard. Otherwise the dispatcher throws
// DegradedTridentError so the calling release pipeline halts before doing
// anything irreversible.
//
// The actual lens execution is pluggable via `executor` so tests can stub
// without spawning real Codex/Gemini/Claude calls. Production executor lives
// alongside cross-orchestrator.js (existing surface).
//
// Zero external deps. ESM. No emoji.

import { probeLenses } from './lens-health.js';

// Custom error so callers can distinguish degraded-rejection from a normal
// audit failure. Carries the lens-health snapshot for diagnostic output.
export class DegradedTridentError extends Error {
  constructor(message, { lensHealth, gate, requested_accept_degraded } = {}) {
    super(message);
    this.name = 'DegradedTridentError';
    this.code = 'TRIDENT_DEGRADED';
    this.lensHealth = lensHealth || null;
    this.gate = gate || null;
    this.requested_accept_degraded = !!requested_accept_degraded;
  }
}

// Gates that block on degraded mode unless explicitly overridden.
// Kept in module scope so callers don't have to memorise the list.
export const RELEASE_BLOCKER_GATES = new Set([
  'publish',
  'tag',
  'deploy',
  'release',
]);

// Severity ordering used to coerce verdicts down. Higher = more severe.
const VERDICT_RANK = {
  PASS:        0,
  CONDITIONAL: 1,
  WARN:        2,
  FLAG:        3,
  FAIL:        4,
};

function rankOf(v) {
  if (v == null) return VERDICT_RANK.WARN;
  const up = String(v).toUpperCase();
  return VERDICT_RANK[up] != null ? VERDICT_RANK[up] : VERDICT_RANK.WARN;
}

// Coerce a verdict so it never sits below `floor`. Used to enforce the
// single-lens NEVER-auto-PASS rule.
function coerceVerdict(verdict, floor) {
  const r = rankOf(verdict);
  const f = rankOf(floor);
  if (r >= f) return String(verdict || floor).toUpperCase();
  return String(floor).toUpperCase();
}

// Default executor for tests / stubs. Production callers pass their own.
// Receives ({ lens, brief }), returns { verdict, findings, latency_ms }.
async function defaultExecutor({ lens }) {
  return {
    lens,
    verdict: 'PASS',
    findings: [],
    latency_ms: 0,
    note: 'default-stub-executor',
  };
}

// runTrident -- top-level orchestrator.
//
//   opts:
//     brief             -- string, the audit target/prompt. Required.
//     accept_degraded   -- bool. Default false. If true, single-lens runs
//                          may return non-PASS verdicts but are still
//                          flagged with mode 'single-lens-accepted'.
//     gate              -- string. If in RELEASE_BLOCKER_GATES, degraded
//                          runs throw unless accept_degraded=true.
//     executor          -- ({lens,brief}) -> Promise<{verdict, findings, ...}>
//     probeOpts         -- forwarded to probeLenses (e.g. { fresh: true })
//     which             -- which lenses to probe (default all three)
//
// Returns:
//     { verdict, mode, live_lenses, dead_lenses, lens_results, lens_health }
//
// `mode` values:
//     'full'                     -- 3/3 live, PASS allowed
//     'partial'                  -- 2/3 live, CONDITIONAL ceiling
//     'single-lens-degraded'     -- 1/3 live, WARN ceiling (caller didn't accept)
//     'single-lens-accepted'     -- 1/3 live, accept_degraded=true, non-PASS verdicts
//     'offline'                  -- 0/3 live (only reachable when not throwing)
export async function runTrident(opts = {}) {
  const {
    brief,
    accept_degraded = false,
    gate = null,
    executor = defaultExecutor,
    probeOpts = {},
    which = { codex: true, gemini: true, claude: true },
  } = opts;

  if (!brief || typeof brief !== 'string') {
    throw new Error('runTrident: `brief` (string) is required');
  }

  // 1. Probe lens health.
  const lensHealth = await probeLenses(which, probeOpts);
  const summary = lensHealth.summary || { live_count: 0, total: 0, live_lenses: [], dead_lenses: [], mode: 'offline' };
  const live = summary.live_lenses;
  const dead = summary.dead_lenses;

  // 2. Release-blocker gating: degraded + release-blocker + no override -> throw.
  const isReleaseBlocker = gate && RELEASE_BLOCKER_GATES.has(String(gate).toLowerCase());
  const isDegraded = summary.live_count <= 1;

  if (isReleaseBlocker && isDegraded && !accept_degraded) {
    throw new DegradedTridentError(
      `Trident is degraded (${summary.live_count}/${summary.total} lenses live: ${live.join(', ') || 'none'}). ` +
      `Release-blocker gate "${gate}" rejects single-lens verdicts. Pass accept_degraded:true to override after human review.`,
      { lensHealth, gate, requested_accept_degraded: accept_degraded }
    );
  }

  // 3. Offline -> always throw, regardless of gate. No lenses = no audit.
  if (summary.live_count === 0) {
    throw new DegradedTridentError(
      'Trident offline: no lenses live. Cannot run audit.',
      { lensHealth, gate, requested_accept_degraded: accept_degraded }
    );
  }

  // 4. Run executor against each live lens in parallel.
  const lensResults = await Promise.all(
    live.map(async (lens) => {
      try {
        const r = await executor({ lens, brief });
        return { lens, ok: true, ...r };
      } catch (err) {
        return {
          lens,
          ok: false,
          verdict: 'FAIL',
          findings: [],
          error: err && err.message ? err.message : String(err),
        };
      }
    })
  );

  // 5. Determine effective mode + verdict floor.
  let mode;
  let floor;
  if (summary.live_count >= 3) {
    mode = 'full';
    floor = 'PASS';
  } else if (summary.live_count === 2) {
    mode = 'partial';
    // 2/3 can return CONDITIONAL at best; PASS is reserved for 3/3.
    floor = 'CONDITIONAL';
  } else { // single-lens
    if (accept_degraded) {
      mode = 'single-lens-accepted';
      // Caller accepted reduced confidence. Verdict floor = CONDITIONAL.
      // PASS is still impossible -- one lens cannot produce 3-lens consensus.
      floor = 'CONDITIONAL';
    } else {
      mode = 'single-lens-degraded';
      // Hard ceiling: WARN. Never PASS, never CONDITIONAL.
      floor = 'WARN';
    }
  }

  // 6. Aggregate verdict: take the max severity reported by any lens, then
  //    coerce up to the floor for the current mode.
  let aggregateVerdict = 'PASS';
  for (const r of lensResults) {
    if (rankOf(r.verdict) > rankOf(aggregateVerdict)) {
      aggregateVerdict = String(r.verdict || 'WARN').toUpperCase();
    }
  }
  const finalVerdict = coerceVerdict(aggregateVerdict, floor);

  return {
    verdict: finalVerdict,
    mode,
    live_lenses: live,
    dead_lenses: dead,
    lens_results: lensResults,
    lens_health: lensHealth,
    accept_degraded: !!accept_degraded,
    gate: gate || null,
  };
}

// Convenience: surface a one-line health string for narration.
export function summariseLensHealth(lensHealth) {
  const s = lensHealth && lensHealth.summary;
  if (!s) return 'lens health: unknown';
  return `lens health: ${s.live_count}/${s.total} live (${s.live_lenses.join(', ') || 'none'})`;
}
