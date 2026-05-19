#!/usr/bin/env node
/**
 * IJFW transcript parser.
 * Processes ~/.claude/projects/*\/*.jsonl and writes ~/.ijfw/transcript-summary.json.
 *
 * Usage:
 *   node parse-transcripts.js              # incremental (default)
 *   node parse-transcripts.js --incremental
 *   node parse-transcripts.js --force      # re-parse everything
 *   node parse-transcripts.js --stats      # print summary, no parse
 *
 * Env:
 *   IJFW_SKIP_PARSE=1        # exit immediately, do nothing
 *   IJFW_PARSE_BUDGET_MS=N   # wall-clock budget (default 30000)
 */

// Per-shell escape hatch -- short-circuit before any I/O.
if (process.env.IJFW_SKIP_PARSE === '1') process.exit(0);

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, openSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
// Canonical pricing -- single source of truth. mcp-server is a sibling
// of scripts/. Importing keeps the dashboard receipt surface in lockstep
// with everything else (cross-dispatcher, /api/prices, computeCost in
// readers). H4.8 audit fix.
import { getTierRatesPerMillion, computeCost as computeTurnCost } from '../../mcp-server/src/cost/pricing.js';

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');
const IJFW_GLOBAL = join(HOME, '.ijfw');
const SUMMARY_FILE = join(IJFW_GLOBAL, 'transcript-summary.json');

// Detect billing mode once per run. ANTHROPIC_API_KEY = paid API; otherwise
// Claude Code is OAuth-authed (Max/Pro/Team subscription). Override with
// IJFW_BILLING_MODE=max|api.
function detectBillingMode() {
  const override = (process.env.IJFW_BILLING_MODE || '').toLowerCase();
  if (override === 'max' || override === 'api') return override;
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  return 'max';
}
const BILLING_MODE = detectBillingMode();
const PIDFILE = join(IJFW_GLOBAL, '.parse-transcripts.pid');
const BUDGET_MS = (() => {
  const n = parseInt(process.env.IJFW_PARSE_BUDGET_MS || '30000', 10);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();

// Single-process guard. Returns true if we got the lock.
// Atomic via O_CREAT|O_EXCL ('wx' flag) so concurrent starts cannot both
// acquire. If the lock file already exists, peek at the PID inside and
// reclaim only if the holder is dead (POSIX `kill -0`). Empty/unparseable
// PID is treated as a racing-writer signal -- back off rather than reclaim,
// because deleting the file would orphan the racer's lock.
function acquireLock() {
  try { mkdirSync(IJFW_GLOBAL, { recursive: true }); } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(PIDFILE, 'wx');
    } catch (err) {
      if (err && err.code !== 'EEXIST') return false;
      // File exists. Inspect PID.
      let oldPid = NaN;
      try { oldPid = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10); } catch {}
      // Empty / NaN means another process is mid-create. Back off.
      if (!Number.isFinite(oldPid) || oldPid <= 0) return false;
      // Holder still alive? Don't steal.
      try { process.kill(oldPid, 0); return false; } catch { /* dead, fall through */ }
      // Reclaim stale lock.
      try { unlinkSync(PIDFILE); } catch { return false; }
      continue; // retry the exclusive open
    }
    try { writeFileSync(fd, String(process.pid)); } finally { try { closeSync(fd); } catch {} }
    const release = () => { try { unlinkSync(PIDFILE); } catch {} };
    process.on('exit', release);
    process.on('SIGINT',  () => { release(); process.exit(130); });
    process.on('SIGTERM', () => { release(); process.exit(143); });
    return true;
  }
  return false;
}

// --- Pricing (sourced canonically from mcp-server/src/cost/pricing.js) ---
// Per-tier $/M view (opus/sonnet/haiku) is derived from the canonical
// model_prices.json -- no hardcoded rates here. H4.8 audit fix.
const PRICING = getTierRatesPerMillion();

function getModelTier(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus'))   return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku'))  return 'haiku';
  return null;
}

