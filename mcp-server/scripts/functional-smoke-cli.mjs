#!/usr/bin/env node
/**
 * functional-smoke-cli.mjs — END-TO-END functional smoke for IJFW's
 * STATEFUL / DISPATCH CLI verbs, driven through the REAL `ijfw` binary
 * (cross-orchestrator-cli.js) exactly as a user runs them.
 *
 * Sibling of:
 *   - functional-smoke.mjs            (MEMORY surface)
 *   - functional-smoke-dashboard.mjs  (SSE dashboard)
 *   - functional-smoke-diag.mjs       (doctor / status / swarm truthfulness)
 *   - functional-smoke-workflow.mjs   (workflow surface)
 * This file is deliberately SEPARATE and must never be merged into them.
 *
 * Why this exists: IJFW's unit + `--help` + route tests assert PARSE + DISPATCH
 * SHAPE only. They never drive a verb to its REAL on-disk effect, so an entire
 * failure class stays invisible to a green suite:
 *
 *   - async-not-awaited        handler returns a Promise; output is `[object
 *                              Promise]` / undefined / exit races the async work
 *   - wrong-binary / wrong-route   verb dispatches to the wrong function
 *   - reports-success-on-failure   exit 0 + cheerful text when nothing happened
 *   - reads-but-misreads-state     reads a state file but pulls the wrong field
 *                                  (e.g. wrapper {code,data} leaks through and
 *                                  the consumer prints `undefined`)
 *   - writes-but-never-reads / reads-but-never-writes on state files
 *   - crash swallowed by a catch that prints success
 *
 * This harness spawns the REAL CLI as a child process in a SCRATCH HOME +
 * SCRATCH PROJECT, points HOME / USERPROFILE / IJFW_HOME / IJFW_PROJECT_DIR at
 * the scratch, and asserts the REAL effect of each verb: exit code, stdout
 * content, AND side-effect files actually created / modified on disk. Any
 * lie (success-on-failure, stale/undefined state, missing write) trips a
 * [BROKEN] and exits the harness non-zero.
 *
 * It includes a NEGATIVE CONTROL: a verb that SHOULD fail on bad input is
 * asserted to actually return non-zero — proving the harness can detect a
 * break and is not vacuously green.
 *
 * HARD ISOLATION: only freshly-minted temp dirs are touched. The real ~/.ijfw,
 * ~/.claude and ~/.config are NEVER written. install/uninstall/update are
 * driven ONLY against the scratch HOME (and the offline portion only).
 *
 * Re-runnable. Exits 0 on full pass, non-zero on any [BROKEN].
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..');
const CLI = join(MCP_DIR, 'src', 'cross-orchestrator-cli.js');

// ---------------------------------------------------------------------------
// Tiny assertion + scratch harness
// ---------------------------------------------------------------------------
const cleanups = [];
function scratchDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  // Guard: never operate against the real home.
  if (d === homedir() || d.length < 4) {
    console.error('Refusing to run: scratch dir resolution looks unsafe.');
    process.exit(2);
  }
  cleanups.push(d);
  return d;
}
function cleanupAll() {
  for (const d of cleanups.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

let broken = 0;
let works = 0;
function works_(name) { works++; console.log(`  [WORKS]  ${name}`); }
function broken_(name, why) { broken++; console.log(`  [BROKEN] ${name}${why ? `  -- ${why}` : ''}`); }
function expect(name, cond, why) { cond ? works_(name) : broken_(name, why); }

const NODE_DIR = dirname(process.execPath);
const SYS_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// Spawn the REAL CLI. Every IJFW HOME-ish env var points at the scratch HOME so
// no verb can ever touch the operator's real ~/.ijfw, ~/.claude, or ~/.config.
function runCli(args, { home, proj, env = {}, cwd } = {}) {
  const PATH = [NODE_DIR, ...SYS_DIRS, '/opt/homebrew/bin'].join(':');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || proj || process.cwd(),
    env: {
      // Start from a SCRUBBED env (not process.env) so the harness never
      // inherits the operator's real HOME / API keys / IJFW_* config.
      PATH,
      HOME: home,
      USERPROFILE: home,
      IJFW_HOME: join(home, '.ijfw'),
      IJFW_PROJECT_DIR: proj || home,
      CI: '1',
      NO_OPEN: '1',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, signal: r.signal };
}

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  spawnSync('git', ['-c', 'user.email=smoke@ijfw', '-c', 'user.name=smoke', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir, env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — proves the harness can DETECT a break.
// `ijfw team <bogus-sub>` and `ijfw recover <bogus-sub>` MUST exit non-zero.
// If these passed silently we would not trust any of the [WORKS] above them.
// ---------------------------------------------------------------------------
function testNegativeControl() {
  console.log('\n[negative-control] a verb that SHOULD fail on bad input must return non-zero');
  const home = scratchDir('ijfw-cli-neg-home-');
  const proj = scratchDir('ijfw-cli-neg-proj-');

  const bogusTeam = runCli(['team', 'totally-bogus-subcommand'], { home, proj });
  expect('NEGATIVE CONTROL: `team <bogus>` exits non-zero (harness can detect a break)',
    bogusTeam.status !== 0, `status=${bogusTeam.status}`);

  // Sanity inverse: a known-good verb returns 0. If this FAILS while the bogus
  // one "passes", the harness is inverted — both halves guard each other.
  const goodHelp = runCli(['mode'], { home, proj });
  expect('NEGATIVE CONTROL inverse: a real pointer verb (`mode`) exits 0',
    goodHelp.status === 0, `status=${goodHelp.status}`);
}

// ---------------------------------------------------------------------------
// POINTER STUBS — mode / metrics / handoff. Real effect = the redirect text.
// (They are registry pointer-stubs; the bug class here is a stub that prints
// nothing / wrong text / crashes.)
// ---------------------------------------------------------------------------
function testPointerStubs() {
  console.log('\n[pointer-stubs] mode / metrics / handoff print real redirect guidance + exit 0');
  const home = scratchDir('ijfw-cli-ptr-home-');
  const proj = scratchDir('ijfw-cli-ptr-proj-');

  const mode = runCli(['mode'], { home, proj });
  expect('`ijfw mode` prints config/statusline guidance + exit 0',
    mode.status === 0 && /config --audit|statusline/i.test(mode.stdout), `status=${mode.status} out=${mode.stdout.slice(0,80)}`);

  const metrics = runCli(['metrics'], { home, proj });
  expect('`ijfw metrics` prints dashboard/benchmark guidance + exit 0',
    metrics.status === 0 && /dashboard|benchmark|ijfw_metrics/i.test(metrics.stdout), `status=${metrics.status} out=${metrics.stdout.slice(0,80)}`);

  const handoff = runCli(['handoff'], { home, proj });
  expect('`ijfw handoff` points at the handoff skill / blackboard handoff + exit 0',
    handoff.status === 0 && /handoff/i.test(handoff.stdout), `status=${handoff.status} out=${handoff.stdout.slice(0,80)}`);
}

// ---------------------------------------------------------------------------
// CONFIG — `ijfw config --audit` prints the queued-feature notice; bare prints
// usage. Both exit 0. Drive the real text, not just dispatch shape.
// ---------------------------------------------------------------------------
function testConfig() {
  console.log('\n[config] --audit + bare both render real text');
  const home = scratchDir('ijfw-cli-cfg-home-');
  const proj = scratchDir('ijfw-cli-cfg-proj-');

  const audit = runCli(['config', '--audit'], { home, proj });
  expect('`ijfw config --audit` renders the queued-feature notice + exit 0',
    audit.status === 0 && /queued|config --audit/i.test(audit.stdout), `status=${audit.status} out=${audit.stdout.slice(0,80)}`);

  const bare = runCli(['config'], { home, proj });
  expect('`ijfw config` (bare) renders usage + exit 0',
    bare.status === 0 && /Usage: ijfw config/i.test(bare.stdout), `status=${bare.status} out=${bare.stdout.slice(0,80)}`);
}

// ---------------------------------------------------------------------------
// TEAM — init must WRITE charter.json + workflow.json to the scratch project;
// status must READ them back (not a hardcoded banner).
// ---------------------------------------------------------------------------
function testTeam() {
  console.log('\n[team] init writes charter+workflow; status reads them back');
  const home = scratchDir('ijfw-cli-team-home-');
  const proj = scratchDir('ijfw-cli-team-proj-');
  gitInit(proj);

  const init = runCli(['team', 'init', '--name', 'SmokeTeamABC'], { home, proj, cwd: proj });
  const charter = join(proj, '.ijfw', 'team', 'charter.json');
  const workflow = join(proj, '.ijfw', 'team', 'workflow.json');
  expect('`ijfw team init` exits 0 and WRITES charter.json + workflow.json on disk',
    init.status === 0 && existsSync(charter) && existsSync(workflow),
    `status=${init.status} charter=${existsSync(charter)} workflow=${existsSync(workflow)}`);

  // The written charter must carry the name we passed (write actually persisted
  // the input, not a default).
  let charterName = null;
  try { charterName = JSON.parse(readFileSync(charter, 'utf8')).team_name; } catch { /* */ }
  expect('team charter.json persists the --name we passed',
    charterName === 'SmokeTeamABC', `team_name=${charterName}`);

  const status = runCli(['team', 'status'], { home, proj, cwd: proj });
  expect('`ijfw team status` READS the written charter (echoes the real name)',
    status.status === 0 && status.stdout.includes('SmokeTeamABC'),
    `status=${status.status} out=${status.stdout.slice(0,80)}`);

  // Empty-project status must NOT fabricate a team.
  const emptyProj = scratchDir('ijfw-cli-team-empty-');
  const emptyStatus = runCli(['team', 'status'], { home, proj: emptyProj, cwd: emptyProj });
  expect('`ijfw team status` on a fresh project reports "no team" + exit non-zero (no faked team)',
    emptyStatus.status !== 0 && /No complete team/i.test(emptyStatus.stdout),
    `status=${emptyStatus.status} out=${emptyStatus.stdout.slice(0,80)}`);
}

