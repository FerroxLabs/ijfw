/**
 * termination.js — Composable termination conditions for orchestrator loops
 * (v1.5.0 audit-MED-work-M3, AutoGen-style API).
 *
 * Every condition is a function `(iter: number, state: object) => boolean`
 * returning TRUE iff the loop should stop. Conditions compose via `or` (any
 * fires) and `and` (all fire). The `runtime-loop.js` wrappers accept an
 * optional `termination:` predicate; default behaviour is `MaxAttempts(N)`.
 *
 * State shape passed by the loop caller — fields are read defensively so
 * conditions can be combined without worrying about which is "responsible"
 * for which field:
 *   {
 *     startTimestamp?: number,   // unix ms (or seconds — see WallClockTimeout)
 *     tokensUsed?:    number,    // running total
 *     findings?:      Array<{ severity: 'HIGH'|'MEDIUM'|'LOW'|'INFO' }>,
 *   }
 */

// ---------------------------------------------------------------------------
// Atomic conditions
// ---------------------------------------------------------------------------

/**
 * Stop after `maxAttempts` iterations (iter is 0-indexed; condition fires
 * when `iter + 1 >= maxAttempts`, i.e. after the Nth attempt completes).
 *
 * @param {number} maxAttempts  positive integer
 * @returns {(iter: number, state?: object) => boolean}
 */
export function MaxAttempts(maxAttempts) {
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`MaxAttempts: maxAttempts must be >= 1, got ${maxAttempts}`);
  }
  return (iter /* , _state */) => iter + 1 >= maxAttempts;
}

/**
 * Stop after `budgetMs` milliseconds of wall-clock have elapsed since
 * `state.startTimestamp` (which the caller must initialise — usually
 * `Date.now()` before the first iteration).
 *
 * Defensive: missing/non-number startTimestamp falls back to never-firing
 * (a misconfigured timeout shouldn't accidentally terminate the loop).
 *
 * @param {number} budgetMs
 * @returns {(iter: number, state: object) => boolean}
 */
export function WallClockTimeout(budgetMs) {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new TypeError(`WallClockTimeout: budgetMs must be >= 0, got ${budgetMs}`);
  }
  return (_iter, state) => {
    const start = state && typeof state.startTimestamp === 'number' ? state.startTimestamp : null;
    if (start === null) return false;
    return Date.now() - start >= budgetMs;
  };
}

/**
 * Stop once `state.tokensUsed` reaches or exceeds `maxTokens`. Defensive:
 * non-number tokensUsed never fires (so callers can opt in without poisoning
 * loops that don't track tokens).
 *
 * @param {number} maxTokens
 * @returns {(iter: number, state: object) => boolean}
 */
export function TokenBudget(maxTokens) {
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new TypeError(`TokenBudget: maxTokens must be >= 0, got ${maxTokens}`);
  }
  return (_iter, state) => {
    const used = state && typeof state.tokensUsed === 'number' ? state.tokensUsed : null;
    if (used === null) return false;
    return used >= maxTokens;
  };
}

/**
 * Stop when `state.findings` contains at least one finding of `severity` or
 * higher. Severity ladder (high → low): HIGH > MEDIUM > LOW > INFO.
 *
 * @param {'HIGH'|'MEDIUM'|'LOW'|'INFO'} severity
 * @returns {(iter: number, state: object) => boolean}
 */
export function FindingSeverity(severity) {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  const threshold = rank[severity];
  if (threshold === undefined) {
    throw new TypeError(
      `FindingSeverity: severity must be one of HIGH|MEDIUM|LOW|INFO, got ${severity}`,
    );
  }
  return (_iter, state) => {
    const findings = state && Array.isArray(state.findings) ? state.findings : null;
    if (!findings) return false;
    return findings.some((f) => {
      const sev = f && typeof f.severity === 'string' ? f.severity.toUpperCase() : null;
      return sev !== null && (rank[sev] ?? -1) >= threshold;
    });
  };
}

// ---------------------------------------------------------------------------
// Composition combinators
// ---------------------------------------------------------------------------

/**
 * Compose: stop iff ANY of the given conditions stop. Mirrors AutoGen's `|`
 * operator on termination conditions.
 *
 * @param {...((iter: number, state: object) => boolean)} conds
 * @returns {(iter: number, state: object) => boolean}
 */
export function or(...conds) {
  return (iter, state) => conds.some((c) => c(iter, state));
}

/**
 * Compose: stop iff ALL of the given conditions stop. Mirrors AutoGen's `&`
 * operator on termination conditions.
 *
 * @param {...((iter: number, state: object) => boolean)} conds
 * @returns {(iter: number, state: object) => boolean}
 */
export function and(...conds) {
  // Empty-and is true (trivially satisfied), but we treat the empty-arg case
  // as "never stop" — explicit-is-better-than-implicit.
  if (conds.length === 0) return () => false;
  return (iter, state) => conds.every((c) => c(iter, state));
}

/**
 * Negation — stop iff `cond` does NOT stop. Rarely useful alone; included
 * for parity with the boolean algebra.
 *
 * @param {(iter: number, state: object) => boolean} cond
 * @returns {(iter: number, state: object) => boolean}
 */
export function not(cond) {
  return (iter, state) => !cond(iter, state);
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

/**
 * Default termination used by `runtime-loop.js` callers that didn't pass an
 * explicit predicate. Currently MaxAttempts(REVIEW_MAX_ITERATIONS) — matches
 * the v1.4.4 N3 behaviour (re-review caps at 3 iterations).
 *
 * Caller is free to pass their own predicate via the `termination:` arg.
 *
 * @param {number} [maxAttempts=3]
 * @returns {(iter: number, state?: object) => boolean}
 */
export function defaultTermination(maxAttempts = 3) {
  return MaxAttempts(maxAttempts);
}
