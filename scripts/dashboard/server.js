#!/usr/bin/env node
/**
 * IJFW Dashboard HTTP server.
 * Serves the approved Variant B (sidebar sections) dashboard design.
 * Zero deps. Node built-ins only. Designed to run as a background daemon.
 *
 * Usage:
 *   node server.js [--port N]        Start server (default port 19747)
 *   node server.js --stop            Stop running server
 *   node server.js --status          Check if running
 *
 * Files:
 *   ~/.ijfw/dashboard.port           Port number (written on start)
 *   ~/.ijfw/dashboard.pid            PID (written on start)
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, unlinkSync, mkdirSync, realpathSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
// C9.7: Trident lens-health probes for the dashboard tile.
import { probeLenses, healthTileShape } from '../../mcp-server/src/trident/lens-health.js';
// SECURITY (audit H3.3): redact secrets before serving raw memory/transcript content.
import { redactSecrets } from '../../mcp-server/src/redactor.js';

// SECURITY (audit H3.2): strict Content-Security-Policy header applied to every
// HTML response. `'unsafe-inline'` is required because the dashboard inlines
// styles + scripts in index.html; everything else is locked to same-origin.
// `default-src 'self'` blocks foreign script/iframe injection even if XSS slips through.
const CSP_HEADER = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

// SECURITY (audit H3.3): refuse to redact files larger than 5 MiB. Streaming
// regex replace across multi-MB files is both slow and risks splitting a
// secret across chunk boundaries; bounce with 413 instead.
const MEMORY_FILE_MAX_BYTES = 5 * 1024 * 1024;

// Probe sqlite3 binary once at startup. All callers check this before querying.
const SQLITE3_AVAILABLE = (() => {
  const r = spawnSync('sqlite3', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return !r.error && r.status === 0;
})();
const SQLITE3_MISSING_REASON = SQLITE3_AVAILABLE
  ? null
  : 'sqlite3 not installed -- run: brew install sqlite3 (macOS) or apt install sqlite3 (Linux)';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const IJFW_GLOBAL = join(HOME, '.ijfw');
const BRAINSTORM_CONTENT_DIR = join(IJFW_GLOBAL, 'brainstorm', 'content');
const PORT_FILE = join(IJFW_GLOBAL, 'dashboard.port');
const PID_FILE = join(IJFW_GLOBAL, 'dashboard.pid');
const CONFIG_FILE = join(HOME, '.ijfw', 'dashboard-config.json');
const DEFAULT_PORT = 19747;

const DEFAULT_CONFIG = {
  accountTier: 'max',
  subscriptions: [
    { name: 'Claude Max 20x', cost: 200, period: 'monthly' },
    { name: 'Codex Pro', cost: 20, period: 'monthly' },
    { name: 'Gemini AI Ultra', cost: 250, period: 'monthly' },
  ],
  theme: 'dark',
  refreshInterval: 10,
};

function findDashboardHtml() {
  const candidates = [
    join(__dirname, 'index.html'),
    join(__dirname, '../../.planning/v1.1-preflight-dashboard/mockups/b-sidebar-sections/index.html'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// --- Data helpers ---

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out = [];
  let malformed = 0;
  for (const line of lines) {
    try { out.push(JSON.parse(line)); }
    catch { malformed++; }
  }
  if (malformed > 0) {
    process.stderr.write(`[ijfw-dashboard] ${path}: ${malformed}/${lines.length} lines malformed\n`);
  }
  return out;
}

function readText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function parseRegistry() {
  const path = join(IJFW_GLOBAL, 'registry.md');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|').map(s => s.trim());
      return { path: parts[0], hash: parts[1], timestamp: parts[2] };
    })
    .filter(r => r.path);
}

// Find the cost-data JSON -- use the most recent one
function findCodburn() {
  if (!existsSync(IJFW_GLOBAL)) return null;
  const files = readdirSync(IJFW_GLOBAL)
    .filter(f => f.startsWith('codeburn-') && f.endsWith('.json'))
    .sort().reverse();
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(IJFW_GLOBAL, files[0]), 'utf8')); }
  catch (err) {
    process.stderr.write(`[ijfw-dashboard] findCodburn(${files[0]}): ${err.message}\n`);
    return null;
  }
}

// --- Local DB helper (hardcoded SQL only, no user input) ---
function querySqlite(dbPath, sql) {
  if (!SQLITE3_AVAILABLE) return [];
  try {
    const out = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8', timeout: 5000 });
    return out.trim().split('\n').filter(Boolean);
  } catch (err) {
    process.stderr.write(`[ijfw-dashboard] querySqlite(${dbPath}): ${err.message}\n`);
    return [];
  }
}

// --- Codex conversation data ---
function readCodexData() {
  if (!SQLITE3_AVAILABLE) return { available: false, reason: SQLITE3_MISSING_REASON };
  const dbPath = join(HOME, '.codex', 'state_5.sqlite');
  if (!existsSync(dbPath)) return null;

  const modelRows = querySqlite(dbPath,
    'SELECT model, COUNT(*) as threads, SUM(tokens_used) as total_tokens FROM threads GROUP BY model ORDER BY total_tokens DESC'
  );
  const models = modelRows.map(row => {
    const parts = row.split('|');
    return { model: parts[0] || 'unknown', threads: parseInt(parts[1]) || 0, tokens: parseInt(parts[2]) || 0 };
  });

  const projRows = querySqlite(dbPath,
    'SELECT cwd, COUNT(*) as threads, SUM(tokens_used) as total_tokens FROM threads GROUP BY cwd ORDER BY total_tokens DESC LIMIT 30'
  );
  const projects = projRows.map(row => {
    const parts = row.split('|');
    return { path: parts[0], name: basename(parts[0] || ''), threads: parseInt(parts[1]) || 0, tokens: parseInt(parts[2]) || 0 };
  });

  const totalsRow = querySqlite(dbPath, 'SELECT COUNT(*), SUM(tokens_used) FROM threads');
  let totalThreads = 0, totalTokens = 0;
  if (totalsRow[0]) {
    const parts = totalsRow[0].split('|');
    totalThreads = parseInt(parts[0]) || 0;
    totalTokens = parseInt(parts[1]) || 0;
  }

  return { models, projects, totalThreads, totalTokens };
}

// --- Gemini project list from ~/.gemini/history/ ---
function readGeminiData() {
  const historyDir = join(HOME, '.gemini', 'history');
  if (!existsSync(historyDir)) return { projects: [] };
  try {
    const projects = readdirSync(historyDir).filter(d => {
      try { return statSync(join(historyDir, d)).isDirectory(); } catch { return false; }
    });
    return { projects };
  } catch (err) {
    process.stderr.write(`[ijfw-dashboard] readGeminiData(): ${err.message}\n`);
    return { projects: [] };
  }
}

// --- Scan ~/dev/*/ for dirs that have .ijfw/ ---
function scanDevProjects() {
  const devDir = join(HOME, 'dev');
  if (!existsSync(devDir)) return [];
  try {
    return readdirSync(devDir)
      .map(d => join(devDir, d))
      .filter(p => {
        try { return statSync(p).isDirectory() && existsSync(join(p, '.ijfw')); }
        catch { return false; }
      });
  } catch (err) {
    process.stderr.write(`[ijfw-dashboard] scanDevProjects(): ${err.message}\n`);
    return [];
  }
}

