/**
 * runtime-loop.js — v1.5.0-major S02: callable runtime wrapper for the
 * v1.4.4 N2 status protocol. Closes the "discipline-in-markdown" gap by
 * giving the orchestrator-LLM an MCP tool to invoke per subagent report,
 * instead of reading SKILL.md and hoping it remembers to call the right
 * thing in the right order.
 *
 * Pipeline (per subagent message):
 *   reviewSubagentReport(reportText, ctx)
 *     1. parseAgentReport(reportText)   -- status-protocol.js N2
 *     2. handleStatus(parsed, dispatchTs, ctx)
 *     3. return { action, ...decision, parsed? }
 *
 * Failure modes are explicit, never thrown:
 *   - ProtocolViolation  -> { action: 'redispatch_needs_context',
 *                              missing: 'protocol-violation', error, raw }
 *   - Stale commit       -> { action: 'redispatch_needs_context',
 *                              missing: 'commit-before-report' }   (from handleStatus)
 *
 * The MCP tool wrapper in server.js passes projectRoot from cwd.
 */

import { parseAgentReport, handleStatus, ProtocolViolation } from './status-protocol.js';
// v1.5.0 N4.obs M1: ensure a trace_id is minted at the start of the orchestrator
// loop so every downstream checkpoint/receipt/session row can be rolled up by
// session in the dashboard.
import { ensureTraceId } from '../observability/trace-id.js';
// v1.5.0 audit-MED-work-M1 / M3: resume_preference config loader + composable
// termination conditions.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTermination } from './termination.js';
// v1.5.0 wire-W1.A: opt-in repo-map prefix for subagent dispatch / redispatch.
// Folds the importance-ranked file summary in front of the brief when
// IJFW_REPO_MAP=1 is set. Default off so existing flows are byte-identical.
import { buildRepoMap, compactBriefForSubagent } from '../lib/repo-map.js';
// v1.5.1 W2.B: T20 truncation detection + state-replay recovery. Was an orphan
// module (CHANGELOG cited a "measured rate" with no production caller). Wiring
// it here makes runtime-loop the production caller — handleTruncation now
// classifies/recovers truncated subagents instead of routing blind.
import {
  detectTruncation,
  recoverSubagent,
  measureTruncationRate,
  writeRateArtifact,
} from '../recovery/truncation.js';
// v1.5.1 W2.E: S08 incident-driven worktree safety guards. Was an orphan
// module. Wired here as preconditions of the worktree-isolated dispatch path:
// guards run BEFORE the subagent is spawned so cwd-drift / path-escape /
// protected-ref hazards are caught at the orchestrator boundary.
import {
  assertNoCwdDrift,
  captureSpawnToplevel,
  assertPathWithinToplevel,
  assertNotProtectedRef,
} from '../lib/worktree-guards.js';
// v1.5.1 W2.E: the actual worktree-isolated subagent spawn lives in
// subagent-telemetry.js; runtime-loop wraps it with the guard preconditions.
import { dispatchSubagent } from './subagent-telemetry.js';

/**
 * Review a subagent's report through the v1.4.4 4-value protocol.
 * Returns a route decision object the orchestrator should act on.
 *
 * @param {string} reportText - the subagent's final message
 * @param {object} ctx
 * @param {number} ctx.dispatchTimestamp - Unix seconds at dispatch
 * @param {string} [ctx.branch]          - dispatched branch (for branch-tuple freshness check)
 * @param {string} ctx.projectRoot       - absolute path of project root for git commands
 * @returns {{ action: string, parsed?: object, missing?: string, error?: string, raw?: string, [k: string]: unknown }}
 */
