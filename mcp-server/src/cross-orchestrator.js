// cross-orchestrator.js -- Trident execution flow.
//
// runCrossOp: probe roster → diversity pick → swarm resolve →
//             parallel fire → merge → receipt write → return.
//
// Stamp note (U7): buildRequest stamps internally with new Date() per call.
// The orchestrator's runStamp is used exclusively in the receipt and as the
// archive identity for this run. We don't patch buildRequest to accept an
// override -- simpler, and the receipt is the authoritative record.
//
// Specialist swarm (U6): isInstalled is cached per-process in audit-roster;
// pickAuditors already calls it. We do not re-probe here.
//
// ESM, zero external deps.

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pickAuditors, isReachable, ROSTER } from './audit-roster.js';
import { loadSwarmConfig, DEFAULT_AUDITORS } from './swarm-config.js';
import { buildRequest, parseResponse, mergeResponses, checkBudget } from './cross-dispatcher.js';
import { writeReceipt, readReceipts } from './receipts.js';
import { runViaApi } from './api-client.js';
import { RELEASE_BLOCKER_GATES, DegradedTridentError } from './trident/dispatch.js';

// ---------------------------------------------------------------------------
// Per-provider timeout defaults (ms). Codex cold-start can take 120s+ (U2).
// ---------------------------------------------------------------------------
const PROVIDER_TIMEOUT_MS = {
  codex:       120_000,
  gemini:       45_000,
  anthropic:    60_000,
  'api-mode':   30_000,
};
const DEFAULT_TIMEOUT_MS = 90_000;

function timeoutForPick(pick, resolvedTimeoutSec) {
  if (resolvedTimeoutSec) return resolvedTimeoutSec * 1000;
  // v1.5.0 S7: roster-level override takes precedence over family default.
  // Codex needs 8min for review work vs 90s default; see audit-roster.js.
  if (pick.timeoutMs) return pick.timeoutMs;
  return PROVIDER_TIMEOUT_MS[pick.id] ?? DEFAULT_TIMEOUT_MS;
}

// parsePosInt -- parse a raw string to a positive integer in [min, max].
// Returns fallback on non-numeric, NaN, ≤0, or >max.
function parsePosInt(raw, fallback, min = 1, max = Infinity) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

// Read one line from stdin. Resolves with trimmed string.
function readLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// Emit pre-fire UX string to stderr; handle --confirm interactive gate.
// Returns true to proceed, false to cancel.
async function uxGate(picks, missing, confirm, quiet = false) {
  const ids = picks.map(p => p.id).join(', ');
  const missingFamilies = [...new Set(
    (missing || [])
      .map(m => m.family || m.id)
      .filter(Boolean)
  )];

  if (confirm) {
    process.stderr.write(`Confirm combo: ${ids}? [y/N] `);
    const answer = await readLine('');
    if (answer.toLowerCase() !== 'y') {
      process.stderr.write('Cancelled.\n');
      return false;
    }
    return true;
  }

  if (!quiet) {
    if (missingFamilies.length > 0) {
      const missing_label = missingFamilies.join(', ');
      const hint = missingFamilies.map(f => `${f}-family`).join(' or ');
      process.stderr.write(
        `Partial roster: running ${ids}; missing ${missing_label}. Install a ${hint} CLI for full Trident diversity.\n`
      );
    } else {
      process.stderr.write(
        `Auto-proceeding with ${ids}. Pass --confirm to override on next turn.\n`
      );
    }
  }
  return true;
}

// Angle assignments per mode per auditor family/id.
const AUDIT_ANGLE = () => 'general';

const RESEARCH_ANGLE = (id) => {
  if (id === 'codex' || id === 'opencode' || id === 'aider') return 'benchmarks';
  if (id === 'claude') return 'synthesis';
  return 'citations'; // gemini, copilot, default
};

const CRITIQUE_ANGLE = (id) => {
  if (id === 'codex' || id === 'opencode' || id === 'aider') return 'technical';
  if (id === 'gemini' || id === 'copilot') return 'strategic';
  return 'ux'; // claude, default
};

function angleFor(mode, id) {
  if (mode === 'audit')    return AUDIT_ANGLE(id);
  if (mode === 'research') return RESEARCH_ANGLE(id);
  if (mode === 'critique') return CRITIQUE_ANGLE(id);
  throw new Error(`Unknown mode: ${mode}`);
}

// buildSpawnEnv -- compose env for a given auditor pick.
// Issue #9-A: when running the gemini CLI, if GEMINI_API_KEY is present,
// strip gcloud-related env vars so gemini-cli's own auth precedence does not
// silently pick up an unrelated gcloud project (cloudaicompanion.googleapis.com
// billing collisions). Reproduced by Kat in issue #9.
//
// Precedence we enforce when GEMINI_API_KEY is set:
//   GEMINI_API_KEY (kept) > GOOGLE_APPLICATION_CREDENTIALS (dropped)
//                         > gcloud active-project env (dropped)
export function buildSpawnEnv(pick, baseEnv) {
  const env = { ...baseEnv };
  if (pick && pick.id === 'gemini' && env.GEMINI_API_KEY) {
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.GCLOUD_PROJECT;
    delete env.CLOUDSDK_CORE_PROJECT;
  }
  return env;
}

