#!/usr/bin/env node
/**
 * functional-smoke-diag.mjs — END-TO-END functional smoke for IJFW's
 * DIAGNOSTIC / UTILITY verbs: `ijfw doctor`, `ijfw status`, `ijfw swarm`.
 *
 * Sibling of functional-smoke.mjs (which covers the MEMORY surface). This file
 * is deliberately SEPARATE and must never be merged into it.
 *
 * Why this exists: doctor/status/swarm report TRUTH to the user about what is
 * installed, what state exists, and what the swarm is doing. The dangerous
 * failure mode for a *diagnostic* verb is not crashing — it is reporting
 * SUCCESS / HEALTH / STATE that is FALSE. The unit + `--help` + route tests
 * assert PARSE + DISPATCH shape; they never plant a binary on a scratch PATH
 * and confirm doctor's verdict flips, never seed a receipt and confirm status
 * reflects it, never assert the swarm path reads real project state vs faking
 * a hardcoded banner. A verb can lie and still pass every existing test.
 *
 * This harness drives the REAL CLI (cross-orchestrator-cli.js) as a child
 * process in a SCRATCH HOME + SCRATCH PROJECT and asserts each verb reports
 * TRUTHFULLY. Any false report (present-claimed-absent, absent-claimed-present,
 * hardcoded/stale state, or a faked banner) exits the harness non-zero.
 *
 * The load-bearing assertion is the doctor PATH-manipulation pair:
 *   - PLANT an executable for a normally-ABSENT auditor on a scratch PATH and
 *     assert doctor flips it to cli_installed:true.
 *   - DROP a normally-PRESENT auditor's bin dir from PATH and assert doctor
 *     reports it cli_installed:false.
 *   - PLANT a NON-executable file shadowing an auditor name and assert doctor
 *     reports cli_installed:false (present-on-PATH but NOT runnable — the
 *     "reports a tool that cannot be invoked" lie this harness was built to
 *     catch; closed by the isInstalled `[ -x ]` hardening in audit-roster.js).
 *
 * Re-runnable. Touches only freshly-minted temp dirs; never the real ~/.ijfw.
 */

import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cross-orchestrator-cli.js');