function getModelFamily(model) {
  if (!model) return 'unknown';
  // Normalize: strip date suffixes, keep base name
  // e.g. "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
  return model.replace(/-\d{8}$/, '');
}

// Cost is computed against the canonical pricing module. We prefer the
// per-model resolver (handles cache_create_5m vs 1h split correctly) and
// fall back to the per-tier $/M table when the caller only knows the tier.
function computeCost(tier, usage, model) {
  // Prefer model-aware computation: it understands ephemeral 5m vs 1h
  // cache_creation splits and uses the same path as the receipts surface.
  if (model) {
    return computeTurnCost(model, {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_create_tokens_5m: usage.cache_creation_input_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
    });
  }
  if (!tier || !PRICING[tier]) return 0;
  const p = PRICING[tier];
  const M = 1_000_000;
  return (
    (usage.input_tokens || 0) / M * p.in +
    (usage.output_tokens || 0) / M * p.out +
    (usage.cache_read_input_tokens || 0) / M * p.cache_read +
    (usage.cache_creation_input_tokens || 0) / M * p.cache_creation
  );
}

// --- Parse a single JSONL file ---
function parseTranscript(filePath) {
  const result = {
    file: basename(filePath),
    startTime: null,
    endTime: null,
    durationMinutes: 0,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: 0,
    theoreticalCost: 0,
    billingMode: BILLING_MODE,
    toolUsage: {},
    turnCount: 0,
  };

  let raw;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch (err) {
    process.stderr.write(`[parse-transcripts] Cannot read ${filePath}: ${err.message}\n`);
    return null;
  }

  const lines = raw.split('\n');
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { malformed++; continue; }

    // Track timestamps
    if (obj.timestamp) {
      if (!result.startTime || obj.timestamp < result.startTime) result.startTime = obj.timestamp;
      if (!result.endTime || obj.timestamp > result.endTime) result.endTime = obj.timestamp;
    }

    const msg = obj.message;
    if (!msg) continue;

    // Count human turns
    if (msg.role === 'user') result.turnCount++;

    // Assistant response with usage
    if (msg.usage) {
      result.inputTokens += msg.usage.input_tokens || 0;
      result.outputTokens += msg.usage.output_tokens || 0;
      result.cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
      result.cacheCreationTokens += msg.usage.cache_creation_input_tokens || 0;

      if (msg.model && !result.model) result.model = msg.model;
    }

    // Tool use events in content array
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'tool_use' && item.name) {
          result.toolUsage[item.name] = (result.toolUsage[item.name] || 0) + 1;
        }
      }
    }
  }

  // Compute cost. theoreticalCost is paid-API equivalent; cost is what the
  // user actually paid (0 for Max-subscription sessions).
  const tier = getModelTier(result.model);
  result.theoreticalCost = computeCost(tier, {
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    cache_read_input_tokens: result.cacheReadTokens,
    cache_creation_input_tokens: result.cacheCreationTokens,
  }, result.model);
  result.cost = BILLING_MODE === 'max' ? 0 : result.theoreticalCost;

  if (malformed > 0) {
    process.stderr.write(`[parse-transcripts] ${filePath}: ${malformed}/${lines.length} lines malformed\n`);
  }

  // Duration
  if (result.startTime && result.endTime) {
    const ms = new Date(result.endTime) - new Date(result.startTime);
    result.durationMinutes = Math.round(ms / 60000 * 10) / 10;
  }

  return result;
}