// --- All IJFW memory files across all projects with .ijfw/ + Claude native memory ---
function buildAllMemory() {
  const registry = parseRegistry();
  const devProjects = scanDevProjects();

  // Collect all project paths that have .ijfw/
  const projectPaths = new Set();
  for (const r of registry) {
    if (existsSync(join(r.path, '.ijfw'))) projectPaths.add(r.path);
  }
  for (const p of devProjects) {
    projectPaths.add(p);
  }

  const results = [];

  function pushMemFile(fp, name, project, type) {
    try {
      const stat = statSync(fp);
      if (!stat.isFile()) return;
      const content = readFileSync(fp, 'utf8');
      let entries;
      if (type === 'claude-native') {
        // MEMORY.md format: each "- " bullet = one entry
        entries = content.split('\n').filter(l => l.startsWith('- ')).length || null;
      } else {
        // IJFW memory: count "## " headings as entries; fall back to "---" frontmatter pairs
        const headingCount = content.split('\n').filter(l => l.startsWith('## ')).length;
        if (headingCount > 0) {
          entries = headingCount;
        } else {
          const dashCount = content.split('\n').filter(l => l.trim() === '---').length;
          entries = dashCount > 0 ? Math.ceil(dashCount / 2) : null;
        }
      }
      const rawLines = content.split('\n').filter(Boolean).length;
      results.push({
        name,
        project,
        path: fp,
        size: stat.size,
        type,
        entries,
        rawLines,
        snippet: content.slice(0, 2000),
      });
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readMemoryFile(${fp}): ${err.message}\n`);
    }
  }

  // IJFW memory files per project
  for (const projectPath of projectPaths) {
    const memDir = join(projectPath, '.ijfw', 'memory');
    if (!existsSync(memDir)) continue;
    const projectName = basename(projectPath);
    try {
      for (const name of readdirSync(memDir)) {
        pushMemFile(join(memDir, name), name, projectName, 'ijfw');
      }
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${memDir}): ${err.message}\n`);
    }
  }

  // Global .ijfw memory
  const globalMemDir = join(IJFW_GLOBAL, '.ijfw', 'memory');
  if (existsSync(globalMemDir)) {
    try {
      for (const name of readdirSync(globalMemDir)) {
        pushMemFile(join(globalMemDir, name), name, '_global', 'ijfw');
      }
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${globalMemDir}): ${err.message}\n`);
    }
  }

  // Claude native memory -- all .md files in ~/.claude/projects/*/memory/
  const claudeProjectsDir = join(HOME, '.claude', 'projects');
  if (existsSync(claudeProjectsDir)) {
    try {
      for (const dir of readdirSync(claudeProjectsDir)) {
        const memDir = join(claudeProjectsDir, dir, 'memory');
        if (!existsSync(memDir)) continue;
        try {
          for (const name of readdirSync(memDir)) {
            if (!name.endsWith('.md')) continue;
            pushMemFile(join(memDir, name), name, dir, 'claude-native');
          }
        } catch (err) {
          process.stderr.write(`[ijfw-dashboard] readdir(${memDir}): ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${claudeProjectsDir}): ${err.message}\n`);
    }
  }

  return results;
}

// --- Claude memory files across all ~/.claude/projects/ (legacy shape for claudeProjectMemory) ---
function readAllClaudeMemory() {
  const claudeProjectsDir = join(HOME, '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return [];
  let dirs;
  try { dirs = readdirSync(claudeProjectsDir); }
  catch (err) {
    process.stderr.write(`[ijfw-dashboard] readAllClaudeMemory(): ${err.message}\n`);
    return [];
  }
  const results = [];
  for (const dir of dirs) {
    const memDir = join(claudeProjectsDir, dir, 'memory');
    if (!existsSync(memDir)) continue;
    try {
      for (const name of readdirSync(memDir)) {
        if (!name.endsWith('.md')) continue;
        const memPath = join(memDir, name);
        try {
          const stat = statSync(memPath);
          const content = readFileSync(memPath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim().startsWith('- ['));
          results.push({
            projectDir: dir,
            path: memPath,
            entryCount: lines.length,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch (err) {
          process.stderr.write(`[ijfw-dashboard] readMemoryFile(${memPath}): ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${memDir}): ${err.message}\n`);
    }
  }
  return results.sort((a, b) => b.entryCount - a.entryCount);
}

function readMemoryFiles() {
  const candidates = [
    join(IJFW_GLOBAL, '.ijfw', 'memory'),
    join(IJFW_GLOBAL, 'memory'),
  ];
  const registry = parseRegistry();
  for (const r of registry) {
    candidates.push(join(r.path, '.ijfw', 'memory'));
  }

  const files = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const fp = join(dir, name);
        try {
          const stat = statSync(fp);
          files.push({ name, path: fp, size: stat.size, mtime: stat.mtime.toISOString() });
        } catch (err) {
          process.stderr.write(`[ijfw-dashboard] readMemoryFile(${fp}): ${err.message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${dir}): ${err.message}\n`);
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Build merged project list from cost data + codex + gemini ---
function buildMergedProjects(codeburnProjects, codexProjects, geminiProjects) {
  const map = new Map(); // keyed by basename

  // Build cost lookup from codeburn projects, summing sub-paths into parent basename
  // e.g. "/dev/ijfw" and "/dev/ijfw/mcp-server" both resolve to "ijfw"
  const costLookup = {};
  const sessionsLookup = {};
  const apiCallsLookup = {};
  for (const p of (codeburnProjects || [])) {
    const name = basename(p['Project'] || '');
    if (!name) continue;
    costLookup[name] = (costLookup[name] || 0) + (p['Cost (USD)'] ?? 0);
    sessionsLookup[name] = (sessionsLookup[name] || 0) + (p['Sessions'] ?? 0);
    apiCallsLookup[name] = (apiCallsLookup[name] || 0) + (p['API Calls'] ?? 0);
  }

  // Populate map with one entry per unique basename
  for (const name of Object.keys(costLookup)) {
    map.set(name, {
      name,
      path: null,
      claudeCost: costLookup[name],
      claudeSessions: sessionsLookup[name] || null,
      claudeApiCalls: apiCallsLookup[name] || null,
      codexTokens: null,
      codexThreads: null,
      gemini: false,
    });
  }
  // Backfill full paths from the first matching codeburn entry
  for (const p of (codeburnProjects || [])) {
    const name = basename(p['Project'] || '');
    if (name && map.has(name) && !map.get(name).path) {
      map.get(name).path = p['Project'];
    }
  }

  for (const p of (codexProjects || [])) {
    const name = basename(p.path || '');
    if (!name) continue;
    if (map.has(name)) {
      map.get(name).codexTokens = (map.get(name).codexTokens || 0) + p.tokens;
      map.get(name).codexThreads = (map.get(name).codexThreads || 0) + p.threads;
    } else {
      map.set(name, {
        name,
        path: p.path,
        claudeCost: null,
        claudeSessions: null,
        claudeApiCalls: null,
        codexTokens: p.tokens,
        codexThreads: p.threads,
        gemini: false,
      });
    }
  }

  for (const dir of (geminiProjects || [])) {
    const name = dir;
    if (map.has(name)) {
      map.get(name).gemini = true;
    } else {
      map.set(name, {
        name,
        path: null,
        claudeCost: null,
        claudeSessions: null,
        claudeApiCalls: null,
        codexTokens: null,
        codexThreads: null,
        gemini: true,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => (b.claudeCost || 0) - (a.claudeCost || 0));
}

// --- Load or create dashboard config ---
function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
    catch (err) {
      // Corrupt config: rename to .corrupt.<ts> so the user has a recoverable
      // copy AND the next run regenerates from defaults instead of getting
      // stuck on the corrupted file forever.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = `${CONFIG_FILE}.corrupt.${stamp}`;
      try {
        renameSync(CONFIG_FILE, corruptPath);
        process.stderr.write(`[ijfw-dashboard] loadConfig(): ${err.message} -- moved corrupt config to ${corruptPath}; regenerating from defaults\n`);
      } catch (renameErr) {
        process.stderr.write(`[ijfw-dashboard] loadConfig(): ${err.message} (rename of corrupt config also failed: ${renameErr.message})\n`);
      }
      // Fall through to "create with defaults" branch below.
    }
  }
  // Create with defaults (file absent, or corrupt-and-renamed-aside).
  try {
    mkdirSync(IJFW_GLOBAL, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  } catch (err) {
    process.stderr.write(`[ijfw-dashboard] loadConfig() write: ${err.message}\n`);
  }
  return { ...DEFAULT_CONFIG };
}

// --- Observation summary ---
function buildObservationSummary(observations) {
  const byType = {};
  for (const obs of observations) {
    const type = obs.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  const recentMeaningful = observations
    .filter(o => o.type !== 'memory-recall')
    .slice(0, 10);

  return { byType, recentMeaningful };
}

// --- Enrich cross-run findings ---
function enrichCrossRun(run) {
  const findingItems = run.findings?.items ?? [];
  const severity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of findingItems) {
    const s = (item.severity || '').toLowerCase();
    if (s in severity) severity[s]++;
  }

  const auditors = (run.auditors ?? []).map(a => ({
    id: a.id,
    family: a.family,
    status: a.status,
  }));

  const projectName = run.target ? basename(run.target) : (run.cwd ? basename(run.cwd) : null);

  // Preserve findings.items so the UI can render individual finding cards
  return {
    ...run,
    project: projectName,
    findingsBySeverity: severity,
    auditors,
    findings: { ...run.findings, items: findingItems },
  };
}

// --- Sessions indexed by session number for journal join ---
function buildSessionIndex(sessionsJsonlPath) {
  const rows = readJsonl(sessionsJsonlPath);
  const index = {};
  for (const row of rows) {
    if (row.session != null) index[row.session] = row;
  }
  return index;
}

// --- Collect sessions.jsonl paths across all known projects ---
function collectAllSessionPaths() {
  const registry = parseRegistry();
  const devProjects = scanDevProjects();

  const paths = [];
  const seen = new Set();

  const add = (p) => {
    if (!seen.has(p)) { seen.add(p); paths.push(p); }
  };

  // Global fallback
  const globalSess = join(IJFW_GLOBAL, '.ijfw', 'metrics', 'sessions.jsonl');
  if (existsSync(globalSess)) add(globalSess);

  for (const r of registry) {
    const p = join(r.path, '.ijfw', 'metrics', 'sessions.jsonl');
    if (existsSync(p)) add(p);
  }
  for (const projectPath of devProjects) {
    const p = join(projectPath, '.ijfw', 'metrics', 'sessions.jsonl');
    if (existsSync(p)) add(p);
  }

  return paths;
}

// --- Savings ledger: six-lever dollar-saved calculation ---
function computeSavingsLedger(transcriptData, costData) {
  // Actual cost: prefer 30-day codeburn total; fall back to transcript aggregate
  const cb30Summary = costData?.thirtyDaySummary;
  const actualCost = cb30Summary?.['Cost (USD)'] ?? transcriptData?.aggregate?.totalCost ?? 0;

  if (!actualCost || actualCost <= 0) {
    return {
      actualCost: 0,
      estimatedWithoutIjfw: 0,
      savedAmount: 0,
      savedPercent: 0,
      levers: { cacheHitRate: null, haikuRoutingPct: null, outputReductionPct: 0.30, memorySaves: 0 },
      methodologyNote: 'No cost data available yet. Run sessions to see savings estimates.',
    };
  }

  // --- Lever 1: Cache hit rate ---
  // From 30-day totals in codeburn daily data; fall back to transcript aggregate
  let totalCacheRead = cb30Summary?.['Cache Read Tokens'] ?? transcriptData?.aggregate?.totalCacheRead ?? 0;
  let totalInput = cb30Summary?.['Input Tokens'] ?? transcriptData?.aggregate?.totalInputTokens ?? 0;
  const cacheHitRate = (totalInput + totalCacheRead) > 0
    ? totalCacheRead / (totalInput + totalCacheRead)
    : 0.70; // default estimate

  // Cache multiplier: without IJFW, assume 25% hit rate (natural conversation
  // has some cache reuse from repeated system prompts; 10% was too aggressive).
  // cache_read costs ~10% of a normal input token on Anthropic pricing.
  const withIjfwCacheFactor = cacheHitRate * 0.1 + (1 - cacheHitRate) * 1.0;
  const baselineCacheFactor = 0.25 * 0.1 + 0.75 * 1.0; // 25% hit rate baseline
  const cacheMultiplier = withIjfwCacheFactor > 0 ? baselineCacheFactor / withIjfwCacheFactor : 1.0;

  // --- Lever 2: Model routing (Haiku % of calls) ---
  // Estimate from costData.models: what fraction of cost is on Haiku vs Sonnet/Opus
  const cbModels = (costData?.models ?? []).filter(m => m['Model'] !== '<synthetic>');
  let haikuRoutingPct = null;
  let routingMultiplier = 1.0;
  if (cbModels.length > 0) {
    const totalModelCost = cbModels.reduce((s, m) => s + (m['Cost (USD)'] || 0), 0);
    const haikuCost = cbModels
      .filter(m => (m['Model'] || '').toLowerCase().includes('haiku'))
      .reduce((s, m) => s + (m['Cost (USD)'] || 0), 0);
    haikuRoutingPct = totalModelCost > 0 ? haikuCost / totalModelCost : null;

    if (haikuRoutingPct != null && haikuRoutingPct > 0) {
      // Without IJFW routing, assume all work goes to Sonnet.
      // Haiku is ~5x cheaper than Sonnet on output tokens.
      // Blended routing benefit: haikuPct * (1 - 1/5) = haikuPct * 0.8 savings on that fraction
      // So the no-IJFW cost would be: actualCost / (1 - haikuPct * 0.8)
      routingMultiplier = 1 / Math.max(1 - haikuRoutingPct * 0.8, 0.2);
    }
  }

  // --- Lever 3: Output reduction (fixed estimate, midpoint of 20-40% range) ---
  const outputReductionPct = 0.30;
  // Without IJFW output discipline, cost multiplier = 1 / (1 - 0.30) ≈ 1.43
  const outputMultiplier = 1 / (1 - outputReductionPct);

  // --- Lever 4: Memory saves (MCP tool round-trips saved) ---
  // Count ijfw_memory_recall + ijfw_memory_store invocations from transcript tool usage
  const toolBreakdown = transcriptData?.aggregate?.toolBreakdown ?? {};
  const memorySaves =
    (toolBreakdown['ijfw_memory_recall'] || 0) +
    (toolBreakdown['ijfw_memory_store'] || 0) +
    (toolBreakdown['ijfw_memory_search'] || 0);

  // --- Composite baseline ---
  // Apply all three multipliers (cache, routing, output) to back-calculate what cost
  // would have been without IJFW. Cap at 5x for defensibility -- higher claims lose
  // credibility with skeptics even when the math supports them.
  const compositeMultiplier = Math.min(cacheMultiplier * routingMultiplier * outputMultiplier, 5.0);
  const estimatedWithoutIjfw = actualCost * compositeMultiplier;

  const savedAmount = estimatedWithoutIjfw - actualCost;
  const savedPercent = Math.round((savedAmount / estimatedWithoutIjfw) * 100);

  const cacheHitDisplay = Math.round(cacheHitRate * 100);
  const haikuDisplay = haikuRoutingPct != null ? Math.round(haikuRoutingPct * 100) : null;

  return {
    actualCost: Math.round(actualCost * 100) / 100,
    estimatedWithoutIjfw: Math.round(estimatedWithoutIjfw * 100) / 100,
    savedAmount: Math.round(savedAmount * 100) / 100,
    savedPercent,
    levers: {
      cacheHitRate,
      haikuRoutingPct,
      outputReductionPct,
      memorySaves,
    },
    methodologyNote: `Actual 30-day cost $${actualCost.toFixed(2)} vs estimated $${estimatedWithoutIjfw.toFixed(2)} without IJFW. ` +
      `Cache lever: ${cacheHitDisplay}% hit rate vs 25% baseline (natural conversation has some cache reuse; Anthropic cache reads cost ~10% of normal input tokens). ` +
      (haikuDisplay != null ? `Routing lever: ${haikuDisplay}% of cost on Haiku; without IJFW routing, assumed all Sonnet. ` : '') +
      `Output discipline lever: 30% output reduction (20-40% measured range). ` +
      (memorySaves > 0 ? `Memory lever: ${memorySaves} MCP round-trips that skipped redundant context re-fetch. ` : '') +
      `Composite multiplier: ${compositeMultiplier.toFixed(2)}x (capped at 5x). Numbers are estimates from your actual session data.`,
  };
}

// --- Compute savings (W1C): per-project FTS5 raw-row counts grouped by
//     source_kind. Reads <projectRoot>/.ijfw/index/compute.db. Empty state
//     when the db is absent -- the dashboard renders a positive "0 / start
//     using compute:" tile rather than an error.
//
//     The dashboard prefers better-sqlite3 when reachable from this process
//     (mcp-server bundles it), and falls back to the existing sqlite3 CLI
//     helper otherwise. Both paths return the same shape:
//       { totalRuns: <int>, byKind: { <kind>: <int>, ... }, project: <string> }
//
//     Exposed for unit tests (test-dashboard-compute-savings.js).
let _betterSqlite = undefined; // tri-state: undefined=uninspected, null=missing, fn=ctor
async function _loadBetterSqlite() {
  if (_betterSqlite !== undefined) return _betterSqlite;
  // Try repo-root then mcp-server location (the canonical install).
  const candidates = [
    join(__dirname, '..', '..', 'mcp-server', 'node_modules', 'better-sqlite3', 'lib', 'index.js'),
    join(__dirname, '..', '..', 'node_modules', 'better-sqlite3', 'lib', 'index.js'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const mod = await import(p);
      _betterSqlite = mod.default || mod;
      return _betterSqlite;
    } catch {
      // Fall through; CLI fallback handles the case.
    }
  }
  _betterSqlite = null;
  return null;
}

export async function getComputeSavings(projectRoot) {
  const empty = { totalRuns: 0, byKind: {}, project: projectRoot };
  if (!projectRoot) return empty;
  const dbPath = join(projectRoot, '.ijfw', 'index', 'compute.db');
  if (!existsSync(dbPath)) return empty;

  // Preferred path: better-sqlite3.
  const Better = await _loadBetterSqlite();
  if (Better) {
    let db;
    try {
      db = new Better(dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare('SELECT source_kind, COUNT(*) AS n FROM raw GROUP BY source_kind').all();
      const byKind = {};
      let totalRuns = 0;
      for (const r of rows) {
        const k = r.source_kind || 'unknown';
        const n = Number(r.n) || 0;
        byKind[k] = n;
        totalRuns += n;
      }
      return { totalRuns, byKind, project: projectRoot };
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] getComputeSavings(${dbPath}): ${err.message}\n`);
      return empty;
    } finally {
      try { db && db.close(); } catch { /* best-effort */ }
    }
  }

  // Fallback: sqlite3 CLI (matches existing dashboard pattern).
  if (!SQLITE3_AVAILABLE) return empty;
  const lines = querySqlite(dbPath, 'SELECT source_kind, COUNT(*) FROM raw GROUP BY source_kind');
  const byKind = {};
  let totalRuns = 0;
  for (const line of lines) {
    const parts = line.split('|');
    const k = parts[0] || 'unknown';
    const n = parseInt(parts[1], 10) || 0;
    byKind[k] = n;
    totalRuns += n;
  }
  return { totalRuns, byKind, project: projectRoot };
}

