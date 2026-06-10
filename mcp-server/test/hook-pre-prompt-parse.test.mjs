// hook-pre-prompt-parse.test.mjs — regression for DEFECT 2.
//
// THE BUG (release-blocking, crashed on EVERY real install): the first
// `node --input-type=module` block in claude/hooks/scripts/pre-prompt.sh
// declared `let intent = null;` which COLLIDED with a `const intent = …`
// injected by the ROUTER_CALL block whenever intent-router.js was present (every
// real install) -> `SyntaxError: Identifier 'intent' has already been declared`
// -> the whole node block failed to PARSE -> no `.session-feedback.jsonl` rows,
// no intent nudge, no prompt-check context. (The unit suite missed it because it
// never RAN the real hook with the router branch live.)
//
// THE FIX renamed the JS binding to `routerIntent` (one declaration) and made
// the ROUTER_CALL fragment ASSIGN to it instead of redeclaring.
//
// THIS TEST drives the REAL shipped hook (claude/hooks/scripts/pre-prompt.sh)
// end-to-end exactly as Claude Code does — stdin JSON {session_id,prompt}, run
// from a scratch project CWD, with CLAUDE_PLUGIN_ROOT pointed at the real
// claude/ dir so the hook resolves the REAL intent-router.js + feedback-detector
// .js + prompt-check.js (the sibling mcp-server/src layout of an install). It
// asserts the hook:
//   (1) exits cleanly (the node block must not crash), and
//   (2) writes a `.session-feedback.jsonl` correction row from
//       "no, use tabs not spaces" (proves the feedback-capture node block PARSED
//       and RAN with the router present — the exact thing the collision broke).
//
// Belt-and-braces, it also confirms the script has no bare `intent`
// declaration/assignment left in the JS fragments (a static guard so a future
// edit can't silently reintroduce the collision even on a machine where the live
// run happens to mask it).
//
// Zero deps, Node + bash built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const CLAUDE_DIR = join(REPO, 'claude');
const HOOK = join(CLAUDE_DIR, 'hooks', 'scripts', 'pre-prompt.sh');
const SRC = join(REPO, 'mcp-server', 'src');
const ROUTER = join(SRC, 'intent-router.js');
const FEEDBACK = join(SRC, 'feedback-detector.js');
const DETECTOR = join(SRC, 'prompt-check.js');

test('DEFECT 2: the real pre-prompt hook runs with intent-router present and writes a feedback correction row', () => {
  // Preconditions: the hook + the three modules it loads must exist, so the
  // ROUTER + FEEDBACK branches (the ones that produced the collision) are taken.
  for (const f of [HOOK, ROUTER, FEEDBACK, DETECTOR]) {
    assert.ok(existsSync(f), `missing dependency for the live hook run: ${f}`);
  }

  const scratchHome = mkdtempSync(join(tmpdir(), 'ijfw-hook-home-'));
  const scratchRepo = mkdtempSync(join(tmpdir(), 'ijfw-hook-repo-'));
  mkdirSync(join(scratchRepo, '.ijfw'), { recursive: true });

  try {
    const payload = JSON.stringify({ session_id: 'hook-parse-smoke', prompt: 'no, use tabs not spaces' });

    // Drive the REAL hook exactly as Claude Code's UserPromptSubmit does: the
    // payload on stdin, run from the project CWD. CLAUDE_PLUGIN_ROOT -> the real
    // claude/ dir so `$CLAUDE_PLUGIN_ROOT/../mcp-server/src` resolves the REAL
    // intent-router + feedback-detector + prompt-check (the installed sibling
    // layout). HOME is a scratch dir so the style-capture leg + logs are
    // isolated. We strip IJFW_DISABLE so the hook actually runs.
    const env = {
      ...process.env,
      HOME: scratchHome,
      USERPROFILE: scratchHome,
      CLAUDE_PLUGIN_ROOT: CLAUDE_DIR,
      IJFW_HOST: 'claude-code',
    };
    delete env.IJFW_DISABLE;
    // The hook reads NODE_ENV/NODE_TEST_CONTEXT only via downstream modules; the
    // feedback-capture leg under test does not gate on them, so leaving them set
    // is fine here (this leg writes into the scratch-repo .ijfw, not homedir).

    const res = spawnSync('bash', [HOOK], {
      input: payload,
      cwd: scratchRepo,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });

    // (1) The hook must not crash. The contract is "never crash Claude Code" —
    // it exits 0 even on internal errors — so we assert a clean exit AND that the
    // feedback row landed (the real proof the node block ran).
    assert.equal(res.status, 0, `hook must exit 0; status=${res.status} stderr=${res.stderr}`);

    // (2) The feedback-capture node block must have PARSED + RUN and written the
    // correction row. Before the fix this block threw SyntaxError (duplicate
    // `intent`) and NOTHING was written.
    const fbPath = join(scratchRepo, '.ijfw', '.session-feedback.jsonl');
    assert.ok(existsSync(fbPath),
      `the hook must write .session-feedback.jsonl (the node block must run, not crash on a `
      + `redeclaration); hook stderr: ${res.stderr}`);
    const rows = readFileSync(fbPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1, 'at least one feedback row must be written');
    assert.ok(rows.some((r) => r.kind === 'correction'),
      `a 'correction' feedback row must be written for "no, use tabs not spaces"; got ${JSON.stringify(rows)}`);

    // The prompt-check state must also be written with the correction kind —
    // a second witness that the full block executed past the (formerly fatal)
    // declaration.
    const statePath = join(scratchRepo, '.ijfw', '.prompt-check-state');
    assert.ok(existsSync(statePath), 'prompt-check state must be written');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(Array.isArray(state.feedback_kinds) && state.feedback_kinds.includes('correction'),
      `prompt-check state must record the correction kind; got ${JSON.stringify(state)}`);
  } finally {
    rmSync(scratchHome, { recursive: true, force: true });
    rmSync(scratchRepo, { recursive: true, force: true });
  }
});

test('DEFECT 2 (static guard): pre-prompt.sh JS fragments must not reintroduce a bare `intent` declaration', () => {
  const script = readFileSync(HOOK, 'utf8');
  // The historical collision was `let intent = null;` + an injected
  // `const intent = …`. Guard against either form returning. We strip shell
  // COMMENT lines first so the explanatory comment (which deliberately names the
  // forbidden tokens) doesn't trip the guard — only real code is checked.
  const code = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /\blet intent\b/,
    'pre-prompt.sh must not declare a bare `let intent` (DEFECT 2 collision)');
  assert.doesNotMatch(code, /\bconst intent\b/,
    'pre-prompt.sh must not declare a bare `const intent` (DEFECT 2 collision)');
  assert.match(code, /let routerIntent = null;/,
    'pre-prompt.sh must declare `let routerIntent = null;` (the DEFECT 2 fix)');
});