// --- Collect all JSONL files across all projects (recursive) ---
// Claude Code stores transcripts at two levels:
//   depth 2: ~/.claude/projects/<slug>/session.jsonl
//   depth 3: ~/.claude/projects/<slug>/session-uuid/agent.jsonl
function collectFiles() {
  if (!existsSync(CLAUDE_PROJECTS)) return [];
  const files = [];
  let dirs;
  try { dirs = readdirSync(CLAUDE_PROJECTS); }
  catch (err) {
    process.stderr.write(`[parse-transcripts] Cannot read ${CLAUDE_PROJECTS}: ${err.message}\n`);
    return [];
  }
  for (const dir of dirs) {
    const dirPath = join(CLAUDE_PROJECTS, dir);
    let stat;
    try { stat = statSync(dirPath); }
    catch (err) {
      process.stderr.write(`[parse-transcripts] Cannot read ${dirPath}: ${err.message}\n`);
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try { entries = readdirSync(dirPath); }
    catch (err) {
      process.stderr.write(`[parse-transcripts] Cannot read ${dirPath}: ${err.message}\n`);
      continue;
    }
    for (const f of entries) {
      const fp = join(dirPath, f);
      let fstat;
      try { fstat = statSync(fp); }
      catch (err) {
        process.stderr.write(`[parse-transcripts] Cannot read ${fp}: ${err.message}\n`);
        continue;
      }
      // Direct JSONL files (depth 2)
      if (f.endsWith('.jsonl') && fstat.isFile()) {
        files.push({ path: fp, projectDir: dir, mtime: fstat.mtimeMs });
      }
      // Session UUID directories: <uuid>/subagents/*.jsonl
      if (fstat.isDirectory()) {
        const subagentsDir = join(fp, 'subagents');
        if (existsSync(subagentsDir)) {
          let subEntries;
          try { subEntries = readdirSync(subagentsDir); }
          catch (err) {
            process.stderr.write(`[parse-transcripts] Cannot read ${subagentsDir}: ${err.message}\n`);
            continue;
          }
          for (const sf of subEntries) {
            if (!sf.endsWith('.jsonl')) continue;
            const sfp = join(subagentsDir, sf);
            let sfstat;
            try { sfstat = statSync(sfp); }
            catch (err) {
              process.stderr.write(`[parse-transcripts] Cannot read ${sfp}: ${err.message}\n`);
              continue;
            }
            if (sfstat.isFile()) {
              files.push({ path: sfp, projectDir: dir, mtime: sfstat.mtimeMs });
            }
          }
        }
      }
    }
  }
  return files;
}

// --- Derive a human-readable project name from the dir slug ---
// ~/.claude/projects/-Users-seandonahoe-dev-ijfw  ->  ijfw
function projectName(dirSlug) {
  const parts = dirSlug.replace(/^-/, '').split('-');
  // Last meaningful segment (skip username/home parts)
  // Heuristic: find index of 'dev' or 'Desktop', take the rest
  const devIdx = parts.indexOf('dev');
  if (devIdx !== -1 && devIdx < parts.length - 1) {
    return parts.slice(devIdx + 1).join('-');
  }
  return parts[parts.length - 1] || dirSlug;
}

// --- Load existing summary ---
function loadSummary() {
  if (!existsSync(SUMMARY_FILE)) return null;
  try { return JSON.parse(readFileSync(SUMMARY_FILE, 'utf8')); }
  catch (err) {
    process.stderr.write(`[parse-transcripts] Cannot parse ${SUMMARY_FILE}: ${err.message}\n`);
    return null;
  }
}

// --- Build aggregate from scratch from all project sessions ---
function buildAggregate(projects) {
  const agg = {
    totalCost: 0,
    totalTheoreticalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalSessions: 0,
    totalTurns: 0,
    modelBreakdown: {},
    toolBreakdown: {},
    hourlyActivity: new Array(24).fill(0),
    dailyActivity: {},
    peakHour: 0,
    activeDays: 0,
    currentStreak: 0,
  };

  for (const [, proj] of Object.entries(projects)) {
    agg.totalCost += proj.totalCost;
    agg.totalTheoreticalCost += proj.totalTheoreticalCost || 0;
    agg.totalInputTokens += proj.totalInputTokens;
    agg.totalOutputTokens += proj.totalOutputTokens;
    agg.totalCacheRead += proj.totalCacheRead;
    agg.totalSessions += proj.transcripts;

    for (const sess of proj.sessions) {
      agg.totalTurns += sess.turnCount || 0;

      // Model breakdown
      const family = getModelFamily(sess.model || '');
      if (!agg.modelBreakdown[family]) {
        agg.modelBreakdown[family] = { sessions: 0, cost: 0, theoreticalCost: 0, tokens: 0 };
      }
      agg.modelBreakdown[family].sessions++;
      agg.modelBreakdown[family].cost += sess.cost || 0;
      agg.modelBreakdown[family].theoreticalCost += sess.theoreticalCost || 0;
      agg.modelBreakdown[family].tokens += (sess.inputTokens || 0) + (sess.outputTokens || 0);

      // Tool breakdown
      for (const [tool, count] of Object.entries(sess.toolUsage || {})) {
        agg.toolBreakdown[tool] = (agg.toolBreakdown[tool] || 0) + count;
      }

      // Hourly + daily activity
      if (sess.startTime) {
        try {
          const d = new Date(sess.startTime);
          const hour = d.getUTCHours();
          agg.hourlyActivity[hour]++;
          const day = d.toISOString().slice(0, 10);
          if (!agg.dailyActivity[day]) agg.dailyActivity[day] = { sessions: 0, cost: 0, theoreticalCost: 0 };
          agg.dailyActivity[day].sessions++;
          agg.dailyActivity[day].cost += sess.cost || 0;
          agg.dailyActivity[day].theoreticalCost += sess.theoreticalCost || 0;
        } catch (err) {
          process.stderr.write(`[parse-transcripts] Date parse error for ${sess.file}: ${err.message}\n`);
        }
      }
    }
  }

  // Peak hour
  let peak = 0;
  for (let h = 0; h < 24; h++) {
    if (agg.hourlyActivity[h] > agg.hourlyActivity[peak]) peak = h;
  }
  agg.peakHour = peak;

  // Active days + streak
  const days = Object.keys(agg.dailyActivity).sort();
  agg.activeDays = days.length;

  // Current streak: consecutive days ending today-or-yesterday
  if (days.length) {
    const today = new Date().toISOString().slice(0, 10);
    let streak = 0;
    let cursor = new Date(today);
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      if (agg.dailyActivity[key]) {
        streak++;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      } else {
        break;
      }
    }
    agg.currentStreak = streak;
  }

  return agg;
}

