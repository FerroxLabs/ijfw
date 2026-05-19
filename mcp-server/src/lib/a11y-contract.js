// a11y-contract.js -- v1.5.0 audit-MED-design-#11.
//
// Accessibility as part of the design contract.  Mirrors lighthouse-pillar.js:
// the actual axe-core run is performed by a peer tool (chrome-devtools-mcp's
// axe runner, the user's own playwright + @axe-core/playwright, etc.).  This
// module is the pure-stdlib evaluator that:
//
//   1. Reads `a11y_target: <WCAG-id>` + `max_violations: <N>` from UI-SPEC.md
//      (already parsed by uispec-drift.js → parseUISpec).
//   2. Takes the raw axe-core result (array of violations) from the caller.
//   3. Returns {pass, violations, target, count, reason} where pass=false when
//      violations.length > maxViolations (default 0).
//
// Graceful-degrade: missing axe results → pass=null reason='axe-unavailable'.
//
// Exports:
//   - DEFAULT_A11Y_TARGET  -- 'WCAG-2.2-AA'
//   - DEFAULT_MAX_VIOLATIONS -- 0
//   - evaluateA11y(axeReport, contract?)
//   - axePromptFor(url, target)

export const DEFAULT_A11Y_TARGET = 'WCAG-2.2-AA';
export const DEFAULT_MAX_VIOLATIONS = 0;

/**
 * Evaluate an axe-core violations report.
 *
 * Accepts shapes:
 *   - axe-core full result: { violations: [...], passes: [...], incomplete: [...] }
 *   - bare array of violations: [{ id, impact, ... }, ...]
 *   - { violations: [...] }
 *
 * @param {object|Array|null|undefined} axeReport
 * @param {object} [contract]
 * @param {string} [contract.target]          a11y_target ID
 * @param {number} [contract.maxViolations]   max allowed
 * @param {string[]} [contract.severityFilter]  Only count violations whose
 *   `impact` is in this set; default ['critical','serious'].  Pass `['*']`
 *   to count all severities.
 * @returns {{pass: boolean|null, count: number|null, violations: Array, target: string, reason: string, maxViolations: number, severityFilter: string[]}}
 */
export function evaluateA11y(axeReport, contract = {}) {
  const target = contract.target || DEFAULT_A11Y_TARGET;
  const maxViolations =
    typeof contract.maxViolations === 'number' ? contract.maxViolations : DEFAULT_MAX_VIOLATIONS;
  const severityFilter =
    Array.isArray(contract.severityFilter) && contract.severityFilter.length > 0
      ? contract.severityFilter
      : ['critical', 'serious'];

  if (axeReport == null) {
    return {
      pass: null,
      count: null,
      violations: [],
      target,
      reason: 'axe-unavailable',
      maxViolations,
      severityFilter,
    };
  }

  const raw = Array.isArray(axeReport)
    ? axeReport
    : Array.isArray(axeReport.violations)
      ? axeReport.violations
      : null;

  if (!Array.isArray(raw)) {
    return {
      pass: null,
      count: null,
      violations: [],
      target,
      reason: 'violations-array-missing',
      maxViolations,
      severityFilter,
    };
  }

  const counted = severityFilter.includes('*')
    ? raw
    : raw.filter((v) => v && severityFilter.includes(v.impact));

  const pass = counted.length <= maxViolations;
  const reason = pass
    ? `${counted.length} violation(s) within budget`
    : `${counted.length} violation(s) exceed budget ${maxViolations}`;

  return {
    pass,
    count: counted.length,
    violations: counted,
    target,
    reason,
    maxViolations,
    severityFilter,
  };
}

/**
 * Build the prompt fragment ijfw-ui-auditor uses to run axe-core via
 * chrome-devtools-mcp (or fallback to @axe-core/cli locally).
 *
 * @param {string} url
 * @param {string} [target]
 */
export function axePromptFor(url, target = DEFAULT_A11Y_TARGET) {
  return [
    `Run axe-core for ${target} compliance against:`,
    `  url: ${url}`,
    'Prefer chrome-devtools-mcp:evaluate_script with the axe-core CDN bundle,',
    'or run `npx @axe-core/cli ${url}` locally if the peer is installed.',
    'Pipe the resulting violations[] through evaluateA11y() from',
    'mcp-server/src/lib/a11y-contract.js.  BLOCK the review if pass=false.',
  ].join('\n');
}