// ---------------------------------------------------------------------------
// Tiny assertion + temp-dir harness
// ---------------------------------------------------------------------------
const cleanups = [];
function scratchDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
function cleanupAll() {
  for (const d of cleanups.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// Resolve the directory holding `node` and the system bin dirs. The doctor
// probe and the CLI both need `node` + `bash` reachable, so every scratch PATH
// we build MUST keep these — otherwise we are testing "node can't launch", not
// "doctor detection". This is the subtlety that makes a naive PATH=fake test
// produce empty output instead of a real verdict.
const NODE_DIR = dirname(process.execPath);
const SYS_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
function basePath(...extra) {
  return [...extra, NODE_DIR, ...SYS_DIRS].filter(Boolean).join(':');
}

// Run the CLI with an explicit env (HOME, PATH, …) in a given cwd, capture
// stdout. We force --json so output is deterministic regardless of TTY.
function runCli(args, { home, projDir, pathStr, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: projDir || process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PATH: pathStr || process.env.PATH,
      ...env,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function runJson(args, opts) {
  const out = runCli(args, opts);
  let parsed = null;
  try { parsed = JSON.parse(out.stdout); } catch { /* leave null */ }
  return { ...out, json: parsed };
}

// ---------------------------------------------------------------------------
// DOCTOR — the truth-of-detection verb
// ---------------------------------------------------------------------------
function testDoctor() {
  console.log('\n[doctor] CLI/API detection must mirror reality, not a stale roster');
  const home = scratchDir('ijfw-diag-doctor-home-');

  // Pick a roster auditor that is NORMALLY ABSENT on dev machines so planting
  // a fake binary is a clean present-flip signal. `aider` is the canonical
  // absent entry (pipx-installed, rarely on PATH).
  const PLANT_ID = 'aider';

  // --- 1. baseline: doctor runs and emits valid JSON with the roster shape ---
  const base = runJson(['doctor', '--json'], { home, pathStr: basePath('/opt/homebrew/bin', join(home, '.local', 'bin')) });
  check('doctor emits parseable JSON', base.json && Array.isArray(base.json.auditors), `status=${base.status} stdout[0..80]=${base.stdout.slice(0, 80)}`);
  const ids = base.json ? base.json.auditors.map(a => a.id) : [];
  check('doctor roster includes the core auditors', ['codex', 'gemini', 'claude'].every(x => ids.includes(x)), `ids=${ids.join(',')}`);

  // --- 2. PLANT an executable aider on a scratch PATH → must flip to present ---
  const planted = scratchDir('ijfw-diag-plantbin-');
  const exe = join(planted, PLANT_ID);
  writeFileSync(exe, '#!/bin/sh\necho fake-auditor\n');
  chmodSync(exe, 0o755);
  const withPlant = runJson(['doctor', '--json'], { home, pathStr: basePath(planted) });
  const plantedEntry = withPlant.json?.auditors.find(a => a.id === PLANT_ID);
  check(`doctor detects a PLANTED executable '${PLANT_ID}' on PATH (present-flip)`,
    plantedEntry && plantedEntry.cli_installed === true,
    `cli_installed=${plantedEntry?.cli_installed}`);

  // --- 3. NON-executable file shadowing the same name → must stay absent ---
  //   This is the "present-claimed but cannot be invoked" lie. `command -v`
  //   reports a non-+x file on PATH as found; doctor must NOT call it installed.
  const nonexec = scratchDir('ijfw-diag-nonexec-');
  writeFileSync(join(nonexec, PLANT_ID), 'this is not an executable\n'); // no chmod +x
  const withNonExec = runJson(['doctor', '--json'], { home, pathStr: basePath(nonexec) });
  const nonExecEntry = withNonExec.json?.auditors.find(a => a.id === PLANT_ID);
  check(`doctor reports a NON-executable '${PLANT_ID}' as ABSENT (no false 'installed')`,
    nonExecEntry && nonExecEntry.cli_installed === false,
    `cli_installed=${nonExecEntry?.cli_installed} (command -v finds it on PATH but it is not runnable)`);

  // --- 4. DROP a present auditor's dir → must report it absent ---------------
  //   Probe the real machine: which roster bins live where. We DROP homebrew +
  //   the user's ~/.local/bin so any auditor installed only there flips to
  //   absent. If NONE of the roster bins are reachable from the bare base PATH
  //   we just assert the planted-aider-free base shows aider absent (still a
  //   valid absent-report check).
  const bareBase = basePath(); // node + system only, no homebrew, no .local
  const bare = runJson(['doctor', '--json'], { home, pathStr: bareBase });
  const aiderBare = bare.json?.auditors.find(a => a.id === PLANT_ID);
  check(`doctor reports '${PLANT_ID}' ABSENT when not on PATH (absent-report)`,
    aiderBare && aiderBare.cli_installed === false,
    `cli_installed=${aiderBare?.cli_installed}`);

  // Same PLANTED executable, two PATHs: one that INCLUDES its dir, one that
  // DROPS it. The verdict MUST differ (present → absent). This proves doctor's
  // answer tracks PATH rather than returning a hardcoded/cached value, and is
  // host-independent (we control the binary, so it never vacuously skips).
  const presentEntry = withPlant.json?.auditors.find(a => a.id === PLANT_ID); // PATH includes `planted`
  check('doctor verdict TRACKS PATH (same binary: present when its dir is on PATH, absent when dropped)',
    presentEntry?.cli_installed === true && aiderBare?.cli_installed === false,
    `present(dir-on-path)=${presentEntry?.cli_installed} absent(dir-dropped)=${aiderBare?.cli_installed}`);

  // --- 5. api_set honesty: flips with the env var, not hardcoded -------------
  const keySet = runJson(['doctor', '--json'], { home, pathStr: bareBase, env: { OPENAI_API_KEY: 'sk-diag-test' } });
  const keyUnset = runJson(['doctor', '--json'], { home, pathStr: bareBase, env: { OPENAI_API_KEY: '' } });
  const codexSet = keySet.json?.auditors.find(a => a.id === 'codex');
  const codexUnset = keyUnset.json?.auditors.find(a => a.id === 'codex');
  check('doctor api_set=true when OPENAI_API_KEY is set', codexSet?.api_set === true, `api_set=${codexSet?.api_set}`);
  check('doctor api_set=false when OPENAI_API_KEY is empty', codexUnset?.api_set === false, `api_set=${codexUnset?.api_set}`);
}

// ---------------------------------------------------------------------------
// STATUS — must reflect REAL receipts, never a hardcoded hero line
// ---------------------------------------------------------------------------
function testStatus() {
  console.log('\n[status] hero line + run count must reflect real seeded receipts');
  const home = scratchDir('ijfw-diag-status-home-');
  const proj = scratchDir('ijfw-diag-status-proj-');

  // --- 1. empty project → runs:0, no faked hero line ---
  const empty = runJson(['status', '--json'], { home, projDir: proj });
  check('status on empty project reports runs:0', empty.json && empty.json.runs === 0, `json=${JSON.stringify(empty.json)}`);
  check('status on empty project reports null hero (no fabricated banner)', empty.json && empty.json.hero === null, `hero=${empty.json?.hero}`);

  // --- 2. seed one receipt → runs:1, last.mode + hero must reflect it ---
  const receiptsDir = join(proj, '.ijfw', 'receipts');
  mkdirSync(receiptsDir, { recursive: true });
  const receiptsFile = join(receiptsDir, 'cross-runs.jsonl');
  const r1 = { mode: 'audit', timestamp: '2026-06-08T10:00:00.000Z', auditors: [{ id: 'codex' }, { id: 'gemini' }], findings: { consensus: 2, contested: 1, unique: 5 }, duration_ms: 42000 };
  writeFileSync(receiptsFile, JSON.stringify(r1) + '\n');
  const one = runJson(['status', '--json'], { home, projDir: proj });
  check('status reflects 1 seeded receipt (runs:1)', one.json && one.json.runs === 1, `runs=${one.json?.runs}`);
  check('status last.mode mirrors the seeded receipt (audit)', one.json?.last?.mode === 'audit', `mode=${one.json?.last?.mode}`);
  check('status hero is computed from real findings (non-null, references findings)',
    typeof one.json?.hero === 'string' && /findings/.test(one.json.hero),
    `hero=${one.json?.hero}`);

  // --- 3. append a DISTINCT second receipt → runs:2, last flips to it ---
  const r2 = { mode: 'critique', timestamp: '2026-06-08T11:30:00.000Z', auditors: [{ id: 'codex' }], findings: { consensus: 0, contested: 0, unique: 3 }, duration_ms: 9000 };
  writeFileSync(receiptsFile, JSON.stringify(r1) + '\n' + JSON.stringify(r2) + '\n');
  const two = runJson(['status', '--json'], { home, projDir: proj });
  check('status increments to runs:2 after a 2nd receipt (not stale)', two.json?.runs === 2, `runs=${two.json?.runs}`);
  check('status last.mode flips to the newest receipt (critique)', two.json?.last?.mode === 'critique', `mode=${two.json?.last?.mode}`);
  check('status hero RE-computes (differs from the 1-receipt hero)',
    one.json?.hero !== two.json?.hero,
    `one='${one.json?.hero}' two='${two.json?.hero}'`);
}

// ---------------------------------------------------------------------------
// SWARM — must read real project state, never fake a "planned" banner
// ---------------------------------------------------------------------------
function testSwarm() {
  console.log('\n[swarm] status/tasks/worktree must read real project state, fail honestly when absent');
  const home = scratchDir('ijfw-diag-swarm-home-');
  const proj = scratchDir('ijfw-diag-swarm-proj-');

  // --- 1. swarm status with NO team → must NOT fabricate "planned"; honest error ---
  const noTeam = runCli(['swarm', 'status'], { home, projDir: proj });
  check('swarm status without a team does NOT fake a "planned" banner',
    !/Swarm:\s*planned/i.test(noTeam.stdout),
    `stdout=${noTeam.stdout.trim().slice(0, 120)}`);
  check('swarm status without a team exits non-zero (honest failure)',
    noTeam.status !== 0,
    `status=${noTeam.status}`);
  check('swarm status without a team points the user at remediation',
    /team init|No complete team/i.test(noTeam.stdout),
    `stdout=${noTeam.stdout.trim().slice(0, 120)}`);

  // --- 2. swarm tasks with no prepared tasks → honest "unavailable", not empty success ---
  const noTasks = runCli(['swarm', 'tasks'], { home, projDir: proj });
  check('swarm tasks without prepared tasks reports unavailable/empty honestly',
    /unavailable|No prepared swarm tasks/i.test(noTasks.stdout),
    `stdout=${noTasks.stdout.trim().slice(0, 120)}`);

  // --- 3. swarm worktree list in a REAL git repo → exercises the git path ---
  // Build a throwaway git repo so the worktree code runs its real git plumbing
  // rather than erroring on "not a repo".
  try {
    execSync('git init -q && git -c user.email=diag@ijfw -c user.name=diag commit -q --allow-empty -m init', {
      cwd: proj, stdio: 'ignore',
      env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    const wt = runCli(['swarm', 'worktree', 'list'], { home, projDir: proj });
    check('swarm worktree list runs in a real git repo and reports empty honestly',
      wt.status === 0 && /No swarm worktrees recorded/i.test(wt.stdout),
      `status=${wt.status} stdout=${wt.stdout.trim().slice(0, 120)}`);
  } catch (e) {
    check('swarm worktree list git-repo setup', false, `git setup failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------
console.log('functional-smoke-diag — doctor / status / swarm truthfulness gate');
console.log('CLI:', CLI);
try {
  testDoctor();
  testStatus();
  testSwarm();
} finally {
  cleanupAll();
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
