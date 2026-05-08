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
import { pickAuditors, isReachable } from './audit-roster.js';
import { loadSwarmConfig } from './swarm-config.js';
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
        proc.stdin.end();
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
