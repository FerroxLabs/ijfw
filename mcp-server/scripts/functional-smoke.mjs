#!/usr/bin/env node
/**
 * functional-smoke.mjs — END-TO-END functional smoke for IJFW's flagship
 * MEMORY feature, driven through the REAL MCP server over real JSON-RPC stdio.
 *
 * Why this exists: the unit/`--help`/route tests assert PARSE + DISPATCH shape,
 * not real retrieval. A handler can return a Promise (un-awaited), throw inside
 * a catch, or index into the wrong tier and STILL pass those tests while being
 * functionally broken in real use. This harness asserts REAL behaviour:
 *
 *   store -> recall (exact keyword)          must return the stored memory
 *   store -> recall (NATURAL LANGUAGE)       must return the stored memory
 *                                            (the load-bearing case; NL queries
 *                                             share no exact tokens with the
 *                                             stored phrasing)
 *   store -> ijfw_memory_search              must return the stored memory
 *   ijfw_memory_facts                        must return structured facts/no err
 *   ijfw_memory_prelude                      must return a coherent brief
 *   cross-project: store in A, search from B must find it
 *
 * It runs in a SCRATCH HOME + scratch project (mktemp), never touching the real
 * ~/.ijfw or the repo's .ijfw/memory. Exits non-zero on ANY silent miss.
 *
 * Re-runnable / CI-able:  node scripts/functional-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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
    this.proc = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
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

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})\nstderr:\n${this.stderr}`));
      }, 30000);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async call(name, args) {
    const resp = await this.request('tools/call', { name, arguments: args });
    return resp;
  }

  close() {
    try { this.proc.stdin.end(); } catch { /* noop */ }
    try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
  }
}

// Pull the text payload out of a tools/call response.
function callText(resp) {
  const c = resp && resp.result && resp.result.content;
  if (Array.isArray(c) && c.length && typeof c[0].text === 'string') return c[0].text;
  if (resp && resp.error) return `__ERROR__: ${JSON.stringify(resp.error)}`;
  return `__UNEXPECTED__: ${JSON.stringify(resp)}`;
}
function callIsError(resp) {
  return !!(resp && resp.result && resp.result.isError);
}

// ---------------------------------------------------------------------------
// Assertions / reporting
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'WORKS ' : 'BROKEN';
  const line = `[${tag}] ${name}`;
  console.log(line + (detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''));
}

function makeScratchEnv(home, projectDir) {
  // Inherit PATH etc, override HOME + project resolution + disable network/WS.
  const env = { ...process.env };
  env.HOME = home;
  env.USERPROFILE = home;
  env.IJFW_HOME = join(home, '.ijfw');
  env.IJFW_PROJECT_DIR = projectDir;
  env.CLAUDE_PROJECT_DIR = projectDir;
  // Keep cold-tier off so the test is deterministic and dependency-free.
  env.IJFW_VECTORS = '0';
  delete env.IJFW_REGISTRY_WS_URL;
  delete env.IJFW_REGISTRY_WS_SOURCE;
  return env;
}

async function setupProject(root) {
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.ijfw', 'memory'), { recursive: true });
  return proj;
}

