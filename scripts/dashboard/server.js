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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync, realpathSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

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
    const out = execSync(`sqlite3 "${dbPath}" "${sql}"`, { encoding: 'utf8', timeout: 5000 });
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

function buildApiData() {
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
    try {
      const data = buildApiData();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      process.stderr.write(`[ijfw-dashboard] /api/data error: ${err.stack}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal dashboard error. Check server logs.' }));
    }
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

  if (url === '/api/memory-file') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const filePath = qs.get('path');
    const name = qs.get('name');

    function serveMemoryContent(fp, displayName) {
      try {
        const content = readFileSync(fp, 'utf8');
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(withRefresh);
      } else {
        // Fragment -- wrap in dark themed shell
        const navLinks = files.map((f, i) =>
          `<a href="/brainstorm?file=${encodeURIComponent(f)}" class="${i === 0 ? 'active' : ''}">${f}</a>`
        ).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
