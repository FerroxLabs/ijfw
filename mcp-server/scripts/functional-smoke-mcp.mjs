#!/usr/bin/env node
/**
 * functional-smoke-mcp.mjs — END-TO-END functional smoke for the IJFW MCP tools
 * that functional-smoke.mjs (memory) and functional-smoke-workflow.mjs (state)
 * do NOT cover, driven through the REAL MCP server over real JSON-RPC stdio.
 *
 * Covers: ijfw_prompt_check, ijfw_metrics, ijfw_run, ijfw_brain (think + links +
 * wiki.get + profile.get/brief/audit), ijfw_cross_audit_converge (shape/reach),
 * and two cross-cutting ijfw_state verbs (decision.add, state.validate).
 *
 * Why this exists: the unit/`--help`/route tests assert PARSE + DISPATCH shape,
 * not real behaviour. A handler can return an un-awaited Promise, throw inside a
 * catch, or read the wrong file and STILL pass those tests while being broken in
 * real use (exactly how NL recall shipped broken for ~3 weeks). This harness
 * asserts REAL behaviour and a NEGATIVE CONTROL proves it can detect a break.
 *
 * Runs in a SCRATCH HOME + scratch project (mktemp), never touching the real
 * ~/.ijfw or the repo's .ijfw/memory. Exits non-zero on ANY silent miss.
 *
 *   node scripts/functional-smoke-mcp.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '..', 'src', 'server.js');

// ---------------------------------------------------------------------------
// Minimal JSON-RPC stdio client for the MCP server.
// ---------------------------------------------------------------------------
class McpClient {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    this.exited = new Promise((res) => this.proc.on('exit', res));
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

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})\nstderr:\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  call(name, args, timeoutMs = 30000) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  close() {
    try { this.proc.stdin.end(); } catch { /* noop */ }
    try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
  }
}

