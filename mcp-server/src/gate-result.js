/**
 * gate-result.js
 *
 * IJFW v1.4.0 Wave 1 / t5 — Gate-Result Emitter
 *
 * Consumer surface every quality gate calls to emit a canonical gate-result.
 * Composes the W0 schema (validation) + formatter modules, fills in defaults,
 * detects project_type when omitted, and writes a fire-and-forget JSON
 * receipt under .ijfw/memory/gate-receipts/.
 *
 * Discipline:
 *   - ESM only; built-in Node.js modules only (no new prod deps).
 *   - ASCII only in strings.
 *   - Receipt writes MUST NOT throw — the gate's hot path is the priority.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  GATE_NAME_PATTERN,
  SCHEMA_VERSION,
  VALID_STATUSES,
  formatGateResult,
  makeGateId,
  validateGateResult,
} from './gate-result-schema.js';
import { detect as detectProjectType } from './project-type-detector.js';

// Re-exports so consumers can import everything they need from this module.
export {
  GATE_NAME_PATTERN,
  SCHEMA_VERSION,
  VALID_STATUSES,
  formatGateResult,
  makeGateId,
  validateGateResult,
};

/**
 * emitGateResult(gateOpts, context) — build, validate, and format a gate
 * result. Returns the fenced ```gate-result\n<json>\n``` block.
 *
 * @param {{
 *   gate: string,
 *   status: string,
 *   lenses?: Array,
 *   affected_artifacts?: Array,
 *   accounting: {duration_ms: number, lenses_invoked: number, cost_usd: number|null},
 *   remediation?: Array,
 *   receipts_ref?: string|null,
 *   supersedes?: string|null,
 * }} gateOpts
 * @param {{projectRoot?: string, project_type?: string}} [context]
 * @returns {Promise<string>}
 */
export async function emitGateResult(gateOpts, context = {}) {
  if (gateOpts === null || typeof gateOpts !== 'object') {
    throw new TypeError('emitGateResult: gateOpts must be an object');
  }

  const projectType =
    typeof context.project_type === 'string' && context.project_type.length > 0
      ? context.project_type
      : await resolveProjectType(context.projectRoot);

  const result = {
    schema_version: SCHEMA_VERSION,
    gate_id: makeGateId(gateOpts.gate),
    gate: gateOpts.gate,
    status: gateOpts.status,
    project_type: projectType,
    lenses: Array.isArray(gateOpts.lenses) ? gateOpts.lenses : [],
    affected_artifacts: Array.isArray(gateOpts.affected_artifacts)
      ? gateOpts.affected_artifacts
      : [],
    accounting: gateOpts.accounting,
    remediation: Array.isArray(gateOpts.remediation) ? gateOpts.remediation : [],
    receipts_ref: gateOpts.receipts_ref === undefined ? null : gateOpts.receipts_ref,
    supersedes: gateOpts.supersedes === undefined ? null : gateOpts.supersedes,
    emitted_at: new Date().toISOString(),
  };

  const { valid, errors } = validateGateResult(result);
  if (!valid) {
    throw new Error(
      `emitGateResult: invalid gate-result — ${errors.join('; ')}`,
    );
  }

  return formatGateResult(result);
}

/**
 * makeReceipt(gateResult) — fire-and-forget JSON receipt write.
 *
 * Writes `.ijfw/memory/gate-receipts/<gate_id>.json` (creating parent dirs
 * as needed). Disk errors are swallowed and logged to stderr; this never
 * throws so the gate's hot path is never blocked by receipt issues.
 *
 * @param {object} gateResult — validated gate-result object (NOT the
 *   fenced block string). Caller is responsible for passing the object;
 *   if you only have the block string, JSON.parse the body first.
 * @param {{projectRoot?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function makeReceipt(gateResult, opts = {}) {
  try {
    if (!gateResult || typeof gateResult !== 'object') return;
    const gateId = typeof gateResult.gate_id === 'string' ? gateResult.gate_id : null;
    if (!gateId) return;

    const root = typeof opts.projectRoot === 'string' && opts.projectRoot.length > 0
      ? opts.projectRoot
      : process.cwd();

    const receiptPath = join(
      root,
      '.ijfw',
      'memory',
      'gate-receipts',
      `${gateId}.json`,
    );

    await mkdir(dirname(receiptPath), { recursive: true });
    const body = JSON.stringify(gateResult, null, 2) + '\n';
    await writeFile(receiptPath, body, 'utf8');
  } catch (err) {
    // Fire-and-forget: log and move on. The gate hot path must not fail.
    const msg = err && err.message ? err.message : String(err);
    try {
      process.stderr.write(`ijfw: gate-result receipt write failed: ${msg}\n`);
    } catch {
      /* even stderr write can fail in odd environments; nothing to do */
    }
  }
}

// --- Internals -------------------------------------------------------------

async function resolveProjectType(projectRoot) {
  try {
    const root = typeof projectRoot === 'string' && projectRoot.length > 0
      ? projectRoot
      : process.cwd();
    // detect() is synchronous; we call it inside an async function so any
    // throw is captured by the catch below and falls back to 'unknown'.
    const detected = detectProjectType(root);
    if (detected && typeof detected.primary_type === 'string' && detected.primary_type.length > 0) {
      return detected.primary_type;
    }
    if (detected && typeof detected.type === 'string' && detected.type.length > 0) {
      return detected.type;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
