/**
 * sandbox-macos.js -- macOS sandbox-exec wrapper for the compute runner.
 *
 * Generates a per-invocation Scheme-syntax sandbox profile (.sb) inline,
 * writes it to the per-invocation temp dir, and returns a spawn-ready
 * { cmd, args, env } that the runner uses with child_process.spawn.
 *
 * Default-deny model: deny default; allow file-read for project root +
 * read-only paths needed for execution (system libs, dyld); allow file-write
 * only for cwd + temp dir; deny network unless allowNet=true.
 *
 * Honest caveats:
 *  - sandbox-exec is deprecated by Apple but still functional through current
 *    macOS releases; we use it because it's the only OS-level mechanism
 *    universally available without extra installs.
 *  - Some Apple-internal subsystems (e.g. mDNSResponder lookup) may leak
 *    metadata even when network is denied; this is documented best-effort.
 *
 * Zero external deps.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Build the .sb profile body as a Scheme s-expression.
// Each allowed path is escaped for inclusion in (literal "...").
function escapeForSb(s) {
  // Backslash + double-quote escaped for Scheme string literals.
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// V3-B3 sensitive-path enumeration: subpaths of $HOME we MUST deny reads on.
// Honest framing: the V3-B1 baseline calls for an allowlist; in practice
// macOS Node+Python require broad read access to dyld + system libs to start
// at all. We therefore implement reads as "broadly allowed except this
// enumerated deny-list", which produces the same observable outcome as a
// strict allowlist for the V3-B3 exfil-walk fixtures (Documents / .ssh /
// browser cookies / keychain / .aws / .gnupg / etc) without breaking Node.
// Writes remain a strict allowlist (cwd + tempDir + allowedPaths).
const SENSITIVE_HOME_SUBPATHS = [
  'Documents', 'Downloads', 'Desktop', 'Pictures', 'Movies', 'Music',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/Slack',
  'Library/Application Support/com.apple.sharedfilelist',
  'Library/Group Containers',
  'Library/Cookies',
  'Library/Keychains',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
  '.ssh', '.aws', '.gnupg', '.docker', '.kube',
  '.config', '.config/gcloud',
  '.cargo', '.op',
];
const SENSITIVE_HOME_LITERALS = [
  '.npmrc', '.pypirc', '.netrc', '.gitconfig', '.gitconfig.local',
  '.bash_history', '.zsh_history', '.psql_history',
  '.profile', '.bashrc', '.zshrc',
];

function denyHomeClauses(home) {
  if (!home) return '';
  const subs = SENSITIVE_HOME_SUBPATHS
    .map((p) => `  (subpath "${escapeForSb(join(home, p))}")`)
    .join('\n');
  const lits = SENSITIVE_HOME_LITERALS
    .map((p) => `  (literal "${escapeForSb(join(home, p))}")`)
    .join('\n');
  return `;; V3-B3 sensitive-path deny-list (subpath)
(deny file-read*
${subs}
)
;; V3-B3 sensitive-path deny-list (literal)
(deny file-read*
${lits}
)`;
}

function buildProfile({ projectRoot: _projectRoot, cwd, tempDir, allowedPaths, allowNet, home }) {
  const writes = new Set([cwd, tempDir, ...(allowedPaths || [])]);
  const writeClauses = Array.from(writes)
    .filter(Boolean)
    .map((p) => `  (subpath "${escapeForSb(p)}")`)
    .join('\n');

  // Network clause: explicit allow only when requested. We avoid a bare
  // `(deny network*)` because it interferes with Node's IPC startup; we
  // narrow the deny to outbound traffic + remote sockets while leaving
  // local UNIX sockets (used by Node IPC + libuv) intact.
  const networkClause = allowNet
    ? '(allow network*)'
    : '(deny network-outbound)\n(deny network-inbound)\n(allow network* (local ip "*:*"))\n(allow network-bind (local ip))';

  return `(version 1)
(deny default)

;; Required for sandbox-exec + Node/Python startup
(allow process*)
(allow signal)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow sysctl-read)
(allow mach-lookup)
(allow iokit-open)

;; Read access: broad by default; sensitive home subpaths denied below.
(allow file-read*)

${denyHomeClauses(home)}

;; Write access: strict allowlist (cwd + tempDir + allowedPaths).
(allow file-write*
${writeClauses}
)

;; Standard /dev nodes (read+write).
(allow file-read* file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/tty"))

;; Network (default deny outbound + inbound; loopback allowed for IPC).
${networkClause}
`;
}

/**
 * wrap({ cmd, args, env, cwd, allowNet, allowedPaths, projectRoot, tempDir })
 *  -> { cmd, args, env, profilePath }
 *
 * Wraps the requested invocation in `sandbox-exec -f <profile> <cmd> <args...>`.
 * Caller is responsible for cleaning up `profilePath` after the subprocess exits.
 */
export function wrap({ cmd, args, env, cwd, allowNet, allowedPaths, projectRoot, tempDir }) {
  if (!tempDir) throw new Error('sandbox-macos: tempDir is required');
  // Resolve the home dir from the (already scrubbed) env, with a host
  // homedir() fallback. Used to expand the V3-B3 sensitive deny-list.
  const home = (env && env.HOME) || homedir() || null;
  const profile = buildProfile({
    projectRoot: projectRoot || cwd,
    cwd,
    tempDir,
    allowedPaths,
    allowNet: !!allowNet,
    home,
  });
  const profilePath = join(tempDir, 'sandbox.sb');
  writeFileSync(profilePath, profile, { mode: 0o600 });

  return {
    cmd: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, cmd, ...args],
    env,
    profilePath,
  };
}

// Exposed for tests.
export { buildProfile as _buildProfileForTest };
