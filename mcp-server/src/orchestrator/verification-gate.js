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
//
// v1.5.0 audit-MED-work-M8: documented the rationale + introduced a SECOND
// "low-confidence" tier (LOW_CONFIDENCE_PATTERNS) intended for advise-mode-
// only callers. The strict-by-default gate (enforceVerificationGate) keeps
// using COMPLETION_PATTERNS so the existing iron-law stays unchanged; tools
// that want to surface "you might have claimed completion" without blocking
// can call `checkVerificationGateLowConfidence`. See CHANGELOG v1.5.0 for
// the policy entry.
const COMPLETION_PATTERNS = [
  /\b(?:DONE|completed|shipped|PASS)\b/,
  /✅/,
  /\b(?:all tests pass|build succeeded|deployed|ready to ship)\b/i,
];

/**
 * Low-confidence completion signals — words that USED to be in
 * COMPLETION_PATTERNS but were removed in r13-M-01 / r13-M-04 because they
 * fired on neutral language. These should NEVER block (strict-mode default
 * uses COMPLETION_PATTERNS only), but advise-mode callers can use them to
 * nudge an agent that's drifting toward a claim without evidence.
 */
export const LOW_CONFIDENCE_PATTERNS = [
  /\b(?:done|complete|passes|works|finished)\b/i,
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
/* eslint-disable security/detect-unsafe-regex --
 * Matches verify-cmd strings from developer-authored plan/spec files (not
 * network input). Fixed-suffix alternations + bounded env-var prefix loop
 * are not backtrack-exploitable.
 */
const VERIFY_VERB_RE =
  /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:npm test|node --test|cargo test|pytest|preflight|ijfw preflight|npm run build|yarn build|pnpm build|bun build|cargo build|tsc --build|tsc -b|make(?:\s|$))/i;
/* eslint-enable security/detect-unsafe-regex */

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

/**
 * Low-confidence advisory variant of `checkVerificationGate`. Uses the
 * LOW_CONFIDENCE_PATTERNS list (lowercase `done`/`complete`/etc.) so callers
 * can detect drift toward completion claims that the strict gate (rightly)
 * ignores. ADVISORY ONLY — never wired into the iron-law enforcement path.
 *
 * Returns the same shape as `checkVerificationGate`. Skipping evidence here
 * is NOT a violation in the strict-enforcement sense; callers decide what
 * to do (typically: surface as INFO finding to the operator).
 *
 * @param {string} message
 * @param {Array<{tool: string, input?: {command?: string}}>} toolCallsInMessage
 * @returns {{ ok: true } | { ok: false, violation: string, claim: string, lowConfidence: true }}
 */
export function checkVerificationGateLowConfidence(message, toolCallsInMessage) {
  const claims = LOW_CONFIDENCE_PATTERNS.flatMap((p) => message.match(p) ?? []);
  if (claims.length === 0) return { ok: true };

  const verificationCalls = (Array.isArray(toolCallsInMessage) ? toolCallsInMessage : []).filter(
    (t) => t.tool === 'Bash' && isVerificationCommand(t.input?.command ?? ''),
  );
  if (verificationCalls.length === 0) {
    return {
      ok: false,
      violation: `Low-confidence completion signal "${claims[0]}" without fresh verification (advisory)`,
      claim: claims[0],
      lowConfidence: true,
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
 * Set of target paths whose write failure has already been logged to stderr
 * this process. Prevents stderr flooding when the memory dir is unwritable
 * and a high-frequency caller (e.g. a stuck subagent loop) keeps retrying.
 *
 * v1.5.0 audit-H4.3 (HIGH-Rel1): recordViolation used to silently swallow
 * write failures, defeating the gate's whole job (surfacing violations to
 * the memory-feedback system). The fix:
 *   1. Emit ONE stderr line per failure (with the claim, so the violation
 *      isn't fully lost), then
 *   2. Return a result shape so callers can observe success/failure, but
 *   3. NEVER throw — recordViolation remains advisory in posture.
 *      Failures that used to be invisible are now AUDIBLE (stderr) +
 *      OBSERVABLE (return shape), but still non-fatal.
 */
const RECORD_FAILURE_LOGGED = new Set();

/**
 * Append a violation record to .ijfw/memory/verification-violations.jsonl.
 * Auto-creates parent directories.
 *
 * Advisory in posture (never throws), but no longer silent: write failures
 * are logged to stderr (once per target-path, dedup'd via a module-level
 * Set) and returned in the result shape so callers can observe them.
 *
 * @param {{ violation: string, claim: string, [key: string]: unknown }} violation
 * @param {string} projectRoot  Absolute path to the project root.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, path: string, error: string }>}
 */
export async function recordViolation(violation, projectRoot) {
  const file = join(projectRoot, '.ijfw', 'memory', 'verification-violations.jsonl');
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(
      file,
      JSON.stringify({ ...violation, recorded_at: new Date().toISOString() }) + '\n',
    );
    return { ok: true, path: file };
  } catch (err) {
    const errMsg = err && err.message ? String(err.message) : String(err);
    // Dedup: only one stderr line per target path per process, to avoid
    // flooding when the memory dir is unwritable for a long-running loop.
    if (!RECORD_FAILURE_LOGGED.has(file)) {
      RECORD_FAILURE_LOGGED.add(file);
      const claim = violation && violation.claim ? String(violation.claim) : '<unknown>';
      // One-line stderr log so the violation isn't fully lost. Includes the
      // claim string so a downstream operator can correlate.
      process.stderr.write(
        `[verification-gate] recordViolation write failed path=${file} claim=${JSON.stringify(claim)} err=${errMsg}\n`,
      );
    }
    return { ok: false, path: file, error: errMsg };
  }
}

/**
 * Reset the recordViolation failure-dedup Set. Test-only helper so each
 * test can assert "one stderr line per failure" independently of other
 * tests in the same process.
 *
 * @internal
 */
export function _resetRecordViolationDedup() {
  RECORD_FAILURE_LOGGED.clear();
}