// spawnCli -- single-settlement guard + SIGKILL on timeout or abort signal.
// Returns { stdout, stderr, exitCode, timedOut, aborted } or null on spawn error.
function spawnCli(pick, request, timeoutMs, signal = null, env = process.env) {
  return new Promise((resolve) => {
    const parts = pick.invoke.trim().split(/\s+/);
    const bin = parts[0];
    const args = parts.slice(1);

    let settled = false;
    const settle = (val) => { if (settled) return; settled = true; resolve(val); };

    const killAndAbort = () => {
      if (proc) {
        proc.kill('SIGKILL');
        try { proc.stdout.destroy(); } catch { /* ignore */ }
        try { proc.stderr.destroy(); } catch { /* ignore */ }
      }
      clearTimeout(timer);
      settle({ stdout: '', stderr: 'aborted', exitCode: null, timedOut: false, aborted: true });
    };

    // Check abort before spawning.
    if (signal?.aborted) { resolve({ stdout: '', stderr: 'aborted', exitCode: null, timedOut: false, aborted: true }); return; }

    let proc;
    const timer = setTimeout(() => {
      if (proc) {
        proc.kill('SIGKILL');
        // Destroy stdio streams so the event loop isn't kept alive by open pipes.
        try { proc.stdout.destroy(); } catch { /* ignore */ }
        try { proc.stderr.destroy(); } catch { /* ignore */ }
      }
      settle({ stdout: '', stderr: 'timeout', exitCode: null, timedOut: true, aborted: false });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: buildSpawnEnv(pick, env) });
    } catch {
      clearTimeout(timer);
      settle(null);
      return;
    }

    // Listen for external abort (runAc).
    if (signal) signal.addEventListener('abort', killAndAbort, { once: true });

    // CLI children can exit before consuming stdin (for example auth failures,
    // startup validation, or commands that reject piped input). Treat pipe
    // errors as child stderr/exit evidence, not uncaught process exceptions.
    proc.stdin.on('error', (err) => {
      if (err?.code && !stderr.includes(err.code)) stderr += `${stderr ? '\n' : ''}stdin ${err.code}`;
    });
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    // Single-settlement guard: error + close can both fire on spawn failure.
    proc.on('error', () => { clearTimeout(timer); settle(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', killAndAbort);
      settle({ stdout, stderr, exitCode: code, timedOut: false, aborted: false });
    });

    // 1.2.5 (1.3 audit fix): respect backpressure on the stdin write. For
    // typical 1-50 KB prompts the pipe buffer absorbs the write, but very
    // large requests (long synthesis prompts, big file targets) can return
    // false from .write() and require a 'drain' event before .end() to avoid
    // dropping bytes on certain CLI implementations.
    try {
      const flushed = proc.stdin.write(request);
      if (flushed) {
        try { proc.stdin.end(); } catch { /* stdin may close before end */ }
      } else {
        proc.stdin.once('drain', () => { try { proc.stdin.end(); } catch { /* */ } });
      }
    } catch {
      // stdin may already be closed on some CLI tools
    }
  });
}

// fireExternal -- CLI with API-key fallback.
// Returns { stdout, stderr, exitCode, status, source, elapsedMs }
// status: 'ok' | 'empty' | 'failed' | 'timeout' | 'fallback-used' | 'aborted' | null (cli normal)
// source: 'cli' | 'api' | 'none'
//
// Timeout → fallback policy: a CLI timeout IS fallback-eligible. A slow CLI
// gets bypassed by the API when available. API uses its own 30s budget so
// the overall result is either 'fallback-used' (API succeeded) or the original
// 'timeout' (both paths exhausted).
async function fireExternal(pick, request, timeoutMs, env = process.env, signal = null) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  // Helper: extract mode/angle/target from the request payload for API calls.
  function extractApiParams() {
    const modeMatch  = request.match(/^Mode:\s+(\S+)/m);
    const angleMatch = request.match(/^Angle:\s+(\S+)/m);
    const mode  = modeMatch  ? modeMatch[1]  : 'audit';
    const angle = angleMatch ? angleMatch[1] : 'general';
    const targetMatch = request.match(/## Target\s*\n\n([\s\S]*)$/);
    const target = targetMatch ? targetMatch[1].trim() : request;
    return { mode, angle, target };
  }

  // API-only pick (preferredSource: 'api') -- skip spawnCli entirely.
  if (pick.preferredSource === 'api' && pick.apiFallback && isReachable(pick.id, env).api) {
    if (signal?.aborted) return { stdout: '', stderr: 'aborted', exitCode: null, status: 'aborted', source: 'none', elapsedMs: elapsed() };
    const { mode, angle, target } = extractApiParams();
    const apiResult = await runViaApi(pick, mode, angle, target, env, PROVIDER_TIMEOUT_MS['api-mode'], signal);
    if (apiResult.status === 'ok') {
      return { stdout: apiResult.raw, stderr: '', exitCode: 0, status: 'fallback-used', source: 'api', elapsedMs: elapsed() };
    }
    return { stdout: '', stderr: apiResult.error, exitCode: null, status: 'failed', source: 'none', elapsedMs: elapsed() };
  }

  const raw = await spawnCli(pick, request, timeoutMs, signal, env);

  // Aborted by runAc
  if (raw && raw.aborted) {
    return { stdout: '', stderr: 'aborted', exitCode: null, status: 'aborted', source: 'none', elapsedMs: elapsed() };
  }

  // Explicit timeout -- attempt API fallback before giving up.
  if (raw && raw.timedOut) {
    if (pick.apiFallback && isReachable(pick.id, env).api) {
      const { mode, angle, target } = extractApiParams();
      const apiResult = await runViaApi(pick, mode, angle, target, env, PROVIDER_TIMEOUT_MS['api-mode'], signal);
      if (apiResult.status === 'ok') {
        return { stdout: apiResult.raw, stderr: '', exitCode: 0, status: 'fallback-used', source: 'api', elapsedMs: elapsed() };
      }
    }
    return { stdout: '', stderr: 'timeout', exitCode: null, status: 'timeout', source: 'none', elapsedMs: elapsed() };
  }

  // CLI failed -- try API fallback
  const cliOk = raw !== null && raw.exitCode === 0;
  if (!cliOk && pick.apiFallback && isReachable(pick.id, env).api) {
    const { mode, angle, target } = extractApiParams();
    const apiResult = await runViaApi(pick, mode, angle, target, env, PROVIDER_TIMEOUT_MS['api-mode'], signal);

    if (apiResult.status === 'ok') {
      return { stdout: apiResult.raw, stderr: '', exitCode: 0, status: 'fallback-used', source: 'api', elapsedMs: elapsed() };
    }
    return { stdout: '', stderr: apiResult.error, exitCode: null, status: 'failed', source: 'none', elapsedMs: elapsed() };
  }

  if (raw === null) {
    return { stdout: '', stderr: 'spawn error', exitCode: null, status: 'failed', source: 'none', elapsedMs: elapsed() };
  }

  return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode, status: null, source: 'cli', elapsedMs: elapsed() };
}