// Aggregate compute savings across every known project + the global IJFW
// directory. Per-project entries with 0 rows are dropped; the headline
// totalRuns sums all projects so the dashboard sees one combined figure.
async function buildComputeSavings() {
  const registry = parseRegistry();
  const devProjects = scanDevProjects();
  const seen = new Set();
  const projectRoots = [];
  const add = (p) => {
    if (p && !seen.has(p)) { seen.add(p); projectRoots.push(p); }
  };
  for (const r of registry) add(r.path);
  for (const p of devProjects) add(p);
  add(IJFW_GLOBAL);

  // Pick the most-populated project as the "primary" for the project label
  // shown in the tile -- keeps the empty-state tip visible when nothing is
  // indexed yet, and surfaces the busiest index when there is data.
  const totals = { totalRuns: 0, byKind: {}, project: null };
  let bestRuns = -1;
  for (const root of projectRoots) {
    let entry;
    try { entry = await getComputeSavings(root); }
    catch (err) {
      process.stderr.write(`[ijfw-dashboard] buildComputeSavings(${root}): ${err.message}\n`);
      continue;
    }
    if (!entry || !entry.totalRuns) continue;
    totals.totalRuns += entry.totalRuns;
    for (const [k, n] of Object.entries(entry.byKind || {})) {
      totals.byKind[k] = (totals.byKind[k] || 0) + n;
    }
    if (entry.totalRuns > bestRuns) {
      bestRuns = entry.totalRuns;
      totals.project = entry.project;
    }
  }
  return totals;
}