export function reviewSubagentReport(reportText, ctx) {
  // v1.5.0 N4.obs M1: mint (or adopt) a session trace_id on the first
  // orchestrator call. Idempotent -- subsequent calls reuse the cached id, and
  // a subagent inheriting via IJFW_TRACE_ID env keeps the parent's id.
  ensureTraceId();
  if (typeof reportText !== 'string' || reportText.length === 0) {
    return {
      action: 'redispatch_needs_context',
      missing: 'protocol-violation',
      error: 'empty or non-string reportText',
      raw: String(reportText ?? ''),
    };
  }
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('reviewSubagentReport: ctx is required');
  }
  if (typeof ctx.dispatchTimestamp !== 'number' || !Number.isFinite(ctx.dispatchTimestamp)) {
    throw new TypeError('reviewSubagentReport: ctx.dispatchTimestamp must be a finite number (unix seconds)');
  }
  if (typeof ctx.projectRoot !== 'string' || ctx.projectRoot.length === 0) {
    throw new TypeError('reviewSubagentReport: ctx.projectRoot is required');
  }

  let parsed;
  try {
    parsed = parseAgentReport(reportText);
  } catch (err) {
    if (err instanceof ProtocolViolation) {
      return {
        action: 'redispatch_needs_context',
        missing: 'protocol-violation',
        error: err.reason,
        raw: err.raw,
      };
    }
    throw err;
  }

  // If the parsed branch contradicts the dispatched branch, prefer the parsed
  // (agent-reported) value -- handleStatus uses it for the branch-tuple check.
  // The ctx.branch is informational; we don't override what the agent said.
  const decision = handleStatus(parsed, ctx.dispatchTimestamp, { projectRoot: ctx.projectRoot });
  return { ...decision, parsed };
}

/**
 * Cross-AI resume routing (v1.5.0 W12-C N02).
 *
 * When a subagent truncates mid-task, the orchestrator can resume the same
 * checkpoint on a *different* AI to avoid the same context-window/format
 * failure mode. These helpers encode the routing matrix + brief composition
 * so the orchestrator-LLM doesn't have to remember it.
 *
 * The matrix is deliberately small and hand-tuned: each entry picks an
 * alternate AI whose context window / output style differs from the one
 * that truncated. We never reselect the truncated AI itself.
 */

// Built-in defaults. v1.5.0 audit-MED-work-M1 promoted this to a config-
// readable field on `.ijfw/swarm.json::resume_preference` so rosters that
// include `opencode`, `aider`, `copilot`, etc. get cross-AI resume too
// instead of falling through to escalate_to_user.
const DEFAULT_RESUME_PREFERENCE = {
  claude: ['gemini', 'codex'],
  gemini: ['claude', 'codex'],
  codex: ['claude', 'gemini'],
};

// Cache one read per projectRoot per process — `selectResumeAI` is hot on the
// orchestrator critical path and re-reading swarm.json every call wastes I/O.
const _resumePrefCache = new Map();

/**
 * Load `resume_preference` from `<projectRoot>/.ijfw/swarm.json` if present,
 * shallow-merge over the built-in defaults. Missing file / malformed JSON /
 * missing field → defaults silently (this is advisory routing, never throws).
 *
 * Result shape: `{ [truncatedAI]: string[] }`. Keys NOT in defaults are kept
 * (so a project with `opencode: ['claude','gemini']` can have its entry
 * looked up by selectResumeAI), and entries in defaults stay unless the
 * config explicitly overrides them with an array.
 *
 * @param {string} [projectRoot]
 * @returns {Record<string, string[]>}
 */
export function loadResumePreference(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ...DEFAULT_RESUME_PREFERENCE };
  }
  if (_resumePrefCache.has(projectRoot)) {
    return _resumePrefCache.get(projectRoot);
  }
  const merged = { ...DEFAULT_RESUME_PREFERENCE };
  try {
    const swarmPath = join(projectRoot, '.ijfw', 'swarm.json');
    if (existsSync(swarmPath)) {
      const raw = JSON.parse(readFileSync(swarmPath, 'utf8'));
      const cfg = raw && typeof raw === 'object' ? raw.resume_preference : null;
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        for (const [k, v] of Object.entries(cfg)) {
          if (typeof k !== 'string' || k.length === 0) continue;
          if (!Array.isArray(v)) continue;
          const list = v.filter((x) => typeof x === 'string' && x.length > 0);
          if (list.length > 0) merged[k] = list;
        }
      }
    }
  } catch { /* advisory — fall back to defaults */ }
  _resumePrefCache.set(projectRoot, merged);
  return merged;
}

/**
 * Test-only helper to clear the resume-preference cache. Used by tests that
 * mutate `.ijfw/swarm.json` and re-call `selectResumeAI` in the same process.
 * @internal
 */
