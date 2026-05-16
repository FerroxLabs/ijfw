/**
 * test-session-start-detachment.js
 *
 * IJFW v1.4.0 Wave 4 / t20 — Verifies the session-start.sh detachment
 * contract for the domain-manifest:load dispatch (R11 / F11).
 *
 * Why this test exists:
 *   The session-start hook MUST exit promptly even when the dispatched
 *   `ijfw run domain-manifest:load` body is slow. The current placeholder
 *   body is `true </dev/null >/dev/null 2>&1` wrapped in `( ... & )` with a
 *   trailing `disown 2>/dev/null || true`. The t16 rewrite will replace the
 *   `true` with the real CLI invocation but MUST preserve the detachment
 *   shape -- this test pins the shape AND the runtime behaviour.
 *
 * Strategy:
 *   - Copy the real session-start.sh into a tmp dir.
 *   - Produce TWO patched copies:
 *       control: body = `true </dev/null >/dev/null 2>&1`  (the current state)
 *       slow:    body = `sleep 5 </dev/null >/dev/null 2>&1`
 *   - Spawn each with `bash <script>` in a minimised env that points HOME and
 *     IJFW_DIR at a tmp dir; measure wall-clock duration.
 *   - Assert the delta (slow - control) < 500ms. The session-start prelude
 *     does plenty of unrelated work that swamps absolute numbers; the DELTA
 *     is the load-bearing signal because only the detached body changes
 *     between the two runs.
 *
 * Plus a static shape check: the unpatched script contains both `disown`
 * and an ampersand immediately followed by the subshell close `)`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// session-start.sh lives at claude/hooks/scripts/session-start.sh relative to
// the repo root. This test file is at mcp-server/test-...js so go up one.
const REPO_ROOT = path.resolve(__dirname, '..');
const SESSION_START_PATH = path.join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'session-start.sh');

// The placeholder body line we're patching. Defined as a literal so a future
// reformat changes both this constant AND the static-shape test together.
const PLACEHOLDER_LINE = '( true </dev/null >/dev/null 2>&1 & )';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readScript() {
  return fs.readFile(SESSION_START_PATH, 'utf8');
}

async function writePatchedScript(tmpDir, suffix, replacementBody) {
  const src = await readScript();
  assert.ok(
    src.includes(PLACEHOLDER_LINE),
    `session-start.sh must contain the placeholder line "${PLACEHOLDER_LINE}" for the detachment test to patch`,
  );
  const patchedLine = `( ${replacementBody} </dev/null >/dev/null 2>&1 & )`;
  const patched = src.replace(PLACEHOLDER_LINE, patchedLine);
  const dest = path.join(tmpDir, `session-start.${suffix}.sh`);
  await fs.writeFile(dest, patched, { mode: 0o755 });
  return dest;
}

function runScript(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
      // Detach so the child's own backgrounded processes can outlive the
      // bash process without keeping our `child` handle alive.
      detached: false,
    });
    const t0 = Date.now();
    child.once('exit', (code) => {
      const elapsed = Date.now() - t0;
      resolve({ elapsed, code });
    });
    child.once('error', reject);
    // Safety net so a stuck `bash` never hangs the test runner.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('runScript: bash exceeded 30s timeout'));
    }, 30000).unref();
  });
}

async function withTmpHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-det-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-det-cwd-'));
  // The script wants a .ijfw dir at cwd, plus a writable $HOME.
  await fs.mkdir(path.join(cwd, '.ijfw'), { recursive: true });
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  return { home, cwd };
}

function envFor(home, cwd) {
  // Minimal env -- keep PATH so `bash`, `node`, `awk`, `sed`, `grep`, `shasum`,
  // `wc`, `date`, `mkdir` resolve. Disable the dashboard auto-start, indexer
  // and transcript parser so the absolute time is closer to a clean baseline
  // (the DELTA is what matters but a tighter baseline catches regressions faster).
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: home,
    PWD: cwd,
    IJFW_DISABLE: '',
    IJFW_SKIP_PARSE: '1',
    // Run the dashboard render with a path that doesn't exist so the bin
    // shim returns immediately.
    CLAUDE_PLUGIN_ROOT: '/nonexistent/ijfw-test-plugin-root',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('static shape: session-start.sh contains disown + subshell-ampersand-close', async () => {
  const src = await readScript();
  assert.match(src, /disown/, 'expected literal "disown" in session-start.sh');
  // `&` then optional whitespace then `)` -- the (... &) subshell shape
  // that makes the backgrounded job detach from the parent shell.
  assert.match(src, /&[ \t]*\)/, 'expected `& )` subshell-close pattern');
  // Belt and braces: the specific placeholder line we patch must exist so
  // the runtime test can find its anchor.
  assert.ok(
    src.includes(PLACEHOLDER_LINE),
    `placeholder line missing: ${PLACEHOLDER_LINE}`,
  );
});

test('runtime: session-start.sh exits regardless of detached body duration', async () => {
  const { home, cwd } = await withTmpHome();
  const tmpScripts = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-det-scripts-'));

  const controlScript = await writePatchedScript(tmpScripts, 'control', 'true');
  const slowScript = await writePatchedScript(tmpScripts, 'slow', 'sleep 5');

  // Stable env across both runs.
  const env = envFor(home, cwd);

  // Run each script a few times and take the median to dampen GC / FS noise
  // (~5x runs, ~5s for the slow path in the WORST case where detachment
  // actually fails; with detachment intact, slow run lands ~equal to control).
  const N = 3;
  async function median(scriptPath) {
    const samples = [];
    for (let i = 0; i < N; i += 1) {
      const r = await runScript(scriptPath, env);
      samples.push(r.elapsed);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  // Run control first to warm any module / FS cache so slow doesn't pay
  // first-touch costs.
  const controlMs = await median(controlScript);
  const slowMs = await median(slowScript);
  const delta = slowMs - controlMs;

  // Diagnostic line -- visible in the test output's tail so reviewers can
  // see the measured numbers without re-running with verbose flags.
  // eslint-disable-next-line no-console
  console.log(
    `[detachment] control=${controlMs}ms slow=${slowMs}ms delta=${delta}ms`,
  );

  // If detachment is intact, sleep-5 never blocks the script's exit, so the
  // delta is dominated by run-to-run noise (typically << 500ms).
  // If detachment regressed (e.g. `&` dropped), slow would be ~5000ms more.
  assert.ok(
    delta < 500,
    `detachment regression: slow body added ${delta}ms over control ` +
      `(control=${controlMs}ms, slow=${slowMs}ms). The sleep-5 body MUST NOT ` +
      `block session-start.sh exit -- check that "( ... & )" + disown is preserved.`,
  );

  // Also sanity-check that the slow script actually exits within the test
  // timeout budget; a 30s bash watchdog is the absolute ceiling.
  assert.ok(slowMs < 10000, `slow run took ${slowMs}ms which is too long; ` +
    `something other than detachment is regressing.`);
});
