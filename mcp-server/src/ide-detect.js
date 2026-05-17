/**
 * ide-detect.js — IJFW v1.4.3 W9-B / B18
 *
 * Auto-detects which IDE is hosting the MCP server. 4-step probe:
 *   1. process.env.IJFW_IDE_ID (explicit override)
 *   2. process.env.npm_config_user_agent substring match
 *   3. Parent process inspection (POSIX `ps`, Windows `wmic`/`powershell`)
 *   4. Fallback 'unknown' — ARCH-L-01: emit one-time stderr info notice
 *
 * Result is cached per-process at first call (no perf cost on hot paths).
 *
 * Known IDE binary substrings (case-insensitive): claude, codex, gemini,
 * cursor, windsurf, copilot, hermes, wayland.
 *
 * NOTE: parent-process inspection is performed synchronously via
 * `child_process.spawnSync`. It is intentionally short-timeout and
 * best-effort: any failure falls through to step 4.
 */

import { spawnSync } from 'node:child_process';

const KNOWN_IDES = ['claude', 'codex', 'gemini', 'cursor', 'windsurf', 'copilot', 'hermes', 'wayland'];

const ID_PATTERN = /^[a-z0-9-]+$/;

let _cachedIde = null;
let _unknownLoggedThisProcess = false;

function matchKnownIde(s) {
  if (typeof s !== 'string') return null;
  const lower = s.toLowerCase();
  for (const id of KNOWN_IDES) {
    if (lower.includes(id)) return id;
  }
  return null;
}

function detectFromUserAgent() {
  const ua = process.env.npm_config_user_agent;
  return matchKnownIde(ua);
}

function detectFromParentProcess() {
  const ppid = process.ppid;
  if (!ppid || ppid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      // Use PowerShell as primary; fall back to wmic if it fails.
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Get-WmiObject Win32_Process -Filter "ProcessId=${ppid}" | Select-Object -ExpandProperty Name`],
        { encoding: 'utf8', timeout: 1500 },
      );
      if (r.status === 0 && r.stdout) {
        const match = matchKnownIde(r.stdout);
        if (match) return match;
      }
      const r2 = spawnSync('wmic', ['process', 'where', `ProcessId=${ppid}`, 'get', 'Name'], { encoding: 'utf8', timeout: 1500 });
      if (r2.status === 0 && r2.stdout) {
        return matchKnownIde(r2.stdout);
      }
      return null;
    }
    // POSIX
    const r = spawnSync('ps', ['-o', 'comm=', '-p', String(ppid)], { encoding: 'utf8', timeout: 1500 });
    if (r.status === 0 && r.stdout) {
      return matchKnownIde(r.stdout);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect the host IDE id. Cached at first call.
 *
 * @returns {string} one of KNOWN_IDES, an env-var value matching ID_PATTERN,
 *                   or 'unknown'.
 */
export function detectIde(_opts = {}) {
  if (_cachedIde !== null) return _cachedIde;

  // 1) explicit env var override
  const envOverride = process.env.IJFW_IDE_ID;
  if (typeof envOverride === 'string' && envOverride.length > 0 && ID_PATTERN.test(envOverride)) {
    _cachedIde = envOverride;
    return _cachedIde;
  }

  // 2) npm_config_user_agent
  const uaMatch = detectFromUserAgent();
  if (uaMatch) {
    _cachedIde = uaMatch;
    return _cachedIde;
  }

  // 3) parent process inspection
  const ppMatch = detectFromParentProcess();
  if (ppMatch) {
    _cachedIde = ppMatch;
    return _cachedIde;
  }

  // 4) fallback
  _cachedIde = 'unknown';
  if (!_unknownLoggedThisProcess) {
    process.stderr.write('[ijfw] info: IDE detection unavailable; cross-IDE conflict detection disabled. Set IJFW_IDE_ID to override.\n');
    _unknownLoggedThisProcess = true;
  }
  return _cachedIde;
}

/**
 * Test-only: clear cache + reset one-time stderr notice flag.
 */
export function _resetIdeCacheForTest() {
  _cachedIde = null;
  _unknownLoggedThisProcess = false;
}

export const KNOWN_IDE_LIST = Object.freeze([...KNOWN_IDES]);
