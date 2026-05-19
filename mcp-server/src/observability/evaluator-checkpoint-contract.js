/**
 * observability/evaluator-checkpoint-contract.js -- v1.5.0 N4.obs M3.
 *
 * First shipped pre-built evaluator. Story for the audit / dashboard / docs:
 *
 *   "IJFW ships evaluators. Even without integrating with Weave / Phoenix /
 *   Langfuse, you get N built-in checks that score every subagent report
 *   against the orchestrator's contracts."
 *
 * THIS evaluator scores a subagent's final Status block against the v1.4.4 N2
 * status-protocol contract -- the four MANDATORY sections every implementer
 * agent is required to emit on completion:
 *
 *   1. Status:     -- one of DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
 *   2. SHAs:       -- list of commit SHAs landed (or "(none)")
 *   3. Files:      -- list of files touched (or "(none)")
 *   4. Tests:      -- "<pass>/<total>" or "(none)"
 *
 * The four-section contract is enforced by:
 *   - orchestrator/checkpoint-contract.md (cadence + size cap)
 *   - orchestrator/status-protocol.js (parseAgentReport regex)
 *   - the N4.obs M3 brief instructions all implementer subagents receive
 *
 * Returns:
 *   {
 *     valid:    boolean,                // true iff missing[] is empty
 *     missing:  string[],               // section names that were absent
 *     details:  { [section]: 'present'|'absent' },
 *     reason?:  string,                 // when valid=false, short rationale
 *   }
 *
 * Designed to be cheap (regex-only, no LLM call) so dispatch-planner and
 * plan-checker can run it inline on every report.
 *
 * Future evaluators can be added next to this file under the same exported
 * `evaluators` registry shape so the dashboard can enumerate them.
 */

/** Canonical evaluator id -- stable, matches the file slug. */
export const ID = 'checkpoint-contract';

/** The four sections required by v1.4.4 N2. Stable order = stable UI. */
export const REQUIRED_SECTIONS = Object.freeze([
  'STATUS',
  'SHAS',
  'FILES',
  'TESTS',
]);

/**
 * Synonyms tolerated for each section heading. Implementer agents have shipped
 * a few minor variants ("SHA(s):", "Files:", "Tests:"), so the evaluator
 * accepts them all. The status-protocol parser is stricter; we want this
 * evaluator to be a high-recall first-pass so it doesn't false-flag obviously
 * compliant reports.
 */
const SECTION_PATTERNS = Object.freeze({
  // STATUS must be on its own line; allow trailing space + colon + value.
  STATUS: /^\s*Status\s*:\s*(?:DONE(?:_WITH_CONCERNS)?|NEEDS_CONTEXT|BLOCKED)\b/im,
  SHAS:   /^\s*SHA(?:s|\(s\))?\s*:/im,
  FILES:  /^\s*Files?\s*:/im,
  TESTS:  /^\s*Tests?\s*:/im,
});

/**
 * Evaluate a subagent's final report against the checkpoint-contract.
 *
 * @param {string} statusBlock  the agent's final Status block (or full report)
 * @returns {{valid: boolean, missing: string[], details: Record<string, 'present'|'absent'>, reason?: string}}
 */
export function evaluateCheckpointContract(statusBlock) {
  if (typeof statusBlock !== 'string' || statusBlock.length === 0) {
    return {
      valid: false,
      missing: [...REQUIRED_SECTIONS],
      details: Object.fromEntries(REQUIRED_SECTIONS.map((s) => [s, 'absent'])),
      reason: 'empty or non-string report',
    };
  }

  const details = {};
  const missing = [];
  for (const section of REQUIRED_SECTIONS) {
    const re = SECTION_PATTERNS[section];
    const present = re ? re.test(statusBlock) : false;
    details[section] = present ? 'present' : 'absent';
    if (!present) missing.push(section);
  }

  const valid = missing.length === 0;
  return {
    valid,
    missing,
    details,
    ...(valid ? {} : { reason: `missing required sections: ${missing.join(', ')}` }),
  };
}

/**
 * Evaluator registry entry. Loaders (dashboard tile, plan-checker, dispatcher)
 * import this to enumerate built-in evaluators without name-spelunking.
 */
export const evaluator = Object.freeze({
  id: ID,
  title: 'Checkpoint contract (4 required sections)',
  description:
    'Scores a subagent\'s final Status block against the v1.4.4 N2 four-section contract: Status / SHAs / Files / Tests.',
  // Per-evaluator weights live with the evaluator so dashboard can show them
  // alongside the score without an external registry.
  weight: 1.0,
  run: evaluateCheckpointContract,
});

/**
 * Registry shape. Adding evaluators later is "import + push".
 */
export const evaluators = Object.freeze([evaluator]);