// fanOut -- rolling concurrency window; zero-dep semaphore.
async function fanOut(tasks, concurrency = 3) {
  const results = Array.from({ length: tasks.length });
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// minResponsesFanOut -- abort stragglers once minResponses auditors settle
// productively. Takes a shared AbortController (runAc) so pending picks get
// killed on threshold.
//
// 1.2.5 audit fixes:
//   - 1.4 (HIGH): only "productive" results (status null = CLI exit 0, or
//     'fallback-used' = API succeeded) count toward minResponses. Failed /
//     timeout / aborted results count toward all-settled detection so the
//     promise still resolves, but they no longer prematurely satisfy
//     minResponses. Previously: 2 immediate failures with minResponses=2
//     could abort still-running productive auditors.
//   - 1.1 (HIGH): .catch() guard on fireExternal so a synchronous throw
//     can never leave the orchestrator promise unresolved forever.
async function minResponsesFanOut(requests, picks, resolvedTimeoutSec, env, concurrency, minResponses, runAc) {
  const total = requests.length;
  const results = Array.from({ length: total }, () => null);
  let productiveCount = 0;
  let settledCount = 0;
  let nextIdx = 0;
  let done = false;

  function isProductive(raw) {
    return Boolean(raw) && (raw.status === null || raw.status === 'fallback-used');
  }

  return new Promise((resolveAll) => {
    function check() {
      if (done) return;
      const enoughProductive = productiveCount >= Math.min(minResponses, total);
      const allDone = settledCount >= total;
      if (enoughProductive || allDone) {
        done = true;
        runAc.abort();  // signal remaining in-flight picks to terminate
        for (let j = 0; j < total; j++) {
          if (results[j] === null) {
            results[j] = { stdout: '', stderr: 'aborted', exitCode: null, status: 'aborted', source: 'none', elapsedMs: 0 };
          }
        }
        resolveAll(results);
      }
    }
    function launchNext() {
      if (done || nextIdx >= total) return;
      const i = nextIdx++;
      const { pick, payload } = requests[i];
      fireExternal(pick, payload, timeoutForPick(pick, resolvedTimeoutSec), env, runAc.signal)
        .then(raw => {
          results[i] = raw;
          settledCount++;
          if (isProductive(raw)) productiveCount++;
          check();
          launchNext();
        })
        .catch(err => {
          results[i] = {
            stdout: '',
            stderr: `unexpected: ${err && err.message ? err.message : 'unknown'}`,
            exitCode: null, status: 'failed', source: 'none', elapsedMs: 0,
          };
          settledCount++;
          check();
          launchNext();
        });
    }
    for (let w = 0; w < Math.min(concurrency, total); w++) launchNext();
  });
}

function countItems(p) {
  if (Array.isArray(p.items)) return p.items.length;
  if (Array.isArray(p.consensus)) return p.consensus.length + (p.contested || []).length;
  return 0;
}

// ---------------------------------------------------------------------------
// phase-e-auto helpers (v1.4.4 N10)
// ---------------------------------------------------------------------------

// Resolve the next CROSS-AUDIT-r<N>.md path under .planning/<phase>/.
// Scans for existing r<N> files and increments the highest N found.
function resolveAuditOutputPath(projectDir, phase) {
  const planningDir = join(projectDir, '.planning', phase);
  let maxN = 0;
  if (existsSync(planningDir)) {
    try {
      const files = readdirSync(planningDir);
      for (const f of files) {
        const m = f.match(/^CROSS-AUDIT-r(\d+)\.md$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxN) maxN = n;
        }
      }
    } catch { /* non-fatal */ }
  }
  return join(planningDir, `CROSS-AUDIT-r${maxN + 1}.md`);
}

