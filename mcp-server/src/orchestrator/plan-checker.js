/**
 * plan-checker.js — v1.5.0-major W12-D C14: pre-dispatch plan validation gate.
 *
 * Pure-function library called by the existing `ijfw_subagent_post_done` MCP
 * tool routing (no new MCP tool — cap is full at 12/12). Also surfaced in the
 * `ijfw-plan-check` skill as the deterministic pre-dispatch gate.
 *
 * Distilled from /Users/seandonahoe/.claude/agents/gsd-plan-checker.md — extracts
 * the mechanically-checkable rules (the prose-reasoning ones stay in the skill).
 *
 * No I/O, no network — operates on plan text passed in by caller.
 *
 * v1.5.0 audit-MED-work-M2: this module now optionally composes with
 * `dispatch-planner.js::buildManifest` to surface wave-table file-overlap
 * findings at plan-review time instead of dispatch time. Pass
 * `{ checkWaveOverlap: true }` to opt in. Findings are INFO severity by
 * default (advisory — overlap forces worktree-isolation, not failure).
 */

import { parsePlan, buildManifest } from '../dispatch-planner.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Literal placeholder tokens that must not appear in a plan handed to execute.
 * Case-insensitive match on word boundaries (except the bracketed/angle forms,
 * which are matched literally).
 */
const PLACEHOLDER_PATTERNS = [
  { regex: /\bTBD\b/g,                 token: 'TBD' },
  { regex: /\bFIXME\b/g,               token: 'FIXME' },
  { regex: /\bXXX\b/g,                 token: 'XXX' },
  { regex: /\[fill me in\]/gi,         token: '[fill me in]' },
  { regex: /<placeholder>/gi,          token: '<placeholder>' },
  { regex: /\?\?\?/g,                  token: '???' },
];

/**
 * Acceptance-criteria signal — any one of these substrings is enough to satisfy
 * "task has acceptance criteria" (intentionally loose; planners write in prose).
 */
const ACCEPTANCE_REGEX = /\b(acceptance|done\s*when|criteria|expected)\b/i;

/**
 * Empty-step detector: a list item or numbered step whose body (after stripping
 * the marker) is under 20 chars of non-whitespace.
 */
const EMPTY_STEP_THRESHOLD = 20;

/**
 * Test-skip contradictions — if a task says it adds tests AND also says to
 * skip them, that's a BLOCK regardless of strict mode.
 */
const TEST_ADD_REGEX  = /\b(add(?:ing)?|write|writing|create|creating)\s+(?:the\s+)?tests?\b/i;
const TEST_SKIP_REGEX = /\b(skip\s+(?:the\s+)?tests?|tests?\s+not\s+required|no\s+tests?\s+needed)\b/i;

// ---------------------------------------------------------------------------
// Finding helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Finding
 * @property {'BLOCK'|'WARN'|'INFO'} severity
 * @property {string} code
 * @property {string} message
 * @property {string} [locationHint]
 */

function mkFinding(severity, code, message, locationHint) {
  const f = { severity, code, message };
  if (locationHint) f.locationHint = locationHint;
  return f;
}

// ---------------------------------------------------------------------------
// Task-block extraction
// ---------------------------------------------------------------------------

/**
 * A "task" can show up in three forms across the planners IJFW supports:
 *   1. `## Task <name>` / `## Task: <name>` (markdown heading)
 *   2. `### Task <name>` (third-level heading)
 *   3. `task_id: <id>` (frontmatter-ish, e.g. inside <task> XML blocks)
 *
 * We extract task blocks by splitting on these boundaries. Each block keeps
 * the heading line + everything up to the next task boundary or EOF.
 *
 * @param {string} planText
 * @returns {Array<{header: string, body: string, lineStart: number}>}
 */
