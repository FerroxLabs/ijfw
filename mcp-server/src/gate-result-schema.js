/**
 * gate-result-schema.js
 *
 * IJFW v1.4.0 Wave 0 / t1 — Gate-Result Schema
 *
 * A "gate-result" is the canonical contract emitted by every quality gate
 * in IJFW (Trident, preflight, plan-check, swarm-review, cross-audit,
 * override-audit, extension-install). All gates speak this shape so that
 * downstream consumers (blackboard, receipts, dashboards, remediation
 * router) can read any gate uniformly.
 *
 * Locked decisions (do not relitigate without an ADR):
 *   - FLAG status is required (it matches Trident's existing 5-level hierarchy).
 *   - project_type is required at the top level — IJFW is project-agnostic.
 *     Artifact ref types include book/content concepts, not just `file`.
 *   - `lenses` is empty for single-model gates (preflight, audit-ci); only
 *     multi-model gates (Trident, swarm-review, cross-audit) populate it.
 *   - `remediation` is schema-ready and partially auto-routed in v1.4.0 via
 *     `memory-feedback.js` (W7/B3), which surfaces pattern hints in the
 *     prelude when N+ recent gates fail on the same artifact type. Full
 *     auto-dispatch beyond pattern hints (e.g. cross-skill correlation,
 *     time-series detection) remains v1.5.0+.
 *   - `cost_usd` may be null (some gates run locally, free).
 *   - `gate_id` collapses any `:` in namespaced gates to `-` to keep ids
 *     filesystem-friendly across all 14 supported platforms.
 *
 * Format: gate-result objects are wire-encoded as a fenced
 *   ```gate-result
 *   <json>
 *   ```
 * block. This lets receipts grep gate-result blocks without parsing
 * surrounding markdown and lets blackboard collators round-trip them.
 *
 * Hand-rolled validator. No joi/zod/ajv — zero new prod dependencies.
 */

export const SCHEMA_VERSION = '1.0';

/**
 * Gate name pattern.
 *   - lowercase alpha-numeric with dashes
 *   - optional single `:`-delimited namespace (e.g. `preflight:audit-ci`)
 *   - must start with an alpha char in each segment
 */
export const GATE_NAME_PATTERN = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;

export const VALID_STATUSES = Object.freeze([
  'PASS',
  'CONDITIONAL',
  'WARN',
  'FLAG',
  'FAIL',
]);

export const VALID_PROJECT_TYPES = Object.freeze([
  'software',
  'book',
  'content',
  'business',
  'design',
  'mixed',
  'unknown',
]);

export const VALID_ARTIFACT_TYPES = Object.freeze([
  'file',
  'chapter',
  'section',
  'asset',
  'persona',
  'decision',
  'component',
]);

const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * makeGateId(gate) — build a `<gate>-<timestamp>-<rand4>` id.
 * Namespaced gates collapse `:` to `-` for filesystem safety.
 *
 * @param {string} gate
 * @returns {string}
 */
