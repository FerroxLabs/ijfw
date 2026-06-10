#!/usr/bin/env node
/**
 * functional-smoke-injection.mjs — CROSS-CLIENT INJECTION VERIFICATION (S8).
 *
 * v1.6.0 personalization ships ONE local profile and projects it into every CLI
 * coding agent through whatever injection surface that client honors. Marketing
 * may ONLY list a client as "personalization travels here" once we have PROVEN,
 * through the client's REAL surface, that the profile actually reaches the agent.
 *
 * This harness drives the THREE injection surfaces end-to-end through their real
 * interfaces (no mocks) and emits a machine-readable PER-CLIENT VERDICT:
 *
 *   (a) MCP `instructions` path  — spawn the real server, drive the real JSON-RPC
 *       `initialize` handshake, assert the brief lands in `result.instructions`
 *       when the inject gate is ON, and is ABSENT when OFF / kill-switched.
 *   (b) MCP Resource path        — `resources/list` advertises ijfw://profile/brief
 *       and `resources/read` returns the brief text when ON, empty when OFF.
 *   (c) Rules-file path          — run the REAL session-start.sh hook in a scratch
 *       HOME + project and assert the project-scoped rules file (CLAUDE.md managed
 *       block) actually lands. The DEDICATED profile-snapshot adapter (renderSnapshot
 *       wired into the hook, spec slice S6) is NOT yet shipped, so that sub-leg is
 *       reported UNVERIFIED — honestly, never faked.
 *
 * NEGATIVE CONTROLS are first-class: for every surface we assert that with the
 * kill switch engaged (or the gate closed) NO injection occurs. A surface that
 * "passes" with the gate open AND with it closed is blind — that is itself a fail.
 *
 * Per-client verdicts (verified / partial / unverified):
 *   - verified   : at least one injection surface PROVEN to reach this client AND
 *                  its negative control PROVEN (gate-off => no injection).
 *   - partial    : at least one surface proven, but a surface this client is
 *                  expected to honor is NOT yet wired / not provable here.
 *   - unverified : NO surface proven for this client.
 *
 * Output: a `=== injection verification ... ===` tally plus a machine-readable
 * `INJECTION_VERDICTS_JSON: {...}` line the e2e gate / marketing tooling can parse.
 * Exits non-zero if any *expected-and-claimed* surface regresses or if a negative
 * control leaks.
 *
 *   node scripts/functional-smoke-injection.mjs
 *   node scripts/functional-smoke-injection.mjs --verdicts   # print only the JSON
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '..', 'src', 'server.js');
const REPO_ROOT = resolve(__dirname, '..', '..');
const SESSION_START = resolve(REPO_ROOT, 'claude', 'hooks', 'scripts', 'session-start.sh');

const VERDICTS_ONLY = process.argv.includes('--verdicts');

// ---------------------------------------------------------------------------
// Result recorder
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!VERDICTS_ONLY) {
    console.log(`[${ok ? 'WORKS ' : 'BROKEN'}] ${name}` +
      (detail ? `\n        ${String(detail).replace(/\n/g, '\n        ').slice(0, 400)}` : ''));
  }
}

// Track which injection surfaces were PROVEN reachable (positive + its negative
// control both held). Marketing/verdict logic reads these.
const surfaceProven = {
  'mcp-instructions': false,
  'mcp-resource': false,
  'rules-file-claude-md': false,
  'rules-file-profile-snapshot': false, // S6 — dedicated profile snapshot in a rules file
  'voice-exemplars': false, // V5 — voice few-shot block, store-backed serve path
};

// ---------------------------------------------------------------------------
// Minimal JSON-RPC stdio client (same shape as functional-smoke-mcp.mjs).
// ---------------------------------------------------------------------------
class McpClient {
  constructor(env, cwd) {
    this.proc = spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
  }
  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: r } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        r(msg);
      }
    }
  }
  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout waiting for ${method} (id ${id})\nstderr:\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolveP(m); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  close() {
    try { this.proc.stdin.end(); } catch { /* noop */ }
    try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Scratch-profile seeding. We seed a profile carrying a CONFIRMED style axis so