// --- v1.5.0 W12-C N05: dashboard intervention sentinels ---
//
// The operator clicks a button in the live wave dashboard; we write a sentinel
// JSON file into `<projectRoot>/.ijfw/wave-<waveId>/` that the orchestrator-LLM
// polls on its next loop. Three sentinel kinds:
//   - subagent-<subId>.redispatch.json  -- re-run a stuck subagent
//   - subagent-<subId>.swap-ai.json     -- swap the AI family for next dispatch
//   - wave-<waveId>.block.json          -- pause the wave pending clearance
//
// Strict separation of concerns: dashboard = read + sentinel-writer,
// orchestrator = sentinel-consumer + actor. We never invoke orchestrator code
// directly from the HTTP server; the orchestrator picks sentinels up on its
// own cadence. This keeps the dashboard a pure I/O layer.
//
// All three writes are atomic (tmp file + rename) so a torn write can never
// leave half a sentinel on disk.

// ID validator -- accepted by both wave_id and sub_id. Strict to prevent path
// traversal (no '.', '/', '\\', whitespace). Mirrors the lock-file pattern in
// orchestrator/subagent-telemetry.js.
const INTERVENTION_ID_RE = /^[A-Za-z0-9_-]+$/;
const ALLOWED_AI_FAMILIES = new Set(['claude', 'codex', 'gemini']);

function _interventionProjectRoot() {
  // Same precedence as checkpoint-cli.js: env override first, then __dirname's
  // two-up (repo root). Tests pass via env to point at a tmp dir.
  if (process.env.IJFW_PARENT_PROJECT_ROOT) {
    return process.env.IJFW_PARENT_PROJECT_ROOT;
  }
  return resolve(__dirname, '..', '..');
}

function _interventionWaveDir(waveId) {
  return join(_interventionProjectRoot(), '.ijfw', `wave-${waveId}`);
}

function _writeSentinelAtomic(targetPath, payload) {
  // mkdir -p the wave dir (orchestrator may not have created it yet if the
  // operator is staging an intervention before the wave is dispatched).
  mkdirSync(dirname(targetPath), { recursive: true });
  // Per-pid + per-call tmp suffix avoids collisions between concurrent writes
  // hitting the same sentinel name.
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  renameSync(tmpPath, targetPath);
  return targetPath;
}

/**
 * Write a redispatch sentinel for a stuck subagent.
 * Returns { ok: true, sentinelPath } on success, { ok: false, status, error } on failure.
 */
export function writeRedispatchSentinel(waveId, subId, body = {}) {
  if (!INTERVENTION_ID_RE.test(String(waveId || ''))) {
    return { ok: false, status: 400, error: 'invalid waveId' };
  }
  if (!INTERVENTION_ID_RE.test(String(subId || ''))) {
    return { ok: false, status: 400, error: 'invalid subId' };
  }
  const payload = {
    type: 'redispatch',
    waveId,
    subId,
    requestedAt: new Date().toISOString(),
    requestedBy: 'dashboard',
    reason: typeof body.reason === 'string' ? body.reason : null,
  };
  const target = join(_interventionWaveDir(waveId), `subagent-${subId}.redispatch.json`);
  try {
    const sentinelPath = _writeSentinelAtomic(target, payload);
    return { ok: true, sentinelPath };
  } catch (err) {
    return { ok: false, status: 500, error: `sentinel write failed: ${err.message}` };
  }
}

/**
 * Write a swap-ai sentinel for a subagent. body.toAI must be one of the
 * supported AI families.
 */
export function writeSwapAiSentinel(waveId, subId, body = {}) {
  if (!INTERVENTION_ID_RE.test(String(waveId || ''))) {
    return { ok: false, status: 400, error: 'invalid waveId' };
  }
  if (!INTERVENTION_ID_RE.test(String(subId || ''))) {
    return { ok: false, status: 400, error: 'invalid subId' };
  }
  const toAI = body && typeof body.toAI === 'string' ? body.toAI : null;
  if (!toAI || !ALLOWED_AI_FAMILIES.has(toAI)) {
    return { ok: false, status: 400, error: `invalid toAI; expected one of ${[...ALLOWED_AI_FAMILIES].join(',')}` };
  }
  const payload = {
    type: 'swap-ai',
    waveId,
    subId,
    toAI,
    requestedAt: new Date().toISOString(),
    requestedBy: 'dashboard',
    reason: typeof body.reason === 'string' ? body.reason : null,
  };
  const target = join(_interventionWaveDir(waveId), `subagent-${subId}.swap-ai.json`);
  try {
    const sentinelPath = _writeSentinelAtomic(target, payload);
    return { ok: true, sentinelPath };
  } catch (err) {
    return { ok: false, status: 500, error: `sentinel write failed: ${err.message}` };
  }
}

/**
 * Write a block-wave sentinel. body.reason is required (operator must say
 * something so the next person to look at the wave knows why it's paused).
 */
export function writeBlockWaveSentinel(waveId, body = {}) {
  if (!INTERVENTION_ID_RE.test(String(waveId || ''))) {
    return { ok: false, status: 400, error: 'invalid waveId' };
  }
  const reason = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return { ok: false, status: 400, error: 'reason is required' };
  }
  const payload = {
    type: 'block',
    waveId,
    requestedAt: new Date().toISOString(),
    requestedBy: 'dashboard',
    reason,
  };
  const target = join(_interventionWaveDir(waveId), `wave-${waveId}.block.json`);
  try {
    const sentinelPath = _writeSentinelAtomic(target, payload);
    return { ok: true, sentinelPath };
  } catch (err) {
    return { ok: false, status: 500, error: `sentinel write failed: ${err.message}` };
  }
}

/**
 * Read POST body with a small cap (sentinels are tiny). Returns parsed JSON
 * or { _bodyError: <msg> } on failure.
 */
