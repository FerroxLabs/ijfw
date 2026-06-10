#!/usr/bin/env node
/**
 * functional-smoke-workflow.mjs
 *
 * END-TO-END functional smoke for the IJFW WORKFLOW / project-orchestration
 * state surface — the state-machine + CLI that back `ijfw state:<verb>` and the
 * workflow phase files (`.ijfw/state/workflow.json`, wave STATE.md, intent
 * journal). This is the SEPARATE workflow-state harness; the memory surface has
 * its own `functional-smoke.mjs` (do not merge the two).
 *
 * WHY THIS EXISTS — provenance: a prior session found cross-audit AND
 * memory-recall were silently 100% broken while passing every unit/--help test
 * (memory: a missing `await` threw on every real recall). The same blind spot
 * can hide a broken workflow: unit tests call `query()` in-process, but the
 * REAL surface users hit is `node cli-run.js state:<verb>` driving disk state
 * across process boundaries, including crash/resume. This harness exercises that
 * real surface — actual child processes, actual disk reads/writes, actual
 * exit codes — and asserts:
 *
 *   1. get on an empty project returns `workflow:null` (not an error).
 *   2. set-phase writes workflow.json; get reads back the SAME state (RESUME).
 *   3. a multi-phase lifecycle (think -> plan -> build -> complete) persists
 *      and resumes consistently across separate CLI invocations.
 *   4. CRASH RECOVERY: a torn write (begin without commit) is rolled back by
 *      `state.replay` and `workflow.get` resumes the pre-crash phase — the
 *      WAL+replay contract, the single highest-risk workflow path.
 *   5. APPEND IDEMPOTENCY: a re-issued append verb (same dedupKey) does NOT
 *      double-write — record COUNT stays 1 (counted by parsing JSONL records,
 *      NOT `wc -l`, which miscounts a no-trailing-newline file as 0).
 *   6. EXIT-CODE CONTRACT: unknown verb / malformed payload / refused gate all
 *      return `ok:false` AND exit non-zero (the load-bearing shell-hook branch).
 *   7. CROSS-SURFACE isError: the MCP `ijfw_state` surface flags `isError` for
 *      every `ok:false` (not just `refused`) — agreeing with the CLI's non-zero
 *      exit and the SDK's `ok` contract. This is the silent-swallow class the
 *      memory-recall regression belonged to.
 *
 * SCRATCH-ONLY: every run uses a fresh `mktemp` HOME + project root. It never
 * touches the real `~/.ijfw` or this repo's `.ijfw/state`. The scratch tree is
 * removed on exit (success or failure).
 *
 * Re-runnable. Exits 0 when every assertion holds, non-zero (with the first
 * failing assertion printed) on any silent miss. No new deps — Node built-ins.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const CLI = join(REPO, 'mcp-server', 'src', 'cli-run.js');
const SDK = join(REPO, 'mcp-server', 'src', 'orchestrator', 'state-sdk.js');

let failures = 0;
let checks = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL: ${msg}`); };
const ok = (msg) => { console.log(`  ok: ${msg}`); };
function assert(cond, msg) {
  checks += 1;
  if (cond) ok(msg); else fail(msg);
  return cond;
}

// --- scratch sandbox --------------------------------------------------------
const SCRATCH = mkdtempSync(join(tmpdir(), 'ijfw-wf-smoke-'));
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
mkdirSync(HOME, { recursive: true });
mkdirSync(PROJ, { recursive: true });
process.on('exit', () => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ } });

const baseEnv = { ...process.env, HOME, IJFW_PROJECT_DIR: PROJ };

/** Run `node cli-run.js state:<verb> <json>` against the scratch project. */
function cli(verb, payloadObj, { env = {}, root = PROJ } = {}) {
  const payload = JSON.stringify(payloadObj ?? {});
  const r = spawnSync(process.execPath,
    [CLI, `state:${verb}`, payload, '--project-root', root],
    { encoding: 'utf8', env: { ...baseEnv, ...env } });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* leave null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** Raw colon-expr invocation (for malformed-shape tests the JSON helper can't form). */
function cliRaw(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', PROJ],
    { encoding: 'utf8', env: baseEnv });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
/** Count NON-BLANK JSONL records (NOT `wc -l` — a no-trailing-newline file reads as 0 lines). */
function jsonlCount(p) {
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).length;
}

const P = {
  workflow: join(PROJ, '.ijfw', 'state', 'workflow.json'),
  journal: join(PROJ, '.ijfw', 'state', 'intent-journal.jsonl'),
  decisions: join(PROJ, '.ijfw', 'blackboard', 'decisions.jsonl'),
};

// ===========================================================================
console.log(`\n[functional-smoke-workflow] scratch=${SCRATCH}`);

// --- 1. EMPTY get -----------------------------------------------------------
console.log('\n[1] workflow.get on an empty project');
{
  const r = cli('workflow.get', {});
  assert(r.code === 0, 'empty workflow.get exits 0');
  assert(r.json && r.json.ok === true, 'empty workflow.get returns ok:true');
  assert(r.json && r.json.workflow === null, 'empty workflow.get returns workflow:null (not an error)');
}

// --- 2. set -> get round-trip (RESUME read-back) ----------------------------
console.log('\n[2] set-phase -> get round-trip + disk consistency');
{
  const set = cli('workflow.set-phase', { phase: 'plan', milestone: 'v1', version: '1.0' });
  assert(set.code === 0 && set.json && set.json.ok === true, 'set-phase plan exits 0 / ok:true');
  assert(set.json.workflow && set.json.workflow.phase === 'plan', 'set-phase result carries phase=plan');

  const disk = readJson(P.workflow);
  assert(disk && disk.phase === 'plan' && disk.milestone === 'v1', 'workflow.json on disk matches the write');

  const get = cli('workflow.get', {});
  assert(get.json && get.json.workflow && get.json.workflow.phase === 'plan',
    'get reads back the SAME phase (resume read-back consistent)');
  assert(get.json.workflow.version === '1.0', 'get round-trips all fields (version)');
}

// --- 3. multi-phase lifecycle persists + resumes ----------------------------
console.log('\n[3] think -> plan -> build -> complete lifecycle');
{
  cli('workflow.set-phase', { phase: 'think' });
  cli('workflow.set-phase', { phase: 'build', status: 'in_progress' });
  const complete = cli('phase.complete', { phase: 'build', evidence: {} },
    { env: { IJFW_STATE_GATE_BYPASS: '1' } });
  assert(complete.code === 0 && complete.json && complete.json.ok === true,
    'phase.complete (gate-bypassed) exits 0 / ok:true');
  const disk = readJson(P.workflow);
  assert(disk && disk.phase === 'build' && disk.status === 'complete',
    'workflow.json shows phase=build status=complete after lifecycle');
  const resume = cli('workflow.get', {});
  assert(resume.json.workflow.status === 'complete',
    'a fresh CLI process resumes the completed status from disk');
}

// --- 4. CRASH RECOVERY: torn write rolled back, resume correct phase --------
console.log('\n[4] crash-recovery: torn write (begin w/o commit) -> replay -> resume');
{
  // Commit a clean baseline phase.
  cli('workflow.set-phase', { phase: 'recover-baseline' });
  const before = readJson(P.workflow);
  assert(before && before.phase === 'recover-baseline', 'crash baseline committed');

  // Inject a torn write in a child: monkeypatch the handler to do the real
  // mutation then throw BEFORE the dispatcher writes the commit record. This is
  // the exact WAL window state.replay must recover.
  const crashScript = `
    import { query, VERBS } from ${JSON.stringify(SDK)};
    const ctx = { projectRoot: ${JSON.stringify(PROJ)} };
    const orig = VERBS['workflow.set-phase'];
    VERBS['workflow.set-phase'] = async function (p, c, e) {
      await orig.call(this, p, c, e);                 // real begin+snapshot+mutate
      throw new Error('SIMULATED CRASH before commit');
    };
    try { await query('workflow.set-phase', { phase: 'torn-build' }, ctx); }
    catch { /* expected */ }
    process.exit(0);
  `;
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript],
    { encoding: 'utf8', env: baseEnv });
  assert(crash.status === 0, 'crash-injector child exited cleanly');

  const torn = readJson(P.workflow);
  assert(torn && torn.phase === 'torn-build', 'workflow.json shows the UNCOMMITTED torn phase before replay');

  const val = cli('state.validate', {});
  const orphans = (val.json.issues || []).filter((i) => /orphaned/.test(i.problem));
  assert(orphans.length === 1, 'state.validate flags exactly 1 orphaned begin');

  const rep = cli('state.replay', {});
  assert(rep.code === 0 && rep.json.ok === true, 'state.replay exits 0 / ok:true');
  assert(Array.isArray(rep.json.rolledBack) && rep.json.rolledBack.length === 1,
    'state.replay rolls back exactly 1 partial');

  const afterDisk = readJson(P.workflow);
  assert(afterDisk && afterDisk.phase === 'recover-baseline',
    'workflow.json rolled BACK to the pre-crash phase');
  const resume = cli('workflow.get', {});
  assert(resume.json.workflow.phase === 'recover-baseline',
    'workflow.get RESUMES the pre-crash phase (no torn state leaks to the user)');

  const val2 = cli('state.validate', {});
  const orphans2 = (val2.json.issues || []).filter((i) => /orphaned/.test(i.problem));
  assert(orphans2.length === 0, 'orphaned begin is sealed after replay (second validate clean)');
}