// the brief/snapshot is NON-EMPTY when the gate is open. The profile is written
// through the REAL store (writeProfile) so the on-disk byte format is exactly
// what the spawned server's readProfile expects — a hand-rolled JSON dump to the
// wrong filename would read back as a cold (empty) profile and the whole test
// would silently prove nothing.
// ---------------------------------------------------------------------------
async function seedProfile(profileDir) {
  const prevDir = process.env.IJFW_PROFILE_DIR;
  const prevEnv = process.env.NODE_ENV;
  process.env.IJFW_PROFILE_DIR = profileDir;
  process.env.NODE_ENV = 'test'; // path-policy carve-out: honor the tmpdir override
  try {
    const { makeProfile } = await import('../src/profile/schema.js');
    const { writeProfile } = await import('../src/profile/store.js');
    const p = makeProfile();
    // >=5 sessions of evidence => "confirmed" => surfaces in the brief/snapshot.
    p.global.style.terseness = { ema: 0.95, alpha: 6, beta: 2, evidence_count: 6 };
    const w = writeProfile(p);
    if (!w.ok) throw new Error(`seed writeProfile failed: ${w.code || ''} ${w.message || ''}`);
  } finally {
    if (prevDir === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prevDir;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
}

/**
 * Build a spawn env for the server with an isolated HOME (settings.json) +
 * PROFILE_DIR. `inject` controls settings.profile.inject; `kill` sets the
 * IJFW_PROFILE_KILL env override.
 */
function makeServerEnv({ home, profileDir, inject, kill }) {
  writeFileSync(join(home, 'settings.json'),
    JSON.stringify(inject === undefined ? {} : { profile: { inject } }), 'utf8');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    IJFW_HOME: join(home, '.ijfw-home-marker') === '' ? home : home, // HOME is the settings root
    IJFW_PROFILE_DIR: profileDir,
    NODE_ENV: 'test', // honor tmpdir profile override (path-policy carve-out)
    IJFW_VECTORS: '0',
  };
  // The gate reads IJFW_HOME || HOME/.ijfw for settings.json. We wrote settings.json
  // directly into `home`, so point IJFW_HOME at `home`.
  env.IJFW_HOME = home;
  if (kill !== undefined) env.IJFW_PROFILE_KILL = kill;
  else delete env.IJFW_PROFILE_KILL;
  delete env.IJFW_REGISTRY_WS_URL;
  delete env.IJFW_REGISTRY_WS_SOURCE;
  return env;
}

// A scratch HOME holds settings.json at its root (the gate reads
// $IJFW_HOME/settings.json). Returns { home, profileDir, cwd } temp paths.
function scratchTriple(root, tag) {
  const home = mkdtempSync(join(root, `home-${tag}-`));
  const profileDir = mkdtempSync(join(root, `prof-${tag}-`));
  const cwd = mkdtempSync(join(root, `cwd-${tag}-`));
  return { home, profileDir, cwd };
}

// ---------------------------------------------------------------------------
// (a) MCP `instructions` path
// ---------------------------------------------------------------------------
async function verifyInstructionsPath(root) {
  // --- POSITIVE: gate ON => instructions present, carries the brief -----------
  const on = scratchTriple(root, 'instr-on');
  await seedProfile(on.profileDir);
  const onEnv = makeServerEnv({ home: on.home, profileDir: on.profileDir, inject: 'on' });
  const onClient = new McpClient(onEnv, on.cwd);
  let onInstr = '';
  let onOk = false;
  try {
    const init = await onClient.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's8', version: '1' },
    });
    const r = init.result || {};
    onInstr = typeof r.instructions === 'string' ? r.instructions : '';
    onOk = !!(r.serverInfo) && onInstr.length > 0 &&
      /observed patterns/i.test(onInstr) && /terseness: terse/.test(onInstr);
  } catch (e) {
    onInstr = `THREW: ${e.message}`;
  } finally {
    onClient.close();
  }
  record('MCP instructions: gate ON => initialize returns the profile brief',
    onOk, onInstr.slice(0, 200));

  // --- NEGATIVE 1: gate OFF (default) => instructions ABSENT -------------------
  const off = scratchTriple(root, 'instr-off');
  await seedProfile(off.profileDir);
  const offEnv = makeServerEnv({ home: off.home, profileDir: off.profileDir }); // no inject key
  const offClient = new McpClient(offEnv, off.cwd);
  let offAbsent = false;
  let offDetail = '';
  try {
    const init = await offClient.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's8', version: '1' },
    });
    const r = init.result || {};
    offAbsent = !!(r.serverInfo) && r.instructions === undefined;
    offDetail = `instructions=${JSON.stringify(r.instructions)}`;
  } catch (e) {
    offDetail = `THREW: ${e.message}`;
  } finally {
    offClient.close();
  }
  record('MCP instructions NEGATIVE CONTROL: gate OFF => NO instructions injected',
    offAbsent, offDetail.slice(0, 200));

  // --- NEGATIVE 2: kill switch engaged (even with inject ON) => ABSENT ---------
  const killed = scratchTriple(root, 'instr-kill');
  await seedProfile(killed.profileDir);
  const killEnv = makeServerEnv({ home: killed.home, profileDir: killed.profileDir, inject: 'on', kill: '1' });
  const killClient = new McpClient(killEnv, killed.cwd);
  let killAbsent = false;
  let killDetail = '';
  try {
    const init = await killClient.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's8', version: '1' },
    });
    const r = init.result || {};
    killAbsent = !!(r.serverInfo) && r.instructions === undefined;
    killDetail = `instructions=${JSON.stringify(r.instructions)}`;
  } catch (e) {
    killDetail = `THREW: ${e.message}`;
  } finally {
    killClient.close();
  }
  record('MCP instructions NEGATIVE CONTROL: kill switch => NO instructions injected',
    killAbsent, killDetail.slice(0, 200));

  // Surface proven only when the positive AND both negative controls hold.
  surfaceProven['mcp-instructions'] = onOk && offAbsent && killAbsent;
}

