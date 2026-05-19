/**
 * verification-gate.js — Iron-Law completion lint: detects completion
 * claims in a message that lack fresh verification evidence (a Bash
 * test/build call in the same message).
 *
 * Gate enforcement: callers receive { ok, violation, claim, enforce }.
 * When `enforce: 'strict'` (default in post-done-runner.js as of W12-F/F4),
 * the caller MUST refuse to advance on ok=false. Use `enforceVerificationGate`
 * (default strict) to get a thrown `VerificationGateViolation` on failure;
 * use the lower-level `checkVerificationGate` for advisory-only callers
 * that prefer to inspect the result themselves.
 *
 * Violations are persisted to .ijfw/memory/verification-violations.jsonl
 * so the memory-feedback system (v1.4.1 B10) can pattern-detect over time.
 *
 * Landed in W10-A2 (v1.4.4 — N5). Promoted to strict-by-default in
 * W12-F/F4 (v1.5.0-major — RT2-H1).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Error subclass — thrown by enforceVerificationGate in strict mode.
// ---------------------------------------------------------------------------

/**
 * Thrown by `enforceVerificationGate` when the gate fails and strict mode
 * is in effect (default). Carries the structured violation alongside the
 * Error contract so callers can branch on `instanceof VerificationGateViolation`.
 */
export class VerificationGateViolation extends Error {
  /**
   * @param {{ violation: string, claim: string }} outcome
   *   The failure result returned by `checkVerificationGate`.
   */
  constructor(outcome) {
    const reason = outcome && outcome.violation
      ? String(outcome.violation)
      : 'Verification gate violation';
    super(reason);
    this.name = 'VerificationGateViolation';
    this.violation = reason;
    this.claim = outcome && outcome.claim ? String(outcome.claim) : '';
  }
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

// r13-M-01 + r13-M-04: dropped bare `complete`, lowercase `done`, AND lowercase
// `pass(?:es)?` — all three fired falsely on common neutral language ("not yet
// complete", "to be done in v1.5", "pass the context"). Detection list is now:
// protocol literal `DONE`, `completed`/`shipped` (deliberate completion verbs),
// uppercase `PASS` (verdict literal), `✅` emoji, and explicit completion phrases
// ("all tests pass" / "build succeeded" / "deployed" / "ready to ship").
const COMPLETION_PATTERNS = [
  /\b(?:DONE|completed|shipped|PASS)\b/,
  /✅/,
  /\b(?:all tests pass|build succeeded|deployed|ready to ship)\b/i,
];

// Bash tool calls that count as fresh verification evidence.
//
// v1.5.1 H1.1 (audit HIGH-S2): the bare `build` substring let non-build
// commands like `Bash("ls build/")` clear the Iron Law without running tests.
//
// v1.5.1 H1.1-followup (Trident r18 finding): the first cut used `[\s;&|]`
// as a command-start marker, but plain whitespace inside arguments still let
// `echo npm test` and `printf 'npm run build'` satisfy the gate. The fix is
// structural, not regex-stretching: split the bash command into chain-
// segments on real shell separators (`;`, `&&`, `||`, `|`) and require a
// verify verb at the START of at least one segment (after an optional
// env-var prefix like `NODE_ENV=production`).
const VERIFY_VERB_RE =
  /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:npm test|node --test|cargo test|pytest|preflight|ijfw preflight|npm run build|yarn build|pnpm build|bun build|cargo build|tsc --build|tsc -b|make(?:\s|$))/i;

const SHELL_SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\|)\s*/;

/**
 * Return true iff `command` runs a recognized test/build verb as the head of
 * at least one chain-segment. `echo npm test` does NOT match (echo is the
 * head); `cd foo && npm test` DOES (the second segment is `npm test`).
 * Exported for unit-tests of the bash-segment splitter.
 */
export function isVerificationCommand(command) {
  if (typeof command !== 'string' || !command) return false;
  const segments = command.trim().split(SHELL_SEGMENT_SPLIT_RE);
  for (const seg of segments) {
    if (VERIFY_VERB_RE.test(seg.trim())) return true;
  }
  return false;
}

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
    (t) => t.tool === 'Bash' && isVerificationCommand(t.input?.command ?? ''),
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
// Strict enforcement wrapper (W12-F/F4 — RT2-H1)
// ---------------------------------------------------------------------------

/**
 * Enforce the verification gate. By default this is strict: a failed gate
 * throws `VerificationGateViolation`. Pass `{ strict: false }` for advisory
 * behavior (returns the same shape as `checkVerificationGate`).
 *
 * @param {string} messageText
 * @param {Array<{tool: string, input?: {command?: string}}>} toolCalls
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, violation: string, claim: string }}
 * @throws {VerificationGateViolation} when strict and gate fails.
 */
export function enforceVerificationGate(messageText, toolCalls, opts = {}) {
  const strict = opts.strict !== false; // default strict
  const outcome = checkVerificationGate(
    typeof messageText === 'string' ? messageText : '',
    Array.isArray(toolCalls) ? toolCalls : [],
  );
  if (!outcome.ok && strict) {
    throw new VerificationGateViolation(outcome);
  }
  return outcome;
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
