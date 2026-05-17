/**
 * IJFW Dashboard Server -- Wave V1.1I
 * Serves the single-file HTML dashboard + SSE stream from observations.jsonl.
 * Adds cost tracking + savings + memory search endpoints.
 * Credit: ccusage (ryoppippi, MIT), tokscale (junhoyeo, MIT), CodeBurn (AgentSeal, MIT).
 * Zero deps. node:http, node:fs, node:path, node:os, node:url only.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, watch, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCostReport, buildBreakdown, buildDailySeries, buildBlockUsage, getSavingsMethodology } from './cost/aggregator.js';
import { ttlCache } from './lib/cache.js';
import { getPricesTable } from './cost/pricing.js';
import { computeValueDelivered } from './cost/savings.js';
import { listMemoryFiles, listKnownProjects } from './memory/reader.js';
import { searchMemory } from './memory/search.js';
import { buildRecallCounts, mergeRecallCounts, topRecalled } from './memory/recall-counter.js';
import { PLACEHOLDER_HTML } from './design-companion.js';
import { listExtensions } from './extension-installer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT: IJFW_PROJECT_ROOT override > user's interactive shell cwd (PWD) > process.cwd() fallback.
// Under npm install the package lands in ~/.ijfw/; PWD keeps memory walks in the user's actual project.
const REPO_ROOT = process.env.IJFW_PROJECT_ROOT
  || process.env.PWD
  || process.cwd();

// Read version dynamically from mcp-server/package.json so bumps don't drift.
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();
const HTML_PATH = join(__dirname, 'dashboard-client.html');

const COST_CACHE_TTL = 30_000; // 30s

// Returns mtime of ~/.ijfw/metrics/sessions.jsonl (cross-platform session ledger), or 0 if absent.
function ijfwLedgerMtime() {
  try {
    return statSync(join(homedir(), '.ijfw', 'metrics', 'sessions.jsonl')).mtimeMs;
  } catch {
    return 0;
  }
}

// Build invalidator key: "<latest mtime in ms>:<jsonl file count>:<ledger mtime>" across ~/.claude/projects/
// Distinguishes empty ('0:0:empty') from walk error ('0:0:err:<code>') to avoid cache collisions.
// Ledger mtime included so Codex/Gemini session writes bust this cache immediately (W9-H2).
function claudeProjectsMtimeKey() {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return `0:0:empty:${ijfwLedgerMtime()}`;
  try {
    let latestMtime = 0;
    let fileCount = 0;
    for (const entry of readdirSync(projectsDir)) {
      const projPath = join(projectsDir, entry);
      let pStat;
      try { pStat = statSync(projPath); } catch { continue; }
      if (!pStat.isDirectory()) continue;
      for (const file of readdirSync(projPath)) {
        if (!file.endsWith('.jsonl')) continue;
        fileCount++;
        try {
          const m = statSync(join(projPath, file)).mtimeMs;
          if (m > latestMtime) latestMtime = m;
        } catch {}
      }
    }
    if (fileCount === 0) return `0:0:empty:${ijfwLedgerMtime()}`;
    return `${latestMtime}:${fileCount}:${ijfwLedgerMtime()}`;
  } catch (err) {
    return `0:0:err:${err.code || 'UNKNOWN'}:${ijfwLedgerMtime()}`;
  }
}

// Build invalidator key for memory dirs: "<latestMtime>:<fileCount>"
// Walks all sources that listMemoryFiles() reads:
//   ~/.ijfw/memory/, ~/.ijfw/sessions/, ~/.ijfw/observations.jsonl, ~/.ijfw/HANDOFF.md,
//   ~/.claude/projects/<slug>/memory/, and <REPO_ROOT>/.ijfw/memory/
function memoryDirsMtimeKey() {
  let latestMtime = 0;
  let fileCount = 0;

  function statFile(fp) {
    try {
      const s = statSync(fp);
      fileCount++;
      if (s.mtimeMs > latestMtime) latestMtime = s.mtimeMs;
    } catch {}
  }

  function walkDir(dir) {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir)) {
        statFile(join(dir, entry));
      }
    } catch {}
  }

  walkDir(join(homedir(), '.ijfw', 'memory'));
  walkDir(join(homedir(), '.ijfw', 'sessions'));
  statFile(join(homedir(), '.ijfw', 'observations.jsonl'));
  statFile(join(homedir(), '.ijfw', 'HANDOFF.md'));

  const projectsDir = join(homedir(), '.claude', 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const slug of readdirSync(projectsDir)) {
        walkDir(join(projectsDir, slug, 'memory'));
      }
    } catch {}
  }

  walkDir(join(REPO_ROOT, '.ijfw', 'memory'));

  // Include cross-platform session ledger so non-Claude session writes bust this cache (W9-H2).
  const ledgerMtime = ijfwLedgerMtime();
  if (ledgerMtime > 0) {
    fileCount++;
    if (ledgerMtime > latestMtime) latestMtime = ledgerMtime;
  }

  return `${latestMtime}:${fileCount}`;
}

const DEFAULT_PORT     = 37891;
const PORT_WALK_MAX    = 10;  // walk up to 37891+PORT_WALK_MAX (37900)
const BACKFILL_DEFAULT = 200;
const BACKFILL_CAP     = 50;  // max observations sent on fresh connect (W4.6)

const DESIGN_LIVE_RELOAD_SCRIPT = `
<script>
(function(){
  if (window.__ijfwDesignLiveReload) return;
  window.__ijfwDesignLiveReload = true;
  try {
    var events = new EventSource('/design/stream');
    events.addEventListener('reload', function(){ window.location.reload(); });
  } catch (_) {}
})();
</script>`;

function injectDesignLiveReload(html) {
  if (typeof html !== 'string' || html.includes('__ijfwDesignLiveReload')) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, DESIGN_LIVE_RELOAD_SCRIPT + '\n</body>');
  return html + DESIGN_LIVE_RELOAD_SCRIPT;
}

// ---------- integer param validator ----------
// Rejects numeric-prefix garbage like "10xyz" that parseInt accepts (W9-M2).
// Returns null on invalid input; caller should respond with 400.
function safeIntegerParam(value, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string') return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  if (n > max) return null;
  return n;
}

// ---------- localhost guard ----------
function requireLocalhost(req, res) {
  const addr = req.socket.remoteAddress;
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('403 Forbidden -- localhost only');
  return false;
}

// ---------- simple router ----------
function route(req, res, routes) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  for (const [pattern, handler] of routes) {
    if (typeof pattern === 'string' ? path === pattern : pattern.test(path)) {
      handler(req, res, url);
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}

// ---------- JSONL reader ----------
function readObservations(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  try {
    return readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function filterObservations(obs, params) {
  let result = obs;
  const platform = params.get('platform');
  const since    = params.get('since');
  const limit    = parseInt(params.get('limit') || '200', 10);

  if (platform) result = result.filter(o => o.platform === platform);
  if (since)    result = result.filter(o => o.id > parseInt(since, 10));
  return result.slice(-limit);
}

// ---------- SSE broadcaster ----------
function makeBroadcaster() {
  const clients = new Set();
  let debounceTimer = null;
  let pendingLines = [];

  function flush() {
    if (pendingLines.length === 0) return;
    const toSend = pendingLines.slice();
    pendingLines = [];
    for (const res of clients) {
      try {
        for (const { id, data } of toSend) {
          res.write(`id: ${id}\ndata: ${data}\n\n`);
        }
      } catch {
        clients.delete(res);
      }
    }
  }

  function push(id, jsonLine) {
    pendingLines.push({ id, data: jsonLine });
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, 50);
  }

  function add(res) { clients.add(res); }
  function remove(res) { clients.delete(res); }

  function closeAll() {
    clearTimeout(debounceTimer);
    for (const res of clients) {
      try {
        res.write('event: close\ndata: shutdown\n\n');
        res.end();
      } catch {}
    }
    clients.clear();
  }

  function size() { return clients.size; }

  return { push, add, remove, closeAll, size };
}

// ---------- file watcher with tail ----------
function makeWatcher(ledgerPath, broadcaster) {
  let lastLineCount = 0;
  let watcher = null;
  let pollTimer = null;

  function tail() {
    if (!existsSync(ledgerPath)) return;
    try {
      const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
      if (lines.length > lastLineCount) {
        const newLines = lines.slice(lastLineCount);
        for (const line of newLines) {
          try {
            const obj = JSON.parse(line);
            broadcaster.push(obj.id ?? (lastLineCount + 1), line);
          } catch {}
        }
        lastLineCount = lines.length;
      }
    } catch {}
  }

  // Seed initial count
  if (existsSync(ledgerPath)) {
    try {
      lastLineCount = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).length;
    } catch {}
  }

  function startWatcher() {
    if (!existsSync(ledgerPath)) return;
    try {
      watcher = watch(ledgerPath, () => tail());
      watcher.on('error', () => { /* poll fallback below covers Windows EPERM */ });
    } catch {
      watcher = null;
    }
  }

  // 2s poll fallback in case fs.watch is unreliable
  pollTimer = setInterval(tail, 2000);

  startWatcher();

  function stop() {
    clearInterval(pollTimer);
    if (watcher) { try { watcher.close(); } catch {} }
  }

  return { stop, tail };
}