// Classify a merged audit result into PASS / CONDITIONAL / FAIL.
// HIGH severity finding → FAIL; any finding → CONDITIONAL; none → PASS.
function classifyVerdict(items) {
  if (!Array.isArray(items) || items.length === 0) return 'PASS';
  const hasHigh = items.some(item => {
    const sev = (item.severity || item.level || '').toString().toUpperCase();
    return sev === 'HIGH' || sev === 'CRITICAL';
  });
  return hasHigh ? 'FAIL' : 'CONDITIONAL';
}

// Pick the auditor roster for phase-e-auto from swarm.json (or defaults).
// Filters to entries that are reachable (CLI or API); missing CLI AND no
// apiFallback → skipped with a NOTE entry in the return value.
function resolvePhaseEAuditors(swarmConfig, env) {
  const requestedIds = (Array.isArray(swarmConfig.auditors) && swarmConfig.auditors.length > 0)
    ? swarmConfig.auditors
    : [...DEFAULT_AUDITORS];

  const picks = [];
  const skipped = [];

  for (const id of requestedIds) {
    const entry = ROSTER.find(e => e.id === id);
    if (!entry) {
      skipped.push({ id, reason: 'not in roster' });
      continue;
    }
    const reach = isReachable(id, env);
    if (!reach.any) {
      // CLI missing AND no apiFallback (or key not set) → skip with NOTE
      skipped.push({ id, reason: 'CLI missing and no apiFallback configured' });
      continue;
    }
    // Annotate API-only picks
    const pick = (!reach.cli && reach.api) ? { ...entry, preferredSource: 'api' } : { ...entry };
    picks.push(pick);
  }

  return { picks, skipped };
}

// Run the phase-e-auto branch.  Does NOT use process.exit / uxGate / budget
// guard — it is a programmatic call from the orchestrator, not a CLI call.
async function runPhaseEAuto({ projectDir, phase, target, env, quiet }) {
  const swarmConfig = loadSwarmConfig(projectDir);
  const { picks, skipped } = resolvePhaseEAuditors(swarmConfig, env);

  const notes = skipped.map(s => `NOTE: skipped auditor '${s.id}' — ${s.reason}`);

  if (!quiet && notes.length > 0) {
    process.stderr.write(notes.join('\n') + '\n');
  }

  if (picks.length === 0) {
    const outputPath = resolveAuditOutputPath(projectDir, phase);
    const content = `# Cross-Audit Phase E\n\nNo auditors available.\n\n${notes.map(n => `- ${n}`).join('\n')}\n`;
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, content, 'utf8');
    return { verdict: 'CONDITIONAL', findings: [], outputPath, notes };
  }

  const auditTarget = target || 'HEAD~1..HEAD';
  const resolvedTimeoutSec = null;

  const requests = picks.map(pick => ({
    pick,
    payload: buildRequest('audit', auditTarget, pick.id, 'general', null),
  }));

  const tasks = requests.map(({ pick, payload }) => () =>
    fireExternal(pick, payload, timeoutForPick(pick, resolvedTimeoutSec), env)
  );
  const rawResults = await fanOut(tasks, 3);

  const auditorResults = rawResults.map((raw, i) => {
    const pick = picks[i];
    if (raw === null) {
      return { status: 'failed', counted: false, parsed: { items: [], prose: `[${pick.id}: spawn failed]` } };
    }
    const { stdout, exitCode, status: rawStatus } = raw;
    // v1.5.0 S7: non-productive results MUST NOT count toward synthesis verdict.
    // A hung CLI returning zero items would silently produce a PASS under the
    // old logic (classifyVerdict([]) === 'PASS'). counted:false isolates them.
    if (rawStatus === 'timeout') return { status: 'timeout', counted: false, parsed: { items: [], prose: `[${pick.id}: timeout]` } };
    if (rawStatus === 'failed') return { status: 'failed', counted: false, parsed: { items: [], prose: `[${pick.id}: failed]` } };
    if (rawStatus === 'aborted') return { status: 'aborted', counted: false, parsed: { items: [], prose: `[${pick.id}: aborted]` } };
    if (rawStatus === 'fallback-used') {
      const p = parseResponse('audit', stdout);
      return { status: 'fallback-used', counted: true, parsed: p };
    }
    if (exitCode !== 0) return { status: 'failed', counted: false, parsed: { items: [], prose: `[${pick.id}: exited ${exitCode}]` } };
    const p = parseResponse('audit', stdout);
    return { status: 'ok', counted: true, parsed: p };
  });

  const productive = auditorResults.filter(r => r.counted);
  const parsed = productive.map(r => r.parsed);
  const merged = mergeResponses('audit', parsed);
  const items = Array.isArray(merged) ? merged : [];
  // v1.5.0 S7: when zero auditors return productive output, the verdict is
  // INCONCLUSIVE — refuses to grant PASS from a hung-CLI floor.
  const verdict = productive.length === 0 ? 'INCONCLUSIVE' : classifyVerdict(items);

  // Write synthesis to .planning/<phase>/CROSS-AUDIT-r<N>.md
  const outputPath = resolveAuditOutputPath(projectDir, phase);
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const auditorSummary = picks.map((p, i) => `- ${p.id}: ${auditorResults[i].status}`).join('\n');
  const findingsSection = items.length > 0
    ? items.map(item => `- [${(item.severity || item.level || 'INFO').toUpperCase()}] ${item.text || item.description || JSON.stringify(item)}`).join('\n')
    : '_(none)_';
  const content = [
    `# Cross-Audit Phase E — ${phase}`,
    '',
    `**Verdict:** ${verdict}`,
    `**Auditors:** ${picks.map(p => p.id).join(', ')}`,
    '',
    '## Auditor Status',
    auditorSummary,
    '',
    '## Findings',
    findingsSection,
    '',
    ...(notes.length > 0 ? ['## Notes', ...notes, ''] : []),
  ].join('\n');

  writeFileSync(outputPath, content, 'utf8');

  return { verdict, findings: items, outputPath, notes };
}

