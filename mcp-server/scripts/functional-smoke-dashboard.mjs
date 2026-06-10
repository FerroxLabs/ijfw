#!/usr/bin/env node
/**
 * functional-smoke-dashboard.mjs — END-TO-END functional smoke for IJFW's
 * localhost SSE DASHBOARD, driven through the REAL `ijfw` CLI exactly as a user
 * runs it: `ijfw dashboard start|status|stop`.
 *
 * Why this exists (separate from functional-smoke.mjs, which covers MEMORY):
 * the unit / `--help` / route tests assert PARSE + DISPATCH shape only. They do
 * NOT bind a socket or curl an endpoint, so the dashboard verb regressed
 * silently: `ijfw dashboard start` was wired to the terminal TEXT renderer
 * (scripts/dashboard/bin.js) instead of the SSE web server
 * (mcp-server/bin/ijfw-dashboard). It printed a digest and never bound a port —
 * yet every existing test stayed green. This harness asserts REAL behaviour:
 *
 *   ijfw dashboard start --port P    must bind 127.0.0.1:P and write pid+port
 *   ijfw dashboard status            must report RUNNING with the right port
 *   GET /                            must return the HTML dashboard shell (200)
 *   GET /api/health                  must be 200 + point at the scratch ledger
 *   GET /api/observations            must contain the seeded observation marker
 *   GET /api/economics               must reflect the seeded token costs
 *   GET /stream (SSE)                must emit `: connected` + backfill the obs
 *   ijfw dashboard stop              must release the port + remove pid file
 *   ijfw dashboard status (post-stop) must report NOT running
 *
 * HARD ISOLATION: scratch HOME + scratch port (default 38900, far from the
 * canonical 37891-37900 range so it never collides with a real dashboard).
 * The spawned server is ALWAYS torn down in `finally` — the harness never
 * leaves a port bound, even on assertion failure or exception.
 *
 * Re-runnable. Exits 0 on full pass, non-zero on any failure.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> mcp-server/ -> repo root
const MCP_DIR  = join(__dirname, '..');
const CLI      = join(MCP_DIR, 'src', 'cross-orchestrator-cli.js');

const SCRATCH_PORT = parseInt(process.env.SMOKE_DASH_PORT || '38900', 10);
const OBS_MARKER   = 'SMOKE-DASH-OBS-' + Date.now();

const results = [];
function ok(name)        { results.push({ name, pass: true });  console.log('  PASS  ' + name); }
function bad(name, why)  { results.push({ name, pass: false, why }); console.log('  FAIL  ' + name + (why ? '  -- ' + why : '')); }

// --- tiny HTTP GET helper (no deps) ---
function get(path, { sse = false } = {}) {
  return new Promise((resolve) => {
    const headers = sse ? { Accept: 'text/event-stream' } : {};
    const req = http.get({ host: '127.0.0.1', port: SCRATCH_PORT, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      if (sse) {
        // SSE never ends on its own; grab the opening frames then bail.
        const timer = setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, body }); }, 1500);
        res.on('data', (c) => {
          body += c;
          if (body.includes('\n\n') && body.includes('data:')) {
            clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode, body });
          }
        });
      } else {
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

function runCli(scratchHome, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, HOME: scratchHome, CI: '1', NO_OPEN: '1' },
  });
}

async function main() {
  // Refuse to run if something already squats the scratch port (avoids a
  // false PASS against a stranger's server, and avoids killing it on teardown).
  const pre = await get('/api/health');
  if (pre.status !== 0) {
    console.error(`Port ${SCRATCH_PORT} is already in use. Set SMOKE_DASH_PORT to a free port and retry.`);
    process.exit(2);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'ijfw-dash-smoke-'));
  // Guard: never operate against the real ~/.ijfw.
  if (scratch === homedir() || scratch.length < 4) {
    console.error('Refusing to run: scratch HOME resolution looks unsafe.');
    process.exit(2);
  }
  const ijfwDir  = join(scratch, '.ijfw');
  const pidFile  = join(ijfwDir, 'dashboard.pid');
  const portFile = join(ijfwDir, 'dashboard.port');
  mkdirSync(ijfwDir, { recursive: true });

  // Seed a real observation so endpoints have something concrete to render.
  const obs = { id: 1, platform: 'claude-code', tool: 'Edit', summary: OBS_MARKER,
                ts: '2026-06-08T00:00:00Z', token_cost: 4242, work_tokens: 1717 };
  writeFileSync(join(ijfwDir, 'observations.jsonl'), JSON.stringify(obs) + '\n', 'utf8');

  let started = false;
  try {
    // 1) START via the REAL user-facing CLI verb.
    const start = runCli(scratch, ['dashboard', 'start', '--port', String(SCRATCH_PORT), '--no-open']);
    if (start.status === 0 && (start.stdout || '').includes('127.0.0.1:' + SCRATCH_PORT)) {
      ok('ijfw dashboard start exits 0 + announces bind');
    } else {
      bad('ijfw dashboard start', `status=${start.status} stdout=${JSON.stringify((start.stdout||'').trim())} stderr=${JSON.stringify((start.stderr||'').trim())}`);
    }

    // pid + port files written to the SCRATCH home (not the real one).
    started = existsSync(pidFile);
    if (existsSync(portFile) && readFileSync(portFile, 'utf8').trim() === String(SCRATCH_PORT)) {
      ok('port file written to scratch HOME with requested port');
    } else {
      bad('port file', `exists=${existsSync(portFile)} value=${existsSync(portFile) ? readFileSync(portFile,'utf8').trim() : 'n/a'} expected=${SCRATCH_PORT}`);
    }
    if (existsSync(pidFile)) ok('pid file written to scratch HOME');
    else bad('pid file', 'missing after start');

    // 2) STATUS reports RUNNING with the right port.
    const status = runCli(scratch, ['dashboard', 'status']);
    if (status.status === 0 && /running/i.test(status.stdout || '') && (status.stdout || '').includes(String(SCRATCH_PORT))) {
      ok('ijfw dashboard status reports running + correct port');
    } else {
      bad('ijfw dashboard status (running)', `stdout=${JSON.stringify((status.stdout||'').trim())}`);
    }

    // 3) GET / (the HTML shell).
    const page = await get('/');
    if (page.status === 200 && /<html|<!doctype/i.test(page.body) && page.body.length > 1000) {
      ok('GET / returns HTML dashboard shell (200, non-trivial body)');
    } else {
      bad('GET /', `status=${page.status} len=${page.body.length}`);
    }

    // 4) GET /api/health -> 200, points at the scratch ledger, obsCount>=1.
    const health = await get('/api/health');
    let healthJson = null; try { healthJson = JSON.parse(health.body); } catch {}
    if (health.status === 200 && healthJson && healthJson.ok === true &&
        (healthJson.ledgerPath || '').startsWith(scratch) && healthJson.obsCount >= 1) {
      ok('GET /api/health 200 + scratch ledger + obsCount>=1');
    } else {
      bad('GET /api/health', `status=${health.status} body=${JSON.stringify(health.body).slice(0,200)}`);
    }

    // 5) GET /api/observations contains the seeded marker (real data, not empty shell).
    const obsResp = await get('/api/observations');
    if (obsResp.status === 200 && obsResp.body.includes(OBS_MARKER)) {
      ok('GET /api/observations contains the seeded observation');
    } else {
      bad('GET /api/observations', `status=${obsResp.status} body=${JSON.stringify(obsResp.body).slice(0,200)}`);
    }

    // 6) GET /api/economics reflects seeded token math.
    const econ = await get('/api/economics');
    let econJson = null; try { econJson = JSON.parse(econ.body); } catch {}
    if (econ.status === 200 && econJson && econJson.count >= 1 && econJson.totalTokens === 4242) {
      ok('GET /api/economics reflects seeded token costs');
    } else {
      bad('GET /api/economics', `status=${econ.status} body=${JSON.stringify(econ.body).slice(0,200)}`);
    }

    // 7) SSE /stream emits the heartbeat + backfills the seeded observation.
    const stream = await get('/stream', { sse: true });
    if (stream.status === 200 && stream.body.includes(': connected') && stream.body.includes(OBS_MARKER)) {
      ok('SSE /stream emits heartbeat + backfills the seeded observation');
    } else {
      bad('SSE /stream', `status=${stream.status} body=${JSON.stringify(stream.body).slice(0,200)}`);
    }

    // 8) STOP releases the port + removes the pid file.
    const stop = runCli(scratch, ['dashboard', 'stop']);
    started = existsSync(pidFile); // refresh: should now be false
    const afterStop = await get('/api/health');
    if (stop.status === 0 && afterStop.status === 0 && !existsSync(pidFile)) {
      ok('ijfw dashboard stop releases port + removes pid file');
    } else {
      bad('ijfw dashboard stop', `stopStatus=${stop.status} portStillUp=${afterStop.status !== 0} pidFileLeft=${existsSync(pidFile)}`);
    }

    // 9) STATUS after stop reports NOT running.
    const status2 = runCli(scratch, ['dashboard', 'status']);
    if (status2.status === 0 && /not running/i.test(status2.stdout || '')) {
      ok('ijfw dashboard status reports NOT running after stop');
    } else {
      bad('ijfw dashboard status (stopped)', `stdout=${JSON.stringify((status2.stdout||'').trim())}`);
    }
  } finally {
    // TEARDOWN — ALWAYS. Never leave a port bound, even on exception/failure.
    try {
      if (existsSync(pidFile)) {
        runCli(scratch, ['dashboard', 'stop']);
      }
    } catch {}
    // Belt-and-braces: if the pid file still names a live process, SIGKILL it.
    try {
      if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    } catch {}
    // Final reachability check — if the port is STILL up, that's a teardown failure.
    const leak = await get('/api/health');
    if (leak.status !== 0) {
      bad('TEARDOWN: port released', `something still listening on ${SCRATCH_PORT}`);
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter(r => !r.pass);
  console.log('');
  console.log(`Dashboard functional smoke: ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log('  - ' + f.name + (f.why ? '  (' + f.why + ')' : ''));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('harness error:', e && e.stack || e); process.exit(1); });