// ---------- backfill SSE ----------
// offset: explicit index-based resume (takes precedence over lastEventId when set).
async function backfillSSE(res, ledgerPath, lastEventId, backfillCount, offset = null) {
  if (!existsSync(ledgerPath)) return 0;
  const obs = readObservations(ledgerPath);

  let start;
  if (offset !== null) {
    // Explicit offset-based resume: slice from that index, cap at BACKFILL_CAP.
    start = Math.min(offset, obs.length);
  } else if (lastEventId) {
    // Resume from after the last seen event by id.
    start = obs.findIndex(o => o.id === lastEventId) + 1;
  } else {
    // Fresh connect: cap at BACKFILL_CAP regardless of caller-requested backfillCount (W4.6).
    const cap = Math.min(backfillCount, BACKFILL_CAP);
    start = Math.max(0, obs.length - cap);
    // Emit sentinel so the client knows history was truncated.
    if (obs.length > cap) {
      try {
        const nextOffset = start + cap;
        const sentinel = JSON.stringify({ showing: cap, total: obs.length, next: nextOffset });
        res.write(`event: history-truncated\ndata: ${sentinel}\n\n`);
      } catch {
        return -1;
      }
    }
  }

  const toSend = obs.slice(start, start + BACKFILL_CAP);
  for (const o of toSend) {
    try {
      res.write(`id: ${o.id}\ndata: ${JSON.stringify(o)}\n\n`);
    } catch {
      return -1;
    }
  }
  return toSend.length;
}