export async function runCrossOp({
  mode,
  target,
  projectDir,
  env,
  runStamp,
  expand: _expand,     // reserved -- passed through but unused in current CLI context
  only,
  confirm,             // reserved -- handled by caller (CLI layer)
  perAuditorTimeoutSec,
  minResponses,
  quiet = false,        // suppress uxGate stderr warnings (used by demo)
  gate = null,          // GA-H2: release-blocker gate name (publish/tag/deploy/release)
  accept_degraded = false, // GA-H2: explicit override for single-lens release-blocker audits
} = {}) {
  projectDir = projectDir ?? process.cwd();
  runStamp   = runStamp   ?? new Date().toISOString();
  env        = env        ?? process.env;

  // v1.4.4 N10: phase-e-auto branch — programmatic orchestrator call.
  // Reads .ijfw/swarm.json for auditor roster; graceful CLI-missing skip;
  // writes .planning/<phase>/CROSS-AUDIT-r<N>.md; returns {verdict, findings, outputPath}.
  if (mode === 'phase-e-auto') {
    const phase = target || 'current';
    return runPhaseEAuto({ projectDir, phase, target, env, quiet });
  }

  const start = Date.now();

  // Shared abort controller for this run -- used by minResponsesFanOut to kill stragglers.
  const runAc = new AbortController();

  const rawTimeoutSec = env.IJFW_AUDIT_TIMEOUT_SEC;
  const envTimeoutSec = parsePosInt(rawTimeoutSec, null, 1, 3600);
  if (rawTimeoutSec !== undefined && rawTimeoutSec !== null && envTimeoutSec === null && !quiet) {
    process.stderr.write(`IJFW_AUDIT_TIMEOUT_SEC=${rawTimeoutSec} is invalid; using default ${DEFAULT_TIMEOUT_MS / 1000}s.\n`);
  }
  const resolvedTimeoutSec = perAuditorTimeoutSec ?? envTimeoutSec ?? null;

  // 1. Roster pick (isInstalled cached in audit-roster per U6)
  const { picks, missing, note } = pickAuditors({ strategy: 'diversity', env, only });

  // 2. Short-circuit when no auditors are available
  if (picks.length === 0) {
    process.stderr.write('No external auditors ready -- install codex or gemini for full Trident.\n');
    return { merged: null, picks: [], missing, note };
  }

  // 2b. Budget guard -- post-flight accumulation check (2nd+ calls in session)
  const sessionStart = new Date(Date.now() - process.uptime() * 1000);
  const priorReceipts = readReceipts(projectDir);
  const budgetMsg = checkBudget({ target, picks, receipts: priorReceipts, sessionStart, env });
  if (budgetMsg) {
    process.stderr.write(budgetMsg + '\n');
    process.exit(2);
  }

  // 3. UX gate -- emit status line or prompt before firing
  const proceed = await uxGate(picks, missing, confirm, quiet);
  if (!proceed) process.exit(0);

  // 4. Swarm config (specialist list; swarm dispatch skipped in CLI context)
  const swarmConfig = loadSwarmConfig(projectDir);

  // 5. Build request payloads for each external pick
  const requests = picks.map(pick => ({
    pick,
    payload: buildRequest(mode, target, pick.id, angleFor(mode, pick.id), null),
  }));

  // 6. Fan-out with concurrency cap + optional minResponses short-circuit
  const rawConcurrency = env.IJFW_AUDIT_CONCURRENCY;
  const concurrencyParsed = rawConcurrency != null ? parsePosInt(rawConcurrency, null, 1, 16) : 3;
  const concurrency = concurrencyParsed ?? 3;
  if (rawConcurrency != null && concurrencyParsed === null && !quiet) {
    process.stderr.write(`IJFW_AUDIT_CONCURRENCY=${rawConcurrency} is invalid; using default 3.\n`);
  }

  let rawResults;
  if (minResponses && minResponses < picks.length) {
    rawResults = await minResponsesFanOut(requests, picks, resolvedTimeoutSec, env, concurrency, minResponses, runAc);
  } else {
    const tasks = requests.map(({ pick, payload }) => () =>
      fireExternal(pick, payload, timeoutForPick(pick, resolvedTimeoutSec), env)
    );
    rawResults = await fanOut(tasks, concurrency);
  }

  // 7. Parse each response; classify failures vs empty vs success
  const auditorResults = rawResults.map((raw, i) => {
    const pick = picks[i];

    if (raw === null) {
      return { status: 'failed', source: 'none', stderr: 'spawn error', exitCode: null, elapsedMs: 0, parsed: { items: [], prose: `[${pick.id}: spawn failed]` } };
    }

    const { stdout, stderr: rawStderr, exitCode, status: rawStatus, source, elapsedMs } = raw;
    const stderrSnip = rawStderr ? rawStderr.slice(0, 500) : '';

    if (rawStatus === 'aborted') {
      return { status: 'aborted', source: 'none', stderr: stderrSnip, exitCode: null, elapsedMs, parsed: { items: [], prose: `[${pick.id}: aborted]` } };
    }
    if (rawStatus === 'timeout') {
      return { status: 'timeout', source: 'none', stderr: stderrSnip, exitCode: null, elapsedMs, parsed: { items: [], prose: `[${pick.id}: timeout]` } };
    }
    if (rawStatus === 'failed') {
      return { status: 'failed', source: 'none', stderr: stderrSnip, exitCode, elapsedMs, parsed: { items: [], prose: `[${pick.id}: failed]` } };
    }
    if (rawStatus === 'fallback-used') {
      const p = parseResponse(mode, stdout);
      const itemCount = countItems(p);
      return { status: itemCount === 0 ? 'empty' : 'fallback-used', source: 'api', stderr: stderrSnip, exitCode: 0, elapsedMs, parsed: p };
    }

    // CLI path (rawStatus === null → normal exit from spawnCli)
    if (exitCode !== 0 || (stderrSnip && !stdout.trim())) {
      return { status: 'failed', source: source ?? 'none', stderr: stderrSnip, exitCode, elapsedMs, parsed: { items: [], prose: `[${pick.id}: exited ${exitCode}]` } };
    }
    const p = parseResponse(mode, stdout);
    const itemCount = countItems(p);
    return { status: itemCount === 0 ? 'empty' : 'ok', source: source ?? 'cli', stderr: stderrSnip, exitCode, elapsedMs, parsed: p };
  });

  // 7b. GA-H2: C9.7 degraded-mode enforcement on the production path.
  //   - Counts productive lens results (status 'ok' or 'fallback-used')
  //     plus the in-process Claude-swarm leg (always live in-process).
  //   - When the release-blocker gate is active and the productive lens
  //     count drops to <=1, throw DegradedTridentError unless caller passed
  //     accept_degraded=true. Mirrors src/trident/dispatch.js semantics so
  //     the same invariant fires in tests AND in production.
  //   - When non-release-blocker, we let the audit complete; the verdict
  //     floor coercion below ensures a single-lens result never silently
  //     surfaces as PASS.
  const productiveCount = auditorResults.filter(r => r.status === 'ok' || r.status === 'fallback-used').length
    + 1; // claude-swarm leg always live in-process
  const totalLenses = picks.length + 1;
  const isReleaseBlocker = gate && RELEASE_BLOCKER_GATES.has(String(gate).toLowerCase());
  const isDegraded = productiveCount <= 1;
  const tridentMode = productiveCount >= 3
    ? 'full'
    : productiveCount === 2
      ? 'partial'
      : (accept_degraded ? 'single-lens-accepted' : 'single-lens-degraded');

  if (isReleaseBlocker && isDegraded && !accept_degraded) {
    throw new DegradedTridentError(
      `Trident is degraded (${productiveCount}/${totalLenses} productive lenses; ` +
      `auditor statuses: ${auditorResults.map(r => `${picks[auditorResults.indexOf(r)] && picks[auditorResults.indexOf(r)].id}=${r.status}`).join(', ')}). ` +
      `Release-blocker gate "${gate}" rejects single-lens verdicts. Pass accept_degraded:true to override after human review.`,
      { lensHealth: { productiveCount, totalLenses, auditorResults }, gate, requested_accept_degraded: accept_degraded }
    );
  }

  // 8. All-timeout guard
  if (auditorResults.length > 0 && auditorResults.every(r => r.status === 'timeout')) {
    const currentVal = resolvedTimeoutSec ?? env.IJFW_AUDIT_TIMEOUT_SEC ?? 'default';
    process.stderr.write(
      `All auditors timed out -- check network or raise IJFW_AUDIT_TIMEOUT_SEC (currently ${currentVal})\n`
    );
    return {
      merged: null, picks, missing, note, auditorResults,
      allTimedOut: true, duration_ms: Date.now() - start,
    };
  }

  const parsed = auditorResults.map(r => r.parsed);

  // 9. Merge
  const merged = mergeResponses(mode, parsed);

  const duration_ms = Date.now() - start;

  // 10. Extract findings shape for receipt
  let findings;
  if (mode === 'audit' || mode === 'critique') {
    findings = { items: Array.isArray(merged) ? merged : [] };
  } else {
    findings = merged;
  }

  // 11. Write receipt
  const receipt = {
    v: 1,
    timestamp: new Date().toISOString(),
    run_stamp: runStamp,
    mode,
    target,
    auditors: picks.map((p, i) => ({
      id: p.id,
      family: p.family,
      model: p.model || '',
      status: auditorResults[i].status,
      source: auditorResults[i].source,
      elapsedMs: auditorResults[i].elapsedMs,
      ...(['failed', 'timeout'].includes(auditorResults[i].status)
        ? { error: auditorResults[i].stderr, exitCode: auditorResults[i].exitCode }
        : {}),
    })),
    findings,
    duration_ms,
    input_tokens: null,
    cost_usd: null,
    model: null,
    specialist_swarm: 'skipped (CLI context)',
    swarm_project_type: swarmConfig.project_type,
    // GA-H2: C9.7 lens-health metadata embedded in every receipt so post-
    // hoc audits can reconstruct the degraded-mode posture without re-
    // probing. trident_mode mirrors src/trident/dispatch.js values.
    trident_mode: tridentMode,
    productive_lens_count: productiveCount,
    total_lens_count: totalLenses,
    gate: gate || null,
    accept_degraded: !!accept_degraded,
  };

  writeReceipt(projectDir, receipt);

  return {
    merged,
    receipt,
    picks,
    missing,
    note,
    auditorResults,
    trident_mode: tridentMode,
    productive_lens_count: productiveCount,
    total_lens_count: totalLenses,
    gate: gate || null,
    accept_degraded: !!accept_degraded,
  };
}