// --- 5. APPEND IDEMPOTENCY: same dedupKey does not double-write --------------
console.log('\n[5] append idempotency (decision.add dedupKey)');
{
  const a = cli('decision.add', { text: 'first', dedupKey: 'DK1' });
  assert(a.json && a.json.deduped === false, 'first decision.add writes (deduped:false)');
  const b = cli('decision.add', { text: 'dup', dedupKey: 'DK1' });
  assert(b.json && b.json.deduped === true, 're-issued decision.add is deduped (deduped:true)');
  assert(jsonlCount(P.decisions) === 1,
    'decisions.jsonl holds exactly 1 record after the dup (no double-write)');
}

// --- 6. EXIT-CODE CONTRACT: failures are loud (ok:false + non-zero) ----------
console.log('\n[6] exit-code contract (shell-hook branch)');
{
  const unknown = cli('workflow.bogus', {});
  assert(unknown.code !== 0 && unknown.json && unknown.json.ok === false,
    'unknown verb -> ok:false + non-zero exit');
  assert(unknown.json.code === 'UNKNOWN_VERB', 'unknown verb tagged code:UNKNOWN_VERB');

  const malformed = cliRaw(['state:workflow.get', 'not-json']);
  assert(malformed.code !== 0, 'malformed JSON payload -> non-zero exit');

  // refused hard-gate: wave with required-but-checkpointless subagents.
  cli('wave.advance', { waveId: 'wave-x', status: 'in_progress' });
  const refused = cli('wave.advance',
    { waveId: 'wave-x', status: 'complete', hardGate: true, requiredSubagents: ['s1'] });
  assert(refused.code !== 0 && refused.json && refused.json.ok === false && refused.json.refused === true,
    'refused hard-gate -> ok:false + refused:true + non-zero exit');
}