// ---------------------------------------------------------------------------
// BLACKBOARD + HANDOFF — init/note write real ledger; status reflects; handoff
// writes a real markdown file.
// ---------------------------------------------------------------------------
function testBlackboardHandoff() {
  console.log('\n[blackboard] init/note write a real ledger; handoff writes a real file');
  const home = scratchDir('ijfw-cli-bb-home-');
  const proj = scratchDir('ijfw-cli-bb-proj-');

  const init = runCli(['blackboard', 'init'], { home, proj, cwd: proj });
  const bbDir = join(proj, '.ijfw', 'blackboard');
  expect('`ijfw blackboard init` exits 0 + creates the blackboard dir on disk',
    init.status === 0 && existsSync(bbDir), `status=${init.status} dir=${existsSync(bbDir)}`);

  const MARKER = 'BB-NOTE-MARKER-' + Date.now();
  const note = runCli(['blackboard', 'note', '--message', MARKER], { home, proj, cwd: proj });
  // The note must land in SOME file under the blackboard dir (real write).
  let noteOnDisk = false;
  try {
    for (const f of readdirSync(bbDir)) {
      if (existsSync(join(bbDir, f)) && readFileSync(join(bbDir, f), 'utf8').includes(MARKER)) { noteOnDisk = true; break; }
    }
  } catch { /* */ }
  expect('`ijfw blackboard note` PERSISTS the note text to the ledger (not just echoed)',
    note.status === 0 && noteOnDisk, `status=${note.status} onDisk=${noteOnDisk}`);

  // NEGATIVE: claim without an artifact must fail honestly.
  const badClaim = runCli(['blackboard', 'claim'], { home, proj, cwd: proj });
  expect('`ijfw blackboard claim` with no artifact fails honestly (exit non-zero)',
    badClaim.status !== 0 && /artifact-required|Claim failed/i.test(badClaim.stdout + badClaim.stderr),
    `status=${badClaim.status}`);

  // HANDOFF — writes a real markdown handoff file and prints its path.
  const HO = 'HANDOFF-BODY-' + Date.now();
  const handoff = runCli(['blackboard', 'handoff', '--message', HO], { home, proj, cwd: proj });
  const m = handoff.stdout.match(/Handoff written:\s*(\S+)/);
  const handoffPath = m ? m[1] : null;
  const handoffWritten = handoffPath && existsSync(handoffPath) && readFileSync(handoffPath, 'utf8').includes(HO);
  expect('`ijfw blackboard handoff` WRITES a real handoff file containing the message',
    handoff.status === 0 && handoffWritten, `status=${handoff.status} path=${handoffPath} written=${handoffWritten}`);
}