// ---------------------------------------------------------------------------
// (b) MCP Resource path — ijfw://profile/brief
// ---------------------------------------------------------------------------
async function verifyResourcePath(root) {
  // --- POSITIVE: gate ON => resources/list advertises + read returns brief ----
  const on = scratchTriple(root, 'res-on');
  await seedProfile(on.profileDir);
  const onEnv = makeServerEnv({ home: on.home, profileDir: on.profileDir, inject: 'on' });
  const onClient = new McpClient(onEnv, on.cwd);
  let advertised = false;
  let readOk = false;
  let readDetail = '';
  try {
    await onClient.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's8', version: '1' },
    });
    onClient.notify('notifications/initialized', {});
    const listed = await onClient.request('resources/list', {});
    const uris = ((listed.result && listed.result.resources) || []).map(r => r.uri);
    advertised = uris.includes('ijfw://profile/brief');

    const read = await onClient.request('resources/read', { uri: 'ijfw://profile/brief' });
    const contents = (read.result && read.result.contents) || [];
    const text = contents.length && typeof contents[0].text === 'string' ? contents[0].text : '';
    readOk = text.length > 0 && /observed patterns/i.test(text) && /terseness: terse/.test(text);
    readDetail = `advertised=${advertised} text="${text.slice(0, 120)}"`;
  } catch (e) {
    readDetail = `THREW: ${e.message}`;
  } finally {
    onClient.close();
  }
  record('MCP resource: ijfw://profile/brief advertised by resources/list',
    advertised, readDetail.slice(0, 200));
  record('MCP resource: gate ON => resources/read returns the profile brief',
    readOk, readDetail.slice(0, 200));

  // --- NEGATIVE: kill switch => read returns EMPTY brief ----------------------
  const killed = scratchTriple(root, 'res-kill');
  await seedProfile(killed.profileDir);
  const killEnv = makeServerEnv({ home: killed.home, profileDir: killed.profileDir, inject: 'on', kill: '1' });
  const killClient = new McpClient(killEnv, killed.cwd);
  let emptyOnKill = false;
  let killDetail = '';
  try {
    await killClient.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's8', version: '1' },
    });
    killClient.notify('notifications/initialized', {});
    const read = await killClient.request('resources/read', { uri: 'ijfw://profile/brief' });
    const contents = (read.result && read.result.contents) || [];
    const text = contents.length && typeof contents[0].text === 'string' ? contents[0].text : '__NO_CONTENT__';
    // The resource read NEVER errors; under the kill switch it returns an EMPTY
    // brief. Empty (and specifically no terseness band leaking) is the proof.
    emptyOnKill = !(read.result && read.result.isError) &&
      text.trim() === '' && !/terseness: terse/.test(text);
    killDetail = `text="${text.slice(0, 120)}"`;
  } catch (e) {
    killDetail = `THREW: ${e.message}`;
  } finally {
    killClient.close();
  }
  record('MCP resource NEGATIVE CONTROL: kill switch => brief read is EMPTY (no leak)',
    emptyOnKill, killDetail.slice(0, 200));

  surfaceProven['mcp-resource'] = advertised && readOk && emptyOnKill;
}

