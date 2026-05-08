/**
 * sandbox-detect.js -- Runtime detection of available OS isolation mechanism.
 *
 * Returns a `wrap()` function from the appropriate platform module, or null
 * with a user-visible warning when no OS-level isolation is available.
 *
 * Honest framing per V3-B1: never claim "no network egress" without an
 * enforceable mechanism. Best-effort caveat is documented when null returned.
 *
 * Zero external dependencies -- Node.js built-ins only.
 */

import { execFileSync } from 'child_process';
import { platform } from 'os';

// Cached probe results so repeated invocations don't reshell.
let _cache = null;

// Probe for a binary on PATH without invoking a shell.
// Bin name is hardcoded at every call site (no user input) -- execFileSync
// also gives us defense in depth.
function which(bin) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [bin], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).toString().trim();
      return out ? out.split(/\r?\n/)[0] : null;
    }
    // POSIX: `command -v` is a builtin so we use /bin/sh -c with the bin
    // name as a literal arg (passed via args, not interpolated into command).
    // execFile semantics ensure no shell-metachar interpretation of `bin`.
    const out = execFileSync('/bin/sh', ['-c', 'command -v "$1" 2>/dev/null || true', '--', bin], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * detectSandbox() -> { wrapper, kind, available } + warning side effect.
 *
 * - kind: 'nsjail' | 'firejail' | 'bwrap' | 'sandbox-exec' | 'appcontainer' | null
 * - wrapper: imported platform module exposing `wrap(...)`, or null on unknown OS
 * - available: boolean (true when OS-level isolation is enforceable)
 *
 * On unsupported platforms, returns { wrapper: null, kind: null, available: false }
 * and emits a console.warn with the documented best-effort caveat.
 */
export async function detectSandbox() {
  if (_cache) return _cache;

  const plat = platform();
  let result;

  if (plat === 'linux') {
    let kind = null;
    if (which('nsjail')) kind = 'nsjail';
    else if (which('firejail')) kind = 'firejail';
    else if (which('bwrap')) kind = 'bwrap';

    const mod = await import('./sandbox-linux.js');
    if (kind) {
      result = { wrapper: mod, kind, available: true };
    } else {
      console.warn(
        '[ijfw compute] Sandbox: best-effort only on this Linux host -- ' +
        'install nsjail, firejail, or bwrap for OS-level isolation.'
      );
      result = { wrapper: mod, kind: null, available: false };
    }
  } else if (plat === 'darwin') {
    const mod = await import('./sandbox-macos.js');
    if (which('sandbox-exec')) {
      result = { wrapper: mod, kind: 'sandbox-exec', available: true };
    } else {
      console.warn(
        '[ijfw compute] Sandbox: best-effort only on this Darwin host -- ' +
        'sandbox-exec not found in PATH (unexpected; macOS ships it by default).'
      );
      result = { wrapper: mod, kind: null, available: false };
    }
  } else if (plat === 'win32') {
    const mod = await import('./sandbox-windows.js');
    if (which('powershell.exe') || which('pwsh.exe')) {
      // available=false because AppContainer enforcement is partial; honest signal.
      console.warn(
        '[ijfw compute] Sandbox: best-effort only on Windows -- ' +
        'AppContainer wrapper has documented graceful-degrade; subprocess runs without ' +
        'OS-level network namespace isolation.'
      );
      result = { wrapper: mod, kind: 'appcontainer', available: false };
    } else {
      console.warn(
        '[ijfw compute] Sandbox: best-effort only on this Windows host -- ' +
        'PowerShell not available; subprocess runs without OS-level isolation.'
      );
      result = { wrapper: mod, kind: null, available: false };
    }
  } else {
    console.warn(
      `[ijfw compute] Sandbox: best-effort only on this platform (${plat}) -- ` +
      'no OS-level isolation available. Subprocess runs with scrubbed env + ' +
      'allowlist path-prefix check only.'
    );
    result = { wrapper: null, kind: null, available: false };
  }

  _cache = result;
  return result;
}

// Test hook: reset cache so probe re-runs (used by adversarial tests).
export function _resetSandboxDetectCache() {
  _cache = null;
}

// Re-exported for tests + diagnostics.
export { which as _whichForTest };