function extractTaskBlocks(planText) {
  const lines = planText.split('\n');
  const taskHeaderRegex = /^(?:#{2,3})\s+Task\b[:\s]|^\s*task_id\s*:/i;
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (taskHeaderRegex.test(line)) {
      if (current) blocks.push(current);
      current = { header: line.trim(), body: '', lineStart: i + 1 };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Extract all task IDs declared in the plan. Looks for `task_id: X`, an `id:`
 * directly under a `## Task` heading, or `## Task <id>` / `### Task <id>`
 * patterns where <id> is a short alnum/dash token.
 *
 * @param {string} planText
 * @returns {Set<string>}
 */
function extractTaskIds(planText) {
  const ids = new Set();
  const lines = planText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*task_id\s*:\s*([A-Za-z0-9_\-.]+)/i))) {
      ids.add(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*id\s*:\s*([A-Za-z0-9_\-.]+)/i))) {
      // Only count `id:` lines that appear shortly after a Task heading.
      const lookback = lines.slice(Math.max(0, i - 5), i).join('\n');
      if (/^#{2,3}\s+Task\b/im.test(lookback)) ids.add(m[1]);
      continue;
    }
    if ((m = line.match(/^#{2,3}\s+Task[:\s]+([A-Za-z0-9_\-.]+)/i))) {
      ids.add(m[1]);
    }
  }
  return ids;
}

/**
 * Extract dependency references from a task body. Matches `depends:` and
 * `blocked-by:` (also `blocked_by:` / `depends_on:` — common variants).
 *
 * @param {string} body
 * @returns {string[]}
 */
function extractDependencyRefs(body) {
  const refs = [];
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(?:depends(?:_on)?|blocked[-_]by)\s*:\s*(.+)$/i);
    if (!m) continue;
    // Value may be a single id, comma list, or YAML-style ["a", "b"].
    const raw = m[1].trim().replace(/^\[|\]$/g, '');
    const parts = raw.split(/[,\s]+/).map((p) => p.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    for (const p of parts) refs.push(p);
  }
  return refs;
}

/**
 * Detect "empty step" lines inside a task body — bullet/numbered list items
 * whose payload is short and vague.
 *
 * @param {string} body
 * @param {number} bodyLineOffset  1-indexed line number where the body starts in the plan
 * @returns {Array<{text: string, line: number}>}
 */