// ---------------------------------------------------------------------------
// (c) Rules-file path — drive the REAL session-start.sh hook.
//
// The hook authors the project-scoped CLAUDE.md managed block (the guaranteed
// Claude Code visibility path). We assert that the managed block actually lands
// in a project-scoped file. We ALSO probe for a dedicated profile SNAPSHOT in a
// rules file (spec slice S6). That adapter is not yet wired, so we report it
// honestly as UNVERIFIED rather than faking a pass.
// ---------------------------------------------------------------------------
function verifyRulesFilePath(root) {
  if (!existsSync(SESSION_START)) {
    record('rules-file: session-start.sh present', false, `missing: ${SESSION_START}`);
    return;
  }

  const home = mkdtempSync(join(root, 'rf-home-'));
  const project = mkdtempSync(join(root, 'rf-proj-'));
  // Seed prior memory so the hook has something to project into the managed
  // block (HAVE_MEMORY path). A project journal line is the cheapest trigger.
  mkdirSync(join(project, '.ijfw', 'memory'), { recursive: true });
  writeFileSync(join(project, '.ijfw', 'memory', 'knowledge.md'),
    '# knowledge\n\n**Decision: use Postgres for billing (cited).**\n', 'utf8');

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // Keep the hook's background probes hermetic + fast; disable nothing that
    // affects the CLAUDE.md write path.
    IJFW_SKIP_PARSE: '1',
    CLAUDE_PLUGIN_ROOT: '', // force fallback path resolution (no global install)
  };
  // The hook is cwd-sensitive: it writes CLAUDE.md into $(pwd). Run it WITH the
  // project as cwd so the project-scoped write fires (and the P0 cwd guard, which
  // refuses to write into $HOME, is satisfied because cwd != HOME).
  const res = spawnSync('bash', [SESSION_START], {
    cwd: project, env, encoding: 'utf8', timeout: 30000,
  });

  const claudeMd = join(project, 'CLAUDE.md');
  const landed = existsSync(claudeMd);
  let blockOk = false;
  let detail = `exit=${res.status} CLAUDE.md=${landed}`;
  if (landed) {
    const body = readFileSync(claudeMd, 'utf8');
    // The managed block is the project-scoped rules-file injection that the hook
    // guarantees. Assert the markers + the memory pointer landed.
    blockOk = /IJFW-MEMORY-START/.test(body) && /IJFW-MEMORY-END/.test(body) &&
      /Project memory|ijfw-memory|Recent decisions/i.test(body);
    detail += ` block=${blockOk}`;
  }
  record('rules-file: session-start.sh writes the project-scoped managed block to CLAUDE.md',
    blockOk, detail.slice(0, 220));
  surfaceProven['rules-file-claude-md'] = blockOk;

  // NEGATIVE CONTROL: with the inject opt-out (.ijfw/no-inject) set, the hook
  // must NOT author the managed block — proving the rules-file injection is
  // gated, not unconditional.
  const home2 = mkdtempSync(join(root, 'rf-home-off-'));
  const project2 = mkdtempSync(join(root, 'rf-proj-off-'));
  mkdirSync(join(project2, '.ijfw', 'memory'), { recursive: true });
  writeFileSync(join(project2, '.ijfw', 'memory', 'knowledge.md'),
    '# knowledge\n\n**Decision: use Postgres for billing (cited).**\n', 'utf8');
  writeFileSync(join(project2, '.ijfw', 'no-inject'), '', 'utf8'); // opt OUT
  const env2 = { ...env, HOME: home2, USERPROFILE: home2 };
  spawnSync('bash', [SESSION_START], { cwd: project2, env: env2, encoding: 'utf8', timeout: 30000 });
  const claudeMd2 = join(project2, 'CLAUDE.md');
  // Either no CLAUDE.md at all, or one without our managed markers.
  let noInjectOnOptOut = true;
  let negDetail = `CLAUDE.md=${existsSync(claudeMd2)}`;
  if (existsSync(claudeMd2)) {
    const body2 = readFileSync(claudeMd2, 'utf8');
    noInjectOnOptOut = !/IJFW-MEMORY-START/.test(body2);
    negDetail += ` markers=${/IJFW-MEMORY-START/.test(body2)}`;
  }
  record('rules-file NEGATIVE CONTROL: .ijfw/no-inject => hook does NOT author the block',
    noInjectOnOptOut, negDetail.slice(0, 200));
  // The managed-block surface is "proven" only when the positive landed AND the
  // opt-out negative control held (gated, not unconditional).
  surfaceProven['rules-file-claude-md'] = blockOk && noInjectOnOptOut;

  // Dedicated profile-snapshot-in-a-rules-file (S6) — probe honestly. The
  // adapter (renderSnapshot wired into the hook) is not shipped; absence here is
  // EXPECTED and is recorded as UNVERIFIED, not BROKEN.
  let snapshotWired = false;
  if (landed) {
    const body = readFileSync(claudeMd, 'utf8');
    // A wired profile snapshot would emit flat "style.<axis>: <band>" lines.
    snapshotWired = /style\.\w+:\s+\w+/.test(body);
  }
  surfaceProven['rules-file-profile-snapshot'] = snapshotWired;
  // Informational only — never fails the gate (it's an unshipped slice).
  if (!VERDICTS_ONLY) {
    console.log(`[${snapshotWired ? 'WORKS ' : 'PENDING'}] rules-file: dedicated profile SNAPSHOT in rules file (spec S6)` +
      `\n        ${snapshotWired ? 'wired' : 'NOT wired yet (renderSnapshot un-hooked) => reported UNVERIFIED, not faked'}`);
  }
}