export function makeGateId(gate) {
  if (typeof gate !== 'string' || !GATE_NAME_PATTERN.test(gate)) {
    throw new TypeError(
      `makeGateId: invalid gate name "${gate}" — must match ${GATE_NAME_PATTERN}`,
    );
  }
  const safe = gate.replace(/:/g, '-');
  const ts = Date.now();
  // 4-hex random suffix. Math.random is fine here — gate_id collision risk
  // is operational, not security-critical (Trident audit is the trust gate).
  const rand4 = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${safe}-${ts}-${rand4}`;
}

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) !== null
      ? Object.getPrototypeOf(v) === Object.prototype
      : false
  );
}

function isString(v) {
  return typeof v === 'string';
}

function isNonNullObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * validateGateResult(obj) — hand-rolled validator.
 *
 * @param {unknown} obj
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateGateResult(obj) {
  const errors = [];

  if (!isNonNullObject(obj)) {
    return { valid: false, errors: ['root: must be an object'] };
  }

  // schema_version
  if (obj.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `schema_version: must equal "${SCHEMA_VERSION}", got ${JSON.stringify(obj.schema_version)}`,
    );
  }

  // gate
  if (!isString(obj.gate)) {
    errors.push('gate: must be a string');
  } else if (!GATE_NAME_PATTERN.test(obj.gate)) {
    errors.push(
      `gate: "${obj.gate}" does not match ${GATE_NAME_PATTERN}`,
    );
  }

  // status
  if (!VALID_STATUSES.includes(obj.status)) {
    errors.push(
      `status: must be one of ${VALID_STATUSES.join('|')}, got ${JSON.stringify(obj.status)}`,
    );
  }

  // project_type
  if (!VALID_PROJECT_TYPES.includes(obj.project_type)) {
    errors.push(
      `project_type: must be one of ${VALID_PROJECT_TYPES.join('|')}, got ${JSON.stringify(obj.project_type)}`,
    );
  }

  // lenses
  if (!Array.isArray(obj.lenses)) {
    errors.push('lenses: must be an array (empty for single-model gates)');
  } else {
    obj.lenses.forEach((lens, i) => {
      if (!isNonNullObject(lens)) {
        errors.push(`lenses[${i}]: must be an object`);
        return;
      }
      if (!isString(lens.model)) errors.push(`lenses[${i}].model: must be a string`);
      if (!VALID_STATUSES.includes(lens.verdict)) {
        errors.push(
          `lenses[${i}].verdict: must be one of ${VALID_STATUSES.join('|')}`,
        );
      }
      if (typeof lens.confidence !== 'number' || lens.confidence < 0 || lens.confidence > 1) {
        errors.push(`lenses[${i}].confidence: must be number in [0,1]`);
      }
      if (!isString(lens.summary)) errors.push(`lenses[${i}].summary: must be a string`);
    });
  }

  // affected_artifacts
  if (!Array.isArray(obj.affected_artifacts)) {
    errors.push('affected_artifacts: must be an array');
  } else {
    obj.affected_artifacts.forEach((a, i) => {
      if (!isNonNullObject(a)) {
        errors.push(`affected_artifacts[${i}]: must be an object`);
        return;
      }
      if (!VALID_ARTIFACT_TYPES.includes(a.type)) {
        errors.push(
          `affected_artifacts[${i}].type: must be one of ${VALID_ARTIFACT_TYPES.join('|')}`,
        );
      }
      if (!isString(a.ref)) errors.push(`affected_artifacts[${i}].ref: must be a string`);
      if (!isString(a.role)) errors.push(`affected_artifacts[${i}].role: must be a string`);
    });
  }

  // accounting
  if (!isNonNullObject(obj.accounting)) {
    errors.push('accounting: must be an object');
  } else {
    const a = obj.accounting;
    if (typeof a.duration_ms !== 'number' || a.duration_ms < 0) {
      errors.push('accounting.duration_ms: must be a non-negative number');
    }
    if (typeof a.lenses_invoked !== 'number' || a.lenses_invoked < 0 || !Number.isInteger(a.lenses_invoked)) {
      errors.push('accounting.lenses_invoked: must be a non-negative integer');
    }
    if (a.cost_usd !== null && (typeof a.cost_usd !== 'number' || a.cost_usd < 0)) {
      errors.push('accounting.cost_usd: must be null or non-negative number');
    }
  }

  // remediation
  if (!Array.isArray(obj.remediation)) {
    errors.push('remediation: must be an array (may be empty)');
  } else {
    obj.remediation.forEach((r, i) => {
      if (!isNonNullObject(r)) {
        errors.push(`remediation[${i}]: must be an object`);
        return;
      }
      if (!isString(r.action)) errors.push(`remediation[${i}].action: must be a string`);
      if (!isString(r.target)) errors.push(`remediation[${i}].target: must be a string`);
      if (!isString(r.agent_recommended)) {
        errors.push(`remediation[${i}].agent_recommended: must be a string`);
      }
      if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
        errors.push(`remediation[${i}].confidence: must be number in [0,1]`);
      }
    });
  }

  // receipts_ref
  if (obj.receipts_ref !== null && !isString(obj.receipts_ref)) {
    errors.push('receipts_ref: must be a string or null');
  }

  // supersedes
  if (obj.supersedes !== null && !isString(obj.supersedes)) {
    errors.push('supersedes: must be a string or null');
  }

  // gate_id
  if (!isString(obj.gate_id) || obj.gate_id.length === 0) {
    errors.push('gate_id: must be a non-empty string');
  } else if (isString(obj.gate)) {
    // Soft-check that gate_id starts with the (colon-collapsed) gate name.
    const safeGate = obj.gate.replace(/:/g, '-');
    if (!obj.gate_id.startsWith(safeGate + '-')) {
      errors.push(
        `gate_id: expected to start with "${safeGate}-" (colon-collapsed gate name)`,
      );
    }
  }

  // emitted_at
  if (!isString(obj.emitted_at) || !ISO8601_PATTERN.test(obj.emitted_at)) {
    errors.push('emitted_at: must be ISO-8601 string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * formatGateResult(obj) — render a gate-result object as a fenced
 *   ```gate-result\n<json>\n```
 * block. Does NOT validate first — call validateGateResult() yourself.
 *
 * @param {object} obj
 * @returns {string}
 */
export function formatGateResult(obj) {
  const json = JSON.stringify(obj, null, 2);
  return '```gate-result\n' + json + '\n```';
}