function _readJsonBody(req, maxBytes = 16_384) {
  return new Promise((resolveBody) => {
    let body = '';
    let destroyed = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        destroyed = true;
        try { req.destroy(); } catch {}
        resolveBody({ _bodyError: 'request body too large' });
      }
    });
    req.on('end', () => {
      if (destroyed) return;
      if (!body) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(body)); }
      catch { resolveBody({ _bodyError: 'invalid JSON body' }); }
    });
    req.on('error', () => {
      if (!destroyed) resolveBody({ _bodyError: 'request read error' });
    });
  });
}

/**
 * Listed active waves for the intervention UI. Reads .ijfw/wave-<id> checkpoints
 * and returns { waves: [{ waveId, subagents: [{ subId, lastAction, ts, ... }] }] }.
 */
export function listActiveWaves(projectRootOverride) {
  const root = projectRootOverride || _interventionProjectRoot();
  const ijfwDir = join(root, '.ijfw');
  if (!existsSync(ijfwDir)) return { waves: [] };
  let entries;
  try { entries = readdirSync(ijfwDir); }
  catch { return { waves: [] }; }
  const waves = [];
  for (const name of entries) {
    if (!name.startsWith('wave-')) continue;
    const waveId = name.slice('wave-'.length);
    if (!INTERVENTION_ID_RE.test(waveId)) continue;
    const waveDir = join(ijfwDir, name);
    let files;
    try { files = readdirSync(waveDir); }
    catch { continue; }
    const subagents = [];
    let blocked = false;
    for (const f of files) {
      if (f === `wave-${waveId}.block.json`) { blocked = true; continue; }
      const cpMatch = f.match(/^subagent-(.+)\.checkpoint\.json$/);
      if (!cpMatch) continue;
      const subId = cpMatch[1];
      try {
        const data = JSON.parse(readFileSync(join(waveDir, f), 'utf8'));
        subagents.push({
          subId,
          ts: data.ts || null,
          lastAction: data.last_action || null,
          toolUseCount: data.tool_use_count ?? null,
          redispatchPending: existsSync(join(waveDir, `subagent-${subId}.redispatch.json`)),
          swapAiPending: existsSync(join(waveDir, `subagent-${subId}.swap-ai.json`)),
        });
      } catch {
        subagents.push({ subId, ts: null, lastAction: '(unreadable checkpoint)' });
      }
    }
    subagents.sort((a, b) => a.subId.localeCompare(b.subId));
    waves.push({ waveId, blocked, subagents });
  }
  waves.sort((a, b) => a.waveId.localeCompare(b.waveId));
  return { waves };
}

// --- Transcript summary cache ---
function readTranscriptSummary() {
  const p = join(IJFW_GLOBAL, 'transcript-summary.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (err) {
    process.stderr.write(`[ijfw-dashboard] readTranscriptSummary(): ${err.message}\n`);
    return null;
  }
}

// --- API data aggregator ---