// ---------------------------------------------------------------------------
// v1.5.0 W12-C N01+N03 — runPhaseEConverge
// ---------------------------------------------------------------------------
//
// Multi-lens consensus convergence (lock-in #47 — canonical Phase E).
// Single-shot Phase E is the FALLBACK. Default behavior is a convergence
// loop with divergence detection.
//
// Per-iteration flow:
//   1. Dispatch all lenses in parallel.
//   2. Collect verdicts (PASS / CONDITIONAL / FAIL) + finding lists.
//   3. If all PASS → done.
//   4. If verdicts diverge, build a CYCLE_SUMMARY (prior verdicts +
//      areas of disagreement) and re-dispatch with it injected.
//   5. Cap at `maxIterations` (default 3). If still divergent at the cap,
//      emit `consensus_failed` and surface divergence.
//   6. Stall breaker: if iter N produces byte-identical findings to
//      iter N-1, halt with `stalled: true` rather than burn tokens.
//
// Dispatcher contract (for test/DI):
//   dispatch({ lens, commitRange, iteration, cycleSummary }) →
//     { lens, verdict: 'PASS'|'CONDITIONAL'|'FAIL'|'UNREACHABLE',
//       findings: Array<{severity?, text?, ...}> }
//
// Tests inject a synthetic dispatcher; production passes a real one
// that wraps `fireExternal` / `parseResponse` / `classifyVerdict` (or
// reuses runCrossOp for each iteration).
// ---------------------------------------------------------------------------

