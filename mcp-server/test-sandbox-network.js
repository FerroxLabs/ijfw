#!/usr/bin/env node
/**
 * test-sandbox-network.js -- Network deny / opt-in tests (V3-B1, V3-B2).
 *
 * Per-platform expectation:
 *   - macOS (sandbox-exec): allowNet=false MUST block; allowNet=true MUST allow.
 *   - Linux with isolation: same.
 *   - Best-effort hosts (no isolation tool): test logs DEGRADED rather than
 *     failing, since OS-level deny isn't reachable.
 *
 * The probe uses Node's built-in `dns.lookup` which is the canonical low-level
 * network primitive. We don't actually need the request to succeed -- just
 * to confirm whether the subprocess CAN reach the OS resolver.
 *
 * 5s probe timeout per case so a hanging socket doesn't stall the test.
 */

import { runCompute } from './src/compute/runner.js';
import { detectSandbox } from './src/compute/sandbox-detect.js';
import { wrap as wrapLinux } from './src/compute/sandbox-linux.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

let pass = 0;
let fail = 0;
let degraded = 0;

function logResult(name, ok, detail, isDegraded = false) {
  const tag = isDegraded ? 'DEGRADED' : (ok ? 'PASS' : 'FAIL');
  if (isDegraded) degraded++;
  else if (ok) pass++;
  else fail++;
  console.log(`  [${tag}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

const PROBE_SCRIPT = `
  const dns = require('dns');
  // 4s internal timeout so the probe can't hang past the runner's outer
  // budget.
  const t = setTimeout(() => { console.log('NET_TIMEOUT'); process.exit(0); }, 4000);
  dns.lookup('example.com', (err, addr) => {
    clearTimeout(t);
    if (err) console.log('NET_BLOCKED:' + err.code);
    else console.log('NET_OK:' + addr);
  });
`;

// B2 unit assertion: nsjail/bwrap/firejail args carry the right network
// flags for both modes. These are pure-function checks; they run on every
// platform even where the wrappers aren't installed, because we are only
// asserting the args array, not invoking the binary.
function assertLinuxNetArgs() {
  const baseInput = {
    cmd: '/usr/bin/node',
    args: ['-e', '1'],
    env: {},
    cwd: '/tmp/jail',
    allowedPaths: [],
    projectRoot: '/tmp/jail',
    tempDir: '/tmp/jail',
  };

  // nsjail allowNet=false: must NOT contain --disable_clone_newnet (that
  // flag would DISABLE the new netns). Must contain --iface_no_lo to
  // deny loopback as well.
  {
    const w = wrapLinux({ ...baseInput, kind: 'nsjail', allowNet: false });
    const args = w.args.join(' ');
    if (/--disable_clone_newnet\b/.test(args)) {
      logResult('nsjail allowNet=false omits --disable_clone_newnet', false,
        'B2 regression: flag still present');
    } else if (!/--iface_no_lo\b/.test(args)) {
      logResult('nsjail allowNet=false omits --disable_clone_newnet', false,
        '--iface_no_lo missing -- loopback would still be reachable');
    } else {
      logResult('nsjail allowNet=false omits --disable_clone_newnet', true,
        '--iface_no_lo present');
    }
  }
  // nsjail allowNet=true: --disable_clone_newnet MUST be present so the
  // child shares the host netns.
  {
    const w = wrapLinux({ ...baseInput, kind: 'nsjail', allowNet: true });
    const args = w.args.join(' ');
    if (/--disable_clone_newnet\b/.test(args)) {
      logResult('nsjail allowNet=true sets --disable_clone_newnet', true);
    } else {
      logResult('nsjail allowNet=true sets --disable_clone_newnet', false,
        'flag missing -- child would land in fresh empty netns');
    }
  }
  // bwrap allowNet=false: --unshare-net must be present.
  {
    const w = wrapLinux({ ...baseInput, kind: 'bwrap', allowNet: false });
    const args = w.args.join(' ');
    if (/--unshare-net\b/.test(args)) {
      logResult('bwrap allowNet=false sets --unshare-net', true);
    } else {
      logResult('bwrap allowNet=false sets --unshare-net', false, 'flag missing');
    }
  }
  // firejail allowNet=false: --net=none must be present.
  {
    const w = wrapLinux({ ...baseInput, kind: 'firejail', allowNet: false });
    const args = w.args.join(' ');
    if (/--net=none\b/.test(args)) {
      logResult('firejail allowNet=false sets --net=none', true);
    } else {
      logResult('firejail allowNet=false sets --net=none', false, 'flag missing');
    }
  }
}

async function main() {
  console.log('=== sandbox network tests ===');
  const det = await detectSandbox();
  console.log(`platform=${platform()} sandbox.kind=${det.kind} available=${det.available}`);

  // Pure-function args checks (run on every platform).
  assertLinuxNetArgs();

  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-net-'));
  try {
    // 1. allowNet=false -- expect block on enforced platforms.
    {
      const r = await runCompute({
        language: 'js',
        script: PROBE_SCRIPT,
        projectRoot,
        timeoutMs: 8_000,
        allowNet: false,
      });
      const reached = r.stdout.includes('NET_OK:');
      const isDegraded = r.sandbox.degraded || !r.sandbox.available;
      if (reached && isDegraded) {
        logResult('allowNet=false denies network', false,
          `reached network under best-effort sandbox -- expected on this host`, true);
      } else if (reached) {
        logResult('allowNet=false denies network', false,
          `LEAK -- subprocess reached network under enforced sandbox kind=${r.sandbox.kind}`);
      } else {
        logResult('allowNet=false denies network', true,
          `stdout=${r.stdout.trim().slice(0, 80)} kind=${r.sandbox.kind || 'none'}`);
      }
    }

    // 2. allowNet=true -- expect success on connected hosts; if no internet,
    // we surface as DEGRADED rather than fail.
    {
      const r = await runCompute({
        language: 'js',
        script: PROBE_SCRIPT,
        projectRoot,
        timeoutMs: 8_000,
        allowNet: true,
      });
      const reached = r.stdout.includes('NET_OK:');
      const blocked = r.stdout.includes('NET_BLOCKED:') || r.stdout.includes('NET_TIMEOUT');
      if (reached) {
        logResult('allowNet=true permits network', true, r.stdout.trim().slice(0, 80));
      } else if (blocked) {
        // Could be: (a) host has no internet, or (b) sandbox failed to grant.
        logResult('allowNet=true permits network', false,
          `subprocess could not resolve example.com (offline host or sandbox bug): ${r.stdout.trim().slice(0, 80)}`,
          true);
      } else {
        logResult('allowNet=true permits network', false,
          `unexpected stdout=${r.stdout.slice(0, 120)}`);
      }
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }

  console.log(`\nnetwork: pass=${pass} fail=${fail} degraded=${degraded}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('test-sandbox-network crashed:', e);
  process.exit(2);
});