function findEmptySteps(body, bodyLineOffset) {
  const out = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
    if (!m) continue;
    const payload = m[1].trim();
    // Strip any leading "implement/do/fix" filler and re-measure to catch
    // "implement the thing" style placeholders.
    const stripped = payload.replace(/^(?:implement|do|fix|handle)\s+(?:the\s+)?/i, '').trim();
    if (stripped.length < EMPTY_STEP_THRESHOLD) {
      out.push({ text: payload, line: bodyLineOffset + i });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a plan text against the C14 pre-dispatch ruleset.
 *
 * Findings carry one of three severities:
 *  - BLOCK: dispatch must abort
 *  - WARN:  dispatch may proceed but the orchestrator should surface the issue
 *  - INFO:  advisory only
 *
 * In `strict: true` mode, WARNs from the placeholder check get promoted to
 * BLOCK (the rest keep their natural severity — the strict-promotion is
 * scoped to placeholders by design, matching the gsd-plan-checker semantics
 * where placeholder text in a "ready to dispatch" plan is a hard failure).
 *
 * @param {string} planText
 * @param {{strict?: boolean, checkWaveOverlap?: boolean}} [opts]
 * @returns {{ok: boolean, findings: Finding[]}}
 */
function validatePlan(planText, opts = {}) {
  const strict = !!opts.strict;
  const checkWaveOverlap = !!opts.checkWaveOverlap;
  /** @type {Finding[]} */
  const findings = [];

  if (typeof planText !== 'string') {
    return {
      ok: false,
      findings: [mkFinding('BLOCK', 'PC-INPUT', 'planText must be a string')],
    };
  }

  // ---- Check 1: placeholders ----------------------------------------------
  for (const { regex, token } of PLACEHOLDER_PATTERNS) {
    // reset lastIndex on every call to be safe with the global flag
    regex.lastIndex = 0;
    const matches = planText.match(regex);
    if (matches && matches.length > 0) {
      const sev = strict ? 'BLOCK' : 'WARN';
      findings.push(
        mkFinding(
          sev,
          'PC-PLACEHOLDER',
          `Found ${matches.length} placeholder token(s) "${token}" — plan is not ready for dispatch`,
        ),
      );
    }
  }

  // ---- Check 2: completeness (must have ≥1 task) --------------------------
  const taskBlocks = extractTaskBlocks(planText);
  if (taskBlocks.length === 0) {
    findings.push(
      mkFinding(
        'BLOCK',
        'PC-NO-TASKS',
        'Plan contains 0 tasks (expected ≥1 `## Task` / `### Task` / `task_id:` block)',
      ),
    );
  }

  // ---- Check 3: each task has acceptance criteria -------------------------
  for (const block of taskBlocks) {
    if (!ACCEPTANCE_REGEX.test(block.body) && !ACCEPTANCE_REGEX.test(block.header)) {
      findings.push(
        mkFinding(
          'WARN',
          'PC-NO-ACCEPTANCE',
          `Task block missing acceptance criteria (looked for: acceptance|done when|criteria|expected)`,
          `line ${block.lineStart}: ${block.header}`,
        ),
      );
    }
  }

  // ---- Check 4: empty / under-specified steps -----------------------------
  for (const block of taskBlocks) {
    // body starts on the line after the header
    const empties = findEmptySteps(block.body, block.lineStart + 1);
    for (const e of empties) {
      findings.push(
        mkFinding(
          'WARN',
          'PC-EMPTY-STEP',
          `Step is too short / vague to be actionable: "${e.text}"`,
          `line ${e.line}`,
        ),
      );
    }
  }

  // ---- Check 5: dependency sanity (dangling refs) -------------------------
  const declaredIds = extractTaskIds(planText);
  for (const block of taskBlocks) {
    const refs = extractDependencyRefs(block.body);
    for (const ref of refs) {
      if (!declaredIds.has(ref)) {
        findings.push(
          mkFinding(
            'BLOCK',
            'PC-DANGLING-DEP',
            `Task references unknown dependency "${ref}" (not declared as a task_id in this plan)`,
            `line ${block.lineStart}: ${block.header}`,
          ),
        );
      }
    }
  }

  // ---- Check 6: no test-skip contradiction --------------------------------
  for (const block of taskBlocks) {
    const both = TEST_ADD_REGEX.test(block.body) && TEST_SKIP_REGEX.test(block.body);
    if (both) {
      findings.push(
        mkFinding(
          'BLOCK',
          'PC-TEST-SKIP-CONTRADICTION',
          'Task says to add tests AND to skip tests in the same block — pick one',
          `line ${block.lineStart}: ${block.header}`,
        ),
      );
    }
  }

  // ---- Check 7: wave-table file-overlap (M2 composition, opt-in) ---------
  // Runs `buildManifest` on the plan to surface any sub-waves that would be
  // routed to worktree isolation because they declare overlapping `Files:`
  // lines. These are INFO findings, not BLOCK — overlap is RECOVERABLE
  // (dispatch-planner just isolates), but planners benefit from seeing the
  // overlap during review instead of being surprised at dispatch time.
  if (checkWaveOverlap) {
    try {
      const subwaves = parsePlan(planText);
      const manifest = buildManifest(subwaves);
      for (const m of manifest) {
        if (m.mode === 'worktree' && m.overlaps_with && m.overlaps_with.length > 0) {
          findings.push(
            mkFinding(
              'INFO',
              'PC-WAVE-OVERLAP',
              `Sub-wave "${m.id}" overlaps file(s) with peer(s): ${m.overlaps_with.join(', ')} — will be dispatched to worktree isolation`,
              `sub-wave ${m.id} (wave ${m.wave})`,
            ),
          );
        } else if (m.mode === 'worktree' && m.reason === 'no-files-declared') {
          findings.push(
            mkFinding(
              'INFO',
              'PC-WAVE-NO-FILES',
              `Sub-wave "${m.id}" declares no Files: line — will default to worktree isolation`,
              `sub-wave ${m.id} (wave ${m.wave})`,
            ),
          );
        }
      }
    } catch {
      // dispatch-planner is best-effort here; a parse failure is not a
      // plan-check failure — fall through silently.
    }
  }

  const ok = !findings.some((f) => f.severity === 'BLOCK');
  return { ok, findings };
}

export {
  validatePlan,
  // exported for tests / power users:
  extractTaskBlocks,
  extractTaskIds,
  extractDependencyRefs,
  findEmptySteps,
  PLACEHOLDER_PATTERNS,
};
