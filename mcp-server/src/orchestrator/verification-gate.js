/**
 * verification-gate.js — Advisory lint: detects completion claims in a
 * message that lack fresh verification evidence (a Bash test/build call
 * in the same message).
 *
 * ADVISORY ONLY — never throws, never blocks. Returns { ok: true } or
 * { ok: false, violation: string, claim: string }.
 *
 * Violations are persisted to .ijfw/memory/verification-violations.jsonl
 * so the memory-feedback system (v1.4.1 B10) can pattern-detect over time.
 *
 * Landed in W10-A2 (v1.4.4 — N5).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const COMPLETION_PATTERNS = [
  /\b(?:DONE|done|complete|completed|shipped|PASS|pass(?:es)?)\b/,
  /✅/,
  /\b(?:all tests pass|build succeeded|deployed|ready to ship)\b/i,
];

// Bash tool calls that count as fresh verification evidence.
const VERIFICATION_COMMAND_RE =
  /(?:npm test|node --test|cargo test|pytest|preflight|ijfw preflight|build)/i;

// ---------------------------------------------------------------------------
// Core gate
// ---------------------------------------------------------------------------

/**
 * Check whether a message that contains a completion claim also has fresh
 * verification evidence (a Bash tool call running tests/build).
 *
 * @param {string} message           Full text of the agent message.
 * @param {Array<{tool: string, input?: {command?: string}}>} toolCallsInMessage
 *   Tool calls that appeared in the same message turn.
 *
 * @returns {{ ok: true } | { ok: false, violation: string, claim: string }}
 */
export function checkVerificationGate(message, toolCallsInMessage) {
  const claims = COMPLETION_PATTERNS.flatMap((p) => message.match(p) ?? []);
  if (claims.length === 0) return { ok: true };

  const verificationCalls = toolCallsInMessage.filter(
    (t) =>
      t.tool === 'Bash' &&
      VERIFICATION_COMMAND_RE.test(t.input?.command ?? ''),
  );

  if (verificationCalls.length === 0) {
    return {
      ok: false,
      violation: `Completion claim "${claims[0]}" without fresh verification in same message`,
      claim: claims[0],
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Violation recorder
// ---------------------------------------------------------------------------

/**
 * Append a violation record to .ijfw/memory/verification-violations.jsonl.
 * Auto-creates parent directories. Advisory — errors are silently swallowed
 * so a write failure never blocks the orchestrator.
 *
 * @param {{ violation: string, claim: string, [key: string]: unknown }} violation
 * @param {string} projectRoot  Absolute path to the project root.
 * @returns {Promise<void>}
 */
export async function recordViolation(violation, projectRoot) {
  const file = join(projectRoot, '.ijfw', 'memory', 'verification-violations.jsonl');
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(
      file,
      JSON.stringify({ ...violation, recorded_at: new Date().toISOString() }) + '\n',
    );
  } catch {
    // Advisory — never propagate write errors.
  }
}