const VERDICT_PASS          = 'PASS';
const VERDICT_CONDITIONAL   = 'CONDITIONAL';
const VERDICT_FAIL          = 'FAIL';
const VERDICT_UNREACHABLE   = 'UNREACHABLE';
const VERDICT_CONSENSUS_FAIL = 'consensus_failed';
const DEFAULT_LENSES        = ['codex', 'gemini', 'claude'];

// Stable serialization for stall comparison.
function stableFindingsKey(perLensFindings) {
  // perLensFindings: { lens → Array<finding> }
  // Use lens-sorted keys, and within each lens stringify findings (sorted by
  // a stable text representation) so semantically-identical iterations match.
  const lenses = Object.keys(perLensFindings).sort();
  const parts = [];
  for (const lens of lenses) {
    const findings = Array.isArray(perLensFindings[lens]) ? perLensFindings[lens] : [];
    const serialized = findings
      .map(f => JSON.stringify(f, Object.keys(f || {}).sort()))
      .sort();
    parts.push(`${lens}:[${serialized.join(',')}]`);
  }
  return parts.join('|');
}

// Detect whether lens verdicts diverge.
// All-PASS (with no UNREACHABLE) → false. Anything else with mixed verdicts → true.
// All-FAIL across reachable lenses → still divergent only if findings differ;
// pure consensus FAIL is not divergence (everyone agrees the change is bad).
function detectDivergence(lensResults) {
  const reachable = lensResults.filter(r => r.verdict !== VERDICT_UNREACHABLE);
  if (reachable.length === 0) return { divergent: false, axes: [] };
  const verdicts = new Set(reachable.map(r => r.verdict));
  if (verdicts.size === 1) {
    // All reachable lenses agree on the verdict. Findings can still differ
    // (one lens may report extra MEDIUM findings), but verdict consensus is
    // sufficient — convergence is verdict-level, not finding-level.
    return { divergent: false, axes: [] };
  }
  // Verdicts diverge: compute axes (which lens differs from the majority).
  const counts = {};
  for (const r of reachable) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  let majority = reachable[0].verdict;
  let max = 0;
  for (const v of Object.keys(counts)) {
    if (counts[v] > max) { max = counts[v]; majority = v; }
  }
  const axes = reachable
    .filter(r => r.verdict !== majority)
    .map(r => ({ lens: r.lens, verdict: r.verdict, majority }));
  return { divergent: true, axes };
}