// ---------------------------------------------------------------------------
// CHECKPOINT + RECOVER — checkpoint writes md+json+latest; recover status must
// READ the real latest checkpoint id (regression: it printed "undefined" when
// readLatest's {code,data} wrapper leaked through recoveryStatus).
// ---------------------------------------------------------------------------
function testCheckpointRecover() {
  console.log('\n[checkpoint/recover] checkpoint writes files; recover status reads the real id');
  const home = scratchDir('ijfw-cli-cp-home-');
  const proj = scratchDir('ijfw-cli-cp-proj-');

  // recover latest on an EMPTY project: honest "no checkpoint" + non-zero.
  const emptyLatest = runCli(['recover', 'latest'], { home, proj, cwd: proj });
  expect('`ijfw recover latest` with no checkpoints fails honestly (exit non-zero)',
    emptyLatest.status !== 0 && /No checkpoint/i.test(emptyLatest.stdout),
    `status=${emptyLatest.status} out=${emptyLatest.stdout.slice(0,80)}`);

  const cp = runCli(['checkpoint', 'smoke-label'], { home, proj, cwd: proj });
  const cpDir = join(proj, '.ijfw', 'checkpoints');
  const latestJson = join(cpDir, 'latest.json');
  let cpId = null;
  try { cpId = JSON.parse(readFileSync(latestJson, 'utf8')).id; } catch { /* */ }
  expect('`ijfw checkpoint <label>` WRITES md+json+latest.json on disk',
    cp.status === 0 && existsSync(latestJson) && !!cpId,
    `status=${cp.status} latest=${existsSync(latestJson)} id=${cpId}`);

  // The load-bearing regression assertion: recover status must echo the REAL
  // checkpoint id read from latest.json, NOT "undefined".
  const recStatus = runCli(['recover', 'status'], { home, proj, cwd: proj });
  const latestLine = (recStatus.stdout.match(/Latest checkpoint:\s*(.*)/) || [])[1] || '';
  expect('`ijfw recover status` reads the REAL latest checkpoint id (not "undefined")',
    recStatus.status === 0 && cpId && latestLine.trim() === cpId,
    `printed="${latestLine.trim()}" expected="${cpId}"`);

  // recover latest now succeeds and echoes the markdown/id.
  const recLatest = runCli(['recover', 'latest'], { home, proj, cwd: proj });
  expect('`ijfw recover latest` succeeds after a checkpoint exists',
    recLatest.status === 0 && recLatest.stdout.length > 0,
    `status=${recLatest.status}`);
}

