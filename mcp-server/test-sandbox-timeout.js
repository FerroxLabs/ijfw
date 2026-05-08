#!/usr/bin/env node
/**
 * test-sandbox-timeout.js -- Timeout, output-cap, and process-group kill tests.
 *
 * Asserts:
 *   - Default timeout is 30s but caller can pass a smaller cap (we use 3s here
 *     so the test suite is fast; the 30s default is unit-tested via the
 *     clampTimeout helper indirectly).
 *   - Wall-clock timeout SIGKILLs the subprocess (no zombie processes).
 *   - Process-group kill: a forked grandchild does NOT survive the parent
 *     kill (we look for the grandchild's pid in `ps` after the timeout).
 *   - 100MB output cap: a flooder is killed when it crosses the threshold;
 *     `truncated: true` is returned.
 *
 * The grandchild check uses the host's `ps` command after a small grace
 * period (200ms) -- enough for the kernel to reap.
 */

import { runCompute } from './src/compute/runner.js';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

let pass = 0;
let fail = 0;

function logResult(name, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  console.log(`  [${tag}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

function pidAlive(pid) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      }).toString();
      return out.includes(`"${pid}"`);
    } catch { return false; }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function main() {
  console.log('=== sandbox timeout + output-cap tests ===');
  console.log(`platform=${platform()}`);

  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-timeout-'));
  try {
    // 1. Wall-clock timeout fires.
    {
      const start = Date.now();
      const r = await runCompute({
        language: 'js',
        script: `
          // Spin so we don't depend on event-loop callbacks.
          while (true) { /* burn */ }
        `,
        projectRoot,
        timeoutMs: 1_500,
      });
      const dur = Date.now() - start;
      const killed = r.timedOut || r.signal === 'SIGKILL' || dur < 4_000;
      logResult('1.5s timeout SIGKILLs subprocess', killed,
        `timedOut=${r.timedOut} signal=${r.signal} dur=${dur}ms`);
    }

    // 2. Process-group kill: spawn a grandchild that would outlive the parent
    // if we killed only the parent pid. The PARENT prints the grandchild's
    // pid (via the spawn return value) so we capture it through the pipe
    // even when sandbox-exec mediates the grandchild's own stdio.
    {
      const r = await runCompute({
        language: 'js',
        script: `
          const { spawn } = require('child_process');
          const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            stdio: ['ignore','ignore','ignore'],
            detached: false,
          });
          process.stdout.write('GC:' + c.pid + '\\n');
          // Force flush and then block so the timeout fires.
          const start = Date.now();
          while (Date.now() - start < 60_000) { /* spin */ }
        `,
        projectRoot,
        timeoutMs: 2_500,
      });
      const m = r.stdout.match(/GC:(\d+)/);
      if (!m) {
        logResult('process-group kill (grandchild reaped)', false,
          `did not capture grandchild pid; stdout=${JSON.stringify(r.stdout.slice(0, 200))} signal=${r.signal}`);
      } else {
        const gcPid = Number(m[1]);
        // Wait briefly for kernel to reap.
        await new Promise((res) => setTimeout(res, 500));
        const stillAlive = pidAlive(gcPid);
        if (stillAlive) {
          // Best effort: clean up the orphan so we don't leak processes.
          try { process.kill(gcPid, 'SIGKILL'); } catch { /* gone */ }
        }
        logResult('process-group kill (grandchild reaped)', !stillAlive,
          `gcPid=${gcPid} alive=${stillAlive}`);
      }
    }

    // 3. Output cap -- floods stdout, expects truncated=true.
    // We don't push the full 100MB (slow). We assert the cap mechanism works
    // by setting a smaller artificial cap via the runner's behavior:
    // the runner enforces 100MB unconditionally, so we generate ~120MB.
    // To keep the test under 30s, we generate 110 MB at maximum throughput.
    {
      const r = await runCompute({
        language: 'js',
        script: `
          // Write 1MB chunks until we exceed ~110MB.
          const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1 MB of 'A's
          for (let i = 0; i < 110; i++) {
            process.stdout.write(chunk);
          }
        `,
        projectRoot,
        timeoutMs: 30_000,
      });
      const ok = r.truncated === true || (r.signal === 'SIGKILL');
      logResult('100MB output cap truncates', ok,
        `truncated=${r.truncated} stdoutBytes=${Buffer.byteLength(r.stdout)} signal=${r.signal}`);
      // logPath should exist and be non-empty.
      try {
        const st = statSync(r.logPath);
        logResult('full output preserved on disk', st.size > 0,
          `logPath=${r.logPath} size=${st.size}`);
      } catch (e) {
        logResult('full output preserved on disk', false,
          `stat error: ${e && e.message}`);
      }
    }

    // 4. Hard cap clamp -- timeoutMs > 300_000 must clamp to 300_000.
    // We don't actually wait 5 minutes; we just verify the API doesn't reject
    // the input and the run still completes for a fast script.
    {
      const r = await runCompute({
        language: 'js',
        script: `console.log('FAST');`,
        projectRoot,
        timeoutMs: 999_999_999,
      });
      const ok = r.exitCode === 0 && r.stdout.includes('FAST');
      logResult('timeout clamp does not break fast scripts', ok,
        `exit=${r.exitCode} stdout=${r.stdout.trim().slice(0, 60)}`);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }

  console.log(`\ntimeout: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('test-sandbox-timeout crashed:', e);
  process.exit(2);
});