// --- Main ---

const args = process.argv.slice(2);
const forceAll = args.includes('--force');
const statsOnly = args.includes('--stats');

if (statsOnly) {
  if (!existsSync(SUMMARY_FILE)) {
    console.log('[parse-transcripts] No summary found. Run without --stats first.');
    process.exit(0);
  }
  const s = loadSummary();
  console.log(`projects:    ${Object.keys(s.projects).length}`);
  console.log(`sessions:    ${s.aggregate.totalSessions}`);
  console.log(`billing:     ${s.billingMode || 'unknown'}`);
  console.log(`cost paid:   $${(s.aggregate.totalCost || 0).toFixed(4)}`);
  console.log(`theoretical: $${(s.aggregate.totalTheoreticalCost || 0).toFixed(4)}`);
  console.log(`turns:       ${s.aggregate.totalTurns}`);
  console.log(`generated:   ${s.generated}`);
  process.exit(0);
}

try {

// Single-process guard. If another parse is in flight, exit silently.
if (!acquireLock()) process.exit(0);

const existing = loadSummary();
const lastMtime = (!forceAll && existing?.lastParsedMtime) ? existing.lastParsedMtime : 0;

const allFiles = collectFiles();
// Sort by mtime ASC so partial runs make forward progress: each completed
// file advances the watermark, so the next run picks up where this one
// left off instead of looping over the same initial subset.
const toProcess = (forceAll ? allFiles : allFiles.filter(f => f.mtime > lastMtime))
  .sort((a, b) => a.mtime - b.mtime);

if (toProcess.length === 0 && existing) {
  console.log(`[parse-transcripts] Up to date (${allFiles.length} transcripts, no changes).`);
  process.exit(0);
}

console.log(`[parse-transcripts] Parsing ${toProcess.length} file(s) (${allFiles.length} total)...`);
const t0 = Date.now();
let partial = false;

// Start from existing projects if incremental, else fresh
const projects = (forceAll || !existing) ? {} : (existing.projects ? { ...existing.projects } : {});

// On --force, drop everything and rebuild. On incremental we dedupe at push
// time so a partial run (budget hit) only replaces the sessions we actually
// reparsed, not the ones we never got to.
if (forceAll) {
  for (const k of Object.keys(projects)) delete projects[k];
}

let newMaxMtime = lastMtime;
let processed = 0;

for (const { path, projectDir, mtime } of toProcess) {
  if (Date.now() - t0 > BUDGET_MS) {
    partial = true;
    console.log(`[parse-transcripts] ${BUDGET_MS}ms budget reached after ${processed}/${toProcess.length} files; saving partial.`);
    break;
  }
  const name = projectName(projectDir);
  if (!projects[name]) {
    projects[name] = {
      transcripts: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCost: 0,
      totalTheoreticalCost: 0,
      sessions: [],
    };
  }

  const sess = parseTranscript(path);
  if (sess) {
    // Replace any prior entry with the same file name (idempotent re-parse).
    // First-parse-wins for billingMode: preserve the historical mode so a
    // later run under a different env/override does not rewrite past costs.
    const idx = projects[name].sessions.findIndex(s => s.file === sess.file);
    if (idx >= 0) {
      const existingMode = projects[name].sessions[idx].billingMode;
      if (existingMode) {
        sess.billingMode = existingMode;
        sess.cost = existingMode === 'max' ? 0 : sess.theoreticalCost;
      }
      projects[name].sessions[idx] = sess;
    } else {
      projects[name].sessions.push(sess);
    }
  }

  if (mtime > newMaxMtime) newMaxMtime = mtime;
  processed++;
}

// Recompute project-level totals from all sessions (handles incremental correctly)
for (const proj of Object.values(projects)) {
  proj.transcripts = proj.sessions.length;
  proj.totalInputTokens = proj.sessions.reduce((s, r) => s + (r.inputTokens || 0), 0);
  proj.totalOutputTokens = proj.sessions.reduce((s, r) => s + (r.outputTokens || 0), 0);
  proj.totalCacheRead = proj.sessions.reduce((s, r) => s + (r.cacheReadTokens || 0), 0);
  proj.totalCost = proj.sessions.reduce((s, r) => s + (r.cost || 0), 0);
  proj.totalTheoreticalCost = proj.sessions.reduce((s, r) => s + (r.theoreticalCost || 0), 0);
}

const aggregate = buildAggregate(projects);

// Watermark = highest mtime of files we actually processed. Because
// toProcess is sorted ASC, any unprocessed file has mtime >= newMaxMtime,
// so the next run picks them up via the `mtime > lastMtime` filter.
const summary = {
  generated: new Date().toISOString(),
  lastParsedMtime: newMaxMtime || lastMtime,
  totalTranscripts: allFiles.length,
  partial,
  billingMode: BILLING_MODE,
  projects,
  aggregate,
};

try {
  mkdirSync(IJFW_GLOBAL, { recursive: true });
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(`[parse-transcripts] Failed to write summary: ${err.message}`);
  process.exit(1);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const costLabel = BILLING_MODE === 'max'
  ? `paid $0.00, value captured: $${aggregate.totalTheoreticalCost.toFixed(4)}`
  : `cost: $${aggregate.totalCost.toFixed(4)}`;
console.log(`[parse-transcripts] Done in ${elapsed}s. Projects: ${Object.keys(projects).length}, sessions: ${aggregate.totalSessions}, ${costLabel}`);

} catch (err) {
  console.error(`[parse-transcripts] Fatal error: ${err.stack}`);
  process.exit(1);
}