// ---------- main export ----------
export async function startServer(options = {}) {
  const {
    ledgerPath = join(homedir(), '.ijfw', 'observations.jsonl'),
    port: preferredPort = DEFAULT_PORT,
    maxPort,
    version = PKG_VERSION,
  } = options;

  // Walk up to PORT_WALK_MAX ports from preferredPort.
  // When preferredPort is DEFAULT_PORT, this gives the canonical 37891-37900 range.
  const portCeiling = maxPort ?? (preferredPort + PORT_WALK_MAX - 1);

  const broadcaster = makeBroadcaster();
  const watcher = makeWatcher(ledgerPath, broadcaster);

  const startTime = Date.now();

  // Lazily read HTML -- handle both: serving from source and from bundled context.
  let htmlContent = null;
  async function getHtml() {
    if (htmlContent) return htmlContent;
    try {
      htmlContent = await readFile(HTML_PATH, 'utf8');
    } catch {
      htmlContent = '<html><body>Dashboard UI not found. Run from IJFW repo.</body></html>';
    }
    return htmlContent;
  }

  const routes = [
    ['/', async (req, res) => {
      const html = await getHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
      res.end(html);
    }],

    ['/api/observations', (req, res, url) => {
      const obs = readObservations(ledgerPath);
      const filtered = filterObservations(obs, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(filtered));
    }],

    ['/api/summary', (req, res) => {
      const summaryPath = join(dirname(ledgerPath), 'session_summaries.jsonl');
      let summary = null;
      if (existsSync(summaryPath)) {
        try {
          const lines = readFileSync(summaryPath, 'utf8').split('\n').filter(Boolean);
          if (lines.length) summary = JSON.parse(lines[lines.length - 1]);
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    }],

    ['/api/economics', (req, res) => {
      const obs = readObservations(ledgerPath);
      const totalTokens = obs.reduce((s, o) => s + (o.token_cost || 0), 0);
      const workTokens  = obs.reduce((s, o) => s + (o.work_tokens || 0), 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: obs.length, totalTokens, workTokens }));
    }],

    ['/api/health', (req, res) => {
      const obs = readObservations(ledgerPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        status: 'ok',
        version,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        ledgerPath,
        obsCount: obs.length,
      }));
    }],

    ['/api/memory/file', (req, res, url) => {
      const rawPath = url.searchParams.get('path') || '';
      if (!rawPath) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'outside allowed memory dir' }));
        return;
      }
      const reqPath = resolve(rawPath);

      // Security: use path.relative() for prefix check -- works on Windows (backslash) and POSIX.
      // If realpathSync throws (path doesn't exist), return 404 rather than 500.
      function canonOrNull(p) {
        try { return realpathSync(p); } catch { return null; }
      }
      function isUnder(allowedRoot, canonChild) {
        const canonRoot = canonOrNull(allowedRoot);
        if (!canonRoot || !canonChild) return false;
        const rel = relative(canonRoot, canonChild);
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      }

      const canonPath = canonOrNull(reqPath);
      if (!canonPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'file not found' }));
        return;
      }

      const allowed = (
        isUnder(join(homedir(), '.ijfw'), canonPath) ||
        isUnder(join(homedir(), '.claude', 'projects'), canonPath) ||
        isUnder(join(REPO_ROOT, '.ijfw'), canonPath)
      );
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'outside allowed memory dir' }));
        return;
      }
      try {
        const body = readFileSync(canonPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ body: body.slice(0, 10000) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/memory/file' }));
      }
    }],

    // ---------- cost endpoints ----------
    ['/api/cost/today', (req, res) => {
      try {
        // cache key: fixed 1-day window; invalidates when JSONL count or latest mtime changes
        const result = ttlCache('cost:today', COST_CACHE_TTL, claudeProjectsMtimeKey, () => {
          const obs = readObservations(ledgerPath);
          return buildCostReport(1, obs);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/cost/today' }));
      }
    }],

    ['/api/cost/period', (req, res, url) => {
      try {
        const days = parseInt(url.searchParams.get('days') || '7', 10);
        // cache key: per-days-param window; invalidates when JSONL count or latest mtime changes
        const result = ttlCache(`cost:period:${days}`, COST_CACHE_TTL, claudeProjectsMtimeKey, () => {
          const obs = readObservations(ledgerPath);
          return buildCostReport(days, obs);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/cost/period' }));
      }
    }],

    ['/api/cost/by', (req, res, url) => {
      try {
        const dim    = url.searchParams.get('dim') || 'platform';
        const period = url.searchParams.get('period') || '7d';
        const days   = parseInt(period.replace(/\D/g, '') || '7', 10);
        // cache key: per-dim+period breakdown; invalidates when JSONL count or latest mtime changes
        const result = ttlCache(`cost:by:${dim}:${days}`, COST_CACHE_TTL, claudeProjectsMtimeKey, () => {
          const obs = readObservations(ledgerPath);
          return buildBreakdown(dim, days, obs);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/cost/by' }));
      }
    }],

    ['/api/cost/block', (req, res) => {
      try {
        // cache key: 5-hour rolling window; invalidates when JSONL count or latest mtime changes
        const result = ttlCache('cost:block', COST_CACHE_TTL, claudeProjectsMtimeKey, () => buildBlockUsage());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/cost/block' }));
      }
    }],

    ['/api/cost/history', (req, res, url) => {
      try {
        const days = parseInt(url.searchParams.get('days') || '30', 10);
        // cache key: per-days daily series; invalidates when JSONL count or latest mtime changes
        const result = ttlCache(`cost:history:${days}`, COST_CACHE_TTL, claudeProjectsMtimeKey, () => buildDailySeries(days));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/cost/history' }));
      }
    }],

    ['/api/prices', (req, res) => {
      try {
        const table = getPricesTable();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(table));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/prices' }));
      }
    }],

    ['/api/savings/methodology', (req, res) => {
      try {
        const methodology = getSavingsMethodology();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(methodology));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/savings/methodology' }));
      }
    }],

    // ---------- memory endpoints ----------
    ['/api/memory', (req, res, url) => {
      try {
        const tierFilter = url.searchParams.get('tier') || null;
        const result = ttlCache(`memory:list:${tierFilter}`, COST_CACHE_TTL, memoryDirsMtimeKey, () => {
          const { files, total, root, tiers } = listMemoryFiles(REPO_ROOT, tierFilter);
          const { counts, weekCounts, totalThisWeek } = buildRecallCounts(ledgerPath);
          const enriched = mergeRecallCounts(files, counts, weekCounts);
          return { files: enriched, total, root, tiers, totalRecallsThisWeek: totalThisWeek };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/memory' }));
      }
    }],

    ['/api/memory/search', (req, res, url) => {
      try {
        const q     = url.searchParams.get('q') || '';
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const { files } = listMemoryFiles(REPO_ROOT);
        const { counts, weekCounts } = buildRecallCounts(ledgerPath);
        const enriched = mergeRecallCounts(files, counts, weekCounts);
        const results  = searchMemory(q, enriched, limit);
        // Merge recall counts into search results
        const resultMap = new Map(enriched.map(f => [f.path, f]));
        const withCounts = results.map(r => ({
          ...r,
          recall_count:      resultMap.get(r.path)?.recall_count || 0,
          recall_count_week: resultMap.get(r.path)?.recall_count_week || 0,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: withCounts, count: withCounts.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/memory/search' }));
      }
    }],

    ['/api/projects', (req, res) => {
      try {
        const projects = listKnownProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects, total: projects.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/projects' }));
      }
    }],

    ['/api/memory/recall-stats', (req, res) => {
      try {
        const result = ttlCache('memory:recall-stats', COST_CACHE_TTL, memoryDirsMtimeKey, () => {
          const { files } = listMemoryFiles(REPO_ROOT);
          const { counts, weekCounts, totalThisWeek } = buildRecallCounts(ledgerPath);
          const enriched = mergeRecallCounts(files, counts, weekCounts);
          const top = topRecalled(enriched, 5);
          return { top_recalled: top, total_recalls_this_week: totalThisWeek };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/memory/recall-stats' }));
      }
    }],

    // ---------- config endpoints ----------
    ['/api/config', (req, res) => {
      const configPath = join(homedir(), '.ijfw', 'config.json');
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 65536) { req.destroy(); return; } });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            mkdirSync(join(homedir(), '.ijfw'), { recursive: true });
            writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }
      // GET
      const CONFIG_DEFAULTS = { version: 1, subscriptions: {}, accounts: [], prices_pinned_date: '2026-04-16' };
      let config = { ...CONFIG_DEFAULTS };
      if (existsSync(configPath)) {
        try {
          const stored = JSON.parse(readFileSync(configPath, 'utf8'));
          // Merge stored over defaults so new fields appear on first read.
          config = Object.assign({}, CONFIG_DEFAULTS, stored);
        } catch (err) {
          // Corrupt config: rename aside so the user has a recoverable copy AND
          // next read regenerates defaults instead of getting stuck (parity with
          // scripts/dashboard/server.js loadConfig W11-2 fix).
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          try { renameSync(configPath, `${configPath}.corrupt.${stamp}`); }
          catch { /* rename failure is non-fatal; defaults still serve */ }
          process.stderr.write(`[ijfw-mcp] /api/cost/config: ${err.message} -- using defaults; corrupt file preserved as ${configPath}.corrupt.${stamp}\n`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    }],

    // ---------- extensions: installed (B9) ----------
    // Enumerate ~/.ijfw/state-org/extension-registry.json,
    // ~/.ijfw/state-user/extension-registry.json, and project-scope registry.
    // Returns JSON list with name, scope, version, publisher_keyId, permissions,
    // last_activated_time. Path-traversal defence: resolve + assert under HOME.
    ['/api/extensions/installed', async (req, res) => {
      try {
        const home = homedir();
        // realpath both sides — on macOS /var/folders -> /private/var/folders is a symlink,
        // so the registry's realpathed path won't show as under un-realpathed HOME.
        let homeCanon;
        try { homeCanon = realpathSync(home); } catch { homeCanon = home; }
        function isUnderHome(p) {
          try {
            const canon = realpathSync(p);
            const rel = relative(homeCanon, canon);
            return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
          } catch { return false; }
        }

        const REGISTRY_FILENAME = 'extension-registry.json';
        const registryPaths = [
          { scope: 'org',  path: join(home, '.ijfw', 'state-org',  REGISTRY_FILENAME) },
          { scope: 'user', path: join(home, '.ijfw', 'state-user', REGISTRY_FILENAME) },
          { scope: 'project', path: join(REPO_ROOT, '.ijfw', 'state', REGISTRY_FILENAME) },
        ];

        const seen = new Map();
        for (const { scope, path: regPath } of registryPaths) {
          // Path-traversal check on each registry path.
          const resolvedReg = resolve(regPath);
          const underHome = isUnderHome(resolvedReg) ||
            resolvedReg.startsWith(resolve(REPO_ROOT));
          if (!underHome) continue;
          if (!existsSync(resolvedReg)) continue;
          let registry;
          try {
            const raw = readFileSync(resolvedReg, 'utf8');
            const parsed = JSON.parse(raw);
            registry = Array.isArray(parsed.extensions) ? parsed.extensions : [];
          } catch { continue; }

          for (const e of registry) {
            if (!e || !e.name || !e.version) continue;
            const key = `${e.name}@${e.version}`;
            if (seen.has(key)) continue;
            const manifest = (e.manifest && typeof e.manifest === 'object') ? e.manifest : null;
            seen.set(key, {
              name: e.name,
              scope,
              version: e.version,
              publisher_keyId: manifest ? (manifest.publisher_keyId || null) : null,
              permissions: manifest ? (manifest.permissions || null) : null,
              last_activated_time: e.last_activated_time || null,
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ extensions: Array.from(seen.values()) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ extensions: [], error: err.message }));
      }
    }],

    // ---------- extensions: active (B9) ----------
    ['/api/extensions/active', async (req, res) => {
      try {
        const home = homedir();
        const activePath = join(home, '.ijfw', 'state', 'active-extension.json');
        const resolvedActive = resolve(activePath);
        // Path-traversal: must be under HOME
        const rel = relative(home, resolvedActive);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'path traversal rejected' }));
          return;
        }
        if (!existsSync(resolvedActive)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: null }));
          return;
        }
        const raw = readFileSync(resolvedActive, 'utf8');
        const parsed = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: parsed }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: null, error: err.message }));
      }
    }],

    // ---------- extensions: events (B9) ----------
    // Tail-streams ~/.ijfw/state/permission-events.jsonl with optional filters.
    // Allowlisted query params: limit, extension, tool, denied.
    // SSE mode: Accept: text/event-stream. JSON array otherwise.
    // Never reads full file into memory: streams line-by-line.
    ['/api/extensions/events', async (req, res, url) => {
      const ALLOWED_FILTER_KEYS = new Set(['limit', 'extension', 'tool', 'denied']);
      // Reject any non-allowlisted filter key.
      for (const key of url.searchParams.keys()) {
        if (!ALLOWED_FILTER_KEYS.has(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `unknown filter parameter: ${key}` }));
          return;
        }
      }

      const home = homedir();
      const eventsPath = join(home, '.ijfw', 'state', 'permission-events.jsonl');

      const rawLimit = url.searchParams.get('limit');
      let limit = 200;
      if (rawLimit !== null) {
        const n = safeIntegerParam(rawLimit, 10_000);
        if (n === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid limit' }));
          return;
        }
        limit = n;
      }
      const filterExtension = url.searchParams.get('extension') || null;
      const filterTool      = url.searchParams.get('tool') || null;
      const filterDenied    = url.searchParams.has('denied')
        ? (url.searchParams.get('denied') !== 'false')
        : null;

      // Stream-tail: read only the last TAIL_CHUNK bytes, never slurp the full file.
      // For permission-events.jsonl which rotates at 10_000 lines, 2MB covers
      // many thousands of events without loading the entire file into memory.
      const TAIL_CHUNK = 2 * 1024 * 1024; // 2MB
      function tailEvents() {
        if (!existsSync(eventsPath)) return [];
        let st;
        try { st = statSync(eventsPath); } catch { return []; }
        if (st.size === 0) return [];
        let lines = [];
        try {
          const fullBuf = readFileSync(eventsPath);
          const slice = fullBuf.subarray(Math.max(0, fullBuf.length - TAIL_CHUNK));
          const text = slice.toString('utf8');
          lines = text.split('\n').filter(Boolean);
          // If we sliced mid-line, the first element may be truncated — drop it.
          if (fullBuf.length > TAIL_CHUNK) lines = lines.slice(1);
        } catch { return []; }

        const results = [];
        for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
          let obj;
          try { obj = JSON.parse(lines[i]); } catch { continue; }
          if (filterExtension !== null && obj.extension !== filterExtension) continue;
          if (filterTool !== null && obj.tool !== filterTool) continue;
          if (filterDenied !== null && Boolean(!obj.allowed) !== filterDenied) continue;
          results.unshift(obj);
        }
        return results;
      }

      const isSSE = (req.headers['accept'] || '').includes('text/event-stream');
      if (isSSE) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        // Send current tail as initial batch.
        const initial = tailEvents();
        for (const evt of initial) {
          try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { break; }
        }
        // Watch for new events.
        let evtWatcher = null;
        let lastLineCount = initial.length;
        try {
          evtWatcher = watch(existsSync(eventsPath) ? eventsPath : join(home, '.ijfw', 'state'), () => {
            if (!existsSync(eventsPath)) return;
            try {
              const fullBuf = readFileSync(eventsPath);
              const text = fullBuf.toString('utf8');
              const lines = text.split('\n').filter(Boolean);
              if (lines.length > lastLineCount) {
                const newLines = lines.slice(lastLineCount);
                lastLineCount = lines.length;
                for (const line of newLines) {
                  let obj; try { obj = JSON.parse(line); } catch { continue; }
                  if (filterExtension !== null && obj.extension !== filterExtension) continue;
                  if (filterTool !== null && obj.tool !== filterTool) continue;
                  if (filterDenied !== null && Boolean(!obj.allowed) !== filterDenied) continue;
                  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
                }
              }
            } catch {}
          });
          if (evtWatcher) evtWatcher.on('error', () => {});
        } catch {}
        req.on('close', () => {
          if (evtWatcher) { try { evtWatcher.close(); } catch {} }
        });
        return;
      }

      // JSON array response.
      const events = tailEvents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
    }],

    // ---------- extensions health (W3/t15) ----------
    // Reads .ijfw/state/extension-registry.json (project) plus org/user via
    // listExtensions(). Missing or malformed registry yields {extensions: []}
    // (day-1 protection). ENOENT and JSON.parse errors are swallowed inside
    // readRegistry(); this handler adds an outer try/catch as a final safety
    // net so a malformed registry can never crash the dashboard.
    ['/api/extensions/health', async (req, res) => {
      try {
        const extensions = await listExtensions(REPO_ROOT);
        // Strip embedded manifest blobs -- the dashboard only needs the
        // status summary fields, not the full manifest.
        const out = (Array.isArray(extensions) ? extensions : []).map((e) => ({
          name: e.name,
          version: e.version,
          scope: e.scope,
          installed_at: e.installed_at || null,
          status: e.status || 'stale',
          last_trident_verdict: e.last_trident_verdict ?? null,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ extensions: out }));
      } catch (err) {
        // ENOENT / missing / malformed -> 200 with empty list (day-1).
        process.stderr.write(`[ijfw-mcp] /api/extensions/health: ${err && err.message ? err.message : err}\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ extensions: [], error: 'malformed registry' }));
      }
    }],

    ['/api/value-delivered', (req, res, url) => {
      try {
        const platform   = url.searchParams.get('platform') || 'claude';
        const days       = parseInt(url.searchParams.get('days') || '7', 10);
        const configPath = join(homedir(), '.ijfw', 'config.json');
        let config = {};
        if (existsSync(configPath)) {
          try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
          catch (err) {
            // Corrupt config: rename aside, log, fall through to {} defaults.
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            try { renameSync(configPath, `${configPath}.corrupt.${stamp}`); }
            catch { /* rename failure non-fatal */ }
            process.stderr.write(`[ijfw-mcp] /api/value-delivered: ${err.message} -- using defaults; corrupt file preserved as ${configPath}.corrupt.${stamp}\n`);
          }
        }
        const tierCfg = (config.subscriptions || {})[platform] || null;
        const obs    = readObservations(ledgerPath);
        const report = buildCostReport(days, obs);
        // Pass a single synthetic turn with aggregated cost
        const turns  = [{ cost_usd: report.cost, platform }];
        const result = computeValueDelivered(tierCfg, turns, days);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, endpoint: '/api/value-delivered' }));
      }
    }],

    // ---------- design companion ----------
    [/^\/design\/files\/[^/]+\.html$/, async (req, res, url) => {
      const contentDir = join(homedir(), '.ijfw', 'design-companion', 'content');
      mkdirSync(contentDir, { recursive: true });
      const name = url.pathname.split('/').pop();
      const filePath = join(contentDir, name);
      let html = null;
      try {
        if (existsSync(filePath)) html = readFileSync(filePath, 'utf8');
      } catch {}
      if (!html) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }
      html = injectDesignLiveReload(html);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'",
      });
      res.end(html);
    }],

    ['/design', async (req, res) => {
      const contentDir = join(homedir(), '.ijfw', 'design-companion', 'content');
      mkdirSync(contentDir, { recursive: true });
      let html = null;
      try {
        const { readdirSync, statSync } = await import('node:fs');
        const files = readdirSync(contentDir)
          .filter(f => f.endsWith('.html'))
          .map(f => ({ name: f, mtime: statSync(join(contentDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          html = readFileSync(join(contentDir, files[0].name), 'utf8');
        }
      } catch {}
      if (!html) {
        html = PLACEHOLDER_HTML;
      }
      html = injectDesignLiveReload(html);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'",
      });
      res.end(html);
    }],

    ['/design/stream', (req, res) => {
      const contentDir = join(homedir(), '.ijfw', 'design-companion', 'content');
      mkdirSync(contentDir, { recursive: true });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      let debounceTimer = null;
      let watcher = null;
      try {
        watcher = watch(contentDir, () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            try { res.write('event: reload\ndata: reload\n\n'); } catch {}
          }, 50);
        });
        // fs.watch on Windows can emit EPERM asynchronously even when the
        // initial call succeeds. Swallow the error so it doesn't bubble as
        // an uncaughtException after request close (Windows-CI regression).
        watcher.on('error', () => { /* graceful degrade -- poll fallback below */ });
      } catch {}

      req.on('close', () => {
        clearTimeout(debounceTimer);
        if (watcher) { try { watcher.close(); } catch {} }
      });
    }],

    ['/stream', async (req, res, url) => {
      // Per W11: pass explicit `max` to safeIntegerParam so absurd values are
      // rejected with 400 rather than silently clamped downstream. Defense-in-depth
      // even though Math.min/slice in backfillSSE would also clamp.
      const OBSERVATION_INDEX_MAX = 1_000_000; // observations.jsonl line index ceiling

      // Validate lastEventId (from SSE header or query param) -- reject prefix-garbage (W9-M2).
      const rawLastId = req.headers['last-event-id'] || url.searchParams.get('lastEventId') || '';
      let lastId = 0;
      if (rawLastId) {
        const parsed = safeIntegerParam(rawLastId, OBSERVATION_INDEX_MAX);
        if (parsed === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid lastEventId' }));
          return;
        }
        lastId = parsed;
      }

      // Validate ?offset (for explicit resume-from-index) -- reject prefix-garbage (W9-M2).
      const rawOffset = url.searchParams.get('offset');
      let offset = null;
      if (rawOffset !== null) {
        offset = safeIntegerParam(rawOffset, OBSERVATION_INDEX_MAX);
        if (offset === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid offset' }));
          return;
        }
      }

      // Validate ?backfill -- reject prefix-garbage (W9-M2). Cap at BACKFILL_CAP
      // (server-side limit) so callers requesting more get a clear 400.
      const rawBackfill = url.searchParams.get('backfill');
      let backfill = BACKFILL_DEFAULT;
      if (rawBackfill !== null) {
        const parsed = safeIntegerParam(rawBackfill, BACKFILL_CAP);
        if (parsed === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `invalid backfill (max ${BACKFILL_CAP})` }));
          return;
        }
        backfill = parsed;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Heartbeat comment to keep connection alive
      res.write(': connected\n\n');

      await backfillSSE(res, ledgerPath, lastId, backfill, offset);

      broadcaster.add(res);
      req.on('close', () => broadcaster.remove(res));
    }],
  ];

  return new Promise((resolve, reject) => {
    let port = preferredPort;

    function tryBind() {
      if (port > portCeiling) {
        reject(new Error(`No free port in range ${preferredPort}-${portCeiling}`));
        return;
      }

      const server = createServer((req, res) => {
        if (!requireLocalhost(req, res)) return;
        route(req, res, routes);
      });

      server.once('error', err => {
        if (err.code === 'EADDRINUSE') {
          port++;
          tryBind();
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        function shutdown() {
          watcher.stop();
          broadcaster.closeAll();
          server.close(() => process.exit(0));
        }
        // Increase limit for test environments that start many servers.
        process.setMaxListeners(process.getMaxListeners() + 2);
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);

        // Wrap server.close so tests can clean up watcher + broadcaster without
        // knowing about them directly.
        const originalClose = server.close.bind(server);
        server.close = (cb) => {
          watcher.stop();
          broadcaster.closeAll();
          return originalClose(cb);
        };
        resolve({ port, server, broadcaster, watcher });
      });
    }

    tryBind();
  });
}

// ---------- daemon entry point ----------
// When spawned with `--daemon`, starts the server and writes PID + port files.
if (process.argv.includes('--daemon')) {
  const pidFile  = process.env.IJFW_PID_FILE  || join(homedir(), '.ijfw', 'dashboard.pid');
  const portFile = process.env.IJFW_PORT_FILE || join(homedir(), '.ijfw', 'dashboard.port');

  startServer().then(({ port }) => {
    const ijfwDir = dirname(pidFile);
    mkdirSync(ijfwDir, { recursive: true });
    // PID file: plain write (single writer; pid is meaningless mid-write)
    writeFileSync(pidFile, String(process.pid), 'utf8');
    // Port file: atomic write via tmp+rename so readers never see a partial value (W4.2).
    // Cleanup tmp on rename failure so it doesn't leak (W9-M1).
    const portTmp = `${portFile}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(portTmp, String(port), 'utf8');
    try {
      renameSync(portTmp, portFile);
    } catch (err) {
      try { unlinkSync(portTmp); } catch {}
      throw new Error(`atomic write failed for ${portFile}: ${err.message}`);
    }
  }).catch(err => {
    process.stderr.write('[ijfw-dashboard] ' + err.message + '\n');
    process.exit(1);
  });
}
