// IJFW v1.3.0 Alpha -- A3 post-install cold-scan trigger (V3-F3).
//
// Fired from installer/src/install.js after the install completes. Spawns
// the project-type detector as a detached child so the installer never
// blocks. Result lands in <project>/.ijfw/project.type async; the next
// session-start hook reads the cached file under the 50ms hook budget.
//
// Honest framing: when node-resolution or the detector module is missing
// (broken install, partial dev clone), we degrade to a silent skip rather
// than block the installer.
//
// Public surface:
//   triggerColdScan(projectRoot, options)
//
// Returns:
//   { spawned: bool, pid?: number, reason?: string }

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the runner entry. Resolved from this file's directory
// (installer/src/post-install/) up to repo root, then down into
// mcp-server/src/cold-scan-runner.mjs. The runner is a tiny adapter that
// calls detect() + writeProjectType().
const RUNNER_REL_FROM_HERE = '../../../mcp-server/src/cold-scan-runner.mjs';

export function triggerColdScan(projectRoot, options = {}) {
  const root = String(projectRoot || process.cwd());
  if (!existsSync(root)) {
    return { spawned: false, reason: 'project root not present' };
  }

  // Resolve the runner relative to this file's location, then walk up to
  // the repo root from /installer/src/post-install/. Try several candidate
  // layouts so dev clones, custom-dir installs, and vendored copies all
  // resolve the runner correctly.
  const ijfwHome = options.ijfwHome || process.env.IJFW_HOME || '';
  const candidates = [
    resolve(__dirname, RUNNER_REL_FROM_HERE),                            // repo root from installer/src/post-install/
    resolve(__dirname, '../../mcp-server/src/cold-scan-runner.mjs'),     // legacy guess (kept for compat)
    ijfwHome ? join(ijfwHome, 'mcp-server/src/cold-scan-runner.mjs') : '', // explicit IJFW_HOME
    resolve(projectRoot, 'mcp-server/src/cold-scan-runner.mjs'),         // projectRoot itself is an IJFW checkout
  ].filter(Boolean);
  let runnerPath = null;
  for (const c of candidates) {
    if (c && existsSync(c)) { runnerPath = c; break; }
  }
  if (!runnerPath) {
    return { spawned: false, reason: 'cold-scan runner not present' };
  }

  // Use the executing node binary so we don't depend on PATH discovery.
  const nodeBin = options.nodeBin || process.execPath;

  const args = [runnerPath, '--project-root', root];
  if (options.c9Available === false) args.push('--no-c9');
  if (options.maxFiles) args.push('--max-files', String(options.maxFiles));

  try {
    const child = spawn(nodeBin, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, IJFW_COLD_SCAN: '1' },
    });
    child.unref();
    return { spawned: true, pid: child.pid };
  } catch (err) {
    return { spawned: false, reason: String(err && err.message ? err.message : err) };
  }
}

export default triggerColdScan;
