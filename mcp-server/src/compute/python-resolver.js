/**
 * python-resolver.js -- Resolve a Python interpreter for the compute runner.
 *
 * Behavior (per V3-F14 routing):
 *   - When IJFW_HOST=wayland, the bundled python-build-standalone interpreter
 *     under ${WAYLAND_HOME or profileHome}/runtime/python/bin/python3 is used.
 *     If missing, we fail loud (PythonNotFoundError) -- never silently fall
 *     back to system Python in a Wayland host.
 *   - Otherwise, probe for python3 then python on PATH. Fail loud if neither
 *     is found.
 *
 * Errors carry `code` and `interpreter` for the caller to surface to users.
 *
 * Zero external deps.
 */

import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';

export class PythonNotFoundError extends Error {
  constructor(message, { code = 'PYTHON_NOT_FOUND', interpreter = null } = {}) {
    super(message);
    this.name = 'PythonNotFoundError';
    this.code = code;
    this.interpreter = interpreter;
  }
}

function isExecutableFile(p) {
  try {
    if (!existsSync(p)) return false;
    const st = statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// Locate a binary on PATH using execFile (no shell).
function whichPython(name) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [name], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).toString().trim();
      const first = out ? out.split(/\r?\n/)[0] : null;
      return first && isExecutableFile(first) ? first : null;
    }
    const out = execFileSync('/bin/sh', ['-c', 'command -v "$1" 2>/dev/null || true', '--', name], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out && isExecutableFile(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * resolvePython(projectRoot) -> { interpreter, source }
 *  - source: 'wayland-bundled' | 'system'
 *
 * Throws PythonNotFoundError on miss. Never silently falls back across
 * the wayland-bundled / system boundary -- that boundary is a deliberate
 * security signal (bundled = signed + reproducible; system = trust-on-first-use).
 */
export function resolvePython(/* projectRoot */) {
  const host = process.env.IJFW_HOST;

  if (host === 'wayland') {
    const profile = process.env.WAYLAND_HOME || join(homedir(), '.wayland');
    if (!isAbsolute(profile)) {
      throw new PythonNotFoundError(
        `[ijfw compute] WAYLAND_HOME must be absolute when IJFW_HOST=wayland (got "${profile}").`,
        { code: 'PYTHON_HOST_PATH_INVALID' }
      );
    }
    const candidate = process.platform === 'win32'
      ? join(profile, 'runtime', 'python', 'python.exe')
      : join(profile, 'runtime', 'python', 'bin', 'python3');

    if (isExecutableFile(candidate)) {
      return { interpreter: candidate, source: 'wayland-bundled' };
    }
    throw new PythonNotFoundError(
      `[ijfw compute] Bundled Python not found at ${candidate}. ` +
      `Install Wayland's python-build-standalone runtime or unset IJFW_HOST=wayland.`,
      { code: 'PYTHON_BUNDLED_MISSING', interpreter: candidate }
    );
  }

  // Non-Wayland host: probe system PATH. Fail loud on miss.
  const py3 = whichPython('python3');
  if (py3) return { interpreter: py3, source: 'system' };
  const py = whichPython('python');
  if (py) return { interpreter: py, source: 'system' };

  throw new PythonNotFoundError(
    '[ijfw compute] No Python interpreter found on PATH. ' +
    'Install Python 3 (python3 or python) or run under a Wayland host with ' +
    'IJFW_HOST=wayland and the bundled runtime.',
    { code: 'PYTHON_NOT_ON_PATH' }
  );
}