// Build a CYCLE_SUMMARY string injected into the next iteration's lens brief.
function buildCycleSummary(iteration, prior) {
  const lines = [
    `# CYCLE_SUMMARY (iteration ${iteration})`,
    '',
    'Previous round verdicts:',
  ];
  for (const r of prior.lensResults) {
    lines.push(`- ${r.lens}: ${r.verdict} (${(r.findings || []).length} findings)`);
  }
  if (prior.divergence && prior.divergence.axes && prior.divergence.axes.length > 0) {
    lines.push('');
    lines.push('Areas of disagreement (lens vs majority):');
    for (const a of prior.divergence.axes) {
      lines.push(`- ${a.lens} said ${a.verdict}; majority said ${a.majority}`);
    }
  }
  lines.push('');
  lines.push('Re-evaluate. If your prior verdict was correct, restate it with explicit reasoning. If the other lenses changed your mind, update accordingly.');
  return lines.join('\n');
}

// Public convergence entrypoint.
// Inputs:
//   commitRange    string (e.g. 'HEAD~1..HEAD')
//   lenses         array of lens ids (default ['codex','gemini','claude'])
//   maxIterations  number (default 3; lock-in #43/#44 style)
//   dispatch       async function (DI hook for tests/production)
//   projectRoot    string (passed through to dispatch)
// Returns:
//   { verdict, iterations, findings, divergence?, stalled?, perIteration }
export async function runPhaseEConverge({
  commitRange,
  lenses = DEFAULT_LENSES,
  maxIterations = 3,
  dispatch,
  projectRoot,
} = {}) {
  if (typeof dispatch !== 'function') {
    throw new Error('runPhaseEConverge: dispatch function is required');
  }
  if (!Array.isArray(lenses) || lenses.length === 0) {
    throw new Error('runPhaseEConverge: lenses must be a non-empty array');
  }
  const cap = Math.max(1, Math.floor(maxIterations));

  let cycleSummary = null;
  let prior = null;
  let priorFindingsKey = null;
  const perIteration = [];

  for (let iter = 1; iter <= cap; iter++) {
    // Fire all lenses in parallel.
    const settlements = await Promise.all(lenses.map(lens =>
      Promise.resolve()
        .then(() => dispatch({ lens, commitRange, iteration: iter, cycleSummary, projectRoot }))
        .catch(err => ({
          lens,
          verdict: VERDICT_UNREACHABLE,
          findings: [],
          error: err && err.message ? err.message : String(err),
        }))
    ));

    const lensResults = settlements.map((r, i) => ({
      lens: r && r.lens ? r.lens : lenses[i],
      verdict: r && r.verdict ? r.verdict : VERDICT_UNREACHABLE,
      findings: r && Array.isArray(r.findings) ? r.findings : [],
      ...(r && r.error ? { error: r.error } : {}),
    }));

    // Build per-lens findings map for stall detection.
    const perLensFindings = {};
    for (const r of lensResults) perLensFindings[r.lens] = r.findings;
    const findingsKey = stableFindingsKey(perLensFindings);

    const reachable = lensResults.filter(r => r.verdict !== VERDICT_UNREACHABLE);
    const divergence = detectDivergence(lensResults);

    perIteration.push({
      iteration: iter,
      lensResults,
      divergent: divergence.divergent,
    });

    const mergedFindings = lensResults.flatMap(r => r.findings.map(f => ({ ...f, _lens: r.lens })));

    // Stop conditions, in priority order.

    // 1. maxIterations === 1 — cap the loop after first iter no matter what.
    if (cap === 1) {
      const verdict = reachable.length === 0
        ? VERDICT_UNREACHABLE
        : (divergence.divergent ? VERDICT_CONSENSUS_FAIL : reachable[0].verdict);
      return {
        verdict,
        iterations: 1,
        findings: mergedFindings,
        ...(divergence.divergent ? { divergence: divergence.axes } : {}),
        perIteration,
      };
    }

    // 2. All reachable lenses PASS → done.
    if (reachable.length > 0 && !divergence.divergent && reachable[0].verdict === VERDICT_PASS) {
      return {
        verdict: VERDICT_PASS,
        iterations: iter,
        findings: mergedFindings,
        perIteration,
      };
    }

    // 3. Consensus on non-PASS (e.g. all FAIL) — short-circuit, no point looping.
    if (reachable.length > 0 && !divergence.divergent) {
      return {
        verdict: reachable[0].verdict,
        iterations: iter,
        findings: mergedFindings,
        perIteration,
      };
    }

    // 4. Stall breaker: byte-identical findings to prior iter → halt.
    if (priorFindingsKey !== null && findingsKey === priorFindingsKey) {
      return {
        verdict: VERDICT_CONSENSUS_FAIL,
        iterations: iter,
        findings: mergedFindings,
        divergence: divergence.axes,
        stalled: true,
        perIteration,
      };
    }

    // 5. Cap hit while still divergent → consensus_failed.
    if (iter === cap) {
      return {
        verdict: VERDICT_CONSENSUS_FAIL,
        iterations: iter,
        findings: mergedFindings,
        divergence: divergence.axes,
        perIteration,
      };
    }

    // Otherwise: stage next iteration with cycle summary.
    prior = { lensResults, divergence };
    cycleSummary = buildCycleSummary(iter + 1, prior);
    priorFindingsKey = findingsKey;
  }

  // Unreachable; loop must exit via one of the return paths above.
  /* c8 ignore next */
  return { verdict: VERDICT_CONSENSUS_FAIL, iterations: cap, findings: [], perIteration };
}
