/**
 * Ralph verify-command allowlist -- Wave 0 F.3
 * Zero deps, ESM. Used by Phase 4 Ralph loop before executing any shell criterion.
 */

export const ALLOWLIST = [
  'grep -q',
  'npm test --',
  'pytest',
  'tsc --noEmit',
  'node --test',
  'bash scripts/',
  'git diff --exit-code',
  'test -f',
  'test -d',
];

export const FORBID_LIST = [
  'rm',
  'rmdir',
  'mv',
  'cp',
  'curl',
  'wget',
  'fetch',
  'git push',
  'git reset --hard',
  'git clean -f',
  'git rebase -i',
  'sudo',
  'chmod',
  'chown',
  'bash -c',
  'eval',
  'npm publish',
  'npm install',
  'pip install',
];

/**
 * Check whether a shell command is safe to run as a Ralph verify step.
 * Checks forbid list first (any token match), then allowlist (prefix match).
 *
 * @param {string} cmd
 * @returns {{ safe: true } | { safe: false, reason: string }}
 */
export function isSafeVerifyCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { safe: false, reason: 'command is empty or not a string' };
  }

  const trimmed = cmd.trim();

  // Forbid list: check each entry as a token sequence against the command.
  // Split on whitespace; check that the forbid token appears as a leading
  // subsequence of whitespace-delimited tokens (so "rm" matches "rm -rf /"
  // but not "grep -q 'rm'").
  for (const forbidden of FORBID_LIST) {
    const forbidTokens = forbidden.split(/\s+/);
    const cmdTokens = trimmed.split(/\s+/);
    let matched = true;
    for (let i = 0; i < forbidTokens.length; i++) {
      if (cmdTokens[i] !== forbidTokens[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { safe: false, reason: `${forbidden} is in forbid list` };
    }
  }

  // Allowlist: command must start with one of the known safe primitives.
  // Primitives ending in '/' (like 'bash scripts/') are path-prefix matches --
  // no trailing space needed since the script name continues the token directly.
  for (const allowed of ALLOWLIST) {
    if (trimmed === allowed) return { safe: true };
    if (allowed.endsWith('/')) {
      if (trimmed.startsWith(allowed)) return { safe: true };
    } else {
      if (trimmed.startsWith(allowed + ' ') || trimmed.startsWith(allowed + '\t')) {
        return { safe: true };
      }
    }
  }

  return { safe: false, reason: 'no allowlist match' };
}
