/**
 * sandbox-windows.js -- Best-effort Windows AppContainer wrapper.
 *
 * Honest framing per V3-B1: AppContainer enforcement on Windows requires
 * COM/Win32 API integration beyond what's portably reachable from a Node
 * MCP server without native bindings. This wrapper is documented as
 * graceful-degrade -- when AppContainer cannot be set up, the subprocess
 * runs with scrubbed env + path-prefix check only, and the runner emits
 * the documented best-effort warning.
 *
 * The wrapper attempts AppContainer via PowerShell + Start-Process when
 * available; otherwise it spawns directly.
 *
 * Zero external deps.
 */

import { existsSync } from 'fs';

// Probe for PowerShell once and cache.
let _psPath = null;
let _psProbed = false;
function findPowerShell() {
  if (_psProbed) return _psPath;
  _psProbed = true;
  const candidates = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        _psPath = c;
        return _psPath;
      }
    } catch { /* keep probing */ }
  }
  return null;
}

/**
 * wrap({ cmd, args, env, cwd, allowNet, allowedPaths, projectRoot, tempDir })
 *  -> { cmd, args, env, degraded }
 *
 * `degraded: true` indicates the caller (runner.js) should treat this as
 * best-effort only and surface the user-visible warning.
 */
export function wrap({ cmd, args, env, cwd /*, allowNet, allowedPaths, projectRoot, tempDir */ }) {
  const ps = findPowerShell();
  if (!ps) {
    // No PowerShell available -- documented graceful-degrade.
    return { cmd, args, env, degraded: true };
  }

  // Best-effort AppContainer launch via Start-Process. AppContainer profile
  // creation requires the New-AppxPackage / NewAppContainer COM ops which
  // aren't reachable from PowerShell without admin + a manifest, so this
  // path mainly enforces the working-directory + isolated env. We document
  // the limitation and return degraded:true so the runner surfaces the
  // honest warning.
  const psScript = [
    '$ErrorActionPreference = "Stop";',
    `$cmd = ${quotePs(cmd)};`,
    `$argList = @(${args.map(quotePs).join(',')});`,
    `Start-Process -FilePath $cmd -ArgumentList $argList -WorkingDirectory ${quotePs(cwd)} -NoNewWindow -Wait`,
  ].join(' ');

  return {
    cmd: ps,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript],
    env,
    degraded: true,
  };
}

function quotePs(s) {
  // PowerShell single-quoted string: escape single quotes by doubling them.
  return `'${String(s).replace(/'/g, "''")}'`;
}