export function _resetResumePrefCache() {
  _resumePrefCache.clear();
}

// Kept for backwards compat with any direct importers.
// eslint-disable-next-line no-unused-vars -- exported binding read by external consumers; keep for backcompat
const RESUME_PREFERENCE = DEFAULT_RESUME_PREFERENCE;

/**
 * Pick a resume AI for a truncated subagent.
 *
 * @param {object} args
 * @param {string} args.truncatedAI               - AI that truncated ('claude' | 'gemini' | 'codex')
 * @param {string[]} [args.available]             - AIs the orchestrator can dispatch to
 * @param {string} [args.lastFailureReason]       - e.g. 'context_window'
 * @returns {string|null}                         - resume target, or null when blocked
 */
export function selectResumeAI({
  truncatedAI,
  available = ['claude', 'gemini', 'codex'],
  lastFailureReason,
  projectRoot,
} = {}) {
  if (typeof truncatedAI !== 'string' || truncatedAI.length === 0) {
    return null;
  }

  // gemini already has the largest practical context window of the three.
  // If it truncated *because of* context-window pressure, no alternative
  // gives us a larger window -- escalate instead of pretending to resume.
  if (lastFailureReason === 'context_window' && truncatedAI === 'gemini') {
    return null;
  }

  // v1.5.0 audit-MED-work-M1: read resume_preference from swarm.json with a
  // fall-through to DEFAULT_RESUME_PREFERENCE. Projects with `opencode` /
  // `aider` / `copilot` in their roster get cross-AI resume routing instead
  // of an escalate_to_user black hole.
  const prefMap = loadResumePreference(projectRoot);
  const preferred = prefMap[truncatedAI] || [];
  for (const candidate of preferred) {
    if (candidate === truncatedAI) continue;
    if (available.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Build a resume brief composing the original spec + checkpoint state.
 * Intentionally omits the Step 0 workspace-setup boilerplate: the resume
 * agent inherits the branch + worktree from the first attempt and skips it.
 *
 * @param {object} args
 * @param {string} args.originalSpec   - original task brief, verbatim
 * @param {object} args.checkpoint     - { filesWritten?, commitSha?, partialProgress? }
 * @param {string} args.fromAI         - AI that truncated
 * @param {string} args.toAI           - AI taking over
 * @returns {string}
 */
export function buildResumeBrief({ originalSpec, checkpoint = {}, fromAI, toAI } = {}) {
  const spec = typeof originalSpec === 'string' ? originalSpec : '';
  const files = Array.isArray(checkpoint.filesWritten) ? checkpoint.filesWritten : [];
  const sha = typeof checkpoint.commitSha === 'string' ? checkpoint.commitSha : '';
  const partial = typeof checkpoint.partialProgress === 'string' ? checkpoint.partialProgress : '';

  const filesLine = files.length > 0 ? `  Files written: ${files.join(', ')}` : '  Files written: (none recorded)';
  const shaLine = sha ? `  Commit: ${sha}` : '  Commit: (none yet)';
  const partialLine = partial ? `  Partial progress: ${partial}` : '  Partial progress: (none recorded)';

  // r15-M6: estimate brief size and surface a context-window advisory. The
  // receiving model may have a SMALLER window than the one that truncated
  // (selectResumeAI refuses gemini→larger when reason is context_window, but
  // it can't know the receiver's exact window from here). Tell the receiver
  // to summarise rather than re-quote if the prior context approaches its cap.
  const approxTokens = Math.ceil((spec.length + filesLine.length + shaLine.length + partialLine.length) / 4);
  const budgetLine = `Approx prior-context tokens: ~${approxTokens}. If this brief plus your reply would exceed your context window, summarise the prior agent's "Files written" + "Partial progress" lines instead of quoting verbatim and proceed.`;

  return [
    spec,
    '',
    '---',
    `RESUME CONTEXT — Prior agent (${fromAI}) truncated. Already done:`,
    filesLine,
    shaLine,
    partialLine,
    '',
    budgetLine,
    '',
    `You are ${toAI}. Continue from here. Do NOT redo completed work.`,
    'Skip workspace setup (Step 0) -- branch + worktree already exist.',
  ].join('\n');
}

/**
 * Decide what to do when a subagent report indicates truncation.
 *
 * v1.5.1 W2.B: when the caller supplies the subagent's `events` stream and/or
 * intent `journal` on `ctx`, this routes through the T20 `detectTruncation`
 * classifier first. The classifier's `reason` (e.g. `'missing-terminal'`,
 * `'open-partial'`) is surfaced on the result as `truncationClass` so the
 * orchestrator can log a precise tell rather than a guessed one. When no
 * event-stream context is given the behaviour is byte-identical to the
 * pre-wire path (the classifier is skipped and routing proceeds on `parsed`).
 *
 * @param {object} args
 * @param {object} args.parsed                 - parsed report (must carry ai + reason if known)
 * @param {object} args.ctx                    - orchestrator context; ctx.checkpoint may be present.
 *                                               Optional: ctx.events[], ctx.journal[],
 *                                               ctx.expectedTerminalVerb for T20 classification.
 * @param {string[]} [args.available]          - AIs available to dispatch
 * @returns {{action:'resume_with_alt_ai', toAI:string, brief:string, truncationClass?:string}
 *           | {action:'escalate_to_user', reason:string, truncationClass?:string}}
 */
export function handleTruncation({ parsed = {}, ctx = {}, available = ['claude', 'gemini', 'codex'] } = {}) {
  const truncatedAI = typeof parsed.ai === 'string' && parsed.ai.length > 0 ? parsed.ai : 'claude';
  let lastFailureReason = parsed.reason;
  const projectRoot = typeof ctx.projectRoot === 'string' ? ctx.projectRoot : undefined;

  // v1.5.1 W2.B — T20 classifier wire. If the orchestrator handed us the
  // subagent's event stream / journal, classify the truncation precisely.
  // The classifier never throws; a 'false' verdict (clean exit) leaves the
  // existing routing untouched so this stays additive.
  let truncationClass;
  if (Array.isArray(ctx.events) || Array.isArray(ctx.journal)) {
    const detection = detectTruncation({
      events: ctx.events,
      journal: ctx.journal,
      expectedTerminalVerb: ctx.expectedTerminalVerb,
    });
    if (detection.truncated) {
      truncationClass = detection.truncated;
      // Promote the classifier's tell to the failure reason when the parsed
      // report didn't carry one — gives selectResumeAI a real signal.
      if (typeof lastFailureReason !== 'string' || lastFailureReason.length === 0) {
        lastFailureReason = detection.truncated;
      }
    } else {
      truncationClass = 'clean';
    }
  }

  const toAI = selectResumeAI({ truncatedAI, available, lastFailureReason, projectRoot });

  if (!toAI) {
    return {
      action: 'escalate_to_user',
      reason: lastFailureReason === 'context_window' && truncatedAI === 'gemini'
        ? 'context_window_exceeded_on_largest_ai'
        : 'no_alternate_ai_available',
      ...(truncationClass ? { truncationClass } : {}),
    };
  }

  const checkpoint = ctx.checkpoint && typeof ctx.checkpoint === 'object' ? ctx.checkpoint : {};
  const originalSpec = typeof ctx.originalSpec === 'string' ? ctx.originalSpec : '';
  const brief = buildResumeBrief({ originalSpec, checkpoint, fromAI: truncatedAI, toAI });

  return {
    action: 'resume_with_alt_ai',
    toAI,
    brief,
    ...(truncationClass ? { truncationClass } : {}),
  };
}

/**
 * v1.5.1 W2.B — async truncation handler that performs T20 STATE RECOVERY
 * before deciding resume routing. This is the production caller the orphan
 * `recovery/truncation.js` module was missing.
 *
 * Pipeline:
 *   1. `recoverSubagent` — runs `state.replay` to snapshot-rollback / seal the
 *      truncated subagent's partial verbs (so the resume agent inherits a
 *      consistent journal, not a half-applied one).
 *   2. `handleTruncation` — the existing sync routing decision.
 *
 * The recovery outcome is attached to the decision as `recovery`. Recovery
 * never throws back to the caller; a failed replay still yields a routing
 * decision (the orchestrator can escalate on `recovery.recovered === false`).
 *
 * @param {object} args                         - same shape as handleTruncation
 * @param {object} [args.checkpoint]            - if it carries `lastVerbId`, replay is scoped
 * @returns {Promise<object>}                   - handleTruncation decision + `recovery`
 */
export async function recoverAndRouteTruncation({
  parsed = {}, ctx = {}, available = ['claude', 'gemini', 'codex'],
} = {}) {
  const projectRoot = typeof ctx.projectRoot === 'string' ? ctx.projectRoot : undefined;
  let recovery = null;
  if (projectRoot) {
    const checkpoint = ctx.checkpoint && typeof ctx.checkpoint === 'object' ? ctx.checkpoint : {};
    try {
      recovery = await recoverSubagent({
        projectRoot,
        waveId: ctx.waveId,
        subId: ctx.subId,
        sinceVerbId: typeof checkpoint.lastVerbId === 'string' ? checkpoint.lastVerbId : undefined,
      });
    } catch (err) {
      // recoverSubagent already swallows replay errors, but guard the call
      // site too — routing must proceed even if recovery wholly fails.
      recovery = { recovered: false, reason: `recovery threw: ${err?.message || err}` };
    }
  }
  const decision = handleTruncation({ parsed, ctx, available });
  return { ...decision, recovery };
}

/**
 * v1.5.1 W2.B — measure the truncation rate that survives T20 recovery and
 * persist it to `.ijfw/telemetry/truncation-rate.json`. This is the runtime
 * surface behind the CHANGELOG "measured rate" claim — it now has a caller.
 *
 * Thin pass-through to `measureTruncationRate` + `writeRateArtifact`; kept on
 * runtime-loop so the orchestrator can fire it post-wave without importing the
 * recovery module directly.
 *
 * @param {object} args
 * @param {string} args.projectRoot             - where the artifact is written
 * @param {{id:string, meta:object}[]} args.fixtures
 * @param {Function} args.runOne                - per-fixture recovery runner
 * @returns {Promise<{result:object, artifactPath:string}>}
 */
export async function measureAndPersistTruncationRate({ projectRoot, fixtures, runOne } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('measureAndPersistTruncationRate: projectRoot is required');
  }
  const result = await measureTruncationRate({ fixtures, runOne });
  const artifactPath = writeRateArtifact(projectRoot, result);
  return { result, artifactPath };
}

// ---------------------------------------------------------------------------
// v1.5.0 wire-W1.A — opt-in repo-map prefix for subagent (re)dispatch briefs
// ---------------------------------------------------------------------------
//
// Production wire-up for `mcp-server/src/lib/repo-map.js`. The orchestrator-LLM
// calls the `ijfw_state` MCP tool with `verb: 'subagent.post-done'` after every
// subagent turn (v1.5.0 T13 absorbed the retired `ijfw_subagent_post_done`
// tool). When the route decision is a redispatch, the LLM composes a NEW brief
// for the next subagent.
// With this wire active, the response payload carries `repoMapPrefix` — a
// pre-built importance-ranked file summary the LLM prepends to the redispatch
// brief, so the downstream subagent doesn't have to crawl the tree.
//
// Default OFF. Activates only when `IJFW_REPO_MAP=1` is set in the calling
// process env AND a valid `projectRoot` is supplied. Pure no-op on miss.
//
// Failure modes are explicit: any throw inside buildRepoMap (permissions,
// unreadable dirs, etc.) is swallowed and yields an empty prefix. This lets
// the orchestrator-LLM remain on the existing redispatch path without
// degrading.

/**
 * Build an opt-in repo-map prefix block for a subagent dispatch brief.
 * Returns '' when env opt-in is missing OR projectRoot is invalid OR the
 * map build throws. Never throws back to the caller.
 *
 * @param {object} args
 * @param {string} [args.projectRoot]
 * @param {object} [args.env]            defaults to process.env
 * @param {number} [args.budgetTokens]   default 1000
 * @returns {Promise<string>}            empty string when disabled or on error
 */
export async function buildSubagentRepoMapPrefix({ projectRoot, env = process.env, budgetTokens } = {}) {
  if (!env || env.IJFW_REPO_MAP !== '1') return '';
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return '';
  try {
    const budget = (typeof budgetTokens === 'number' && budgetTokens > 0) ? budgetTokens : 1000;
    const repoMap = buildRepoMap({ rootDir: projectRoot, budgetTokens: budget });
    // compactBriefForSubagent with an empty baseBrief returns just the
    // header/footer-wrapped prefix block. We surface that as a standalone
    // string the orchestrator-LLM splices in front of its own brief.
    const { brief } = compactBriefForSubagent({ baseBrief: '', repoMap, maxPrefixTokens: budget });
    return typeof brief === 'string' ? brief : '';
  } catch {
    // buildRepoMap throws on missing/inaccessible rootDir; on any error we
    // fall back to "no prefix" rather than corrupt the redispatch payload.
    return '';
  }
}

/**
 * Async wrapper around `reviewSubagentReport`. Returns the same decision shape
 * but attaches `repoMapPrefix` (string) to any redispatch action when the
 * env opt-in is on. The orchestrator-LLM consumes the prefix as the leading
 * block of the next subagent's brief.
 *
 * @param {string} reportText
 * @param {object} ctx                          - same shape as reviewSubagentReport
 * @param {object} [env]                        - defaults to process.env
 * @returns {Promise<object>}                   - decision (sync output + optional prefix)
 */
export async function reviewSubagentReportWithRepoMap(reportText, ctx, env = process.env) {
  const decision = reviewSubagentReport(reportText, ctx);
  if (decision && (decision.action === 'redispatch_needs_context' || decision.action === 'redispatch_with_context')) {
    decision.repoMapPrefix = await buildSubagentRepoMapPrefix({
      projectRoot: ctx?.projectRoot,
      env,
    });
  }
  return decision;
}

/**
 * Async variant of `handleTruncation` that, when the env opt-in is set,
 * prepends the repo-map prefix to the resume brief. Falls back byte-identical
 * to sync handleTruncation when the prefix is empty.
 *
 * @param {object} args                         - same shape as handleTruncation, plus env
 * @returns {Promise<object>}
 */
export async function handleTruncationWithRepoMap({ parsed = {}, ctx = {}, available, env = process.env } = {}) {
  const decision = handleTruncation({ parsed, ctx, available });
  if (decision && decision.action === 'resume_with_alt_ai' && typeof decision.brief === 'string') {
    const prefix = await buildSubagentRepoMapPrefix({ projectRoot: ctx?.projectRoot, env });
    if (prefix.length > 0) {
      decision.brief = prefix + decision.brief;
      decision.repoMapApplied = true;
    }
  }
  return decision;
}

/**
 * Generic iterative loop runner with a composable termination predicate
 * (v1.5.0 audit-MED-work-M3). Closes the "MaxAttempts is the only stop
 * rule" gap by letting callers compose WallClockTimeout, TokenBudget,
 * FindingSeverity, etc. via the `or` / `and` combinators in
 * `./termination.js`.
 *
 * The loop calls `step(iter, state)` on each iteration, expecting either:
 *   - `{ done: true,  result }`        — natural completion; loop returns `{result}`
 *   - `{ done: false, state?: object }` — keep iterating; new state merged in
 *
 * If the termination predicate fires before `done: true`, the loop returns
 * `{ terminated: true, reason: 'termination', iter, state }`.
 *
 * The default predicate is MaxAttempts(3), matching the v1.4.4 N3 cap.
 *
 * @param {object} args
 * @param {(iter: number, state: object) => Promise<{done:boolean, result?:unknown, state?:object}>} args.step
 * @param {object} [args.initialState]   starting state object (shallow-merged with step output)
 * @param {(iter:number, state:object) => boolean} [args.termination]
 * @returns {Promise<{result?:unknown, terminated?:boolean, reason?:string, iter:number, state:object}>}
 */
export async function runLoop({ step, initialState = {}, termination } = {}) {
  if (typeof step !== 'function') {
    throw new TypeError('runLoop: step is required');
  }
  const stop = typeof termination === 'function' ? termination : defaultTermination();
  let state = { ...initialState };
  let iter = 0;
  // Sentinel cap so a broken `termination` predicate can't pin the loop.
  const HARD_CAP = 10_000;
  while (iter < HARD_CAP) {
    const out = await step(iter, state);
    if (out && out.state && typeof out.state === 'object') {
      state = { ...state, ...out.state };
    }
    if (out && out.done) {
      return { result: out.result, iter, state };
    }
    if (stop(iter, state)) {
      return { terminated: true, reason: 'termination', iter, state };
    }
    iter += 1;
  }
  return { terminated: true, reason: 'hard-cap', iter, state };
}

// ---------------------------------------------------------------------------
// v1.5.1 W2.E — S08 worktree-guard preconditions on the dispatch path
// ---------------------------------------------------------------------------
//
// Production wire-up for `mcp-server/src/lib/worktree-guards.js`. The guards
// were lifted from the GSD executor after THREE real incidents (#3097 cwd
// drift, #3099 abs-path escape, #2924 commit-to-protected-ref) and then sat
// orphaned — no caller ran them. `dispatchSubagent` (subagent-telemetry.js)
// spawns a worktree-isolated subagent but performed NO containment check on
// the project root it was handed.
//
// `dispatchSubagentGuarded` runs the guards as PRECONDITIONS — they execute
// and must pass BEFORE the subagent is spawned. A guard failure aborts the
// dispatch (the spawn never happens) so a drifted cwd or an escaping project
// root can never reach the subagent primitive.

/**
 * Run the S08 worktree guards, then dispatch a worktree-isolated subagent.
 *
 * Preconditions (executed in order, BEFORE any spawn):
 *   1. `assertPathWithinToplevel(projectRoot, toplevel)` — the project root we
 *      were handed must be contained within the git toplevel (catches #3099
 *      abs-path escape, incl. symlink escapes via the realpath resolve).
 *   2. `assertNoCwdDrift(toplevel)` — the orchestrator's cwd must still match
 *      the toplevel captured at this call (catches #3097 cwd drift).
 *   3. `assertNotProtectedRef()` — HEAD must NOT be on a protected ref
 *      (main / master / develop / trunk / release-prefixed / prod) — catches
 *      #2924 commit-to-protected-ref before a subagent ever gets a chance to
 *      commit on the wrong branch.
 *
 * Only the `'worktree'` isolation mode is guarded — `'shared'` dispatch does
 * not spawn a separate worktree, so the containment/drift guards don't apply
 * (the protected-ref guard is also skipped there to keep `'shared'` byte-
 * identical to the pre-wire path).
 *
 * On any guard failure the error propagates and `dispatchSubagent` is NEVER
 * called — the spawn is aborted, not best-effort'd.
 *
 * @param {string} waveId
 * @param {string} subId
 * @param {string} role
 * @param {string} brief
 * @param {string} projectRoot                  - absolute path to the project root
 * @param {{isolation?: 'shared'|'worktree', env?: object, platform?: string,
 *          subagentId?: string}} [opts]
 * @returns {Promise<object>}                    - the `subagent.dispatch` verb result
 * @throws {Error} if any S08 guard fails (dispatch aborted)
 */
export async function dispatchSubagentGuarded(waveId, subId, role, brief, projectRoot, opts = {}) {
  const isolation = opts.isolation === 'shared' ? 'shared' : 'worktree';

  if (isolation === 'worktree') {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      throw new Error('dispatchSubagentGuarded: projectRoot is required for worktree isolation');
    }
    // Capture the toplevel ONCE so the drift + containment guards compare
    // against the same reference frame.
    const toplevel = captureSpawnToplevel(projectRoot);
    // #3099 — the project root we dispatch into must be contained.
    assertPathWithinToplevel(projectRoot, toplevel);
    // #3097 — the orchestrator's cwd must not have drifted off the toplevel.
    assertNoCwdDrift(toplevel, projectRoot);
    // #2924 — refuse to spawn a worktree subagent off a protected ref.
    assertNotProtectedRef(projectRoot);
  }

  // Guards passed (or 'shared' mode) — proceed to the real spawn.
  return dispatchSubagent(waveId, subId, role, brief, projectRoot, opts);
}