// ---------------------------------------------------------------------------
// DESIGN — init writes DESIGN.md; existing-file-without-force fails honestly;
// plan renders real guidance from the written DESIGN.md.
// ---------------------------------------------------------------------------
function testDesign() {
  console.log('\n[design] init writes DESIGN.md; re-init without --force fails; plan reads it');
  const home = scratchDir('ijfw-cli-design-home-');
  const proj = scratchDir('ijfw-cli-design-proj-');

  const init = runCli(['design', 'init', '--name', 'SmokeDesign'], { home, proj, cwd: proj });
  const designMd = join(proj, 'DESIGN.md');
  expect('`ijfw design init` WRITES DESIGN.md on disk + exit 0',
    init.status === 0 && existsSync(designMd), `status=${init.status} md=${existsSync(designMd)}`);

  // NEGATIVE: re-init without --force must NOT overwrite + must exit non-zero.
  const reinit = runCli(['design', 'init', '--name', 'Other'], { home, proj, cwd: proj });
  expect('`ijfw design init` again (no --force) refuses + exit non-zero (no silent clobber)',
    reinit.status !== 0 && /already exists/i.test(reinit.stdout),
    `status=${reinit.status} out=${reinit.stdout.slice(0,80)}`);

  const plan = runCli(['design', 'plan'], { home, proj, cwd: proj });
  expect('`ijfw design plan` renders real guidance (reads DESIGN.md) + exit 0',
    plan.status === 0 && /Design plan/i.test(plan.stdout) && plan.stdout.includes('DESIGN.md'),
    `status=${plan.status} out=${plan.stdout.slice(0,80)}`);
}