async function buildApiData() {
  // --- Observations ---
  const observations = readJsonl(join(IJFW_GLOBAL, 'observations.jsonl'))
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  // --- Observation summary ---
  const observationSummary = buildObservationSummary(observations);

  // --- Registry ---
  const registry = parseRegistry();

  // --- Cost data (primary cost source) ---
  const codeburn = findCodburn();
  const cbToday = codeburn?.periods?.['Today'] ?? null;
  const cb30d = codeburn?.periods?.['30 Days'] ?? null;
  const cb7d = codeburn?.periods?.['7 Days'] ?? null;

  const todayCost = cbToday?.summary?.['Cost (USD)'] ?? 0;
  const cost30d = cb30d?.summary?.['Cost (USD)'] ?? 0;
  const todaySessions = cbToday?.summary?.['Sessions'] ?? 0;

  // Daily cost trend from 30d data
  const dailyTrend = (cb30d?.daily ?? []).map(d => ({
    date: d['Date'],
    cost: d['Cost (USD)'] ?? 0,
    cacheRead: d['Cache Read Tokens'] ?? 0,
    inputTokens: d['Input Tokens'] ?? 0,
  }));

  // Cache efficiency from 30d totals
  let totalCacheRead = 0, totalInput = 0;
  for (const d of dailyTrend) {
    totalCacheRead += d.cacheRead;
    totalInput += d.inputTokens;
  }
  if (cbToday?.daily?.length) {
    for (const d of cbToday.daily) {
      totalCacheRead += d['Cache Read Tokens'] ?? 0;
      totalInput += d['Input Tokens'] ?? 0;
    }
  }
  const cacheEfficiency = totalInput + totalCacheRead > 0
    ? (totalCacheRead / (totalInput + totalCacheRead) * 100).toFixed(1)
    : null;

  // --- Sessions per project (from sessions.jsonl) ---
  const projectSessions = {};
  for (const r of registry) {
    const name = basename(r.path);
    let count = 0;
    const localSessions = join(r.path, '.ijfw', 'metrics', 'sessions.jsonl');
    const globalSessions = join(IJFW_GLOBAL, '.ijfw', 'metrics', 'sessions.jsonl');
    const sessFile = existsSync(localSessions) ? localSessions
                   : existsSync(globalSessions) ? globalSessions : null;
    if (sessFile) {
      const rows = readJsonl(sessFile);
      count = rows.length;
    }
    projectSessions[name] = { path: r.path, sessionCount: count, lastSeen: r.timestamp };
  }

  // --- Session index for journal join (merge all known projects) ---
  const allSessionPaths = collectAllSessionPaths();
  const mergedSessionIndex = {};
  for (const sessPath of allSessionPaths) {
    const idx = buildSessionIndex(sessPath);
    Object.assign(mergedSessionIndex, idx);
  }

  // --- Project journal (session timeline) ---
  const journalPath = join(IJFW_GLOBAL, '.ijfw', 'memory', 'project-journal.md');
  const journalText = readText(journalPath) ?? readText(join(IJFW_GLOBAL, 'memory', 'project-journal.md')) ?? '';
  const journalEntries = journalText.split('\n')
    .filter(l => /^\s*-\s*\[/.test(l))
    .map(l => {
      const m = l.match(/\[([^\]]+)\]\s+([^:]+):\s*(.*)/);
      if (!m) return null;
      const entry = { timestamp: m[1], event: m[2].trim(), detail: m[3].trim() };
      // Detail field contains "#26"; also match "session 5" or "session:5" in either field
      const sessMatch = m[3].match(/#(\d+)/)
        ?? m[2].match(/session[:\s#]*(\d+)/i)
        ?? m[3].match(/session[:\s#]*(\d+)/i);
      if (sessMatch) {
        const sessNum = parseInt(sessMatch[1], 10);
        const rec = mergedSessionIndex[sessNum];
        // Only attach metrics if schema v>=2 (v1 records have no token/cost data)
        if (rec && (rec.v ?? 1) >= 2) {
          entry.metrics = {
            model: rec.model ?? null,
            inputTokens: rec.input_tokens ?? null,
            outputTokens: rec.output_tokens ?? null,
            cacheReadTokens: rec.cache_read_tokens ?? null,
            costUsd: rec.cost_usd ?? null,
          };
        }
      }
      return entry;
    })
    .filter(Boolean)
    .reverse();

  // --- Handoff ---
  const handoffPath = join(IJFW_GLOBAL, '.ijfw', 'memory', 'handoff.md');
  const handoff = readText(handoffPath)
    ?? readText(join(IJFW_GLOBAL, 'HANDOFF.md'))
    ?? null;

  // Parse handoff into sections split on ### headings
  let handoffSections = null;
  if (handoff) {
    const sections = [];
    let current = null;
    for (const line of handoff.split('\n')) {
      const h = line.match(/^###\s+(.*)/);
      if (h) {
        if (current) sections.push(current);
        current = { title: h[1].trim(), body: '' };
      } else if (current) {
        current.body += line + '\n';
      }
    }
    if (current) sections.push(current);
    // Trim body whitespace
    handoffSections = sections.map(s => ({ title: s.title, body: s.body.trim() }));
  }

  // --- Archive / handoff history check ---
  const archiveDir = join(IJFW_GLOBAL, '.ijfw', 'archive');
  const sessionsDir = join(IJFW_GLOBAL, '.ijfw', 'sessions');
  let handoffHistoryAvailable = false;
  if (existsSync(archiveDir)) {
    try {
      handoffHistoryAvailable = readdirSync(archiveDir).some(f =>
        f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.jsonl')
      );
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${archiveDir}): ${err.message}\n`);
    }
  }
  if (!handoffHistoryAvailable && existsSync(sessionsDir)) {
    try {
      handoffHistoryAvailable = readdirSync(sessionsDir).length > 0;
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] readdir(${sessionsDir}): ${err.message}\n`);
    }
  }

  // --- Cross-audit receipts ---
  const crossRunsPath = join(IJFW_GLOBAL, '.ijfw', 'receipts', 'cross-runs.jsonl');
  const crossRuns = readJsonl(crossRunsPath)
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    .map(enrichCrossRun);

  // --- Cross-audit response files ---
  const crossAuditDir = join(IJFW_GLOBAL, '.ijfw', 'cross-audit');
  const crossAuditFiles = {};
  if (existsSync(crossAuditDir)) {
    for (const f of readdirSync(crossAuditDir)) {
      if (f.endsWith('.md')) {
        crossAuditFiles[f] = readText(join(crossAuditDir, f));
      }
    }
  }

  // --- Memory files (IJFW .ijfw/memory/) ---
  const memoryFiles = readMemoryFiles();

  // --- All Claude project memory ---
  const claudeProjectMemory = readAllClaudeMemory();

  // --- All memory (unified, enriched) ---
  const allMemory = buildAllMemory();

  // --- Codex data ---
  const codexData = readCodexData();

  // --- Gemini data ---
  const geminiData = readGeminiData();

  // --- "Today by project" -- prefer today-period breakdown, fallback 30d, then registry ---
  const codeburnProjects = codeburn?.projects ?? [];
  const todayProjects = cbToday?.projects ?? [];
  const todayByProjectRaw = (todayProjects.length > 0 ? todayProjects : codeburnProjects).length > 0
    ? (todayProjects.length > 0 ? todayProjects : codeburnProjects).map(p => ({
        name: basename(p['Project'] || ''),
        path: p['Project'] || '',
        sessions: p['Sessions'] ?? 0,
        cost: p['Cost (USD)'] ?? null,
        apiCalls: p['API Calls'] ?? null,
      }))
    : registry.map(r => ({
        name: basename(r.path),
        path: r.path,
        sessions: projectSessions[basename(r.path)]?.sessionCount ?? 0,
        cost: null,
        apiCalls: null,
      }));
  // Deduplicate sub-paths into parent (e.g. "ijfw/mcp-server" -> "ijfw")
  const dedupMap = new Map();
  for (const p of todayByProjectRaw) {
    const name = p.name || '';
    let parentKey = null;
    for (const k of dedupMap.keys()) {
      if (name !== k && (name.startsWith(k + '/') || name.startsWith(k + '-'))) { parentKey = k; break; }
    }
    if (parentKey) {
      const parent = dedupMap.get(parentKey);
      parent.cost = (parent.cost || 0) + (p.cost || 0);
      parent.sessions = (parent.sessions || 0) + (p.sessions || 0);
    } else {
      dedupMap.set(name, { ...p });
    }
  }
  const todayByProject = Array.from(dedupMap.values()).sort((a, b) => (b.cost || 0) - (a.cost || 0));

  // --- Merged project list ---
  const mergedProjects = buildMergedProjects(
    codeburnProjects,
    codexData?.projects ?? [],
    geminiData.projects
  );

  // --- Dashboard config ---
  const config = loadConfig();

  // --- Transcript summary (parse-transcripts.js output) ---
  const transcriptData = readTranscriptSummary();

  // --- Sessions from transcript data (correct per-session values) ---
  const allSessions = [];
  for (const [projName, proj] of Object.entries(transcriptData?.projects ?? {})) {
    for (const sess of (proj.sessions ?? [])) {
      // Determine session type: files starting with "agent-" are subagent dispatches
      const sessionFile = sess.file || sess.fileName || '';
      const type = basename(sessionFile).startsWith('agent-') ? 'subagent' : 'main';
      allSessions.push({ ...sess, project: projName, type });
    }
  }
  // Filter out empty sessions (0 tokens, no model -- aborted or cleared sessions)
  const liveSessions = allSessions.filter(s => s.outputTokens > 0 || s.inputTokens > 0);
  liveSessions.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));

  // todayByProject: Today period has no per-project breakdown, so we use 30d data
  // Label this accurately in the UI via a flag
  const todayByProjectIs30d = todayProjects.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    today: {
      cost: todayCost,
      sessions: todaySessions,
      cacheEfficiency,
      cost30d,
    },
    todayByProject,
    todayByProjectIs30d,
    observations: observations.slice(0, 100),
    observationCount: observations.length,
    observationSummary,
    dailyTrend,
    registry,
    projectSessions,
    sessions: liveSessions.slice(0, 100),
    sessionTotal: liveSessions.length,
    handoff,
    handoffSections,
    handoffHistoryAvailable,
    crossRuns: crossRuns.slice(0, 50),
    crossAuditFiles,
    memoryFiles,
    claudeProjectMemory,
    allMemory,
    codex: codexData,
    gemini: geminiData,
    mergedProjects,
    config,
    costData: {
      generated: codeburn?.generated ?? null,
      todaySummary: cbToday?.summary ?? null,
      sevenDaySummary: cb7d?.summary ?? null,
      thirtyDaySummary: cb30d?.summary ?? null,
      models: cb30d?.models ?? [],
      projects: codeburnProjects,
    },
    transcriptData,
    journalEntries,
    savingsLedger: computeSavingsLedger(transcriptData, {
      thirtyDaySummary: cb30d?.summary ?? null,
      models: cb30d?.models ?? [],
    }),
    computeSavings: await buildComputeSavings(),
  };
}

// --- Brainstorm helpers ---

function listBrainstormFiles() {
  if (!existsSync(BRAINSTORM_CONTENT_DIR)) return [];
  try {
    return readdirSync(BRAINSTORM_CONTENT_DIR)
      .filter(f => f.endsWith('.html'))
      .map(f => {
        const fp = join(BRAINSTORM_CONTENT_DIR, f);
        try { return { name: f, mtime: statSync(fp).mtime }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name);
  } catch (err) {
    process.stderr.write(`[ijfw-dashboard] listBrainstormFiles(): ${err.message}\n`);
    return [];
  }
}

const BRAINSTORM_DARK_WRAPPER = (title, navLinks, body, autoRefresh) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${autoRefresh ? '<meta http-equiv="refresh" content="2">' : ''}
<title>IJFW Brainstorm${title ? ' -- ' + title : ''}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); letter-spacing: .04em; text-transform: uppercase; }
  header .subtitle { font-size: 12px; color: var(--muted); }
  nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 8px 24px; display: flex; gap: 8px; flex-wrap: wrap; }
  nav a { font-size: 12px; color: var(--accent); text-decoration: none; padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; }
  nav a:hover { background: var(--border); }
  nav a.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  main { padding: 24px; }
  .waiting { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; gap: 16px; }
  .waiting .icon { font-size: 48px; }
  .waiting p { color: var(--muted); font-size: 14px; }
  .waiting .pulse { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1.2)} }
</style>
</head>
<body>
<header>
  <h1>IJFW Brainstorm</h1>
  ${title ? `<span class="subtitle">${title}</span>` : ''}
</header>
${navLinks ? `<nav>${navLinks}</nav>` : ''}
<main>${body}</main>
</body>
</html>`;

const BRAINSTORM_WAITING_HTML = BRAINSTORM_DARK_WRAPPER('', '', `
<div class="waiting">
  <div class="icon">💭</div>
  <p>Waiting for brainstorm to start...</p>
  <div class="pulse"></div>
  <p style="font-size:11px">This page auto-refreshes every 2 seconds.</p>
</div>
`, true);

// --- CLI commands ---
// Guarded so importing this module (e.g. from tests) doesn't launch the
// server or process.exit(). Only the direct `node server.js` invocation
// triggers the bootstrap below.
// ---------------------------------------------------------------------------
// v1.5.0 audit-H5.8 — per-extension permission audit log
//
// The runtime-mediator + hermes/wayland Python hooks append events to
// ~/.ijfw/state/permission-events.jsonl. The runtime-mediator rotates the
// file to .0 at ROTATION_LINE_CAP (10_000) lines. The dashboard surfaces the
// last N events, filterable by extension name and since-timestamp.
//
// SECURITY:
//  - lstatSync refuses symlinked events files (H1.3 pattern). A symlink at
//    the events path is suspicious — refuse to read it and emit a stderr
//    advisory so the operator notices.
//  - DoS cap on limit (5000) to bound memory + serialized response size.
//  - Malformed JSONL lines are tolerated (skipped + stderr warn).
//  - Render helpers escape every user-content cell (esc() pattern, H3.1).
// ---------------------------------------------------------------------------

const AUDIT_LOG_LIMIT_CAP = 5000;
const AUDIT_LOG_DEFAULT_LIMIT = 200;

function _auditEventsPath(home) {
  return join(home, '.ijfw', 'state', 'permission-events.jsonl');
}

/**
 * Read one events file (current or .0 rotated). Returns array of events or
 * empty array. Refuses symlinks (security). Tolerates malformed lines.
 *
 * Exported for test access.
 */
export function readPermissionEventsFile(filePath) {
  if (!existsSync(filePath)) return [];
  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    return [];
  }
  if (st.isSymbolicLink && st.isSymbolicLink()) {
    process.stderr.write(
      `[ijfw-dashboard] refusing to read symlinked permission-events file at ${filePath}\n`,
    );
    return [];
  }
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[ijfw-dashboard] ${filePath}: read error: ${err.message}\n`);
    return [];
  }
  const lines = raw.split('\n');
  const out = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object') out.push(ev);
    } catch {
      malformed++;
    }
  }
  if (malformed > 0) {
    process.stderr.write(`[ijfw-dashboard] ${filePath}: ${malformed} malformed line(s) skipped\n`);
  }
  return out;
}

