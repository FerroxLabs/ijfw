// lighthouse-pillar.js -- v1.5.0 audit-MED-design-#7.
//
// Mandatory Lighthouse pillar for the IJFW UI-review pipeline.
//
// Wraps a chrome-devtools-mcp `lighthouse_audit` result and returns a
// deterministic PASS / FAIL verdict per the audit MED:
//
//   FAIL if LCP > 2.5s  OR  CLS > 0.1
//   PASS otherwise.
//
// The actual MCP call is made by the caller (auditor agent or workflow
// dispatcher) because IJFW core has zero external deps.  This module is a
// pure-stdlib evaluator + a result-shape contract the auditor can rely on.
//
// Exports:
//   - evaluateLighthouse(report, opts?)   -> {pass, lcpMs, clsScore, reason, thresholds}
//   - LIGHTHOUSE_THRESHOLDS               -- default LCP/CLS cutoffs
//
// Graceful-degrade: if `report` is null, undefined, or missing the relevant
// audits, returns {pass: null, reason: 'lighthouse-unavailable'}.  Callers
// treat null verdict as "skip" (no peer tool installed) rather than FAIL.

/** Default WCAG/Core-Web-Vitals thresholds. */
export const LIGHTHOUSE_THRESHOLDS = Object.freeze({
  lcpMs: 2500,       // Largest Contentful Paint, milliseconds
  clsScore: 0.1,     // Cumulative Layout Shift, unitless
});

/**
 * Evaluate a Lighthouse audit report against IJFW's CWV gates.
 *
 * Accepts several shapes for robustness:
 *   - The raw Lighthouse JSON: { audits: { 'largest-contentful-paint': { numericValue }, 'cumulative-layout-shift': { numericValue } } }
 *   - A pre-extracted summary: { lcpMs, clsScore }
 *   - A chrome-devtools-mcp wrapper: { lighthouse: <raw>, ... }
 *
 * @param {object|null|undefined} report
 * @param {object} [opts]
 * @param {number} [opts.lcpMs]    Override LCP threshold (ms)
 * @param {number} [opts.clsScore] Override CLS threshold
 * @returns {{pass: boolean|null, lcpMs: number|null, clsScore: number|null, reason: string, thresholds: typeof LIGHTHOUSE_THRESHOLDS}}
 */
export function evaluateLighthouse(report, opts = {}) {
  const thresholds = {
    lcpMs: typeof opts.lcpMs === 'number' ? opts.lcpMs : LIGHTHOUSE_THRESHOLDS.lcpMs,
    clsScore: typeof opts.clsScore === 'number' ? opts.clsScore : LIGHTHOUSE_THRESHOLDS.clsScore,
  };

  if (report == null) {
    return { pass: null, lcpMs: null, clsScore: null, reason: 'lighthouse-unavailable', thresholds };
  }

  const { lcpMs, clsScore } = extractMetrics(report);

  if (lcpMs == null && clsScore == null) {
    return { pass: null, lcpMs: null, clsScore: null, reason: 'metrics-missing', thresholds };
  }

  const reasons = [];
  let pass = true;
  if (lcpMs != null && lcpMs > thresholds.lcpMs) {
    pass = false;
    reasons.push(`LCP ${Math.round(lcpMs)}ms > ${thresholds.lcpMs}ms`);
  }
  if (clsScore != null && clsScore > thresholds.clsScore) {
    pass = false;
    reasons.push(`CLS ${clsScore.toFixed(3)} > ${thresholds.clsScore}`);
  }

  return {
    pass,
    lcpMs: lcpMs ?? null,
    clsScore: clsScore ?? null,
    reason: pass ? 'within-budget' : reasons.join('; '),
    thresholds,
  };
}

function extractMetrics(report) {
  // Pre-extracted summary form.
  if (typeof report.lcpMs === 'number' || typeof report.clsScore === 'number') {
    return {
      lcpMs: typeof report.lcpMs === 'number' ? report.lcpMs : null,
      clsScore: typeof report.clsScore === 'number' ? report.clsScore : null,
    };
  }
  // chrome-devtools-mcp wrapper form.
  const lh = report.lighthouse || report.lhr || report;
  const audits = lh && typeof lh === 'object' ? lh.audits : null;
  if (!audits || typeof audits !== 'object') {
    return { lcpMs: null, clsScore: null };
  }
  const lcpAudit = audits['largest-contentful-paint'] || audits.lcp;
  const clsAudit = audits['cumulative-layout-shift'] || audits.cls;
  const lcpMs =
    lcpAudit && typeof lcpAudit.numericValue === 'number'
      ? lcpAudit.numericValue
      : null;
  const clsScore =
    clsAudit && typeof clsAudit.numericValue === 'number'
      ? clsAudit.numericValue
      : null;
  return { lcpMs, clsScore };
}

/**
 * Build the prompt fragment the ijfw-ui-auditor agent uses to invoke the MCP
 * tool.  Kept here so the verdict-logic and the call-site stay co-located.
 *
 * @param {string} url
 * @returns {string}
 */
export function lighthousePromptFor(url) {
  return [
    'Invoke chrome-devtools-mcp:lighthouse_audit on the dev server URL:',
    `  url: ${url}`,
    'Then pipe the result through evaluateLighthouse() from',
    'mcp-server/src/lib/lighthouse-pillar.js.  FAIL the review if the',
    'returned `pass` is false; record `reason` in UI-REVIEW.md.',
  ].join('\n');
}
