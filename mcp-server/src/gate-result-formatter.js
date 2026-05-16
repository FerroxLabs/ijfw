/**
 * gate-result-formatter.js
 *
 * IJFW v1.4.0 Wave 0 / R2 — Gate-Result Formatter
 *
 * Utility that guarantees the gate-result block is the LAST emitted content
 * from a gate. For code-based gates (Trident, preflight) the formatter is
 * called deterministically before return. For skill-based gates (plan-check,
 * cross-audit, swarm-review) it exposes a markdown snippet the skill pastes
 * at end of its SKILL.md output contract (the model then echoes the block
 * as its last line).
 *
 * Companion to `gate-result-schema.js` (t1).
 */

import { formatGateResult } from './gate-result-schema.js';

const GATE_RESULT_FENCE = /```gate-result\s*\n[\s\S]*?\n```\s*$/;

/**
 * appendGateResult(outputString, gateResult)
 *
 * Append the fenced gate-result block to `outputString`. Idempotent: if
 * `outputString` already ends with a gate-result fence, replace it rather
 * than append a duplicate.
 *
 * @param {string} outputString
 * @param {object} gateResult — validated gate-result object
 * @returns {string}
 */
export function appendGateResult(outputString, gateResult) {
  const base = typeof outputString === 'string' ? outputString : '';
  const block = formatGateResult(gateResult);
  const trimmed = base.replace(/\s+$/, '');

  if (GATE_RESULT_FENCE.test(trimmed)) {
    return trimmed.replace(GATE_RESULT_FENCE, block);
  }

  return trimmed + (trimmed.length > 0 ? '\n\n' : '') + block;
}

/**
 * gateResultBlockOnly(gateResult)
 *
 * Return just the fenced gate-result block. Same as `formatGateResult` but
 * lives in this module so callers depend on `gate-result-formatter` only.
 *
 * @param {object} gateResult
 * @returns {string}
 */
export function gateResultBlockOnly(gateResult) {
  return formatGateResult(gateResult);
}

/**
 * gateResultTemplate(gate)
 *
 * Returns a markdown snippet skills paste at the end of their SKILL.md
 * output contract. The snippet instructs the model to emit a gate-result
 * block as the LAST line of its output, with the supplied `gate` name.
 *
 * @param {string} gate
 * @returns {string}
 */
export function gateResultTemplate(gate) {
  return [
    '## Output contract',
    '',
    `Emit a gate-result block as the LAST line of your output. Use \`gate="${gate}"\`.`,
    'Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.',
    '',
    'Format:',
    '',
    '```gate-result',
    '{',
    '  "schema_version": "1.0",',
    `  "gate": "${gate}",`,
    '  "status": "PASS",',
    '  "project_type": "<from project-type-detector>",',
    '  "lenses": [],',
    '  "affected_artifacts": [],',
    '  "accounting": {"duration_ms": 0, "lenses_invoked": 0, "cost_usd": null},',
    '  "remediation": [],',
    '  "receipts_ref": null,',
    '  "supersedes": null,',
    `  "gate_id": "${gate.replace(/:/g, '-')}-<ts>-<rand4>",`,
    '  "emitted_at": "<ISO-8601>"',
    '}',
    '```',
    '',
    'The block MUST be the last content you emit; nothing after it.',
    '',
  ].join('\n');
}