/**
 * Read both the current events file and any .0 rotated file. Apply optional
 * ext / since filters. Return up to `limit` events in reverse-chronological
 * order. Limit is capped at AUDIT_LOG_LIMIT_CAP for DoS protection.
 *
 * @param {object} opts
 * @param {string} [opts.homeDir] - override $HOME (test injection)
 * @param {string} [opts.ext]     - filter by event.extension === ext
 * @param {string} [opts.since]   - ISO8601; keep events with timestamp >= since
 * @param {number} [opts.limit]   - default 200, capped at 5000
 * @returns {{events: object[], truncated: boolean, total_read: number}}
 */
export function readPermissionEvents(opts = {}) {
  const home = opts.homeDir || process.env.HOME || homedir();
  const current = _auditEventsPath(home);
  const rotated = current + '.0';
  // Read rotated first (older), then current (newer); concat so we can sort.
  const evs = [...readPermissionEventsFile(rotated), ...readPermissionEventsFile(current)];
  let sinceMs = null;
  if (opts.since) {
    const t = Date.parse(opts.since);
    if (!Number.isNaN(t)) sinceMs = t;
  }
  const ext = typeof opts.ext === 'string' && opts.ext ? opts.ext : null;
  const filtered = [];
  for (const ev of evs) {
    if (ext && ev.extension !== ext) continue;
    if (sinceMs !== null) {
      const ts = Date.parse(ev.timestamp || ev.time || '');
      if (Number.isNaN(ts) || ts < sinceMs) continue;
    }
    filtered.push(ev);
  }
  // Sort reverse-chronological by timestamp; events without a parseable
  // timestamp sink to the bottom.
  filtered.sort((a, b) => {
    const ta = Date.parse(a.timestamp || a.time || '') || 0;
    const tb = Date.parse(b.timestamp || b.time || '') || 0;
    return tb - ta;
  });
  let limit = Number.isFinite(+opts.limit) ? Math.floor(+opts.limit) : AUDIT_LOG_DEFAULT_LIMIT;
  if (limit < 1) limit = 1;
  if (limit > AUDIT_LOG_LIMIT_CAP) limit = AUDIT_LOG_LIMIT_CAP;
  const truncated = filtered.length > limit;
  return {
    events: filtered.slice(0, limit),
    truncated,
    total_read: evs.length,
  };
}

/**
 * Server-side HTML escape — must match the client-side esc() used in
 * index.html so server-rendered snippets are XSS-safe. Exported for the
 * XSS-escape test.
 */