// ---------------------------------------------------------------------------
// IMPORT — drive a REAL write: seed a claude-mem sqlite store and assert the
// normalized entry lands in .ijfw/memory/. Plus negative: unknown tool fails.
// ---------------------------------------------------------------------------
function testImport() {
  console.log('\n[import] real claude-mem source -> writes .ijfw/memory; bad tool/source fail honestly');
  const home = scratchDir('ijfw-cli-import-home-');
  const proj = scratchDir('ijfw-cli-import-proj-');

  // NEGATIVE 1: unknown tool must fail honestly.
  const badTool = runCli(['import', 'bogus-tool-xyz'], { home, proj, cwd: proj });
  expect('`ijfw import <bogus-tool>` fails honestly (exit non-zero, names available tools)',
    badTool.status !== 0 && /Unknown tool/i.test(badTool.stdout + badTool.stderr),
    `status=${badTool.status}`);

  // NEGATIVE 2: known tool, NO source on the scratch machine -> clean failure,
  // no write, no fake success.
  const noSource = runCli(['import', 'claude-mem'], { home, proj, cwd: proj });
  expect('`ijfw import claude-mem` with no source fails cleanly (exit non-zero, no write)',
    noSource.status !== 0 && !existsSync(join(proj, '.ijfw', 'memory')) && /No claude-mem data/i.test(noSource.stdout + noSource.stderr),
    `status=${noSource.status} wrote=${existsSync(join(proj, '.ijfw', 'memory'))}`);

  // POSITIVE: seed a real sqlite observations table and import via --path.
  const dbPath = join(home, 'seed-claude-mem.db');
  const MARKER = 'IMPORT-SEED-' + Date.now();
  try {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE observations (title TEXT, type TEXT, narrative TEXT, concepts TEXT, project TEXT, session_id TEXT, created_at TEXT);');
    db.prepare('INSERT INTO observations (title,type,narrative,concepts,project,session_id,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('Smoke import title', 'decision', `${MARKER} narrative body`, '["smoke"]', '/tmp/p', 's1', '2026-06-01T00:00:00Z');
    db.close();
  } catch (e) {
    broken_('import seed sqlite store', `could not seed db: ${e.message}`);
    return;
  }

  const realImport = runCli(['import', 'claude-mem', '--path', dbPath], { home, proj, cwd: proj });
  const memDir = join(proj, '.ijfw', 'memory');
  let wroteMarker = false;
  try {
    if (existsSync(memDir)) {
      for (const f of readdirSync(memDir)) {
        const p = join(memDir, f);
        if (existsSync(p) && readFileSync(p, 'utf8').includes(MARKER)) { wroteMarker = true; break; }
      }
    }
  } catch { /* */ }
  expect('`ijfw import claude-mem --path <seeded.db>` WRITES the imported entry into .ijfw/memory',
    realImport.status === 0 && wroteMarker, `status=${realImport.status} wroteMarker=${wroteMarker}`);
}

// ---------------------------------------------------------------------------
// RECEIPT — seed a real Trident receipt and assert `ijfw receipt last` renders
// a redacted block reflecting it (not a hardcoded sample).
// ---------------------------------------------------------------------------
function testReceipt() {
  console.log('\n[receipt] empty -> honest message; seeded -> redacted block reflects real data');
  const home = scratchDir('ijfw-cli-receipt-home-');
  const proj = scratchDir('ijfw-cli-receipt-proj-');

  const empty = runCli(['receipt', 'last'], { home, proj, cwd: proj });
  expect('`ijfw receipt last` with no runs prints honest "no runs" + exit 0',
    empty.status === 0 && /No Trident runs/i.test(empty.stdout), `status=${empty.status} out=${empty.stdout.slice(0,80)}`);

  // Seed a receipt with a path that MUST be redacted to prove the redactor runs.
  const recDir = join(proj, '.ijfw', 'receipts');
  mkdirSync(recDir, { recursive: true });
  const CLAIM = 'leaky finding at /Users/secretperson/code/x.js';
  const receipt = {
    mode: 'audit', timestamp: '2026-06-08T10:00:00.000Z',
    auditors: [{ id: 'codex' }, { id: 'gemini' }],
    findings: { items: [{ severity: 'HIGH', claim: CLAIM }] },
  };
  writeFileSync(join(recDir, 'cross-runs.jsonl'), JSON.stringify(receipt) + '\n');

  const last = runCli(['receipt', 'last'], { home, proj, cwd: proj });
  expect('`ijfw receipt last` reflects the seeded receipt (auditors + finding) + exit 0',
    last.status === 0 && /codex/.test(last.stdout) && /leaky finding/.test(last.stdout),
    `status=${last.status} out=${last.stdout.slice(0,120)}`);
  expect('`ijfw receipt last` REDACTS absolute /Users paths (no secret username leak)',
    last.status === 0 && !last.stdout.includes('/Users/secretperson') && last.stdout.includes('~'),
    `out=${last.stdout.slice(0,160)}`);
}

// ---------------------------------------------------------------------------
// CODEX — doctor renders real checks and the exit code tracks the verdict.
// ---------------------------------------------------------------------------
function testCodex() {
  console.log('\n[codex] doctor renders real checks; exit code tracks the verdict');
  const home = scratchDir('ijfw-cli-codex-home-');
  const proj = scratchDir('ijfw-cli-codex-proj-');

  const doctor = runCli(['codex', 'doctor'], { home, proj, cwd: proj });
  expect('`ijfw codex doctor` renders the named checks block (real probe, not a stub)',
    /IJFW Codex doctor/.test(doctor.stdout) && /plugin metadata|hooks|AGENTS\.md/i.test(doctor.stdout),
    `status=${doctor.status} out=${doctor.stdout.slice(0,120)}`);

  // NEGATIVE: unknown codex sub fails honestly.
  const bad = runCli(['codex', 'bogus-sub'], { home, proj, cwd: proj });
  expect('`ijfw codex <bogus>` fails honestly (exit non-zero + usage)',
    bad.status !== 0 && /Usage: ijfw codex/i.test(bad.stdout),
    `status=${bad.status}`);
}

// ---------------------------------------------------------------------------
// EXTENSION — list returns real JSON; unknown sub fails honestly. This is the
// fire-and-forget async dispatch path (the async-not-awaited risk surface).
// ---------------------------------------------------------------------------
function testExtension() {
  console.log('\n[extension] list returns real JSON; unknown sub fails honestly (async dispatch)');
  const home = scratchDir('ijfw-cli-ext-home-');
  const proj = scratchDir('ijfw-cli-ext-proj-');

  const list = runCli(['extension', 'list'], { home, proj, cwd: proj });
  let listJson = null; try { listJson = JSON.parse(list.stdout); } catch { /* */ }
  expect('`ijfw extension list` emits parseable JSON with ok:true (not [object Promise])',
    list.status === 0 && listJson && listJson.ok === true && !/\[object Promise\]/.test(list.stdout),
    `status=${list.status} out=${list.stdout.slice(0,100)}`);

  const bad = runCli(['extension', 'definitely-not-a-command'], { home, proj, cwd: proj });
  expect('`ijfw extension <bogus>` fails honestly (exit non-zero from the async path)',
    bad.status !== 0 && /unknown extension command/i.test(bad.stdout + bad.stderr),
    `status=${bad.status} out=${(bad.stdout + bad.stderr).slice(0,120)}`);
}

// ---------------------------------------------------------------------------
// WORKTREE — list (empty) honest; create with a non-existent task fails. Runs
// the real git-worktree plumbing inside a real repo.
// ---------------------------------------------------------------------------
function testWorktree() {
  console.log('\n[worktree] empty list honest; create on a missing task fails honestly');
  const home = scratchDir('ijfw-cli-wt-home-');
  const proj = scratchDir('ijfw-cli-wt-proj-');
  gitInit(proj);

  const list = runCli(['worktree', 'list'], { home, proj, cwd: proj });
  expect('`ijfw worktree list` (none recorded) reports empty honestly + exit 0',
    list.status === 0 && /No swarm worktrees recorded/i.test(list.stdout),
    `status=${list.status} out=${list.stdout.slice(0,80)}`);

  const create = runCli(['worktree', 'create', 'task-that-does-not-exist'], { home, proj, cwd: proj });
  expect('`ijfw worktree create <missing-task>` fails honestly (exit non-zero, names the cause)',
    create.status !== 0 && /halted|task-not-found/i.test(create.stdout + create.stderr),
    `status=${create.status} out=${(create.stdout + create.stderr).slice(0,100)}`);
}

// ---------------------------------------------------------------------------
// PERSONALIZE — rooted in profile/* (do-not-fix zone). Drive the READ-ONLY
// `status` path only and assert it renders real flags. If broken, REPORT.
// ---------------------------------------------------------------------------
function testPersonalize() {
  console.log('\n[personalize] status renders real flags (read-only; profile/* is do-not-fix)');
  const home = scratchDir('ijfw-cli-pers-home-');
  const proj = scratchDir('ijfw-cli-pers-proj-');

  const status = runCli(['personalize', 'status'], { home, proj, cwd: proj });
  expect('`ijfw personalize status` renders the profile-bus flags block + exit 0',
    status.status === 0 && /profile-bus status/i.test(status.stdout) && /inject/i.test(status.stdout),
    `status=${status.status} out=${status.stdout.slice(0,120)}`);
}

// ---------------------------------------------------------------------------
// DEMO + DOCTOR + STATUS — light drive (doctor/status have a dedicated harness
// in functional-smoke-diag.mjs; here we just confirm they run truthfully in an
// isolated scratch HOME without crashing or lying).
// ---------------------------------------------------------------------------
function testDemoDoctorStatus() {
  console.log('\n[demo/doctor/status] run truthfully in scratch (offline)');
  const home = scratchDir('ijfw-cli-dds-home-');
  // demo WRITES a receipt into its project dir, so it gets its OWN scratch proj
  // — sharing one with the status check below would pollute status's run count.
  const demoProj = scratchDir('ijfw-cli-demo-proj-');

  // `ijfw demo` is a TOUR, not a gate: it must exit 0 and report TRUTHFULLY.
  // Two honest outcomes depending on the host: (a) no auditor reachable ->
  // "no auditors" guidance; (b) an auditor CLI is on PATH but unauthenticated
  // (scrubbed API keys) -> it runs and honestly reports per-auditor failure /
  // "no findings" / "no auditors responded". The LIE we guard against is
  // fabricated findings or a non-zero crash. We accept either honest branch.
  const demo = runCli(['demo'], { home, proj: demoProj, cwd: demoProj, env: { OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
  const honestDemo = /No auditors reachable|Install codex|No auditors responded|no findings returned|encountered an issue/i.test(demo.stdout);
  expect('`ijfw demo` (offline / unauthenticated) reports truthfully + exit 0 (no fabricated findings)',
    demo.status === 0 && honestDemo,
    `status=${demo.status} out=${demo.stdout.slice(0,160)}`);

  const doctorHome = scratchDir('ijfw-cli-doctor-home-');
  const doctor = runCli(['doctor', '--json'], { home: doctorHome, proj: doctorHome, cwd: doctorHome });
  let dJson = null; try { dJson = JSON.parse(doctor.stdout); } catch { /* */ }
  expect('`ijfw doctor --json` emits the auditors roster (real probe, parseable)',
    dJson && Array.isArray(dJson.auditors) && dJson.auditors.length > 0,
    `status=${doctor.status} parsed=${!!dJson}`);

  // status gets a PRISTINE project (no demo receipt leaked in).
  const statusProj = scratchDir('ijfw-cli-status-proj-');
  const status = runCli(['status', '--json'], { home, proj: statusProj, cwd: statusProj });
  let sJson = null; try { sJson = JSON.parse(status.stdout); } catch { /* */ }
  expect('`ijfw status --json` on empty project reports runs:0 + null hero (no faked banner)',
    sJson && sJson.runs === 0 && sJson.hero === null, `out=${status.stdout.slice(0,120)}`);
}

// ---------------------------------------------------------------------------
// PREFLIGHT — runs the REAL installer preflight against a CLEAN scratch repo.
// The bug class for preflight is a stub that always exits 0; we assert it runs
// the real gate (its output names the checks) AND that it can FAIL (non-zero)
// when a planted secret exists — proving the gate is live, not a no-op.
// ---------------------------------------------------------------------------
function testPreflight() {
  console.log('\n[preflight] runs the real installer gate; flips to non-zero on a planted secret');
  const home = scratchDir('ijfw-cli-pf-home-');
  const proj = scratchDir('ijfw-cli-pf-proj-');
  gitInit(proj);

  const clean = runCli(['preflight'], { home, proj, cwd: proj });
  // Either the script is present and runs (status 0/1/2 with real gate text),
  // or it is genuinely absent (status 1 + the explicit not-found message). Both
  // are honest; a SILENT exit-0 with no output would be the lie.
  const ranReal = /preflight|secret|gitleaks|gate|check/i.test(clean.stdout + clean.stderr);
  const honestAbsent = clean.status !== 0 && /preflight\.js not found/i.test(clean.stderr + clean.stdout);
  expect('`ijfw preflight` runs the REAL gate (names checks) or reports absent honestly (never a silent exit-0 stub)',
    (ranReal && (clean.status === 0 || clean.status === 1 || clean.status === 2)) || honestAbsent,
    `status=${clean.status} out=${(clean.stdout + clean.stderr).slice(0,160)}`);

  // Plant a secret and confirm the gate FLIPS to non-zero (proves it's live).
  // Only meaningful if the script was actually present and ran.
  if (ranReal && !honestAbsent) {
    writeFileSync(join(proj, 'leak.env'), 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCY\n');
    spawnSync('git', ['add', '-A'], { cwd: proj, env: { ...process.env, HOME: proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    const dirty = runCli(['preflight'], { home, proj, cwd: proj });
    expect('`ijfw preflight` FLIPS to non-zero when a secret is planted (gate is live, not a no-op)',
      dirty.status !== 0, `status=${dirty.status} out=${(dirty.stdout + dirty.stderr).slice(0,160)}`);
  } else {
    console.log('  (skip preflight secret-flip: script absent on this checkout — honest-absent already asserted)');
  }
}

// ---------------------------------------------------------------------------
// INSTALL / UNINSTALL / UPDATE — drive ONLY against the scratch HOME, and only
// the offline portion. `update --check` must not mutate the real machine; an
// absent install script must report honestly. We NEVER run a real install
// against the real HOME (env is scrubbed + pointed at scratch).
// ---------------------------------------------------------------------------
function testInstallSurface() {
  console.log('\n[install/uninstall/update] scratch-only; offline portion fails/reports honestly');
  const home = scratchDir('ijfw-cli-inst-home-');
  const proj = scratchDir('ijfw-cli-inst-proj-');

  // `update --check` is the offline branch: it must run without mutating the
  // scratch (or real) HOME and exit cleanly. We assert it does not crash and
  // does not write into the real home (scratch HOME guarantees that).
  const update = runCli(['update', '--check'], { home, proj, cwd: proj });
  expect('`ijfw update --check` runs offline without crashing (scratch HOME, no real-home mutation)',
    update.status === 0 || update.status === 1,
    `status=${update.status} signal=${update.signal} out=${(update.stdout + update.stderr).slice(0,120)}`);

  // The real ~/.ijfw must be untouched by anything above — assert no scratch
  // verb leaked a write to the operator's actual home. (Belt-and-braces: the
  // scratch HOME isolation already prevents this; we confirm the scratch's
  // IJFW_HOME is where writes go, never homedir().)
  expect('scratch HOME isolation holds (real ~/.ijfw is never the scratch target)',
    home !== homedir() && join(home, '.ijfw') !== join(homedir(), '.ijfw'),
    `home=${home}`);
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------
console.log('functional-smoke-cli — stateful/dispatch CLI verb real-effect gate');
console.log('CLI:', CLI);
try {
  testNegativeControl();
  testPointerStubs();
  testConfig();
  testTeam();
  testBlackboardHandoff();
  testCheckpointRecover();
  testDesign();
  testImport();
  testReceipt();
  testCodex();
  testExtension();
  testWorktree();
  testPersonalize();
  testDemoDoctorStatus();
  testPreflight();
  testInstallSurface();
} finally {
  cleanupAll();
}

console.log('');
console.log(`functional-smoke-cli: ${works} WORKS / ${broken} BROKEN`);
process.exit(broken === 0 ? 0 : 1);