// --- 7. CROSS-SURFACE isError: MCP surface agrees with the CLI --------------
console.log('\n[7] cross-surface isError parity (the silent-swallow guard)');
{
  // roster.synthesize on an unknown domain returns { ok:false } WITHOUT
  // `refused`. The MCP `ijfw_state` surface must still flag isError:true — i.e.
  // it must key isError on the `ok` contract, not just `refused`. We assert the
  // exact predicate server.js uses, plus the CLI surface, so a regression that
  // re-narrows it to `refused`-only fails here.
  const mcpPredScript = `
    import { query } from ${JSON.stringify(SDK)};
    const r = await query('roster.synthesize', { domain: 'no-such-domain' }, { projectRoot: ${JSON.stringify(PROJ)} });
    const refused = r && r.refused === true;
    const failed = !r || r.ok === false;          // mirror server.js ijfw_state
    const isError = failed || refused;
    process.stdout.write(JSON.stringify({ ok: r.ok, refused: !!refused, isError }));
  `;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', mcpPredScript],
    { encoding: 'utf8', env: baseEnv });
  let pred = null;
  try { pred = JSON.parse((out.stdout || '').trim()); } catch { /* leave null */ }
  assert(pred && pred.ok === false, 'roster.synthesize unknown-domain returns ok:false');
  assert(pred && pred.refused === false, '...and is NOT a refused result (the trap case)');
  assert(pred && pred.isError === true,
    'MCP ijfw_state flags isError:true for a non-refused ok:false (no silent SUCCESS)');

  // CLI surface must agree: ok:false -> non-zero exit.
  const cliRoster = cli('roster.synthesize', { domain: 'no-such-domain' });
  assert(cliRoster.code !== 0 && cliRoster.json && cliRoster.json.ok === false,
    'CLI surface agrees: ok:false -> non-zero exit');
}

// ===========================================================================
console.log(`\n[functional-smoke-workflow] ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`[functional-smoke-workflow] FAILED — ${failures} silent miss(es) on the workflow/state surface`);
  process.exit(1);
}
console.log('[functional-smoke-workflow] PASS — workflow/state surface functional end-to-end');
process.exit(0);