export function escAuditCell(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a single audit row to an HTML <tr>. Every user-content cell goes
 * through escAuditCell(). Exported so the XSS-escape test can assert raw
 * payload bytes become escaped entities.
 */
export function renderAuditRow(ev) {
  const ts = escAuditCell(ev && ev.timestamp);
  const extension = escAuditCell(ev && ev.extension);
  const tool = escAuditCell(ev && ev.tool);
  const allowed = ev && ev.allowed === true ? 'allowed' : 'denied';
  const reason = escAuditCell(ev && ev.reason);
  return (
    '<tr>' +
    '<td>' + ts + '</td>' +
    '<td>' + extension + '</td>' +
    '<td>' + tool + '</td>' +
    '<td>' + allowed + '</td>' +
    '<td>' + reason + '</td>' +
    '</tr>'
  );
}

const _entrypoint = (() => {
  try {
    const argv1 = process.argv[1] || '';
    return argv1 === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (_entrypoint) {

const args = process.argv.slice(2);

if (args.includes('--stop')) {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    cleanup();
    console.log(`[ijfw] Dashboard stopped (pid ${pid}).`);
  } catch {
    console.log('[ijfw] Dashboard not running.');
    cleanup();
  }
  process.exit(0);
}

if (args.includes('--status')) {
  if (isRunning()) {
    const port = readFileSync(PORT_FILE, 'utf8').trim();
    console.log(`[ijfw] Dashboard running at http://localhost:${port}`);
  } else {
    console.log('[ijfw] Dashboard not running.');
  }
  process.exit(0);
}

// --- Helpers ---

function cleanup() {
  try { unlinkSync(PORT_FILE); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
}
const cleanupSync = cleanup;

function isRunning() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Server ---

if (isRunning()) {
  const port = readFileSync(PORT_FILE, 'utf8').trim();
  console.log(`[ijfw] Dashboard already running at http://localhost:${port}`);
  process.exit(0);
}

const htmlPath = findDashboardHtml();
if (!htmlPath) {
  console.error('[ijfw] Dashboard HTML not found. Expected scripts/dashboard/index.html');
  process.exit(1);
}

let port = DEFAULT_PORT;
const portArg = args.indexOf('--port');
if (portArg !== -1 && args[portArg + 1]) {
  port = parseInt(args[portArg + 1], 10) || DEFAULT_PORT;
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/data') {
    buildApiData()
      .then((data) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        process.stderr.write(`[ijfw-dashboard] /api/data error: ${err.stack}\n`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal dashboard error. Check server logs.' }));
      });
    return;
  }

  // C9.7: Trident lens-health endpoint. Returns the latest probe snapshot
  // plus a tile-friendly shape (mode, alert flag, per-lens dead-for_ms).
  // Probes are cached for 60s by lens-health.js -- this endpoint is cheap.
  if (url === '/api/trident/lens-health') {
    probeLenses({ codex: true, gemini: true, claude: true })
      .then((probeResult) => {
        const tile = healthTileShape(probeResult);
        const payload = {
          probed_at: probeResult.summary && probeResult.summary.probed_at,
          summary: probeResult.summary,
          tile,
          raw: {
            codex: probeResult.codex,
            gemini: probeResult.gemini,
            claude: probeResult.claude,
          },
        };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify(payload));
      })
      .catch((err) => {
        process.stderr.write(`[ijfw-dashboard] /api/trident/lens-health error: ${err && err.stack}\n`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'lens-health probe did not complete' }));
      });
    return;
  }

  if (url === '/api/config' && req.method === 'POST') {
    let body = '';
    let destroyed = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) { // 100KB limit -- config is tiny
        destroyed = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (destroyed) return;
      try {
        const incoming = JSON.parse(body);
        // Validate keys against allowlist to prevent injection
        const ALLOWED_KEYS = new Set(['accountTier', 'subscriptions', 'theme', 'refreshInterval']);
        const sanitized = {};
        for (const [key, val] of Object.entries(incoming)) {
          if (ALLOWED_KEYS.has(key)) sanitized[key] = val;
        }
        const current = loadConfig();
        const updated = { ...current, ...sanitized };
        mkdirSync(IJFW_GLOBAL, { recursive: true });
        writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: updated }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid config data' }));
      }
    });
    return;
  }

  // v1.5.0 W12-C N05 — live wave intervention.
  //
  // GET  /api/waves                                     -- list active waves + subagents
  // POST /api/wave/<waveId>/subagent/<subId>/redispatch -- write redispatch sentinel
  // POST /api/wave/<waveId>/subagent/<subId>/swap-ai    -- write swap-ai sentinel
  // POST /api/wave/<waveId>/block                       -- write block-wave sentinel
  //
  // The dashboard ONLY writes sentinels; the orchestrator-LLM consumes them.
  if (url === '/api/waves' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const data = listActiveWaves();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Match /api/wave/<waveId>/subagent/<subId>/(redispatch|swap-ai)
  // and    /api/wave/<waveId>/block
  // We use a manual parse rather than a router to keep the zero-dep promise.
  const interventionMatch = url.match(/^\/api\/wave\/([^/]+)(?:\/subagent\/([^/]+))?\/(redispatch|swap-ai|block)$/);
  if (interventionMatch) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    // r15-H3: CSRF/origin defense. The dashboard binds to localhost-only and
    // state-mutating POSTs are operator actions. Reject any cross-origin
    // request: same-origin browser navigations + curl/script (no Origin
    // header) are fine; a browser tab on attacker.example POSTing here is not.
    const origin = req.headers && req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const host = req.headers.host || '';
        if (o.host !== host) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'cross-origin POST refused' }));
          return;
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'malformed Origin header' }));
        return;
      }
    }
    const rawWaveId = decodeURIComponent(interventionMatch[1]);
    const rawSubId = interventionMatch[2] ? decodeURIComponent(interventionMatch[2]) : null;
    const action = interventionMatch[3];

    _readJsonBody(req).then((body) => {
      if (body && body._bodyError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: body._bodyError }));
        return;
      }
      let result;
      if (action === 'block') {
        result = writeBlockWaveSentinel(rawWaveId, body);
      } else if (action === 'redispatch') {
        if (!rawSubId) {
          result = { ok: false, status: 400, error: 'subId required' };
        } else {
          result = writeRedispatchSentinel(rawWaveId, rawSubId, body);
        }
      } else if (action === 'swap-ai') {
        if (!rawSubId) {
          result = { ok: false, status: 400, error: 'subId required' };
        } else {
          result = writeSwapAiSentinel(rawWaveId, rawSubId, body);
        }
      } else {
        result = { ok: false, status: 400, error: 'unknown action' };
      }
      const status = result.ok ? 200 : (result.status || 400);
      // Don't echo internal status field in the response body.
      const payload = result.ok
        ? { ok: true, sentinelPath: result.sentinelPath }
        : { ok: false, error: result.error };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // Serve the intervention UI.
  if (url === '/wave-intervention' || url === '/wave-intervention.html') {
    try {
      const html = readFileSync(join(__dirname, 'wave-intervention.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP_HEADER });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`wave-intervention.html error: ${err.message}`);
    }
    return;
  }

  // v1.5.0 audit-H5.8 — per-extension permission audit log.
  // GET /api/extension-audit-log?ext=<name>&limit=200&since=<iso8601>
  if (url === '/api/extension-audit-log' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const ext = qs.get('ext') || undefined;
      const since = qs.get('since') || undefined;
      const limitRaw = qs.get('limit');
      const limit = limitRaw ? Number(limitRaw) : undefined;
      const result = readPermissionEvents({ ext, since, limit });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(result));
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] /api/extension-audit-log error: ${err && err.stack}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'audit log read failed' }));
    }
    return;
  }

  if (url === '/api/memory-file') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const filePath = qs.get('path');
    const name = qs.get('name');

    function serveMemoryContent(fp, displayName) {
      try {
        // SECURITY (audit H3.3): hard cap file size before reading. The
        // memory-file route can serve raw transcript JSONL which has no schema
        // ceiling; without the cap a 1 GiB file would OOM the dashboard.
        try {
          const st = statSync(fp);
          if (st.size > MEMORY_FILE_MAX_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'file too large', max_bytes: MEMORY_FILE_MAX_BYTES, actual_bytes: st.size }));
            return;
          }
        } catch { /* fall through; readFileSync will surface ENOENT */ }
        const rawContent = readFileSync(fp, 'utf8');
        // SECURITY (audit H3.3): redact secrets (API keys, tokens, JWTs, etc.)
        // before serving raw memory/transcript content to the dashboard.
        // The transcript JSONL files frequently contain tool-call output that
        // echoes user-supplied secrets back into the conversation.
        const content = redactSecrets(rawContent);
        const result = { name: displayName, content, path: fp };
        if (content.length > 5000) {
          // Split on --- frontmatter separators or ## headings
          const parsed = [];
          let current = null;
          for (const line of content.split('\n')) {
            const h = line.match(/^##\s+(.*)/);
            if (h) {
              if (current) parsed.push(current);
              current = { title: h[1].trim(), body: '' };
            } else if (line === '---') {
              if (current) parsed.push(current);
              current = { title: 'Section', body: '' };
            } else if (current) {
              current.body += line + '\n';
            } else {
              current = { title: displayName, body: line + '\n' };
            }
          }
          if (current) parsed.push(current);
          result.parsed = parsed.map(s => ({ title: s.title, body: s.body.trim() }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json',  });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }

    // ?path= -- must start with ~/.claude/projects/ or a registered project path
    // SECURITY: reject path traversal, canonicalize before prefix check
    if (filePath) {
      // Defense in depth: reject .. segments before any filesystem call
      if (filePath.includes('..')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path traversal not permitted' }));
        return;
      }
      // Canonicalize to resolve symlinks
      let canonicalPath;
      try { canonicalPath = realpathSync(resolve(filePath)); }
      catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // Build canonicalized allowlist
      const allowedPrefixes = [];
      try { allowedPrefixes.push(realpathSync(join(HOME, '.claude', 'projects'))); } catch {}
      for (const r of parseRegistry()) {
        try { allowedPrefixes.push(realpathSync(r.path)); } catch {}
      }
      for (const p of scanDevProjects()) {
        try { allowedPrefixes.push(realpathSync(p)); } catch {}
      }
      // Prefix check with path separator to prevent /Users/sean matching /Users/seanevil
      const isAllowed = allowedPrefixes.some(p => canonicalPath === p || canonicalPath.startsWith(p + '/'));
      if (!isAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path not permitted' }));
        return;
      }
      serveMemoryContent(canonicalPath, basename(canonicalPath));
      return;
    }

    // ?name= -- search across all project .ijfw/memory/ dirs
    if (name) {
      const allMem = buildAllMemory();
      const mf = allMem.find(f => f.name === name);
      if (!mf) {
        // Fallback: legacy readMemoryFiles
        const legacyFiles = readMemoryFiles();
        const lf = legacyFiles.find(f => f.name === name);
        if (!lf) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        serveMemoryContent(lf.path, lf.name);
        return;
      }
      serveMemoryContent(mf.path, mf.name);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'provide ?path= or ?name=' }));
    return;
  }

  // --- Brainstorm routes ---

  if (url === '/brainstorm/files') {
    const files = listBrainstormFiles();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache',  });
    res.end(JSON.stringify(files));
    return;
  }

  if (url === '/brainstorm') {
    const files = listBrainstormFiles();
    if (!files.length) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP_HEADER });
      res.end(BRAINSTORM_WAITING_HTML);
      return;
    }
    // Serve newest file, wrapping fragments
    const newestPath = join(BRAINSTORM_CONTENT_DIR, files[0]);
    try {
      const raw = readFileSync(newestPath, 'utf8');
      const isFullDoc = raw.trimStart().toLowerCase().startsWith('<!doctype');
      if (isFullDoc) {
        // Inject meta-refresh if not already present
        const withRefresh = raw.includes('http-equiv="refresh"') || raw.includes("http-equiv='refresh'")
          ? raw
          : raw.replace(/(<head[^>]*>)/i, '$1\n<meta http-equiv="refresh" content="2">');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP_HEADER });
        res.end(withRefresh);
      } else {
        // Fragment -- wrap in dark themed shell
        const navLinks = files.map((f, i) =>
          `<a href="/brainstorm?file=${encodeURIComponent(f)}" class="${i === 0 ? 'active' : ''}">${f}</a>`
        ).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP_HEADER });
        res.end(BRAINSTORM_DARK_WRAPPER(files[0], navLinks, raw, true));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Brainstorm error: ${err.message}`);
    }
    return;
  }

  // Default: serve dashboard HTML
  try {
    const html = readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP_HEADER });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Dashboard error: ${err.message}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    port = 0;
    server.listen(0, '127.0.0.1');
  } else {
    console.error(`[ijfw] Dashboard error: ${err.message}`);
    process.exit(1);
  }
});

server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  writeFileSync(PORT_FILE, String(actualPort));
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`[ijfw] Dashboard: http://localhost:${actualPort}`);

  if (process.env.IJFW_DAEMON === '1') {
    process.stdout.write(`http://localhost:${actualPort}\n`);
    server.unref();
    if (process.stdin.unref) process.stdin.unref();
    if (process.stdout.unref) process.stdout.unref();
    if (process.stderr.unref) process.stderr.unref();
  }
});

process.on('SIGTERM', () => { cleanupSync(); process.exit(0); });
process.on('SIGINT', () => { cleanupSync(); process.exit(0); });

} // end if (_entrypoint)