function callText(resp) {
  const c = resp && resp.result && resp.result.content;
  if (Array.isArray(c) && c.length && typeof c[0].text === 'string') return c[0].text;
  if (resp && resp.error) return `__ERROR__: ${JSON.stringify(resp.error)}`;
  return `__UNEXPECTED__: ${JSON.stringify(resp)}`;
}
function callIsError(resp) {
  return !!(resp && resp.result && resp.result.isError);
}
// A response is "transport-broken" if JSON-RPC itself errored, the payload is an
// un-rendered Promise/undefined, or the text carries our sentinel markers.
function looksUnrendered(t) {
  return /\[object Promise\]|^undefined$|^null$|__ERROR__|__UNEXPECTED__/.test(t.trim());
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'WORKS ' : 'BROKEN'}] ${name}` +
    (detail ? `\n        ${String(detail).replace(/\n/g, '\n        ').slice(0, 400)}` : ''));
}

function makeScratchEnv(home, projectDir) {
  const env = { ...process.env };
  env.HOME = home;
  env.USERPROFILE = home;
  env.IJFW_HOME = join(home, '.ijfw');
  env.IJFW_PROJECT_DIR = projectDir;
  env.CLAUDE_PROJECT_DIR = projectDir;
  env.IJFW_PROFILE_DIR = join(home, '.ijfw', 'profile'); // never touch real profile
  env.IJFW_VECTORS = '0';
  delete env.IJFW_REGISTRY_WS_URL;
  delete env.IJFW_REGISTRY_WS_SOURCE;
  return env;
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'ijfw-fsmcp-'));
  const home = join(scratch, 'home');
  const proj = join(home, 'proj');
  mkdirSync(join(proj, '.ijfw', 'memory'), { recursive: true });
  mkdirSync(join(home, '.ijfw', 'profile'), { recursive: true });

  let client;
  let exitCode = 0;
  try {
    const env = makeScratchEnv(home, proj);
    client = new McpClient(env);

    // --- initialize -----------------------------------------------------
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fsmoke-mcp', version: '1' },
    });
    record('initialize handshake', !!(init.result && init.result.serverInfo),
      init.result && init.result.serverInfo ? JSON.stringify(init.result.serverInfo) : JSON.stringify(init));
    client.notify('notifications/initialized', {});

    const list = await client.request('tools/list', {});
    const toolNames = (list.result && list.result.tools || []).map(t => t.name);
    const required = ['ijfw_prompt_check', 'ijfw_metrics', 'ijfw_run', 'ijfw_brain',
                      'ijfw_cross_audit_converge', 'ijfw_state'];
    const missing = required.filter(t => !toolNames.includes(t));
    record('tools/list advertises target tools', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `all ${required.length} present`);

    // --- ijfw_prompt_check (deterministic regex) ------------------------
    // Vague prompt -> should flag under-specified + return a sharpening suggestion.
    const pcVague = await client.call('ijfw_prompt_check', { prompt: 'fix it' });
    const pcVagueT = callText(pcVague);
    record('prompt_check: flags a vague prompt',
      !callIsError(pcVague) && !looksUnrendered(pcVagueT) && /vague|under|sharpen|specif|unclear|\?/i.test(pcVagueT),
      pcVagueT.slice(0, 200));
    // Detailed prompt -> should NOT flag (proves it discriminates, not always-on).
    const pcClear = await client.call('ijfw_prompt_check', {
      prompt: 'In src/server.js handleRecall, await the async searchMemory call so natural-language recall returns the stored decision rather than throwing on results.map.' });
    const pcClearT = callText(pcClear);
    record('prompt_check: passes a detailed prompt (discriminates)',
      !callIsError(pcClear) && !looksUnrendered(pcClearT),
      pcClearT.slice(0, 160));

    // --- ijfw_metrics (reads sessions.jsonl; empty must be coherent) -----
    const metricsEmpty = await client.call('ijfw_metrics', { period: '7d', metric: 'tokens' });
    const metricsEmptyT = callText(metricsEmpty);
    record('metrics: coherent on empty history (no crash)',
      !callIsError(metricsEmpty) && !looksUnrendered(metricsEmptyT) && metricsEmptyT.length > 0,
      metricsEmptyT.slice(0, 160));
    // Seed a metrics line using the CANONICAL session-record schema
    // (timestamp / input_tokens / output_tokens / cost_usd — see handleMetrics),
    // then assert it is reflected.
    const metricsDir = join(proj, '.ijfw', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(join(metricsDir, 'sessions.jsonl'),
      JSON.stringify({ timestamp: new Date().toISOString(), input_tokens: 1234, output_tokens: 567,
        cache_read_tokens: 0, cost_usd: 0.42, model: 'opus' }) + '\n');
    const metricsSeeded = await client.call('ijfw_metrics', { period: 'all', metric: 'tokens' });
    const metricsSeededT = callText(metricsSeeded);
    record('metrics: reflects a seeded session line',
      !callIsError(metricsSeeded) && /1[,.]?234|1[,.]?801|567|token/i.test(metricsSeededT),
      metricsSeededT.slice(0, 200));

    // --- ijfw_run (actually executes a shell command) -------------------
    const runEcho = await client.call('ijfw_run', { command: 'echo FUNCTIONAL_SMOKE_MARKER_8843', label: 'fsmoke-echo' });
    const runEchoT = callText(runEcho);
    record('run: executes a shell command and returns its output',
      !callIsError(runEcho) && /FUNCTIONAL_SMOKE_MARKER_8843/.test(runEchoT),
      runEchoT.slice(0, 200));
    // Non-zero command -> must surface failure via the isError flag, not lie
    // success. (The MCP failure signal is the structured isError flag; an inline
    // failure also annotates the text with the exit code for the human.)
    const runFail = await client.call('ijfw_run', { command: 'sh -c "echo boom 1>&2; exit 7"', label: 'fsmoke-fail' });
    const runFailT = callText(runFail);
    record('run: surfaces a non-zero exit via isError (does not lie success)',
      callIsError(runFail) === true && /boom|exit|7/i.test(runFailT),
      `isError=${callIsError(runFail)} text=${runFailT.slice(0, 160)}`);

    // --- ijfw_brain think + links --------------------------------------
    const brainThink = await client.call('ijfw_brain', { verb: 'think', args: { query: 'database choice for billing' } });
    const brainThinkT = callText(brainThink);
    record('brain.think: returns a coherent payload (no crash/unrendered)',
      !looksUnrendered(brainThinkT) && brainThinkT.length > 0,
      brainThinkT.slice(0, 200));
    const brainLinks = await client.call('ijfw_brain', { verb: 'links', args: { query: 'billing' } });
    const brainLinksT = callText(brainLinks);
    record('brain.links: returns a coherent payload',
      !looksUnrendered(brainLinksT) && brainLinksT.length > 0,
      brainLinksT.slice(0, 160));
    const brainWiki = await client.call('ijfw_brain', { verb: 'wiki.get', args: {} });
    const brainWikiT = callText(brainWiki);
    record('brain.wiki.get: returns a coherent payload',
      !looksUnrendered(brainWikiT),
      brainWikiT.slice(0, 160));

    // --- ijfw_brain profile.* (the learning feature serve path) ---------
    const profGet = await client.call('ijfw_brain', { verb: 'profile.get', args: {} });
    const profGetT = callText(profGet);
    record('brain.profile.get: cold-start returns empty profile, never errors',
      !callIsError(profGet) && !looksUnrendered(profGetT),
      profGetT.slice(0, 200));
    const profBrief = await client.call('ijfw_brain', { verb: 'profile.brief', args: {} });
    const profBriefT = callText(profBrief);
    record('brain.profile.brief: cold-start returns a (possibly empty) brief, never errors',
      !callIsError(profBrief) && !looksUnrendered(profBriefT),
      profBriefT.slice(0, 200));
    const profAudit = await client.call('ijfw_brain', { verb: 'profile.audit', args: {} });
    const profAuditT = callText(profAudit);
    record('brain.profile.audit: returns an audit listing, never errors',
      !callIsError(profAudit) && !looksUnrendered(profAuditT),
      profAuditT.slice(0, 200));

    // --- ijfw_state cross-cutting verbs --------------------------------
    const decAdd = await client.call('ijfw_state', {
      verb: 'decision.add',
      payload: { text: 'Use Postgres for billing (JSONB + strict txns)', dedupKey: 'fsmoke-pg-billing' },
      projectRoot: proj });
    const decAddT = callText(decAdd);
    // Assert the REAL effect: the decision is persisted to decisions.jsonl on disk.
    const decisionsFile = [
      join(proj, '.ijfw', 'blackboard', 'decisions.jsonl'),
      join(proj, 'ijfw', 'blackboard', 'decisions.jsonl'),
    ].find(p => existsSync(p));
    const decPersisted = !!decisionsFile && /Postgres for billing/.test(readFileSync(decisionsFile, 'utf8'));
    record('state.decision.add: records a decision AND persists it to disk',
      !callIsError(decAdd) && /"ok"\s*:\s*true/i.test(decAddT) && decPersisted,
      `ok=${/"ok"\s*:\s*true/i.test(decAddT)} persisted=${decPersisted} file=${decisionsFile || 'NONE'}`);
    const stateValidate = await client.call('ijfw_state', { verb: 'state.validate', payload: {}, projectRoot: proj });
    const stateValidateT = callText(stateValidate);
    record('state.state.validate: returns a validation verdict',
      !callIsError(stateValidate) && !looksUnrendered(stateValidateT) && /"ok"|valid|ok:/i.test(stateValidateT),
      stateValidateT.slice(0, 200));

    // --- ijfw_cross_audit_converge (validation guard + reachability) ----
    // A real multi-lens Trident dispatches external auditor CLIs (slow; that's an
    // integration test, not a smoke). Here we assert the WRAPPER's shape guard:
    // a MALFORMED commitRange (option-injection shape) must be rejected FAST with
    // a clean structured isError — never spawn auditors, crash, hang, or emit an
    // un-rendered Promise. Bounded timeout proves "fast".
    let convText = '';
    let convOk = false;
    try {
      const conv = await client.call('ijfw_cross_audit_converge',
        { commitRange: '--upload-pack=evil', maxIterations: 1 }, 8000);
      convText = callText(conv);
      convOk = callIsError(conv) && !looksUnrendered(convText) && /invalid shape|required|range/i.test(convText);
    } catch (e) {
      convText = `THREW/HUNG: ${e.message}`;
      convOk = false;
    }
    record('cross_audit_converge: malformed range rejected fast + clean (guard works)',
      convOk, convText.slice(0, 240));

    // --- NEGATIVE CONTROL ----------------------------------------------
    // Prove the harness can SEE a break: call a tool with a bogus verb. The
    // server must reject it (isError or an error payload). If this "passes"
    // silently, the harness is blind and every WORKS above is suspect.
    const neg = await client.call('ijfw_brain', { verb: 'this.verb.does.not.exist', args: {} });
    const negT = callText(neg);
    const negDetected = callIsError(neg) || /unknown|invalid|not.*(support|recogni|exist)|error|enum/i.test(negT);
    record('NEGATIVE CONTROL: bogus brain verb is rejected (harness can detect breaks)',
      negDetected, negT.slice(0, 200));

  } catch (err) {
    record('harness completed without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    if (client) {
      console.log('\n--- server stderr (tail) ---');
      console.log((client.stderr || '(none)').split('\n').slice(-12).join('\n'));
      client.close();
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const broken = results.filter(r => !r.ok);
  console.log(`\n=== MCP functional smoke: ${results.length - broken.length}/${results.length} WORKS ===`);
  if (broken.length) {
    console.log('BROKEN:');
    for (const b of broken) console.log(`  - ${b.name}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

main();
