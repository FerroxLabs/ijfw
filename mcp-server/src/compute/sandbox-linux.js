/**
 * sandbox-linux.js -- Linux nsjail / firejail / bwrap wrapper.
 *
 * Honest caveats:
 *  - We do NOT mandate any one tool. The runner picks the first one detected
 *    by sandbox-detect.js.
 *  - When `kind` is null (no isolation tool installed), we fall back to a
 *    transparent passthrough -- subprocess runs without OS-level mount/network
 *    namespace. The runner emits the documented best-effort warning.
 *
 * All wrappers do their best to:
 *   - Mount cwd + projectRoot + tempDir read/write or read-only as appropriate
 *   - Hide the rest of the filesystem
 *   - Default-deny network unless `allowNet`
 *   - Inherit only the scrubbed env passed in
 *
 * Zero external deps.
 */

import { existsSync } from 'fs';

/**
 * wrap({ cmd, args, env, cwd, allowNet, allowedPaths, projectRoot, tempDir, kind })
 *  -> { cmd, args, env }
 *
 * `kind` is one of 'nsjail' | 'firejail' | 'bwrap' | null.
 * Caller (runner.js) passes the kind value resolved by sandbox-detect.
 */
export function wrap({ cmd, args, env, cwd, allowNet, allowedPaths, projectRoot, tempDir, kind }) {
  const reads = uniq([projectRoot, cwd, tempDir, ...(allowedPaths || [])]).filter(Boolean);
  const writes = uniq([cwd, tempDir, ...(allowedPaths || [])]).filter(Boolean);

  if (kind === 'bwrap') {
    return wrapBwrap({ cmd, args, env, cwd, allowNet, reads, writes });
  }
  if (kind === 'firejail') {
    return wrapFirejail({ cmd, args, env, cwd, allowNet, reads, writes });
  }
  if (kind === 'nsjail') {
    return wrapNsjail({ cmd, args, env, cwd, allowNet, reads, writes });
  }

  // Best-effort fallback: passthrough. Runner has already warned the user.
  return { cmd, args, env };
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

// --- bwrap (bubblewrap) --------------------------------------------------
// bwrap is the simplest + most portable option (used by Flatpak under the hood).
function wrapBwrap({ cmd, args, env, cwd, allowNet, reads, writes }) {
  const bwArgs = [
    '--die-with-parent',
    '--unshare-user-try',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  if (!allowNet) {
    bwArgs.push('--unshare-net');
  } else {
    // Network namespace shared; still hide /etc except resolv.conf.
    bwArgs.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf');
  }

  // Bind read-only system libs needed for any binary to run.
  for (const p of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d']) {
    if (existsSync(p)) bwArgs.push('--ro-bind-try', p, p);
  }

  // Read-only mounts.
  for (const r of reads) {
    bwArgs.push('--ro-bind-try', r, r);
  }
  // Read-write mounts (override the ro-bind for cwd + tempDir).
  for (const w of writes) {
    bwArgs.push('--bind-try', w, w);
  }

  bwArgs.push('--chdir', cwd, '--', cmd, ...args);

  return { cmd: 'bwrap', args: bwArgs, env };
}

// --- firejail ------------------------------------------------------------
function wrapFirejail({ cmd, args, env, cwd, allowNet, reads, writes }) {
  const fjArgs = [
    '--quiet',
    '--noprofile',
    '--private-tmp',
    '--private-dev',
    '--caps.drop=all',
    '--seccomp',
    '--nonewprivs',
    '--noroot',
    '--shell=none',
    '--blacklist=/home',
    '--blacklist=/root',
  ];

  if (!allowNet) {
    fjArgs.push('--net=none');
  }

  for (const r of reads) {
    fjArgs.push(`--read-only=${r}`);
    fjArgs.push(`--whitelist=${r}`);
  }
  for (const w of writes) {
    fjArgs.push(`--read-write=${w}`);
    fjArgs.push(`--whitelist=${w}`);
  }

  fjArgs.push('--', cmd, ...args);
  return { cmd: 'firejail', args: fjArgs, env: { ...env, FJ_CHDIR: cwd } };
}

// --- nsjail --------------------------------------------------------------
function wrapNsjail({ cmd, args, env, cwd, allowNet, reads, writes }) {
  const njArgs = [
    '--mode', 'o',  // execve mode (one-shot)
    '--quiet',
    '--disable_clone_newuser',  // some hosts disable user namespaces
    '--cwd', cwd,
    '--time_limit', '0',         // runner enforces timeout itself
    '--rlimit_as', 'soft',
    '--rlimit_cpu', 'soft',
    '--rlimit_nofile', '256',
    '--rlimit_fsize', '512',     // 512 MB output file size cap
    '--max_cpus', '2',
  ];

  if (!allowNet) {
    // nsjail ISOLATES net by default by creating a fresh network namespace.
    // We do NOT pass --disable_clone_newnet here -- that flag would DISABLE
    // creating the new netns and leave the child on the host network.
    // We do disable loopback too so even local sockets are denied.
    njArgs.push('--iface_no_lo');  // no loopback either when net denied
  } else {
    // Share host net namespace -- explicitly disable creation of new netns.
    njArgs.push('--disable_clone_newnet');
  }

  // Read-only bindmounts for system + project.
  for (const p of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc']) {
    if (existsSync(p)) njArgs.push('--bindmount_ro', `${p}:${p}`);
  }
  for (const r of reads) {
    njArgs.push('--bindmount_ro', `${r}:${r}`);
  }
  for (const w of writes) {
    njArgs.push('--bindmount', `${w}:${w}`);
  }

  njArgs.push('--', cmd, ...args);
  return { cmd: 'nsjail', args: njArgs, env };
}