// ---------------------------------------------------------------------------
// (d) Voice-exemplars path — the V5 store-backed few-shot injection.
//
// Voice exemplars = short raw snippets of the USER's OWN writing, captured
// locally + transiently and few-shot into a prompt so the agent drafts in the
// user's voice. This is a FEATURE, not a research proof: NO stylometry / AUC /
// corpus anywhere. We drive the REAL serve-path injection the way production
// does — capture into the REAL V1 store, then call the REAL `profileSnapshot`
// serve entry (the same renderSnapshot voice seam the rules-file adapter calls)
// with the voice gate ON and NO injected candidate set, so the snapshot must
// RETRIEVE from the store itself. A real `<ijfw-voice>` block coming out is the
// proof. The NEGATIVE CONTROL (gate OFF => no block, byte-identical to no-voice)
// proves the surface is gated, not unconditional — a leg that "passes" both ways
// is blind.
//
// Runs in-process: the voice serve path is pure Node (zero-LLM, no socket/port),
// so spawning a server would add nothing. We isolate via IJFW_PROFILE_DIR +
// NODE_ENV=test (path-policy carve-out) so the real ~/.ijfw is never touched,
// and restore env afterwards.
// ---------------------------------------------------------------------------
async function verifyVoicePath(root) {
  const profileDir = mkdtempSync(join(root, 'voice-prof-'));
  const prevDir = process.env.IJFW_PROFILE_DIR;
  const prevStateDir = process.env.IJFW_PROFILE_STATE_DIR;
  const prevEnv = process.env.NODE_ENV;
  const prevKill = process.env.IJFW_PROFILE_KILL;
  process.env.IJFW_PROFILE_DIR = profileDir;
  process.env.IJFW_PROFILE_STATE_DIR = profileDir;
  process.env.NODE_ENV = 'test'; // path-policy carve-out: honor the tmpdir override
  delete process.env.IJFW_PROFILE_KILL;

  let positiveOk = false;
  let negativeOk = false;
  let isolationOk = false;
  let detail = '';
  try {
    const { captureMessage } = await import('../src/profile/exemplar-capture.js');
    const { listExemplars, exemplarStorePath } = await import('../src/profile/exemplar-store.js');
    const { profileSnapshot } = await import('../src/profile/serve.js');

    // Capture the user's OWN writing into the REAL store (the capture entry the
    // pre-prompt hook uses). A couple of casual samples so a casual task matches.
    captureMessage({ text: 'hey team, quick heads up on the deploy tonight', ts: '2026-06-01T00:00:00.000Z' });
    captureMessage({ text: 'Can you tighten up this paragraph a bit? Reads clunky.', ts: '2026-06-02T00:00:00.000Z' });
    const stored = listExemplars();

    // Isolation: the store resolved under our tmp override, never the real ~/.ijfw.
    const storePath = exemplarStorePath();
    isolationOk = storePath.startsWith(profileDir) && !storePath.includes(join('.ijfw', 'profile'));

    // --- POSITIVE: gate ON + non-empty taskText => a real <ijfw-voice> block,
    //     retrieved FROM the store (no injected candidate set). -----------------
    const on = profileSnapshot({
      includeVoiceExemplars: true,
      taskText: 'help me write a casual note to the team about the rollout',
      context: { host: 'cursor' },
      host: 'cursor',
    });
    const onText = String(on.snapshot || '');
    positiveOk = /<ijfw-voice>/.test(onText)
      && /<\/ijfw-voice>/.test(onText)
      && /match their voice/i.test(onText)
      && !/indistinguishable/i.test(onText)   // honesty bar
      && Array.isArray(on.voice) && on.voice.length >= 1;

    // --- NEGATIVE CONTROL: gate OFF (flag omitted) => NO block, byte-identical
    //     to the no-voice snapshot. A surface that injects with the gate closed
    //     is blind => fail. -------------------------------------------------------
    const baseline = profileSnapshot({ context: { host: 'cursor' }, host: 'cursor' });
    const off = profileSnapshot({
      taskText: 'help me write a casual note to the team about the rollout',
      context: { host: 'cursor' },
      host: 'cursor',
    });
    const offText = String(off.snapshot || '');
    negativeOk = !/<ijfw-voice>/.test(offText)
      && offText === String(baseline.snapshot || '')
      && Array.isArray(off.voice) && off.voice.length === 0;

    detail = `stored=${stored.length} on.voice=${on.voice ? on.voice.length : 'n/a'} `
      + `block=${/<ijfw-voice>/.test(onText)} offBlock=${/<ijfw-voice>/.test(offText)} isolation=${isolationOk}`;
  } catch (e) {
    detail = `THREW: ${e && e.stack ? e.stack : e}`;
  } finally {
    if (prevDir === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevDir;
    if (prevStateDir === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevStateDir;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevKill === undefined) delete process.env.IJFW_PROFILE_KILL; else process.env.IJFW_PROFILE_KILL = prevKill;
  }

  record('voice-exemplars: gate ON + taskText => store-backed <ijfw-voice> few-shot block',
    positiveOk, detail.slice(0, 220));
  record('voice-exemplars NEGATIVE CONTROL: gate OFF => NO voice block (byte-identical to no-voice)',
    negativeOk, detail.slice(0, 220));
  record('voice-exemplars: store path isolated to the tmp override (never real ~/.ijfw)',
    isolationOk, detail.slice(0, 220));

  // Surface proven only when the positive AND the negative control AND isolation hold.
  surfaceProven['voice-exemplars'] = positiveOk && negativeOk && isolationOk;
}

// ---------------------------------------------------------------------------
// Per-client verdict matrix. Each client declares the surfaces it is EXPECTED to
// honor (per the spec's MCP-architecture ladder). A client is:
//   - verified   : >=1 expected surface PROVEN.
//   - partial    : it honors MCP-or-rules but a leg we hoped for is unproven AND
//                  it has at least one proven surface elsewhere... (handled below)
//   - unverified : NO expected surface proven.
// We keep this conservative: marketing should list ONLY `verified` clients.
// ---------------------------------------------------------------------------
function computeVerdicts() {
  // Surfaces each client can honor, highest-first (spec §"MCP architecture").
  const clients = {
    'claude-code': ['mcp-instructions', 'mcp-resource', 'rules-file-claude-md'],
    'codex':       ['mcp-instructions', 'rules-file-claude-md'],
    'vscode-copilot': ['mcp-instructions', 'mcp-resource'],
    'cursor':      ['rules-file-profile-snapshot'], // rules-only tier for the profile snapshot
    'windsurf':    ['rules-file-profile-snapshot'],
    'aider':       ['rules-file-profile-snapshot'],
  };
  const verdicts = {};
  for (const [client, surfaces] of Object.entries(clients)) {
    const proven = surfaces.filter(s => surfaceProven[s]);
    let verdict;
    if (proven.length === 0) verdict = 'unverified';
    else if (proven.length === surfaces.length) verdict = 'verified';
    else verdict = 'partial';
    verdicts[client] = { verdict, proven, expected: surfaces };
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-fsinject-'));
  let exitCode = 0;
  try {
    await verifyInstructionsPath(root);
    await verifyResourcePath(root);
    verifyRulesFilePath(root);
    await verifyVoicePath(root); // V5 — store-backed voice few-shot injection
  } catch (err) {
    record('harness completed without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const verdicts = computeVerdicts();

  // Machine-readable line for the e2e gate + marketing tooling. `verifiedCount`
  // / `verifiedClients` are the authoritative, unambiguous fields the gate reads
  // (grep-counting "verified" across the blob would double-count the detail map).
  const verifiedClients = Object.entries(verdicts)
    .filter(([, v]) => v.verdict === 'verified').map(([k]) => k);
  console.log('INJECTION_VERDICTS_JSON: ' + JSON.stringify({
    verifiedCount: verifiedClients.length,
    verifiedClients,
    surfaces: surfaceProven,
    clients: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.verdict])),
    detail: verdicts,
  }));

  if (!VERDICTS_ONLY) {
    console.log('\n--- per-client injection verdicts ---');
    for (const [client, v] of Object.entries(verdicts)) {
      console.log(`  ${client.padEnd(16)} ${v.verdict.toUpperCase().padEnd(11)} proven: [${v.proven.join(', ') || 'none'}]`);
    }
  }

  const broken = results.filter(r => !r.ok);
  if (!VERDICTS_ONLY) {
    console.log(`\n=== injection verification: ${results.length - broken.length}/${results.length} WORKS ===`);
    if (broken.length) {
      console.log('BROKEN:');
      for (const b of broken) console.log(`  - ${b.name}`);
    }
  }

  // The gate fails if any proven-surface assertion regressed OR a negative
  // control leaked. Unshipped slices (the S6 profile snapshot) are PENDING-only
  // and never fail the gate.
  if (broken.length) exitCode = 1;

  // Honesty guard: at LEAST one client must be `verified`, else the whole
  // personalization claim is hollow and the gate must fail loudly.
  const anyVerified = Object.values(verdicts).some(v => v.verdict === 'verified');
  if (!anyVerified) {
    console.log('FAIL: no client reached `verified` — refusing to claim any cross-client injection.');
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