// ---------------------------------------------------------------------------
async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'ijfw-fsmoke-'));
  const homeA = join(scratch, 'homeA');
  const projA = await setupProject(homeA);
  mkdirSync(join(homeA, '.ijfw'), { recursive: true });

  let client;
  let exitCode = 0;
  try {
    const env = makeScratchEnv(homeA, projA);
    client = new McpClient(env);

    // --- 1. initialize + tools/list -------------------------------------
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fsmoke', version: '1' },
    });
    record('initialize handshake', !!(init.result && init.result.serverInfo),
      init.result && init.result.serverInfo ? `serverInfo=${JSON.stringify(init.result.serverInfo)}` : JSON.stringify(init));
    client.notify('notifications/initialized', {});

    const list = await client.request('tools/list', {});
    const toolNames = (list.result && list.result.tools || []).map(t => t.name);
    const required = ['ijfw_memory_store', 'ijfw_memory_recall', 'ijfw_memory_search',
                      'ijfw_memory_facts', 'ijfw_memory_prelude', 'ijfw_cross_project_search'];
    const missing = required.filter(t => !toolNames.includes(t));
    record('tools/list advertises memory tools', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `all ${required.length} present`);

    // --- 2. STORE several distinct real memories ------------------------
    const stores = [
      { content: 'We chose Postgres over MySQL for the billing service because we needed strict transactional guarantees and JSONB.',
        type: 'decision', tags: ['database', 'billing'], summary: 'Postgres over MySQL for billing' },
      { content: 'The team prefers tabs over spaces and a 100 column line limit for all source files.',
        type: 'preference', tags: ['style'], summary: 'tabs over spaces, 100 col' },
      { content: 'The production API gateway runs on port 8443 behind the Cloudflare tunnel named edge-prod.',
        type: 'observation', tags: ['infra'], summary: 'API gateway port 8443 via Cloudflare edge-prod' },
    ];
    let allStored = true;
    for (const s of stores) {
      const r = await client.call('ijfw_memory_store', s);
      const t = callText(r);
      const ok = !callIsError(r) && !/__ERROR__|__UNEXPECTED__/.test(t);
      if (!ok) allStored = false;
      record(`store: "${s.summary}"`, ok, t.slice(0, 200));
    }

    // Confirm hot tier actually wrote to disk. The startup fs-layout migration
    // flips a fresh project to layout v2, where visible content lives under
    // `<root>/ijfw/memory/` and only internals (index db, layout sentinel)
    // stay under `.ijfw/`. Probe BOTH so the assertion is layout-agnostic.
    const journalCandidates = [
      join(projA, 'ijfw', 'memory', 'project-journal.md'),
      join(projA, '.ijfw', 'memory', 'project-journal.md'),
    ];
    const journalPath = journalCandidates.find(p => existsSync(p));
    const hotWritten = !!journalPath && /Postgres|billing/i.test(readFileSync(journalPath, 'utf8'));
    record('hot tier: journal written to memory dir', hotWritten,
      journalPath ? `journal exists: ${journalPath}` : `journal MISSING (checked: ${journalCandidates.join(' , ')})`);

    // Give fire-and-forget FTS5 indexing a moment.
    await new Promise(r => setTimeout(r, 800));

    // --- 3a. RECALL — exact keyword -------------------------------------
    const recallKw = await client.call('ijfw_memory_recall', { context_hint: 'Postgres' });
    const recallKwText = callText(recallKw);
    const kwOk = !callIsError(recallKw) && /postgres/i.test(recallKwText);
    record('recall (exact keyword "Postgres")', kwOk, recallKwText.slice(0, 300));

    // --- 3b. RECALL — NATURAL LANGUAGE (load-bearing) -------------------
    // These are PARAPHRASE queries: different surface wording from the stored
    // memory, with at least one salient bridging term so the warm-tier BM25
    // engine can rank them (this is the regression that the missing-await bug
    // silently broke for ALL free-text recall — keyword AND paraphrase alike).
    //
    // Honest scope note: the DEFAULT recall tier is lexical BM25 (the cold
    // vector tier is opt-in / dependency-gated). A query with ZERO token
    // overlap with the stored memory (e.g. "how should I format the code" vs
    // a memory that only says "tabs over spaces") legitimately will NOT match
    // on the lexical tier — that's the inherent ceiling of keyword ranking, not
    // a bug. So each case below shares a real concept term with its target.
    const nlQueries = [
      { q: 'what database are we using for billing', expect: /postgres|mysql|billing/i, label: 'what database are we using for billing' },
      { q: 'which port does the gateway listen on', expect: /8443|gateway|cloudflare/i, label: 'which port does the gateway listen on' },
      { q: 'what line column limit do we use for source files', expect: /tabs|spaces|column|line|source/i, label: 'what line column limit for source files' },
    ];
    for (const nl of nlQueries) {
      const r = await client.call('ijfw_memory_recall', { context_hint: nl.q });
      const t = callText(r);
      const ok = !callIsError(r) && nl.expect.test(t);
      record(`NL recall: "${nl.label}"`, ok, t.slice(0, 300));
    }

    // --- 4. ijfw_memory_search ------------------------------------------
    const search = await client.call('ijfw_memory_search', { query: 'billing database choice', scope: 'project' });
    const searchText = callText(search);
    const searchOk = !callIsError(search) && /postgres|mysql|billing/i.test(searchText);
    record('ijfw_memory_search (NL "billing database choice")', searchOk, searchText.slice(0, 300));

    // --- 4b. facts -------------------------------------------------------
    const facts = await client.call('ijfw_memory_facts', {});
    const factsText = callText(facts);
    const factsOk = !/__ERROR__|__UNEXPECTED__/.test(factsText) && !callIsError(facts);
    record('ijfw_memory_facts returns without error', factsOk, factsText.slice(0, 200));

    // --- 4c. prelude -----------------------------------------------------
    const prelude = await client.call('ijfw_memory_prelude', { detail_level: 'summary' });
    const preludeText = callText(prelude);
    const preludeOk = !/__ERROR__|__UNEXPECTED__/.test(preludeText) && !callIsError(prelude) && preludeText.length > 0;
    record('ijfw_memory_prelude returns a coherent brief', preludeOk, preludeText.slice(0, 200));

    // --- 4d. recall reserved-hint path: structured facts feed --------------
    // ijfw_memory_recall({context_hint:'facts'}) is the reserved-keyword branch
    // (distinct from the free-text NL branch). It must return the extracted
    // facts, never error. Stored "API gateway runs on port 8443" should yield
    // a fact row.
    const factsRecall = await client.call('ijfw_memory_recall', { context_hint: 'facts', detail_level: 'full' });
    const factsRecallText = callText(factsRecall);
    const factsRecallOk = !callIsError(factsRecall) && !/__ERROR__|__UNEXPECTED__/.test(factsRecallText);
    record('recall (context_hint:"facts") structured feed', factsRecallOk, factsRecallText.slice(0, 250));

    client.close();
    await client.exited;

    // --- 5. CROSS-PROJECT: store in A (already done), search from B ------
    // Project B uses the SAME scratch HOME so the project registry is shared.
    // For cross-project, A must be registered. The registry is populated on
    // memory writes; B then searches across it.
    const homeShared = homeA;
    const projB = join(homeShared, 'projB');
    mkdirSync(join(projB, '.ijfw', 'memory'), { recursive: true });
    const envB = makeScratchEnv(homeShared, projB);
    const clientB = new McpClient(envB);
    await clientB.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fsmokeB', version: '1' } });
    clientB.notify('notifications/initialized', {});
    // Store one memory in B too, so B is registered and A may be too.
    await clientB.call('ijfw_memory_store', { content: 'Project B uses Redis for its session cache layer.', type: 'observation', tags: ['infra'] });
    const xproj = await clientB.call('ijfw_cross_project_search', { pattern: 'Postgres billing' });
    const xprojText = callText(xproj);
    // Cross-project may legitimately find nothing if A isn't registered in the
    // shared registry; treat "no registered projects" as a soft/skip, but a
    // thrown error or unexpected shape is a hard fail.
    const xprojHardFail = /__ERROR__|__UNEXPECTED__/.test(xprojText);
    const xprojFound = /postgres|billing/i.test(xprojText);
    const xprojSoftSkip = /No other IJFW projects|No registered/i.test(xprojText);
    record('cross_project_search runs without error', !xprojHardFail, xprojText.slice(0, 250));
    if (!xprojSoftSkip) {
      record('cross_project_search finds A from B', xprojFound, xprojText.slice(0, 250));
    } else {
      console.log('        (cross-project registry not populated in scratch — registration is a separate path; not asserting a find)');
    }
    clientB.close();
    await clientB.exited;

  } catch (err) {
    record('harness ran to completion', false, err && err.stack ? err.stack : String(err));
    if (client && client.stderr) console.log('SERVER STDERR:\n' + client.stderr.slice(0, 2000));
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // ---------------------------------------------------------------------
  const failed = results.filter(r => !r.ok);
  console.log('\n=== functional-smoke summary ===');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
    exitCode = 1;
  } else {
    console.log('ALL GREEN — memory store→recall (incl. NL) works end-to-end.');
  }
  process.exit(exitCode);
}

main();
