// cross-orchestrator-cli.js -- thin CLI for `ijfw cross <mode> <target>`.
//
// Commands:
//   ijfw cross <mode> <target> [--confirm] [--with <id>] [--expand]
//   ijfw status
//   ijfw --help
//
// Zero external deps. Parse argv manually.

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, readdirSync, rmSync, realpathSync, copyFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './lib/atomic-io.js';
import { runCrossOp } from './cross-orchestrator.js';
import { chunkText, mergeFindings, CHUNKER_DEFAULTS } from './cross-audit-chunker.js';
import { readReceipts, purgeReceipts } from './receipts.js';
import { renderHeroLine } from './hero-line.js';
import { ROSTER, isInstalled, isReachable } from './audit-roster.js';
import { aggregatePortfolioFindings } from './cross-project-search.js';
import { runImport, runImportAll, listImporters } from './importers/cli.js';
import { validateToken } from './lib/token.js';
import { isVersionStringValid } from './lib/npm-view.js';
import { verifyShasumCrossSource } from './lib/shasum-verify.js';
import {
  addBlackboardNote,
  blackboardStatus,
  claimArtifact,
  DEFAULT_CLAIM_TTL_MS,
  evictOrphanedClaims,
  initBlackboard,
  readBlackboard,
  releaseClaim,
  updateClaimHeartbeat,
  writeHandoff,
} from './blackboard.js';
import { createTeamAssembly, readTeamAssembly } from './team/generator.js';
import {
  addTeamRole,
  checkTeamAssembly,
  listTeamRoles,
  removeTeamRole,
  swapTeamRole,
} from './team/modify.js';
import {
  blockSwarmTask,
  buildSwarmPlan,
  completeSwarmTask,
  listSwarmTasks,
  prepareSwarmTasks,
  readySwarmTask,
  startSwarmTask,
  swarmPlanSummary,
} from './swarm/planner.js';
import { createCheckpoint, latestCheckpoint, recoveryStatus } from './recovery/checkpoint.js';
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  integrateTaskWorktree,
  listTaskWorktrees,
} from './swarm/worktree.js';
import { renderSwarmDispatchPrompt } from './swarm/dispatch-prompt.js';
import { syncCodexAgents } from './codex-agents.js';
// v1.5.1 W2.H — memory benchmark harness (T22). Surfaced via `ijfw metrics --benchmark`.
import { runBenchmark } from './memory/benchmark.js';
import {
  DESIGN_ACTIONS,
  auditDesignText,
  designActionGuide,
  initialDesignMarkdown,
  loadDesignContext,
} from './design-intelligence.js';
// v1.5.1 W3.A.4 — registry-driven usage + alias help.
// SINGLE SOURCE OF TRUTH lives at installer/src/command-registry.js;
// import sibling-package style, matching extension-installer.js precedent.
import {
  COMMAND_REGISTRY,
} from '../../installer/src/command-registry.js';

// ---------------------------------------------------------------------------
// Auditor error translator (1.2.5)
// ---------------------------------------------------------------------------
// Pattern-match common auditor failure signatures and turn the raw stderr
// into one actionable sentence. Returns a short string the degraded-auditor
// surface in cmdCross renders directly.
//
// Order matters: more specific patterns come first so a generic "401" or
// "timeout" doesn't shadow a tool-specific re-auth instruction.
export function translateAuditorError(id, status, stderr, exitCode) {
  const s = String(stderr || '');
  const lower = s.toLowerCase();

  // Tool-specific re-auth signatures (highest specificity)
  if (id === 'codex' && (
        /failed to refre/i.test(s) ||
        /codex_models_manager/i.test(s) ||
        /token.*(expired|invalid)/i.test(s)
      )) {
    return 'Codex auth token expired or stale. Run `codex login` to refresh, then re-run.';
  }
  if (id === 'qwen' && /no auth type is selected/i.test(s)) {
    return 'No auth configured. Run `qwen auth` and pick a provider, then re-run.';
  }
  if (id === 'gemini' && (/safety/i.test(s) || /blocked/i.test(s) || /BLOCKED_BY_SAFETY/i.test(s))) {
    return 'Safety filter blocked output -- may be a false negative on this target. Try a different file or pass --with to swap auditor.';
  }
  if (id === 'claude' && /credit balance.*too low/i.test(lower)) {
    return 'Anthropic credits low. Top up at console.anthropic.com or use the CLI path instead of API.';
  }

  // Status-driven generic patterns
  if (status === 'timeout' || /(operation was )?aborted due to timeout/i.test(s) || /etimedout/i.test(lower)) {
    return 'API timed out. Check network, retry, or pass --with to drop this auditor on the next run.';
  }

  // Generic auth signatures
  if (/\b(401|403)\b/.test(s) || /unauthorized/i.test(s) || /forbidden/i.test(s)) {
    return `Authentication rejected (HTTP 401/403). Re-check the API key for ${id}, then re-run.`;
  }
  if (/(api[_ ]?key|auth(env)?)\s+not\s+set/i.test(s)) {
    return `API key not set. Export the auth env var for ${id} in your shell, then re-run.`;
  }
  if (/\b429\b/.test(s) || /rate[ -]?limit/i.test(lower) || /quota/i.test(lower)) {
    return 'Rate-limited or quota exhausted. Wait a minute or top up your provider, then re-run.';
  }
  if (/enotfound|econnrefused|getaddrinfo/i.test(s)) {
    return 'Network unreachable. Check connectivity, then re-run.';
  }

  // Empty + stderr usually means model emitted prose without the JSON fence.
  if (status === 'empty') {
    return 'Returned no parseable findings (model may have emitted prose without the JSON fence). Re-run or pass --with to swap auditor.';
  }

  // Spawn / exec issues
  if (/spawn .* enoent/i.test(lower) || /command not found/i.test(lower)) {
    return `CLI binary not found on PATH. Install ${id} or set its API key to use the API fallback.`;
  }

  // Catch-all: short raw, but suffix the right action
  const head = s.split('\n')[0].slice(0, 80) || `exit ${exitCode}`;
  return `Failed (${head}). Run \`ijfw doctor\` to diagnose, or pass --with to drop this auditor.`;
}

// ---------------------------------------------------------------------------
// Findings printer
// ---------------------------------------------------------------------------
function printFindings(mode, merged) {
  if (mode === 'audit') {
    const items = Array.isArray(merged) ? merged : [];
    if (items.length === 0) {
      console.log('  Auditors returned no findings -- your target looks solid.');
      console.log('  Run `ijfw cross audit <another-file>` to audit a different target.');
      return;
    }
    console.log('');
    items.forEach((item, i) => {
      const sev = item.severity ? ` [${item.severity}]` : '';
      const loc = item.location ? ` | ${item.location}` : '';
      const issue = String(item.issue || '');
      console.log(`  Step 1.${i + 1} --${sev}${loc} -- ${issue}`);
    });
    return;
  }

  if (mode === 'research') {
    const { consensus = [], contested = [], synthesisPending } = merged || {};
    console.log('');
    console.log(`  Consensus: ${consensus.length}  |  Contested: ${contested.length}`);
    if (synthesisPending) console.log('  Note: synthesis pass pending -- lexical match only.');
    consensus.slice(0, 5).forEach((item, i) => {
      console.log(`  Step 1.${i + 1} -- [consensus] ${String(item.claim || '')}`);
    });
    contested.slice(0, 3).forEach((item, i) => {
      console.log(`  Step 2.${i + 1} -- [contested] ${String(item.claim || '')}`);
    });
    return;
  }

  if (mode === 'critique') {
    const items = Array.isArray(merged) ? merged : [];
    if (items.length === 0) {
      console.log('  No counter-arguments surfaced -- argument appears well-supported.');
      console.log('  Run `ijfw cross critique <another-target>` to challenge a different position.');
      return;
    }
    console.log('');
    items.forEach((item, i) => {
      const sev = item.severity ? ` [${item.severity}]` : '';
      const arg = String(item.counterArg || '');
      console.log(`  Step 1.${i + 1} --${sev} ${arg}`);
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------
// True when the caller wants machine-readable output: explicit --json flag,
// or stdout is not a TTY (gh-CLI convention -- piped/redirected output is
// presumed to be consumed by another process, including sub-agents shelling
// out via bash).
function wantsJson(opts) {
  return Boolean(opts && opts.json) || !process.stdout.isTTY;
}

function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function parseArgs(argv) {
  const args = argv.slice(2); // strip node + script path

  // Global --json flag: any command can be forced to JSON output regardless
  // of TTY. Strip it before per-command parsing so it doesn't confuse
  // positional argument handling.
  let json = false;
  const rest = [];
  for (const a of args) {
    if (a === '--json') json = true;
    else rest.push(a);
  }
  const out = parseArgsInner(rest);
  if (out && typeof out === 'object') out.json = json;
  return out;
}

// v1.5.1 W3.A.4 — COMMAND_ALIAS_HELP is now derived from the command-registry
// (entries where tier === 'pointer-stub'). Each entry's deprecatedReason
// becomes the usage line; title is auto-derived from the canonical name.
// To change the help text or add a new pointer-stub: edit
// installer/src/command-registry.js.
const COMMAND_ALIAS_HELP = Object.freeze(Object.fromEntries(
  COMMAND_REGISTRY
    .filter(e => e.tier === 'pointer-stub')
    .map(e => [e.name, {
      title: `IJFW ${e.name}`,
      usage: e.deprecatedReason,
    }])
));

function parseCrossAlias(mode, args) {
  let only = null;
  let confirm = false;
  let expand = false;
  let chunk = false;
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--confirm') confirm = true;
    else if (arg === '--expand') expand = true;
    else if (arg === '--chunk') chunk = true; // v1.5.1 H1.6 — wire chunker
    else if (arg === '--with' && args[i + 1]) only = args[++i];
    else if (arg.startsWith('--with=')) only = arg.slice('--with='.length);
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  const target = mode === 'research' ? positional.join(' ').trim() : positional[0];
  return { cmd: 'cross', mode, target: target || undefined, only, confirm, expand, chunk };
}

function parseCommandAlias(args) {
  const name = args[0];
  if (name === 'cross-audit') {
    return parseCrossAlias('audit', args);
  }
  if (name === 'cross-critique') {
    return parseCrossAlias('critique', args);
  }
  if (name === 'cross-research') {
    return parseCrossAlias('research', args);
  }
  if (Object.prototype.hasOwnProperty.call(COMMAND_ALIAS_HELP, name)) {
    // v1.5.1 W2.H — `ijfw metrics` is a deprecated pointer-stub, but
    // `ijfw metrics --benchmark` surfaces the memory benchmark harness (T22).
    // Bare `ijfw metrics` still falls through to the deprecation redirect.
    if (name === 'metrics' && args.includes('--benchmark')) {
      const opts = { cmd: 'metrics-benchmark', json: args.includes('--json'), write: true };
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--no-write') opts.write = false;
      }
      return opts;
    }
    return { cmd: 'command-alias', alias: name };
  }
  return null;
}

function parseArgsInner(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { cmd: 'help' };
  }

  const alias = parseCommandAlias(args);
  if (alias) return alias;

  if (args[0] === '--version' || args[0] === '-v') {
    return { cmd: 'version', verbose: args.includes('--verbose') };
  }

  if (args[0] === 'version') {
    return { cmd: 'version', verbose: args.includes('--verbose') };
  }

  if (args[0] === 'help') {
    return { cmd: 'guide', browser: args.includes('--browser') };
  }

  if (args[0] === 'status') {
    return { cmd: 'status' };
  }

  if (args[0] === 'demo') {
    return { cmd: 'demo' };
  }

  if (args[0] === 'doctor') {
    return { cmd: 'doctor' };
  }

  if (args[0] === 'update') {
    const opts = { cmd: 'update' };
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--check') opts.check = true;
      else if (a === '--yes' || a === '-y') opts.yes = true;
      else if (a === '--verify') opts.verify = true;
      else if (a === '--changelog') opts.changelog = true;
      else if (a === '--confirm' && args[i + 1]) { opts.confirm = args[++i]; }
      else if (a === '--auto' && args[i + 1]) { opts.auto = args[++i]; }
    }
    return opts;
  }

  if (args[0] === 'statusline') {
    const opts = { cmd: 'statusline' };
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--install') opts.sub = 'install';
      else if (a === '--compose') opts.sub = 'compose';
      else if (a === '--disable') opts.sub = 'disable';
      else if (a === '--status') opts.sub = 'status';
      else if (a === '--recompute') opts.sub = 'recompute';
    }
    if (!opts.sub) opts.sub = 'status';
    return opts;
  }

  if (args[0] === 'config') {
    const opts = { cmd: 'config' };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--audit') opts.sub = 'audit';
    }
    return opts;
  }

  if (args[0] === 'insight') {
    return { cmd: 'insight', sub: args[1] || 'start' };
  }

  if (args[0] === 'install') {
    return { cmd: 'install' };
  }

  if (args[0] === 'uninstall' || (args[0] === 'off' && args.length === 1)) {
    return { cmd: 'uninstall' };
  }

  if (args[0] === 'preflight') {
    return { cmd: 'preflight' };
  }

  if (args[0] === 'dashboard') {
    return { cmd: 'dashboard', sub: args[1] || 'status' };
  }

  if (args[0] === 'design') {
    return { cmd: 'design', sub: args[1] || 'status' };
  }

  // v1.5.0 wire-W1.D — `ijfw ui-review --spec <path> --scope <dirs>`
  if (args[0] === 'ui-review') {
    const opts = { cmd: 'ui-review', spec: null, scope: null, write: true, gcSketches: false, peerInputs: null };
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if ((a === '--spec' || a === '-s') && args[i + 1]) { opts.spec = args[++i]; }
      else if (a.startsWith('--spec=')) opts.spec = a.slice('--spec='.length);
      else if ((a === '--scope' || a === '-S') && args[i + 1]) { opts.scope = args[++i]; }
      else if (a.startsWith('--scope=')) opts.scope = a.slice('--scope='.length);
      else if (a === '--no-write') opts.write = false;
      else if (a === '--gc-sketches') opts.gcSketches = true;
      else if ((a === '--peer-inputs') && args[i + 1]) { opts.peerInputs = args[++i]; }
      else if (a.startsWith('--peer-inputs=')) opts.peerInputs = a.slice('--peer-inputs='.length);
    }
    return opts;
  }

  if (args[0] === 'blackboard') {
    return { cmd: 'blackboard', sub: args[1] || 'status' };
  }

  if (args[0] === 'team') {
    return { cmd: 'team', sub: args[1] || 'status' };
  }
  if (args[0] === 'override') {
    return { cmd: 'override', sub: args[1] || 'list', rest: args.slice(2) };
  }
  if (args[0] === 'extension') {
    return { cmd: 'extension', sub: args[1] || 'list', rest: args.slice(2) };
  }

  if (args[0] === 'env') {
    // v1.5.2 F6: `ijfw env` lists every IJFW_* env var with current value,
    // default, and one-line description. Closes the configuration-sprawl
    // discoverability gap surfaced in the v1.5.2 cross-audit.
    return { cmd: 'env' };
  }

  if (args[0] === 'swarm') {
    return { cmd: 'swarm', sub: args[1] || 'status' };
  }

  if (args[0] === 'codex') {
    return { cmd: 'codex', sub: args[1] || 'doctor' };
  }

  if (args[0] === 'memory') {
    // `ijfw memory` / `ijfw memory --help` / `ijfw memory -h` → namespace help
    if (args.length === 1 || args[1] === '--help' || args[1] === '-h') {
      return { cmd: 'memory-help' };
    }
    if (args[1] === 'checkpoint') {
      return { cmd: 'memory-checkpoint', label: args[2] || 'manual' };
    }
    if (args[1] === 'reindex') {
      // `ijfw memory reindex`        -> M1 backfill (free, obsidian indexing)
      // `ijfw memory reindex --m2`   -> also run M2 A-Mem auto-link backfill
      //                                 (budget-gated; needs IJFW_AUTOLINK_*)
      let m2 = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--m2' || args[i] === '--autolink') m2 = true;
      }
      return { cmd: 'memory-reindex', m2 };
    }
    return { cmd: 'memory-unknown', sub: args[1] };
  }

  if (args[0] === 'recover') {
    return { cmd: 'recover', sub: args[1] || 'status' };
  }

  // v1.6.0 CLI-honesty — top-level aliases so the documented bare verbs route
  // instead of returning "Unknown command". `checkpoint` forwards to
  // `memory checkpoint`; `worktree` forwards to `swarm worktree`. The canonical
  // namespaced forms still work; these are thin shortcuts (see command-registry).
  if (args[0] === 'checkpoint') {
    return { cmd: 'memory-checkpoint', label: args[1] || 'manual' };
  }
  if (args[0] === 'worktree') {
    return { cmd: 'worktree', sub: args[1] || 'list', rest: args.slice(2) };
  }

  // v1.6.0 Profile-bus learning control. Subcommands:
  //   on | off              -> set inject = on | off
  //   status | show         -> print flags + a summary of what was inferred
  //   forget [id|pattern]   -> delete inferences (right-to-be-forgotten)
  //   share-sensitive on|off-> toggle the med/high-sensitivity host allowlist
  if (args[0] === 'personalize') {
    return { cmd: 'personalize', sub: args[1] || 'status', rest: args.slice(2) };
  }

  if (args[0] === 'receipt') {
    return { cmd: 'receipt', sub: args[1] || 'last' };
  }

  if (args[0] === '--purge-receipts') {
    return { cmd: 'purge-receipts' };
  }

  if (args[0] === 'import') {
    const tool = args[1];
    let dryRun = false, force = false, includeMetrics = false, customPath = null, allMode = false, yes = false;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--dry-run') dryRun = true;
      else if (args[i] === '--force') force = true;
      else if (args[i] === '--all') allMode = true;
      else if (args[i] === '--yes' || args[i] === '-y') yes = true;
      else if (args[i] === '--include-metrics') includeMetrics = true;
      else if (args[i] === '--path' && args[i + 1]) customPath = args[++i];
    }
    return { cmd: 'import', tool, dryRun, force, includeMetrics, customPath, allMode, yes };
  }

  if (args[0] === 'cross') {
    const mode = args[1];

    if (mode === 'project-audit') {
      const rule = args[2];
      let dryRun = false;
      for (let i = 3; i < args.length; i++) {
        if (args[i] === '--dry-run') dryRun = true;
      }
      return { cmd: 'cross-project-audit', rule, dryRun };
    }

    const target = args[2];
    let only = null;
    let confirm = false;
    let expand = false;
    let chunk = false;

    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--confirm') { confirm = true; }
      else if (args[i] === '--expand') { expand = true; }
      else if (args[i] === '--chunk') { chunk = true; } // v1.5.1 H1.6 — wire chunker
      else if (args[i] === '--with' && args[i + 1]) { only = args[++i]; }
    }

    return { cmd: 'cross', mode, target, only, confirm, expand, chunk };
  }

  return { cmd: 'unknown', raw: args[0] };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// v1.5.2 F6: every IJFW_* env var the brain + memory subsystems read at runtime.
// Order: most-likely-to-set first. `default` is the documented fallback when
// the var is unset; `description` is one short line for `ijfw env` output.
const IJFW_ENV_VARS = [
  // Brain (v1.5.2)
  { name: 'IJFW_DREAM_BUDGET_USD',     default: '0.50',                                description: 'Per-cycle USD cap for dream-cycle LLM extraction.' },
  { name: 'IJFW_DREAM_BUDGET_DAY_USD', default: '5.00',                                description: 'Per-day USD cap; cycle stops when reached.' },
  { name: 'IJFW_BRAIN_LOCAL_URL',      default: '(unset)',                             description: 'Ollama-compatible local LLM endpoint to try first.' },
  { name: 'IJFW_BRAIN_EXTRACT_MODEL',  default: 'claude-haiku-4-5-20251001',           description: 'Cheap-tier model id for fact extraction.' },
  { name: 'IJFW_BRAIN_SYNTH_MODEL',    default: 'claude-sonnet-4-6',                   description: 'Mid-tier model id for reconciliation + page synthesis.' },
  { name: 'IJFW_BRAIN_API_KEY',        default: '(falls back to ANTHROPIC_API_KEY)',   description: 'API key for the synth-tier Anthropic call.' },
  { name: 'IJFW_BRAIN_INJECT',         default: 'never',                               description: '"auto"|"always" appends top-N wiki pages to handlePrelude.' },
  // Memory-moat (v1.5.0 — A-Mem auto-linker)
  { name: 'IJFW_AUTOLINK_OFF',         default: '(unset)',                             description: 'Set to disable the A-Mem auto-linker entirely.' },
  { name: 'IJFW_AUTOLINK_BUDGET_USD',  default: '(unbounded if unset)',                description: 'Per-write USD cap for auto-linker LLM calls.' },
  { name: 'IJFW_AUTOLINK_BACKFILL',    default: '(unset)',                             description: 'Set to "1" to opt into M2 backfill during `memory reindex --m2`.' },
];

export function cmdEnv() {
  const widthName = Math.max(...IJFW_ENV_VARS.map((v) => v.name.length)) + 2;
  console.log('IJFW environment variables\n');
  for (const v of IJFW_ENV_VARS) {
    const current = process.env[v.name];
    const shownValue = current !== undefined && current !== '' ? current : '(unset)';
    const isOverridden = current !== undefined && current !== '';
    const tag = isOverridden ? ' [SET]' : '';
    console.log(`  ${v.name.padEnd(widthName)} = ${shownValue}${tag}`);
    console.log(`  ${' '.repeat(widthName)}   default: ${v.default}`);
    console.log(`  ${' '.repeat(widthName)}   ${v.description}`);
    console.log('');
  }
  console.log('Tip: variables tagged [SET] override their defaults. Unset values show the documented default in effect.');
}

function printMemoryHelp() {
  console.log(`
ijfw memory -- project memory namespace

Usage:
  ijfw memory checkpoint <label>   Snapshot current swarm/memory state under <label>.
                                   <label> defaults to "manual" if omitted.
  ijfw memory reindex [--m2]       Backfill M1 obsidian indexing (wikilinks,
                                   #tags, [k:: v] metadata) over the whole
                                   memory db. Free + idempotent. Add --m2 to
                                   also run the A-Mem auto-link backfill --
                                   budget-gated (set IJFW_AUTOLINK_BUDGET_USD
                                   and IJFW_AUTOLINK_BACKFILL=1).

Related:
  ijfw recover [status|latest]     Inspect checkpoints and recovery state.
  ijfw env                         List every IJFW_* env var, current value, default, description.
  ijfw --help                      Top-level user-facing commands.
  ijfw commands                    Full command surface (all verbs).
`.trim());
}

// v1.6.0 CLI-honesty — "did you mean?" engine. Two suggestion sources:
//   (1) a curated map of documented-but-bare verbs to their real home
//       (subcommands of another verb, or "not available in this release"),
//   (2) nearest routed verb by Levenshtein edit-distance over the known set.
// The curated map wins; edit-distance is the fallback. The goal: NO advertised
// verb ever returns a bare "Unknown command" — every miss is guided.

// Curated redirects for verbs users find in old docs / muscle memory. `to` is a
// suggested command; `note` (optional) explains availability.
const VERB_REDIRECTS = Object.freeze({
  checkpoint:       { to: 'ijfw checkpoint <label>  (or: ijfw memory checkpoint <label>)' },
  worktree:         { to: 'ijfw worktree <create|list|integrate|cleanup>  (or: ijfw swarm worktree …)' },
  'worktree-drain': { to: 'ijfw swarm worktree cleanup <task-id>', note: 'there is no bulk "drain"; clean up worktrees per task.' },
  'wave-status':    { to: 'ijfw swarm status', note: 'swarm progress (waves, ready/blocked) is shown by `ijfw swarm status`.' },
  on:               { to: 'ijfw install   (to set up IJFW)   ·   ijfw personalize on   (to enable profile injection)', note: '`on` is not a verb. `off` removes IJFW; it has no symmetric reinstall toggle.' },
  marketplace:      { to: null, note: 'not available in this release. Install via `ijfw install` or your agent\'s native plugin marketplace UI.' },
  cluster:          { to: null, note: 'multi-machine cluster mode is a design milestone, not shipped in this release.' },
  consent:          { to: 'ijfw personalize status', note: 'memory/profile consent is managed via `ijfw personalize` and the memory-consent skill.' },
});

// Every name the orchestrator can actually dispatch (canonical + registry
// aliases + the bare top-level verbs the parser recognizes). Used as the
// edit-distance candidate pool.
function knownVerbNames() {
  const names = new Set();
  for (const e of COMMAND_REGISTRY) {
    if (e.status === 'deprecated') continue;
    names.add(e.name);
    for (const a of (e.aliases || [])) names.add(a);
  }
  // Bare verbs the parser handles that may not be registry entries.
  for (const v of ['status', 'help', 'env', 'recover', 'receipt', 'personalize',
                   'checkpoint', 'worktree', 'memory', 'swarm', 'team',
                   'blackboard', 'codex', 'insight', 'cross']) names.add(v);
  // Drop flag-style + alias-only noise that would never be a useful suggestion.
  names.delete('--purge-receipts');
  return [...names];
}

// Classic iterative Levenshtein. Bounded inputs (CLI verbs), O(n*m) is fine.
function editDistance(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Suggest the single nearest routed verb (prefix match preferred, then edit
// distance). Returns null when nothing is close enough to be helpful.
export function nearestVerb(raw, candidates = knownVerbNames()) {
  const q = String(raw || '').toLowerCase();
  if (!q) return null;
  // Prefix / containment match first (cheap + high-signal).
  const pref = candidates.filter(c => c.startsWith(q) || q.startsWith(c));
  if (pref.length) {
    return pref.sort((a, b) => Math.abs(a.length - q.length) - Math.abs(b.length - q.length))[0];
  }
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(q, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  // Only suggest when reasonably close: <= 2 edits, or <= 40% of the longer.
  const tol = Math.max(2, Math.floor(0.4 * Math.max(q.length, (best || '').length)));
  return bestD <= tol ? best : null;
}

// ---------------------------------------------------------------------------
// Profile-bus learning control — `ijfw personalize` (v1.6.0)
// ---------------------------------------------------------------------------
// MOAT NOTE: every profile module touched here (serve.js, audit.js,
// sensitivity.js) is ZERO-LLM by construction (the P4.5 import-graph guard
// proves serve.js never reaches the LLM tier). We import them DYNAMICALLY so
// the top-of-file static import graph of this CLI stays clean and the
// profile-moat-guard's transitive-import walk is never widened.

const PERSONALIZE_CONSENT_VERSION = '1.6.0';

function printPersonalizeHelp() {
  console.log(`
ijfw personalize -- control the profile-bus learning feature

What it does: IJFW can learn your low-sensitivity interaction STYLE (verbosity,
formality, code-vs-prose) locally and, only if you allow it, include a short
brief in prompts so agents match your style. Capture is always local and never
includes raw text. Injection is OFF until you turn it on.

Usage:
  ijfw personalize status            Show current flags + a summary of what was
                                     inferred (alias: ijfw personalize show).
  ijfw personalize on                Enable injecting the learned style brief.
  ijfw personalize off               Disable injection (capture continues locally).
  ijfw personalize forget [pattern]  Delete inferences. No pattern = forget ALL.
  ijfw personalize share-sensitive on|off
                                     Allow/deny med+high-sensitivity prefs to
                                     leave to allowlisted hosts. Default off.

Hard override: set IJFW_PROFILE_KILL=1 to force-disable ALL injection
regardless of these settings.
`.trim());
}

async function cmdPersonalize(sub, rest = []) {
  const settings = resolveProfileSettings();
  const killed = isTruthyEnv(process.env.IJFW_PROFILE_KILL);

  if (sub === 'on' || sub === 'off') {
    const next = writeProfileSettings({
      inject: sub,
      // First explicit on/off resolves the "ask" consent permanently.
      inject_consent_version: PERSONALIZE_CONSENT_VERSION,
    });
    if (sub === 'on') {
      console.log('Profile injection ENABLED. Your learned low-sensitivity style brief will be added to prompts.');
      if (killed) console.log('Note: IJFW_PROFILE_KILL is set, so injection stays OFF until you unset it.');
      console.log('Turn it off anytime with: ijfw personalize off');
    } else {
      console.log('Profile injection DISABLED. Capture continues locally; nothing is added to prompts.');
    }
    console.log(`(profile.inject = ${next.inject})`);
    return;
  }

  if (sub === 'share-sensitive') {
    const val = rest[0];
    if (val !== 'on' && val !== 'off') {
      console.error('Usage: ijfw personalize share-sensitive on|off');
      process.exit(1);
    }
    const enable = val === 'on';
    writeProfileSettings({ share_sensitive: enable });
    // The serve-path allowlist is the SECOND gate (per-host). Toggling on writes
    // a `*` wildcard line; toggling off removes it. This is the auditable file
    // sensitivity.js reads (share-hosts.txt). We import its path helper lazily.
    try {
      const { shareHostsFilePath } = await import('./profile/sensitivity.js');
      const p = shareHostsFilePath();
      if (enable) {
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
        writeAtomic(p, '# Hosts allowed to receive medium/high-sensitivity profile fields.\n# Managed by `ijfw personalize share-sensitive`. `*` = all hosts.\n*\n', { mode: 0o600 });
        console.log('Sensitive sharing ENABLED for all hosts (wildcard allowlist written).');
        console.log(`Allowlist: ${p}  — edit it to restrict to specific hosts.`);
      } else {
        try { if (existsSync(p)) rmSync(p, { force: true }); } catch { /* */ }
        console.log('Sensitive sharing DISABLED. Only low-sensitivity style can ever be injected.');
      }
    } catch (e) {
      console.error(`Wrote the flag, but could not update the host allowlist: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'forget') {
    const pattern = rest[0];
    try {
      const { forgetAndWrite } = await import('./profile/audit.js');
      // No pattern => forget everything (a bare `*` matcher is rejected by the
      // ReDoS guard, so we pass a catch-all regex the validator accepts).
      const arg = pattern && pattern.trim() ? pattern.trim() : /.*/;
      const r = await forgetAndWrite(arg);
      if (!r || !r.ok) {
        console.error(`Forget failed: ${(r && r.message) || (r && r.code) || 'unknown error'}`);
        process.exit(1);
      }
      const n = (r.removed || []).length;
      console.log(`Forgot ${n} inference${n === 1 ? '' : 's'}${pattern ? ` matching "${pattern}"` : ' (all)'}.`);
      if (r.egressRemoved) console.log(`Also cleared ${r.egressRemoved} egress-log entr${r.egressRemoved === 1 ? 'y' : 'ies'}.`);
      if (n === 0) console.log('Nothing matched — the profile may already be empty.');
    } catch (e) {
      console.error(`Forget failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'status' || sub === 'show') {
    const effective = killed ? 'off (forced by IJFW_PROFILE_KILL)' : settings.inject;
    console.log('IJFW personalize -- profile-bus status');
    console.log('');
    console.log(`  capture          ${settings.capture}        (local style metadata; never raw text)`);
    console.log(`  inject           ${settings.inject}${settings.inject === 'ask' ? '       (default — not injecting until you run: ijfw personalize on)' : ''}`);
    console.log(`  effective inject ${effective}`);
    console.log(`  share_sensitive  ${settings.share_sensitive}      (med/high prefs ${settings.share_sensitive ? 'MAY' : 'will NOT'} leave)`);
    console.log(`  consent          ${settings.inject_consent_version ? `resolved (v${settings.inject_consent_version})` : 'not yet asked'}`);
    console.log('');
    // Summary of what was inferred (zero-LLM audit path).
    try {
      const { profileGet } = await import('./profile/serve.js');
      const r = profileGet({ context: { host: 'cli-personalize' }, env: process.env });
      const styleN = r && r.profile ? Object.keys(r.profile.style || {}).length : 0;
      const expN = r && r.profile ? Object.keys(r.profile.expertise || {}).length : 0;
      const infN = r && r.profile ? (r.profile.inferences || []).length : 0;
      console.log(`  Learned so far:  ${styleN} style ${styleN === 1 ? 'axis' : 'axes'}, ${expN} expertise domain${expN === 1 ? '' : 's'}, ${infN} inference${infN === 1 ? '' : 's'}.`);
      if (styleN + expN + infN === 0) {
        console.log('  (Nothing confirmed yet — keep using IJFW and a style profile builds over sessions.)');
      } else {
        console.log('  Inspect everything with: ijfw_brain { "verb": "profile.audit" }  (or via the memory-audit skill).');
        console.log('  Delete anything with:    ijfw personalize forget [pattern]');
      }
    } catch (e) {
      console.log(`  (Profile summary unavailable: ${e.message})`);
    }
    return;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printPersonalizeHelp();
    return;
  }

  console.error(`Unknown personalize subcommand: ${sub}`);
  console.error('');
  printPersonalizeHelp();
  process.exit(1);
}

function printUnknownCommand(raw) {
  console.error(`Unknown command: ${raw}`);
  const key = String(raw || '').toLowerCase();
  const redirect = Object.prototype.hasOwnProperty.call(VERB_REDIRECTS, key)
    ? VERB_REDIRECTS[key]
    : null;
  if (redirect) {
    if (redirect.to) console.error(`Did you mean:  ${redirect.to}`);
    if (redirect.note) console.error(`Note: ${redirect.note}`);
  } else {
    const near = nearestVerb(key);
    if (near) console.error(`Did you mean:  ijfw ${near}`);
  }
  console.error('Run `ijfw --help` for the user-facing command list, or `ijfw commands` for the full surface.');
}

function cmdCommandAlias(alias) {
  const info = COMMAND_ALIAS_HELP[alias];
  if (!info) {
    console.error(`Unknown command alias: ${alias}`);
    process.exit(1);
  }
  console.log(`${info.title}`);
  console.log('');
  console.log(info.usage);
  process.exit(0);
}

// v1.5.1 W2.H — `ijfw metrics --benchmark`: run the memory benchmark harness
// (T22) against IJFW's own 3-tier store and report recall@k, MRR/NDCG-style
// retrieval quality, throughput, and p50/p95/p99 latency. See
// docs/MEMORY-BENCHMARK.md for the axes and how to interpret the numbers.
async function cmdMetricsBenchmark(opts = {}) {
  const results = await runBenchmark({
    root: process.cwd(),
    write: opts.write !== false,
  });

  if (wantsJson(opts)) {
    emitJson(results);
    return;
  }

  const q = results.axes.query_warm_fts5;
  const ing = results.axes.ingest;
  const recallPairs = Object.entries(q.recall || {});
  console.log('IJFW memory benchmark (T22)');
  console.log('');
  console.log(`  corpus            ${results.corpus.docs} docs / ${results.corpus.queries} queries / ${results.corpus.total_query_samples} timed samples`);
  console.log(`  ingest throughput ${ing.throughput_rps} rows/s`);
  console.log(`  ingest latency    p50 ${ing.latency_ms.p50}ms  p95 ${ing.latency_ms.p95}ms  p99 ${ing.latency_ms.p99}ms`);
  console.log(`  query latency     p50 ${q.latency_ms.p50}ms  p95 ${q.latency_ms.p95}ms  p99 ${q.latency_ms.p99}ms`);
  console.log(`  recall            ${recallPairs.map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  ')}`);
  console.log(`  storage           ${results.axes.storage.bytes_per_memory} bytes/memory (${results.axes.storage.rows_indexed} rows)`);
  console.log(`  cold tier         ${results.axes.query_cold_vector.available ? 'available' : 'reserved (no embedding model)'}`);
  if (results.artifact_path) {
    console.log('');
    console.log(`  artifact          ${results.artifact_path}`);
  }
  console.log('');
  console.log('Axes explained: docs/MEMORY-BENCHMARK.md');
}

async function cmdStatus(projectDir, opts = {}) {
  const receipts = readReceipts(projectDir);
  const last = receipts[receipts.length - 1];

  if (wantsJson(opts)) {
    emitJson({
      runs: receipts.length,
      last: last ? { mode: last.mode || 'cross', timestamp: last.timestamp || null } : null,
      hero: receipts.length > 0 ? renderHeroLine(receipts) : null,
    });
    return;
  }

  if (receipts.length === 0) {
    console.log('No cross-audit runs recorded yet.');
    console.log('Recommended next: `ijfw cross audit <file>` to run your first Trident audit.');
    return;
  }
  const hero = renderHeroLine(receipts);
  const mode = last?.mode || 'cross';
  const ts = last?.timestamp ? last.timestamp.slice(0, 10) : '';
  console.log(`Trident -- run ${receipts.length} -- ${mode}${ts ? ' (' + ts + ')' : ''}`);
  console.log('--');
  console.log(hero);
  console.log('--');
  console.log(`${receipts.length} Trident run${receipts.length === 1 ? '' : 's'} on record.`);
  console.log('Recommended next: `ijfw cross audit <file>`. Say no/alt to override.');
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

// Pre-flight: return true if any auditor is reachable via CLI or API key.
function _anyAuditorReachable() {
  for (const entry of ROSTER) {
    try {
      if (isReachable(entry.id, process.env).any) return true;
    } catch {
      if (isInstalled(entry.id)) return true;
    }
  }
  return false;
}

function _printDemoFindings(picks, auditorResults) {
  const attributed = [];

  for (let i = 0; i < picks.length; i++) {
    const { status, parsed } = auditorResults[i];
    const id = picks[i].id;
    const capitalized = id.charAt(0).toUpperCase() + id.slice(1);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const hasFindings = (status === 'ok' || status === 'fallback-used') && items.length > 0;
    if (!hasFindings) {
      console.log(`  ${capitalized}: no findings returned (status: ${status})`);
      continue;
    }
    for (const item of items) {
      const issue = String(item.issue || '').slice(0, 80);
      const sev = item.severity ? ` [${item.severity}]` : '';
      console.log(`  ${capitalized} found:${sev} ${issue}`);
      attributed.push({ id, item });
    }
  }
  return attributed;
}

async function cmdDemo() {
  const reachable = _anyAuditorReachable();
  if (!reachable) {
    console.log('No auditors reachable yet.');
    console.log('Install codex or gemini, or set OPENAI_API_KEY / GEMINI_API_KEY, then run `ijfw demo`.');
    console.log('Run `ijfw doctor` to see the full roster status.');
    process.exit(0);
  }

  console.log('IJFW demo -- 30-second tour of the Trident');
  console.log('');

  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/demo-target.js');
  if (!existsSync(fixturePath)) {
    console.log('Demo fixture not found -- run `npm pack` or reinstall @ijfw/memory-server.');
    process.exit(0);
  }

  const target = readFileSync(fixturePath, 'utf8');

  let result;
  try {
    result = await runCrossOp({
      mode: 'audit',
      target,
      projectDir: process.cwd(),
      perAuditorTimeoutSec: 30,
      minResponses: 2,
      quiet: true,
    });
  } catch (err) {
    console.log(`Demo run encountered an issue: ${err.message}`);
    process.exit(0);
  }

  const { picks, auditorResults } = result;

  if (!picks || picks.length === 0) {
    console.log('No auditors responded this run.');
    console.log('Install codex or gemini, or set OPENAI_API_KEY / GEMINI_API_KEY, then run `ijfw demo`.');
    console.log('');
    console.log('Run `ijfw cross audit <your-file>` when an auditor is reachable.');
    return;
  }

  console.log('Findings:');
  console.log('');

  if (auditorResults && auditorResults.length === picks.length) {
    // Per-auditor attribution (U11: read auditorResults pre-merge). The helper
    // prints findings as a side effect; its return value is intentionally unused.
    _printDemoFindings(picks, auditorResults);
  } else {
    // Graceful fallback to merged listing when auditorResults unavailable
    const items = Array.isArray(result.merged) ? result.merged : [];
    if (items.length === 0) {
      console.log('  No findings returned.');
    } else {
      console.log('  Note: per-auditor attribution unavailable; showing merged findings.');
      for (const item of items) {
        const sev = item.severity ? ` [${item.severity}]` : '';
        console.log(`  ${sev} ${String(item.issue || '').slice(0, 80)}`);
      }
    }
  }

  const allItems = Array.isArray(result.merged) ? result.merged : [];
  const consensusCritical = allItems.filter(i => i.severity === 'critical' || i.severity === 'high').length;
  console.log('');
  console.log(`That was ${picks.length} AIs, one command. ${allItems.length} findings surfaced${consensusCritical > 0 ? `, ${consensusCritical} consensus-critical` : ''}.`);
  console.log('Try `ijfw cross audit <your-file>` next.');
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

// One-line install hints per auditor id. Used by cmdDoctor to tell the user
// the literal command, not just the dependency name.
const INSTALL_HINT = {
  codex:    'npm install -g @openai/codex',
  gemini:   'npm install -g @google/generative-ai-cli',
  claude:   'npm install -g @anthropic-ai/claude-code',
  copilot:  'gh extension install github/gh-copilot',
  opencode: 'npm install -g opencode',
  aider:    'pipx install aider-chat',
};

// Integration depth definitions per platform.
// depth: list of detected capabilities that constitute "native" integration.
const INTEGRATION_DEPTH = {
  claude: {
    label: 'Claude Code',
    checks: [
      { name: 'native plugin',  detect: () => existsSync(join(homedir(), '.claude', 'plugins', 'ijfw')) || existsSync(join(homedir(), '.claude', 'settings.json')) },
      { name: 'skills',         detect: () => existsSync(join(homedir(), '.claude', 'plugins', 'ijfw', 'skills')) },
      { name: 'hooks',          detect: () => existsSync(join(homedir(), '.claude', 'plugins', 'ijfw', 'hooks')) },
      { name: 'agents',         detect: () => existsSync(join(homedir(), '.claude', 'plugins', 'ijfw', 'agents')) },
      { name: 'commands',       detect: () => existsSync(join(homedir(), '.claude', 'plugins', 'ijfw', 'commands')) },
      { name: 'MCP',            detect: () => { try { const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')); return Boolean(s.mcpServers?.['ijfw-memory'] || s.enabledPlugins?.['ijfw-core@ijfw']); } catch { return false; } } },
    ],
  },
  codex: {
    label: 'Codex',
    checks: [
      { name: 'native skills',  detect: () => existsSync(join(homedir(), '.codex', 'skills')) },
      { name: 'command aliases', detect: () => existsSync(join(homedir(), '.codex', 'commands', 'ijfw.md')) && existsSync(join(homedir(), '.codex', 'commands', 'cross-audit.md')) },
      { name: 'hooks',          detect: () => existsSync(join(homedir(), '.codex', 'hooks.json')) },
      { name: 'context file',   detect: () => existsSync(join(homedir(), '.codex', 'IJFW.md')) },
      { name: 'project agents',  detect: () => existsSync(join(process.cwd(), '.codex', 'agents')) },
      { name: 'MCP',            detect: () => { try { const t = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8'); return t.includes('ijfw-memory'); } catch { return false; } } },
    ],
  },
  gemini: {
    label: 'Gemini',
    checks: [
      { name: 'native extension', detect: () => existsSync(join(homedir(), '.gemini', 'extensions', 'ijfw', 'gemini-extension.json')) },
      { name: 'skills',           detect: () => existsSync(join(homedir(), '.gemini', 'extensions', 'ijfw', 'skills')) },
      { name: 'hooks',            detect: () => existsSync(join(homedir(), '.gemini', 'extensions', 'ijfw', 'hooks', 'hooks.json')) },
      { name: 'commands',         detect: () => existsSync(join(homedir(), '.gemini', 'extensions', 'ijfw', 'commands')) },
      { name: 'policy',           detect: () => existsSync(join(homedir(), '.gemini', 'extensions', 'ijfw', 'policies', 'ijfw.toml')) },
      { name: 'MCP',              detect: () => { try { const s = JSON.parse(readFileSync(join(homedir(), '.gemini', 'settings.json'), 'utf8')); return Boolean(s.mcpServers?.['ijfw-memory']); } catch { return false; } } },
    ],
  },
  cursor: {
    label: 'Cursor',
    checks: [
      { name: 'rules',  detect: () => existsSync(join(process.cwd(), '.cursor', 'rules', 'ijfw.mdc')) },
      { name: 'MCP',    detect: () => { try { const s = JSON.parse(readFileSync(join(process.cwd(), '.cursor', 'mcp.json'), 'utf8')); return Boolean(s.mcpServers?.['ijfw-memory']); } catch { return false; } } },
    ],
  },
  windsurf: {
    label: 'Windsurf',
    checks: [
      { name: 'rules',  detect: () => existsSync(join(process.cwd(), '.windsurfrules')) },
      { name: 'MCP',    detect: () => { try { const s = JSON.parse(readFileSync(join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'), 'utf8')); return Boolean(s.mcpServers?.['ijfw-memory']); } catch { return false; } } },
    ],
  },
  copilot: {
    label: 'Copilot',
    checks: [
      { name: 'instructions',  detect: () => existsSync(join(process.cwd(), '.github', 'copilot-instructions.md')) },
      { name: 'MCP',           detect: () => { try { const s = JSON.parse(readFileSync(join(process.cwd(), '.vscode', 'mcp.json'), 'utf8')); return Boolean(s.mcpServers?.['ijfw-memory']); } catch { return false; } } },
    ],
  },
};

function cmdDoctor(opts = {}) {
  const auditors = [];
  for (const entry of ROSTER) {
    isReachable(entry.id, process.env); // side effect: prime probe cache
    const cli = isInstalled(entry.id);
    const apiOk = Boolean(entry.apiFallback && process.env[entry.apiFallback.authEnv]);
    auditors.push({
      id: entry.id,
      name: entry.name,
      cli_installed: cli,
      api_env: entry.apiFallback ? entry.apiFallback.authEnv : null,
      api_set: apiOk,
    });
  }

  const integrations = [];
  for (const [id, def] of Object.entries(INTEGRATION_DEPTH)) {
    const detected = def.checks
      .filter(c => { try { return c.detect(); } catch { return false; } })
      .map(c => c.name);
    if (detected.length > 0) integrations.push({ id, label: def.label, components: detected });
  }

  const anyReachable = ROSTER.some(e => isReachable(e.id, process.env).any);

  if (wantsJson(opts)) {
    emitJson({ auditors, integrations, any_reachable: anyReachable });
    return;
  }

  console.log('ijfw doctor -- roster + key probe');
  console.log('');

  for (const a of auditors) {
    if (a.cli_installed) {
      console.log(`  [ ok ] ${a.id} CLI -- ${a.name} ready`);
    } else {
      const cmd = INSTALL_HINT[a.id] || `npm install -g ${a.id}`;
      console.log(`  [ .. ] ${a.id} CLI -- standing by`);
      console.log(`         fix: ${cmd}`);
    }
    if (a.api_env) {
      if (a.api_set) {
        console.log(`  [ ok ] ${a.api_env} -- set`);
      } else {
        console.log(`  [ .. ] ${a.api_env} -- standing by`);
        console.log(`         fix: export ${a.api_env}=<your-key> (or add to ~/.ijfw/env)`);
      }
    }
  }
  console.log('');

  if (anyReachable) {
    console.log('At least one auditor is reachable. Run `ijfw cross audit <file>` to start.');
  } else {
    console.log('IJFW has the Trident ready -- install codex or gemini (or set OPENAI_API_KEY / GEMINI_API_KEY), then run `ijfw demo`.');
  }

  console.log('');
  console.log('Integration depth:');
  if (integrations.length === 0) {
    console.log('  Run `bash scripts/install.sh` in your IJFW repo to activate platform bundles.');
  } else {
    for (const i of integrations) console.log(`  ${i.label}: ${i.components.join(' + ')}`);
  }
}

// ---------------------------------------------------------------------------
// Purge receipts
// ---------------------------------------------------------------------------

function cmdPurgeReceipts(projectDir) {
  const count = purgeReceipts(projectDir);
  if (count === 0) {
    console.log('Receipt log is already empty. Run `ijfw cross audit <file>` to generate entries.');
  } else {
    console.log(`Receipt log cleared -- ${count} entr${count === 1 ? 'y' : 'ies'} removed.`);
    console.log('Run `ijfw cross audit <file>` to start fresh.');
  }
}

// Fixes issue #6: target path string was sent to auditors verbatim, causing
// hallucinated findings. If target resolves to a regular file on disk, read
// its contents (with a size cap) so auditors see real code. Topics, git
// ranges, and non-existent paths pass through unchanged.
const TARGET_FILE_SIZE_CAP = 64 * 1024; // 64 KB -- leaves prompt headroom

// r17.1 — size thresholds for pre-flight advisory. Inputs under WARN are
// silent; WARN..CAP get a one-line "this might be slow" advisory; CAP..MAX
// get a "this WILL be truncated, consider chunking" warning before we fire
// any auditor (so the user can cancel rather than burn wall time). Anything
// over MAX would be silently truncated by resolveTarget anyway — the
// pre-flight check makes that loud.
const TARGET_FILE_SIZE_WARN = 32 * 1024;
const TARGET_FILE_SIZE_MAX  = 256 * 1024; // beyond this, advise chunking explicitly

export function resolveTarget(raw, opts = {}) {
  const cap = typeof opts.sizeCap === 'number' ? opts.sizeCap : TARGET_FILE_SIZE_CAP;
  if (typeof raw !== 'string' || !raw) return raw;

  let absPath;
  try {
    absPath = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  } catch {
    return raw;
  }

  if (!existsSync(absPath)) return raw;

  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return raw;
  }

  if (!stat.isFile()) return raw;

  let contents;
  try {
    if (stat.size > cap) {
      const buf = Buffer.alloc(cap);
      const fd = openSync(absPath, 'r');
      try {
        readSync(fd, buf, 0, cap, 0);
      } finally {
        closeSync(fd);
      }
      contents = buf.toString('utf8')
        + `\n\n[... truncated: file is ${stat.size} bytes, showing first ${cap} ...]`;
    } else {
      contents = readFileSync(absPath, 'utf8');
    }
  } catch {
    return raw;
  }

  return `File: ${raw}\n\n${contents}`;
}

// v1.5.1 H1.6 — chunked-dispatch helpers (audit finding token-optimization.md
// HIGH-H4 + trident.md HIGH-1, 2/2 consensus). The chunker has shipped (with
// tests) since r17.1 but was never wired into the CLI. `--chunk` now triggers
// per-chunk dispatch through runCrossOp + a final Jaccard-dedupe merge.

/**
 * Decide whether a target absolute path is large enough to benefit from
 * chunking. Exported for unit-tests.
 */
export function shouldChunkFile(absPath, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : TARGET_FILE_SIZE_CAP;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return false;
    return st.size > threshold;
  } catch {
    return false;
  }
}

/**
 * Read a file and produce the per-chunk target strings the auditors will see.
 * Each chunk is annotated with its index so cross-chunk findings can be
 * reconciled. Exported for unit-tests.
 */
export function buildChunkedTargets(absPath, rawTarget, opts = {}) {
  const content = readFileSync(absPath, 'utf8');
  const chunks = chunkText(content, opts);
  return chunks.map((c, i) => ({
    chunkIndex: i,
    total: chunks.length,
    bytesStart: c.start,
    bytesEnd: c.end,
    target: `File: ${rawTarget} [chunk ${i + 1}/${chunks.length}, bytes ${c.start}-${c.end}]\n\n${c.text}`,
  }));
}

async function cmdCross({ mode, target, only, confirm, expand, chunk }) {
  const VALID_MODES = ['audit', 'research', 'critique'];
  if (!mode || !VALID_MODES.includes(mode)) {
    console.error(`ijfw cross requires a mode: ${VALID_MODES.join(', ')}. Example: ijfw cross audit <file>`);
    process.exit(1);
  }
  if (!target) {
    console.error('ijfw cross needs a target -- pass a file path, git range, or topic. Example: ijfw cross audit CLAUDE.md');
    process.exit(1);
  }

  // Issue #6 fix: substitute file contents for path string when target is a
  // regular file. Keep the raw target for the user-facing echo line.
  const rawTarget = target;

  // r17.1 — pre-flight size advisory. Run BEFORE resolveTarget truncates,
  // so the user sees the real number and can decide to abort + chunk the
  // input themselves rather than getting a silently-truncated audit.
  // r17-M3: resolve relative paths against cwd FIRST, matching the same
  // resolution resolveTarget() uses. Without this, `ijfw cross audit foo.md`
  // (a relative path that exists) would skip the advisory because
  // existsSync(rawTarget) probes against the wrong cwd-anchor.
  try {
    let probePath = null;
    if (typeof rawTarget === 'string' && rawTarget.length < 4096) {
      const resolved = isAbsolute(rawTarget) ? rawTarget : resolve(process.cwd(), rawTarget);
      if (existsSync(resolved)) probePath = resolved;
    }
    if (probePath) {
      const st = statSync(probePath);
      if (st.isFile()) {
        if (st.size > TARGET_FILE_SIZE_MAX) {
          console.log('');
          console.log(`Heads up -- target is ${(st.size / 1024).toFixed(1)} KB, larger than the ${(TARGET_FILE_SIZE_MAX / 1024).toFixed(0)} KB recommended max.`);
          console.log(`Auditors will see only the first ${(TARGET_FILE_SIZE_CAP / 1024).toFixed(0)} KB (truncated). For full coverage, chunk the target into smaller files and audit each, OR pass --chunk to auto-split (see \`ijfw cross --help\`).`);
        } else if (st.size > TARGET_FILE_SIZE_CAP) {
          console.log('');
          console.log(`Note: target is ${(st.size / 1024).toFixed(1)} KB; auditors will see the first ${(TARGET_FILE_SIZE_CAP / 1024).toFixed(0)} KB and a truncation marker. Findings beyond that point will be missed.`);
        } else if (st.size > TARGET_FILE_SIZE_WARN) {
          console.log('');
          console.log(`Note: target is ${(st.size / 1024).toFixed(1)} KB; expect a slower wall time (gemini in particular may push the 90s budget).`);
        }
      }
    }
  } catch { /* statSync failure is non-fatal; size advisory is best-effort */ }

  // v1.5.1 H1.6 — chunked dispatch path. When --chunk is set AND the target
  // is a file larger than the size cap, split via the cross-audit-chunker
  // (boundary-aware, 10% overlap, Jaccard-dedupe merge) and dispatch each
  // chunk through runCrossOp separately. Merge findings at the end. Opt-in
  // because cost scales linearly with chunk count.
  if (chunk) {
    let absPath = null;
    try {
      if (typeof rawTarget === 'string' && rawTarget.length < 4096) {
        const resolved = isAbsolute(rawTarget) ? rawTarget : resolve(process.cwd(), rawTarget);
        if (existsSync(resolved) && statSync(resolved).isFile()) absPath = resolved;
      }
    } catch { /* */ }

    if (!absPath) {
      console.log('');
      console.log('--chunk requires a file target. Topics, git ranges, and missing paths cannot be chunked.');
      // Fall through to normal path -- --chunk silently no-ops for non-files
    } else if (!shouldChunkFile(absPath)) {
      console.log('');
      console.log(`--chunk: target is ${(statSync(absPath).size / 1024).toFixed(1)} KB, under the ${(TARGET_FILE_SIZE_CAP / 1024).toFixed(0)} KB chunk threshold; running single-pass audit instead.`);
      // Fall through to normal path
    } else {
      const chunks = buildChunkedTargets(absPath, rawTarget);
      console.log('');
      console.log(`--chunk: splitting ${rawTarget} into ${chunks.length} chunks (≈${(CHUNKER_DEFAULTS.chunkSize / 1024).toFixed(0)} KB each, ${(CHUNKER_DEFAULTS.overlap / 1024).toFixed(0)} KB overlap).`);
      console.log(`Trident dispatches: ${chunks.length} x per-chunk audit. Cost scales linearly.`);

      const perChunkResults = [];
      const auditorIds = new Set();
      const projectDir = process.cwd();
      let firedAny = false;
      for (const { chunkIndex, total, target: chunkTarget } of chunks) {
        console.log('');
        console.log(`[chunk ${chunkIndex + 1}/${total}] dispatching...`);
        try {
          const r = await runCrossOp({
            mode, target: chunkTarget, projectDir,
            runStamp: new Date().toISOString(), only, confirm, expand,
          });
          const findings = Array.isArray(r.merged) ? r.merged : [];
          perChunkResults.push({ chunkIndex, findings });
          for (const p of (r.picks || [])) auditorIds.add(p.id);
          if ((r.picks || []).length > 0) firedAny = true;
          console.log(`[chunk ${chunkIndex + 1}/${total}] ${findings.length} finding(s) from ${(r.picks || []).length} auditor(s).`);
        } catch (err) {
          console.log(`[chunk ${chunkIndex + 1}/${total}] dispatch error: ${err.message}`);
          perChunkResults.push({ chunkIndex, findings: [] });
        }
      }

      const merged = mergeFindings(perChunkResults);
      console.log('');
      console.log(`=== Chunked audit complete: ${merged.length} unique finding(s) across ${chunks.length} chunks ===`);
      console.log(`Auditors fired (union): ${[...auditorIds].join(', ') || '(none)'}`);
      if (!firedAny) {
        console.log('No auditors fired -- run `ijfw doctor` to see the install hints.');
        process.exit(2); // r17.1 — degraded exit code
      }
      for (const f of merged) {
        const sev = (f.severity || 'note').toUpperCase();
        const cluster = f.clusterSize > 1 ? ` [x${f.clusterSize}]` : '';
        const tgt = f.target ? ` ${f.target} —` : '';
        // v1.5.0 wire-W4: widen field fallback to cover description/issue/
        // detail/note/summary keys auditors emit. Closes the r19 "(no detail)"
        // dropout that made adjudication a guessing game.
        const text = f.finding || f.text || f.message ||
                     f.description || f.issue ||
                     f.detail || f.details || f.note || f.summary ||
                     '(no detail)';
        console.log(`  ${sev}${cluster}${tgt} ${text}`);
      }
      return;
    }
  }

  target = resolveTarget(target);

  // Polish 6: pre-flight reachability check. If no auditor is wired, give a
  // positive recovery hint instead of bombing through to a runCrossOp error.
  if (!_anyAuditorReachable()) {
    console.log('');
    console.log('Trident is standing by -- no auditors reachable yet.');
    console.log('Wire one in 30 seconds: run `ijfw doctor` for the exact install commands.');
    console.log('Tip: any one of codex / gemini / claude / copilot is enough to start.');
    process.exit(0);
  }

  const projectDir = process.cwd();
  const runStamp = new Date().toISOString();

  console.log(`\nijfw cross ${mode} -- target: ${rawTarget}`);
  console.log('Probing roster...');

  let result;
  try {
    result = await runCrossOp({ mode, target, projectDir, runStamp, only, confirm, expand });
  } catch (err) {
    console.log('');
    console.log(`Run didn't complete: ${err.message}`);
    console.log('Try `ijfw doctor` to see what to wire next.');
    process.exit(1);
  }

  const { merged, picks, note, auditorResults } = result;

  if (picks.length === 0) {
    console.log('\nIJFW has the Trident ready -- install codex or gemini (or set OPENAI_API_KEY / GEMINI_API_KEY), then run `ijfw demo`.');
    console.log('Run `ijfw doctor` to see which auditors are available on this machine.');
    return;
  }

  console.log(`Fired: ${picks.map(p => p.id).join(', ')}`);

  if (note) {
    console.log(`\nNote: ${note}`);
  }

  // Issue #9-B + 1.2.5: surface silent auditor degradation AND translate the
  // raw error signature into one actionable line. Old behavior dumped the
  // first 80 chars of stderr, which read like a stack trace. New behavior:
  // pattern-match common auth/timeout/safety/no-key signatures and render
  // "this is what's wrong, this is how to fix it" -- so the user knows
  // whether to re-auth, retry, or change combo without reading source.
  if (auditorResults && auditorResults.length === picks.length) {
    const degraded = [];
    for (let i = 0; i < picks.length; i++) {
      const r = auditorResults[i];
      const id = picks[i].id;
      if (r.status === 'failed' || r.status === 'timeout' || (r.status === 'empty' && r.stderr && r.stderr.trim())) {
        degraded.push({ id, reason: translateAuditorError(id, r.status, r.stderr || '', r.exitCode) });
      }
    }
    if (degraded.length > 0) {
      console.log('');
      console.log('Heads up -- one or more auditors did not contribute this run:');
      for (const d of degraded) {
        console.log(`  - ${d.id}: ${d.reason}`);
      }
      console.log('Trident lineage diversity is reduced for this result. Re-run after fixing the auditor, or pass --with <id> to force a different combination.');
    }
  }

  console.log('\nFindings:');
  printFindings(mode, merged);

  console.log('\nReceipt logged -- run `ijfw status` to see it.');

  // r17.1 — structured exit code so CI scripts + orchestrator-LLM callers
  // can detect degraded runs without scraping console output.
  //   exit 0  — all picks contributed productively
  //   exit 2  — at least one pick didn't contribute (timeout / failure / aborted)
  //   exit 3  — zero picks contributed productively (INCONCLUSIVE verdict)
  // exit 1 is reserved for argv / usage errors (already used above).
  if (auditorResults && Array.isArray(auditorResults)) {
    const productive = auditorResults.filter(r => r.counted === true || r.status === null || r.status === 'fallback-used');
    if (productive.length === 0) process.exit(3);
    if (productive.length < auditorResults.length) process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Portfolio audit -- `ijfw cross project-audit <rule-file>`
// ---------------------------------------------------------------------------

// Read the registry (same format as server.js: path|hash|iso lines). Lives
// here as a narrow duplicate so the CLI does not depend on server.js bootstrap.
function readProjectRegistry() {
  const file = join(homedir(), '.ijfw', 'registry.md');
  if (!existsSync(file)) return [];
  const body = readFileSync(file, 'utf8');
  const out = [];
  for (const line of body.split('\n')) {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 3) continue;
    const [path, hash, iso] = parts;
    if (!path || !isAbsolute(path)) continue;
    out.push({ path, hash, iso });
  }
  return out;
}

async function cmdCrossProjectAudit({ rule, dryRun }) {
  if (!rule) {
    console.error('Usage: ijfw cross project-audit <rule-file> [--dry-run]');
    process.exit(1);
  }

  const resolvedRule = isAbsolute(rule) ? rule : resolve(process.cwd(), rule);
  if (!existsSync(resolvedRule)) {
    console.error(`Rule file not found: ${resolvedRule}`);
    process.exit(1);
  }

  const projects = readProjectRegistry();
  if (projects.length === 0) {
    console.log('No other IJFW projects registered yet.');
    console.log('The registry auto-populates the first time you run any IJFW command in a project:');
    console.log('  cd /path/to/another/project && ijfw status');
    console.log('Then re-run: ijfw cross project-audit ' + rule);
    return;
  }

  console.log(`Phase 12 / Wave 12B -- portfolio audit -- ${projects.length} project${projects.length === 1 ? '' : 's'}.`);

  if (dryRun) {
    for (const p of projects) console.log(`  - ${basename(p.path)}  (${p.path})`);
    console.log('\n--dry-run: no audits dispatched. Drop the flag to fire.');
    return;
  }

  const startedAt = new Date().toISOString();
  const results = [];
  for (const p of projects) {
    const tag = basename(p.path);
    console.log(`  [${tag}] running cross audit ...`);
    const r = spawnSync('ijfw', ['cross', 'audit', resolvedRule], {
      cwd: p.path,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      // shell:true on Windows so ijfw.cmd resolves through PATH.
      shell: process.platform === 'win32',
    });
    if (r.error) {
      results.push({ project: tag, path: p.path, status: 'failed', findings: '', error: `spawn-${r.error.code || 'unknown'}: ${r.error.message}` });
    } else if (r.signal) {
      // Without surfacing r.signal, killed children would otherwise report
      // "exit null" -- portfolio aggregator treated that as silently OK.
      results.push({ project: tag, path: p.path, status: 'failed', findings: r.stdout || '', error: `killed by ${r.signal} (timeout or OS signal)` });
    } else if (r.status !== 0) {
      results.push({ project: tag, path: p.path, status: 'failed', findings: r.stdout || '', error: (r.stderr || '').trim().split('\n')[0] || `exit ${r.status}` });
    } else {
      results.push({ project: tag, path: p.path, status: 'ok', findings: r.stdout || '' });
    }
  }
  const finishedAt = new Date().toISOString();

  const body = aggregatePortfolioFindings(results, { rule: basename(resolvedRule), startedAt, finishedAt });
  const outDir = join(process.cwd(), '.ijfw', 'memory');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `portfolio-audit-${finishedAt.replace(/[:.]/g, '-')}.md`);
  writeFileSync(outFile, body, 'utf8');
  console.log(`\nPortfolio findings written: ${outFile}`);
}

// ---------------------------------------------------------------------------
// Import -- `ijfw import <tool> [--dry-run] [--force] [--path <p>]`
// ---------------------------------------------------------------------------

async function cmdImport(parsed) {
  const tool = parsed.tool;
  if (!tool) {
    console.error(`Usage: ijfw import <tool> [--all] [--dry-run] [--force] [--path <p>]`);
    console.error(`Tools: ${listImporters().join(', ')}`);
    console.error(`  --all       Discover all projects and import each to its own .ijfw/memory/`);
    process.exit(1);
  }

  if (parsed.allMode) {
    return cmdImportAll(parsed);
  }

  const result = await runImport({
    tool,
    dryRun: parsed.dryRun,
    force: parsed.force,
    includeMetrics: parsed.includeMetrics,
    path: parsed.customPath,
  });
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.summary);
  if (result.dryRun && result.samples && result.samples.length > 0) {
    console.log('\nSample entries (dry-run):');
    for (const s of result.samples) console.log(`  - [${s.type}] ${s.summary || '(no title)'}`);
    console.log('\nRe-run without --dry-run to write them to .ijfw/memory/.');
  }
}

async function cmdImportAll(parsed) {
  // Phase 1: always do a dry-run preview first, regardless of user's --dry-run flag.
  const preview = await runImportAll({
    tool: parsed.tool,
    dryRun: true,
    force: parsed.force,
    path: parsed.customPath,
  });
  if (!preview.ok) {
    console.error(preview.error);
    process.exit(1);
  }

  const plan = preview.plan;
  console.log(`\nDiscovered ${plan.matched.length + plan.ambiguous.length + plan.unmatched.length} projects in ${parsed.tool} (${plan.totalEntries} total entries).\n`);

  if (plan.matched.length > 0) {
    console.log(`Auto-matched (${plan.matched.length}):`);
    for (const m of plan.matched) {
      console.log(`  [${m.entryCount.toString().padStart(5)}]  ${m.project.padEnd(30)} -> ${m.path}`);
    }
    console.log('');
  }

  if (plan.ambiguous.length > 0) {
    console.log(`Ambiguous (${plan.ambiguous.length}) -- will go to global archive:`);
    for (const a of plan.ambiguous) {
      const paths = a.candidates.slice(0, 3).map((c) => c.path).join(' OR ');
      console.log(`  [${a.entryCount.toString().padStart(5)}]  ${a.project.padEnd(30)} -> ${paths}`);
    }
    console.log('');
  }

  if (plan.unmatched.length > 0) {
    console.log(`No local match (${plan.unmatched.length}) -- will go to global archive:`);
    for (const u of plan.unmatched) {
      console.log(`  [${u.entryCount.toString().padStart(5)}]  ${u.project}`);
    }
    console.log('');
  }

  if (parsed.dryRun) {
    console.log('Dry run only. Re-run without --dry-run to execute.');
    return;
  }

  // --all is destructive (writes to multiple project dirs). Require --yes.
  if (!parsed.yes) {
    console.log('This will import into all matched projects. Re-run with --yes to confirm.');
    console.log('  ijfw import ' + parsed.tool + ' --all --yes');
    return;
  }

  // Phase 2: execute.
  console.log('Importing...\n');
  const result = await runImportAll({
    tool: parsed.tool,
    dryRun: false,
    force: parsed.force,
    path: parsed.customPath,
  });

  if (!result.ok) {
    console.error('Some imports failed. See per-project results below.');
  }

  // Stats categories from common.js emptyStats(): decisions, patterns,
  // observations, handoffs, preferences, skipped, failed, total.
  const WRITTEN_KEYS = ['decisions', 'patterns', 'observations', 'handoffs', 'preferences'];
  const sumWritten = (s) => s ? WRITTEN_KEYS.reduce((n, k) => n + (s[k] || 0), 0) : 0;

  let totalWritten = 0, totalSkipped = 0, totalFailed = 0;
  for (const r of result.results) {
    if (r.stats) {
      totalWritten += sumWritten(r.stats);
      totalSkipped += (r.stats.skipped || 0);
      totalFailed  += (r.stats.failed  || 0);
    }
    const status = r.ok === false ? 'FAILED' : 'OK';
    const written = sumWritten(r.stats);
    const skipped = r.stats ? (r.stats.skipped || 0) : 0;
    console.log(`  [${status}] ${r.project.padEnd(30)} -> ${r.path}  (${written} written, ${skipped} skipped)`);
  }

  if (result.orphanResult) {
    console.log(`\nGlobal archive (~/.ijfw/memory/global-archive/):`);
    for (const p of result.orphanResult.projects) {
      const written = sumWritten(p.stats);
      const skipped = p.stats ? (p.stats.skipped || 0) : 0;
      totalWritten += written;
      totalSkipped += skipped;
      console.log(`  ${p.ok !== false ? '[OK]' : '[FAILED]'} ${p.project}  (${written} written, ${skipped} skipped)`);
    }
  }

  console.log(`\nTotal: ${totalWritten} written, ${totalSkipped} skipped (already present), ${totalFailed} failed.`);
  console.log('Done.');
}

// ---------------------------------------------------------------------------
// Update -- `ijfw update`  (polish 5)
// ---------------------------------------------------------------------------
//
// Walks up from the launcher to the IJFW source repo, runs git pull, and
// reruns scripts/install.sh in merge-safe mode. Designed for users who
// installed via git clone (the canonical path). For users on
// `npm install -g @ijfw/install`, hints them at the npm command instead.

// v1.1.6 update CLI -- replaces the v1.1.5 git-pull-only flow.
// Subflags:
//   ijfw update                    interactive update (provenance + shasum verified)
//   ijfw update --check            non-invasive availability check
//   ijfw update --yes              non-interactive (terminal-only; rejects MCP context)
//   ijfw update --verify           verification dry-run (no install)
//   ijfw update --changelog        full release notes for available version
//   ijfw update --confirm <token>  consume MCP-issued token, run update
//   ijfw update --auto on|off|ask  set/query auto-update preference
function cmdUpdate(opts = {}) {
  if (opts.auto !== undefined) return cmdUpdateAuto(opts.auto);
  if (opts.check) return cmdUpdateCheck();
  if (opts.verify) return cmdUpdateVerify();
  if (opts.changelog) return cmdUpdateChangelog();
  if (opts.confirm) return cmdUpdateConfirm(opts.confirm);
  process.exit(cmdUpdateInteractive(opts));
}

function ijfwHome() {
  return process.env.IJFW_HOME || join(process.env.HOME || homedir(), '.ijfw');
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

function npmViewVersion(pkg = '@ijfw/install') {
  // shell:true on Windows so npm.cmd / npm.bat resolve. Without it, Node's
  // spawnSync can't find npm and returns ENOENT before the command runs.
  // pkg is hardcoded internally so there is no injection surface.
  const r = spawnSync('npm', ['view', pkg, 'version', '--json'], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: process.platform === 'win32',
  });
  // Distinguish three failure modes so users + bug reports get actionable text
  // instead of a generic "npm view failed".
  if (r.error) {
    const code = r.error.code || 'unknown';
    return { ok: false, message: `spawn-${code}: ${(r.error.message || '').slice(0, 120)}` };
  }
  if (r.signal) {
    return { ok: false, message: `killed by ${r.signal} (likely network timeout)` };
    // r.status === null when killed by signal; explicit branch keeps the next
    // check clean.
  }
  if (r.status !== 0) {
    const stderr = (r.stderr || '').trim();
    return { ok: false, message: stderr || `npm view exited ${r.status} with no stderr` };
  }
  const raw = (r.stdout || '').trim().replace(/^"|"$/g, '');
  // eslint-disable-next-line security/detect-unsafe-regex -- raw is npm's short version string response and is truncated in the error path.
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(raw)) return { ok: false, message: `malformed: ${raw.slice(0, 80)}` };
  return { ok: true, version: raw };
}

function cmpSemver(a, b) {
  const parse = v => {
    const [main, pre] = String(v).split('-', 2);
    const nums = main.split('.').map(n => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || null };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return A.pre < B.pre ? -1 : 1;
}

function readState() { return readJsonSafe(join(ijfwHome(), 'state.json')) || {}; }
function readSettings() { return readJsonSafe(join(ijfwHome(), 'settings.json')) || {}; }

// ---------------------------------------------------------------------------
// Profile-bus settings (v1.6.0) — consent + control surface.
// ---------------------------------------------------------------------------
// The `profile` block predates 1.6 in some installs; resolveProfileSettings()
// backfills the documented defaults on read so the rest of the CLI + the hooks
// never have to defend against a missing block. Defaults (design-locked):
//   capture        = "on"    (local, low-sensitivity metadata only; never raw)
//   inject         = "ask"   (do NOT silently inject — ask once, default off)
//   share_sensitive= false   (med/high prefs require an explicit opt-in)
const PROFILE_DEFAULTS = Object.freeze({
  capture: 'on',
  inject: 'ask',
  share_sensitive: false,
  inject_consent_version: null,
});

function resolveProfileSettings(settings = readSettings()) {
  const p = (settings && typeof settings.profile === 'object' && settings.profile) || {};
  return {
    capture: p.capture === 'off' ? 'off' : 'on',
    inject: (p.inject === 'on' || p.inject === 'off') ? p.inject : 'ask',
    share_sensitive: p.share_sensitive === true,
    inject_consent_version: typeof p.inject_consent_version === 'string'
      ? p.inject_consent_version : null,
  };
}

// resolveProfileInject(opts) -> 'on' | 'off' | 'ask'.
// The single decision the inject GATE consults. The hard kill-switch
// (IJFW_PROFILE_KILL) ALWAYS wins and forces 'off' — capture is never gated by
// it, only injection. Otherwise the settings block decides.
function isTruthyEnv(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}
export function resolveProfileInject({ settings, env = process.env } = {}) {
  if (isTruthyEnv(env.IJFW_PROFILE_KILL)) return 'off';
  return resolveProfileSettings(settings || readSettings()).inject;
}

// Persist the resolved `profile` block under the same single-writer lock the
// state file uses, so a concurrent `ijfw personalize` and an `ijfw update`
// can't clobber each other's settings.json. Merges into the existing file
// (never drops unrelated keys) and writes atomically with 0600.
function writeProfileSettings(patch) {
  const path = join(ijfwHome(), 'settings.json');
  const apply = () => {
    const cur = readJsonSafe(path) || {};
    const profile = { ...PROFILE_DEFAULTS, ...resolveProfileSettings(cur), ...patch };
    const next = { ...cur, profile };
    writeAtomic(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return profile;
  };
  try {
    return withStateLockSync(apply);
  } catch {
    // Lock acquisition failed (e.g. EACCES on the lock dir) — fall back to a
    // best-effort direct write rather than refusing to persist the user's
    // explicit consent choice.
    return apply();
  }
}

// v1.5.0 audit M11 (F-REL-1): writeStateFields was best-effort — readState +
// merge + writeAtomic was a TOCTOU window where a parallel `ijfw update`
// completion could clobber another writer's `last_applied_version`. If the
// write failed silently, the re-entrancy guard (last_applied_version >=
// last_latest_seen) would never fire and every subsequent session would
// nag-loop until manual `ijfw doctor`.
//
// Fix: serialise read-modify-write under a sync directory lock so the merge
// happens against the latest disk state. We use a tiny inlined sync version
// of `withFsLock` (mkdir-with-EEXIST is atomic on POSIX + NTFS) rather than
// importing the async `fs-lock.js` — this whole CLI is sync top-to-bottom and
// converting just-this-callsite to async would force every caller to await.
//
// On lock-acquire failure we still attempt the write (better than refusing to
// persist) and surface the lock failure as a clearer error.
const STATE_LOCK_DIR = () => join(ijfwHome(), '.state.lock');
const STATE_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const STATE_LOCK_STALE_MS = 30000;
const STATE_LOCK_BACKOFF_START_MS = 25;
const STATE_LOCK_BACKOFF_MAX_MS = 250;

function withStateLockSync(fn) {
  const lockDir = STATE_LOCK_DIR();
  // Ensure parent exists; tolerate races.
  try { mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 }); } catch { /* */ }

  const deadline = Date.now() + STATE_LOCK_ACQUIRE_TIMEOUT_MS;
  let staleRecoveryUsed = false;
  let backoff = STATE_LOCK_BACKOFF_START_MS;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { recursive: false });
      acquired = true;
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') {
        // Real FS error (EACCES, ENOENT on parent we couldn't create) —
        // surface so the caller can fall back to best-effort write.
        throw err;
      }
      // Stale recovery: if the lock dir is older than STATE_LOCK_STALE_MS,
      // a previous holder crashed mid-write. Remove + retry once.
      if (!staleRecoveryUsed) {
        try {
          const st = statSync(lockDir);
          if (Date.now() - st.mtimeMs > STATE_LOCK_STALE_MS) {
            staleRecoveryUsed = true;
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch { /* lock vanished mid-stat; retry */ }
      }
      // Bounded busy-wait. Sync sleep via Atomics is heavy; use a tight loop
      // with deadline check (typical contention is microseconds in practice).
      const waitUntil = Date.now() + Math.min(backoff, STATE_LOCK_BACKOFF_MAX_MS, deadline - Date.now());
      // eslint-disable-next-line no-empty
      while (Date.now() < waitUntil) {}
      backoff = Math.min(backoff * 2, STATE_LOCK_BACKOFF_MAX_MS);
    }
  }

  if (!acquired) {
    // Couldn't acquire — fall back to caller's fn anyway. Better to risk a
    // racy write than to lose the re-entrancy guard entry.
    try { return fn(); }
    finally { /* no lock to release */ }
  }

  try {
    return fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function writeStateFields(updates) {
  const path = join(ijfwHome(), 'state.json');
  withStateLockSync(() => {
    // Re-read INSIDE the lock so we don't merge against a stale snapshot.
    const state = Object.assign(readState(), updates);
    try {
      writeAtomic(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      // M11: persist failure is now visible AND surfaces which field would
      // not propagate. Re-entrancy guard relies on last_applied_version;
      // log explicitly so `ijfw doctor` / a user reading logs can spot it.
      console.error(`could not persist state.json (re-entrancy guard may not fire next session): ${e.message}`);
    }
  });
}

// V155-001 (BLOCKER) — `ijfw update` was writing `installed_version` /
// `last_applied_version` based on the install subprocess returning exit 0
// across all 3 install methods (npm-global, git-clone, manual). Exit 0 from
// `npm install -g @ijfw/install@X` is "npm did not crash" — NOT "@ijfw/install
// on disk is now version X". On registry blips, npm-cache poisoning, or a
// no-op install (already-installed, lockfile pin), `state.json` would advance
// to a version that does not exist on the filesystem. Every subsequent
// `ijfw update --check` then saw "we're up to date" and refused to retry.
//
// Fix: AFTER the install subprocess returns 0, re-read the *actual*
// installed package.json (preferring npm-global root for the npm-global path,
// repo-tree installer/package.json for git-clone, and either for manual)
// and confirm `pkg.version === expectedVersion` before writing state.json.
// If they disagree, refuse the state write and surface the discrepancy.
//
// Returns { ok: true, actualVersion } on success, { ok: false, actualVersion,
// reason } on mismatch / unreadable.
//
// Exported (v1.5.5 V155-001 follow-up) so the regression test
// `test-v155-update-flow.js` can drive the function directly without spawning
// the full CLI. Behavior unchanged.
export function verifyInstallSucceeded({ method, repoRoot, expectedVersion }) {
  // TR-006: type-validate `expectedVersion` at function entry. Without this,
  // a stray trailing newline (from sloppy `npmViewVersion` parse) makes the
  // strict `pkg.version === expectedVersion` check fail for the wrong reason
  // and surfaces operator-hostile mismatch messages like
  // "expected v1.5.5\n got v1.5.5". Normalize + validate before any probe.
  expectedVersion = String(expectedVersion || '').trim();
  if (!isVersionStringValid(expectedVersion)) {
    return {
      ok: false,
      actualVersion: null,
      reason: `expectedVersion not a valid semver string (got: ${JSON.stringify(expectedVersion)})`,
    };
  }
  // TR-002: probe candidates are now method-strict. The previous shape
  // silently fell back to `repoRoot/installer/package.json` for ALL methods,
  // so a stale git clone at the expected version would mask an npm-global
  // install that never happened. Each method now declares its own source of
  // truth; `manual` keeps the multi-candidate fallback because dev-mode
  // installs legitimately ride on either npm-global or a sibling git clone.
  const candidates = [];
  const probeNpmGlobal = () => {
    try {
      const r = spawnSync('npm', ['root', '-g'], {
        encoding: 'utf8',
        timeout: 5_000,
        shell: process.platform === 'win32',
      });
      if (r.status === 0) {
        const globalRoot = (r.stdout || '').trim();
        if (globalRoot) {
          candidates.push(join(globalRoot, '@ijfw', 'install', 'package.json'));
        }
      }
    } catch { /* ignore — surfaces as no-candidates */ }
  };
  if (method === 'npm-global') {
    // npm-global verification MUST read the npm-global package.json
    // exclusively. A sibling repo tree at the expected version is a category
    // error here — it would mean we record "npm-global install succeeded"
    // when the only thing on disk at that version is an unrelated git clone.
    probeNpmGlobal();
  } else if (method === 'git-clone' && repoRoot) {
    candidates.push(join(repoRoot, 'installer', 'package.json'));
  } else if (method === 'manual') {
    // Dev-mode: try npm-global first, then the repo tree. Either is a
    // legitimate source of truth for a manually-driven install.
    probeNpmGlobal();
    if (repoRoot) {
      const fallback = join(repoRoot, 'installer', 'package.json');
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      actualVersion: null,
      reason:
        method === 'npm-global'
          ? 'npm-global package.json not readable (npm root -g failed)'
          : `no package.json candidates for method=${method}`,
    };
  }

  const seen = [];
  for (const p of candidates) {
    const pkg = readJsonSafe(p);
    if (!pkg) {
      seen.push(`${p} (unreadable)`);
      continue;
    }
    seen.push(`${p} (v${pkg.version || 'unknown'})`);
    if (pkg.version === expectedVersion) {
      return { ok: true, actualVersion: pkg.version, source: p };
    }
  }
  return {
    ok: false,
    actualVersion: null,
    reason: `no package.json reported version v${expectedVersion}. Probed: ${seen.join(', ')}`,
  };
}

function cmdUpdateCheck() {
  const state = readState();
  const current = state.installed_version || '0.0.0';
  const r = npmViewVersion('@ijfw/install');
  if (!r.ok) {
    console.log(`IJFW: update check failed (${r.message}). Will retry next session.`);
    process.exit(1);
  }
  const cmp = cmpSemver(current, r.version);
  if (cmp >= 0) {
    console.log(`IJFW is up to date (v${current}).`);
    process.exit(0);
  }
  // Exit 0 + machine-readable sentinel so shell scripts can grep rather than
  // rely on exit codes. Previously exited 3 which broke POSIX if-statements.
  console.log(`update-available: ${r.version}`);
  console.log(`Update available: v${current} -> v${r.version}`);
  console.log(`  Release notes: https://github.com/FerroxLabs/ijfw/releases/tag/v${r.version}`);
  console.log(`  Run: ijfw update`);
  process.exit(0);
}

function cmdUpdateVerify() {
  const state = readState();
  const current = state.installed_version || '0.0.0';
  const r = npmViewVersion('@ijfw/install');
  console.log('IJFW update verification:');
  console.log(`  installed: v${current}`);
  console.log(`  install_method: ${state.install_method || 'unknown'}`);
  console.log(`  last_good_shasum: ${state.last_good_shasum || '(none)'}`);
  if (!r.ok) {
    console.log(`  registry: UNREACHABLE (${r.message})`);
    process.exit(1);
  }
  console.log(`  registry latest: v${r.version}`);
  // Provenance check via npm audit signatures
  const sig = spawnSync('npm', ['audit', 'signatures', `@ijfw/install@${r.version}`], {
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
  if (sig.status === 0) {
    console.log(`  provenance: VERIFIED (npm audit signatures)`);
  } else {
    console.log(`  provenance: NOT VERIFIED (audit signatures exited ${sig.status})`);
  }
  // Second factor: shasum cross-verify (F-SEC-7). Dry-run: report but don't
  // exit non-zero -- caller is asking "what would happen if I updated?", and
  // the interactive flow already fails closed on mismatch.
  const shasumDry = verifyShasumCrossSource(r.version);
  if (shasumDry.mode === 'verified') {
    console.log(`  shasum cross-verify: VERIFIED (${shasumDry.npmShasum.slice(0, 12)}...)`);
  } else if (shasumDry.mode === 'mismatch') {
    console.log(`  shasum cross-verify: MISMATCH (npm=${shasumDry.npmShasum} release=${shasumDry.releaseShasum}) -- install would be REFUSED`);
  } else if (shasumDry.mode === 'advisory') {
    console.log(`  shasum cross-verify: ADVISORY (${shasumDry.message})`);
  } else {
    console.log(`  shasum cross-verify: ERROR (${shasumDry.message})`);
  }
  console.log('Verification complete.');
  process.exit(0);
}

function cmdUpdateChangelog() {
  const r = npmViewVersion('@ijfw/install');
  if (!r.ok) {
    console.error(`could not fetch latest version: ${r.message}`);
    process.exit(1);
  }
  // V155 rebrand: ported from GitLab API (releases/v<ver>, data.description)
  // to GitHub API (releases/tags/v<ver>, data.body). GitHub's repo path is
  // NOT URL-encoded, unlike GitLab's %2F-separated project id.
  const url = `https://api.github.com/repos/FerroxLabs/ijfw/releases/tags/v${r.version}`;
  const fetchRes = spawnSync(
    'curl',
    ['-fsSL', '-H', 'User-Agent: ijfw', '-H', 'Accept: application/vnd.github+json', url],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (fetchRes.status !== 0) {
    console.log(`No release notes available for v${r.version}.`);
    console.log(`Visit: https://github.com/FerroxLabs/ijfw/releases/tag/v${r.version}`);
    process.exit(0);
  }
  let body = '';
  try {
    const data = JSON.parse(fetchRes.stdout || '{}');
    body = data.body || '(no body)';
  } catch { body = '(could not parse release JSON)'; }
  // ANSI strip + cap 4KB. Control-char regex is intentional -- defangs
  // CHANGELOG bytes fetched over HTTPS so paste into the terminal can't
  // execute escape sequences. (oxlint flags this as no-control-regex; OK.)
  // oxlint-disable no-control-regex
  const stripped = body
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, 4096);
  // oxlint-enable no-control-regex
  console.log(`Changelog for v${r.version}`);
  console.log('');
  console.log(stripped);
  if (body.length > 4096) console.log(`\n... (truncated; full notes at https://github.com/FerroxLabs/ijfw/releases/tag/v${r.version})`);
  process.exit(0);
}

function cmdUpdateAuto(value) {
  const valid = ['on', 'off', 'ask'];
  if (!valid.includes(value)) {
    console.error(`--auto must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }
  const settingsPath = join(ijfwHome(), 'settings.json');
  const settings = readSettings();
  if (!settings.schema_version) settings.schema_version = 1;
  settings.auto_update = value;
  try {
    writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    console.log(`auto_update set to "${value}".`);
  } catch (e) {
    console.error(`could not persist settings.json: ${e.message}`);
    process.exit(1);
  }
}

function cmdUpdateConfirm(token) {
  // Locate pending sentinel under any session in ~/.ijfw/run/
  const runRoot = join(ijfwHome(), 'run');
  if (!existsSync(runRoot)) {
    console.error('No pending update sentinel found. Run `ijfw_update_check` via your AI first to issue a confirm token.');
    process.exit(1);
  }
  let sentinelPath = null;
  let pending = null;
  let sessionId = null;
  let sawPending = false;
  try {
    for (const dir of readdirSync(runRoot)) {
      const candidate = join(runRoot, dir, 'update-pending.json');
      if (!existsSync(candidate)) continue;
      sawPending = true;
      const candidatePending = readJsonSafe(candidate);
      if (candidatePending && candidatePending.token === token) {
        sentinelPath = candidate;
        pending = candidatePending;
        sessionId = dir;
        break;
      }
    }
  } catch { /* */ }
  if (!sentinelPath) {
    console.error(
      sawPending
        ? 'Token mismatch -- run `ijfw_update_check` via your AI to issue a fresh token.'
        : 'No pending update sentinel found. Run `ijfw_update_check` via your AI to issue one.'
    );
    process.exit(1);
  }

  if (!pending || !isVersionStringValid(pending.target_version)) {
    try { rmSync(sentinelPath, { force: true }); } catch { /* */ }
    console.error('Pending update sentinel is malformed -- run `ijfw_update_check` again to issue a fresh one.');
    process.exit(1);
  }
  const tokenCheck = validateToken(sessionId, token);
  if (!tokenCheck.ok || tokenCheck.target_version !== pending.target_version) {
    try { rmSync(sentinelPath, { force: true }); } catch { /* */ }
    const why =
      tokenCheck.error === 'expired' ? 'Token expired' :
      tokenCheck.error === 'already-consumed' ? 'Token already consumed' :
      tokenCheck.error === 'mismatch' ? 'Token mismatch' :
      'Token validation failed';
    console.error(`${why} -- run \`ijfw_update_check\` to issue a fresh token.`);
    process.exit(1);
  }

  if (process.env.IJFW_FROM_MCP === '1') {
    console.error('Refusing: --confirm must be invoked from a terminal, not an MCP-spawned subprocess.');
    process.exit(1);
  }
  console.log(`Confirming update to v${pending.target_version}...`);
  // Hold sentinel through install; remove synchronously on all paths
  // (happy + error + signal). Node does NOT run pending `finally` blocks
  // on SIGINT/SIGTERM by default, so register explicit handlers that
  // scrub the sentinel before exit.
  const scrubAndExit = (sig) => {
    try { rmSync(sentinelPath, { force: true }); } catch { /* */ }
    // Mimic the shell's default exit code for the signal: 128 + signum.
    const signum = sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1;
    process.exit(128 + signum);
  };
  process.on('SIGINT', () => scrubAndExit('SIGINT'));
  process.on('SIGTERM', () => scrubAndExit('SIGTERM'));
  let exitCode = 1;
  try {
    exitCode = cmdUpdateInteractive({ yes: true, _confirmedFromToken: pending.target_version });
  } finally {
    try { rmSync(sentinelPath, { force: true }); } catch { /* */ }
  }
  process.exit(exitCode);
}

function cmdUpdateInteractive(opts = {}) {
  if (process.env.IJFW_FROM_MCP === '1' && opts.yes) {
    console.error('Refusing: `ijfw update --yes` from an MCP-spawned context. Run from your terminal.');
    return 1;
  }
  const state = readState();
  const current = state.installed_version || '0.0.0';
  const r = npmViewVersion('@ijfw/install');
  if (!r.ok) {
    console.error(`Update check failed: ${r.message}`);
    return 1;
  }
  if (opts._confirmedFromToken && r.version !== opts._confirmedFromToken) {
    console.error(
      `Update target changed from v${opts._confirmedFromToken} to v${r.version}. ` +
      'Re-run ijfw_update_check so the terminal confirmation matches the package being installed.'
    );
    return 1;
  }
  const cmp = cmpSemver(current, r.version);
  if (cmp >= 0) {
    console.log(`IJFW is up to date (v${current}). Nothing to do.`);
    return 0;
  }
  console.log(`IJFW update v${current} -> v${r.version}`);
  console.log('');
  // Provenance check (best-effort; report but don't block on transient failures)
  const sig = spawnSync('npm', ['audit', 'signatures', `@ijfw/install@${r.version}`], {
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
  if (sig.status === 0) {
    console.log('  Provenance: verified');
  } else {
    console.log('  Provenance: WARNING -- could not verify signatures');
    if (!opts.yes) {
      console.log('  Continuing requires --yes (acknowledge unverified provenance).');
      return 1;
    }
  }
  // Shasum cross-verify (F-SEC-7): independent second factor on top of
  // npm-side signatures. Fetches the GitHub release asset shasum and
  // compares it against npm's dist.shasum for the same version. Mismatch
  // means we refuse to install; advisory (release shasum unavailable)
  // requires explicit --yes to proceed.
  const shasum = verifyShasumCrossSource(r.version);
  if (shasum.mode === 'verified') {
    console.log(`  Shasum: verified (${shasum.npmShasum.slice(0, 12)}...)`);
  } else if (shasum.mode === 'mismatch') {
    console.error('  Shasum: MISMATCH -- refusing install.');
    console.error(`    npm     : ${shasum.npmShasum}`);
    console.error(`    release : ${shasum.releaseShasum}`);
    console.error('  The npm tarball does NOT match the GitHub release asset.');
    console.error('  This could indicate a compromised registry or release. Aborting.');
    return 1;
  } else if (shasum.mode === 'error') {
    console.error(`  Shasum: error -- ${shasum.message}`);
    console.error('  Refusing install: cannot establish second-factor integrity.');
    return 1;
  } else if (shasum.mode === 'advisory') {
    console.error(`  Shasum: ADVISORY -- ${shasum.message}`);
    if (!opts.yes) {
      console.error('  Continuing requires --yes (acknowledge missing release shasum).');
      return 1;
    }
    console.error('  Proceeding due to --yes; release shasum could not be verified.');
  } else {
    // Unknown mode: fail closed.
    console.error(`  Shasum: unknown mode "${shasum.mode}" -- refusing install.`);
    return 1;
  }
  // Method dispatch
  const method = state.install_method || 'manual';
  console.log(`  install_method: ${method}`);
  let installRes;
  if (method === 'npm-global') {
    console.log('  Running: npm install -g @ijfw/install@latest');
    installRes = spawnSync('npm', ['install', '-g', `@ijfw/install@${r.version}`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (installRes.error) {
      console.error(`npm install -g could not be spawned (${installRes.error.code}). Run \`npm install -g @ijfw/install@${r.version}\` manually.`);
      return 1;
    }
    if (installRes.signal) {
      console.error(`npm install -g killed by ${installRes.signal}. Run \`npm install -g @ijfw/install@${r.version}\` manually.`);
      return 1;
    }
    if (installRes.status !== 0) {
      console.error(`npm install -g did not complete (exit ${installRes.status}). Run \`npm install -g @ijfw/install@${r.version}\` manually.`);
      return 1;
    }
    // npm install -g only refreshes the CLI shim. The mcp-server payload under
    // ~/.ijfw/mcp-server/ comes from the git tree and is only refreshed when
    // ijfw-install runs. Without this, `ijfw update` reports "updated" while
    // the actual MCP tools keep running stale code until the next manual
    // ijfw-install. Auto-invoke ijfw-install so the upgrade self-completes.
    console.log('  Refreshing ~/.ijfw/ via ijfw-install...');
    const refresh = spawnSync('ijfw-install', [], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (refresh.error) {
      console.error(`Auto-refresh could not be spawned (${refresh.error.code}). Run \`ijfw-install\` manually to finish the upgrade.`);
      return 1;
    }
    if (refresh.signal) {
      console.error(`Auto-refresh killed by ${refresh.signal}. Run \`ijfw-install\` manually to finish the upgrade.`);
      return 1;
    }
    if (refresh.status !== 0) {
      console.error(`Auto-refresh did not complete (exit ${refresh.status}). Run \`ijfw-install\` manually to finish the upgrade.`);
      return 1;
    }
  } else if (method === 'git-clone') {
    const repoRoot = repoRootFromCli();
    const installSh = join(repoRoot, 'scripts', 'install.sh');
    console.log('  Running: git pull + scripts/install.sh');
    // Capture stderr explicitly so bug reports include the why -- previously a
    // network/auth/conflict failure surfaced only as "git pull failed".
    const pull = spawnSync('git', ['-C', repoRoot, 'pull', '--ff-only'], { encoding: 'utf8' });
    if (pull.status !== 0) {
      console.error('git pull failed:');
      if (pull.stderr) console.error(pull.stderr.trim().split('\n').map(l => '  ' + l).join('\n'));
      console.error(`  Run \`git -C ${repoRoot} status\` to inspect.`);
      return 1;
    }
    console.log('  Running: npm install --omit=dev --ignore-scripts');
    const npmInstall = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (npmInstall.error) {
      console.error(`npm install could not be spawned (${npmInstall.error.code}). Run \`npm install --omit=dev --ignore-scripts\` in ${repoRoot} manually.`);
      return 1;
    }
    if (npmInstall.signal) {
      console.error(`npm install killed by ${npmInstall.signal}. Run \`npm install --omit=dev --ignore-scripts\` in ${repoRoot} manually.`);
      return 1;
    }
    if (npmInstall.status !== 0) {
      console.error(`npm install did not complete (exit ${npmInstall.status}). Run \`npm install --omit=dev --ignore-scripts\` in ${repoRoot} manually.`);
      return 1;
    }
    // V155-001 (H-002): hardcoded `bash` ENOENTs on Windows where the runtime
    // is `sh.exe` (Git-Bash) or absent. Use shell:true on Windows so the
    // .sh extension dispatches via the registered shebang handler; POSIX
    // keeps the explicit `bash` binary for portability across distros.
    //
    // TS-001 (v1.5.5 Trident security): with shell:true on Windows, the
    // first argument is interpreted by cmd.exe and tokenized on whitespace,
    // `&`, `(`, `)`, `;`, `%`, etc. Paths containing those characters are
    // common on Windows (e.g. `C:\Users\Bob & Alice\...` or
    // `C:\Program Files (x86)\ijfw\...`) — without quotes cmd will execute
    // an unrelated binary or fail confusingly. Same-uid attacker could plant
    // `C:\Users\Bob.exe` and have it picked up first. Quote the path so
    // cmd.exe treats it as a single token.
    installRes = process.platform === 'win32'
      ? spawnSync(`"${installSh}"`, [], { stdio: 'inherit', shell: true })
      : spawnSync('bash', [installSh], { stdio: 'inherit' });
  } else {
    console.log('  Manual install detected -- run: npx @ijfw/install');
    installRes = spawnSync('npx', ['-y', `@ijfw/install@${r.version}`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
  if (!installRes) {
    console.error('Update did not complete (install command could not be spawned)');
    return 1;
  }
  if (installRes.signal) {
    console.error(`Update did not complete (killed by ${installRes.signal}). State not written.`);
    return 1;
  }
  if (installRes.status !== 0) {
    console.error(`Update did not complete (exit ${installRes.status}). State not written.`);
    return 1;
  }
  // V155-001 (A-001 + C-001 + C-002): subprocess exit 0 is "the command did
  // not crash" — NOT "@ijfw/install on disk is now version r.version".
  // Re-verify by reading the installed package.json BEFORE writing state.json.
  // If the filesystem disagrees with what we asked for, refuse the state
  // write and surface a clear actionable error.
  const repoRoot = method === 'git-clone' ? repoRootFromCli() : null;
  const verify = verifyInstallSucceeded({
    method,
    repoRoot: repoRoot || repoRootFromCli(),
    expectedVersion: r.version,
  });
  if (!verify.ok) {
    console.error(`Update did NOT complete: install subprocess exited 0 but filesystem still reports v${verify.actualVersion || 'unknown'} (expected v${r.version}).`);
    console.error(`  Details: ${verify.reason}`);
    console.error('  State not written. Inspect with `ijfw status`; rerun `ijfw update` after diagnosing.');
    return 1;
  }
  // Persist both fields atomically -- single write avoids concurrent-reader inconsistency.
  // last_good_shasum records the shasum we just successfully cross-verified +
  // installed (per docs/SECURITY.md "last_good_shasum is a one-way 'what did
  // we actually install' record"). Only written when shasum was actually
  // verified (mode === 'verified'); advisory paths leave the previous value
  // so we don't poison the record with an unverified hash.
  const stateUpdate = { last_applied_version: r.version, installed_version: r.version };
  if (shasum && shasum.mode === 'verified' && shasum.npmShasum) {
    stateUpdate.last_good_shasum = shasum.npmShasum;
  }
  writeStateFields(stateUpdate);
  console.log('');
  console.log(`IJFW updated to v${r.version}. Run \`ijfw status\` to confirm.`);
  return 0;
}

// `ijfw --version` (pure) and `ijfw --version --verbose` per v3 section MEDIUM
function cmdVersion(opts = {}) {
  const root = repoRootFromCli();
  const pkgPath = join(root, 'installer', 'package.json');
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'unknown'; } catch { /* */ }

  // `ijfw --version` is a stable shell-script contract -- only switch to
  // JSON when --json is explicit. status/doctor follow the gh-CLI convention
  // and auto-JSON on non-TTY, but version stays one-line on pipe.
  if (opts.json) {
    if (!opts.verbose) {
      emitJson({ package: '@ijfw/install', version });
      return;
    }
    const state = readState();
    const settings = readSettings();
    emitJson({
      package: '@ijfw/install',
      version,
      install_method: state.install_method || null,
      installed_at: state.installed_at ? new Date(state.installed_at * 1000).toISOString() : null,
      last_applied: state.last_applied_version || null,
      auto_update: settings.auto_update || 'ask',
      update_check_interval_hours: (settings.update_check && settings.update_check.interval_hours) || 24,
      ijfw_home: ijfwHome(),
    });
    return;
  }

  if (!opts.verbose) {
    console.log(`@ijfw/install@${version}`);
    return;
  }
  const state = readState();
  const settings = readSettings();
  console.log(`@ijfw/install@${version}`);
  console.log(`  install_method: ${state.install_method || '(not recorded)'}`);
  console.log(`  installed_at:   ${state.installed_at ? new Date(state.installed_at * 1000).toISOString() : '(unknown)'}`);
  console.log(`  last_applied:   ${state.last_applied_version || '(none)'}`);
  console.log(`  auto_update:    ${settings.auto_update || 'ask'}`);
  console.log(`  bg update check: every ${settings.update_check && settings.update_check.interval_hours || 24}h`);
  console.log(`  kill switches: IJFW_DISABLE_UPDATE_CHECK={1,true,yes,on}`);
  console.log(`  ijfw home: ${ijfwHome()}`);
}

// 1.1.6b statusline CLI family. Manages the Claude Code statusLine slot
// at ~/.claude/settings.json. Compose-mode allowlist + change-detection per v3 sec 8.

const STATUSLINE_PATH_ALLOWLIST = [
  // Canonical compose targets -- canonicalized at compare time
  '/.claude/', '/.gsd/', '/.ijfw/claude/', '/.cursor/',
];

function statuslineScriptPath() {
  // Where Claude Code reads the statusline command from
  const root = repoRootFromCli();
  return join(root, 'claude', 'hooks', 'scripts', 'ijfw-statusline.js');
}

function readClaudeSettings() {
  const path = join(homedir(), '.claude', 'settings.json');
  return { path, data: readJsonSafe(path) || {} };
}

function writeClaudeSettings(path, data) {
  try {
    writeAtomic(path, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (e) {
    console.error(`could not write ${path}: ${e.message}`);
    return false;
  }
}

function setIjfwStatuslineSetting(field, value) {
  const settingsPath = join(ijfwHome(), 'settings.json');
  const settings = readSettings();
  if (!settings.schema_version) settings.schema_version = 1;
  if (!settings.statusline) settings.statusline = {};
  settings.statusline[field] = value;
  try {
    writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch (e) {
    console.error(`could not persist settings.json: ${e.message}`);
    return false;
  }
}

function isPathInAllowlist(p) {
  if (!p || typeof p !== 'string') return false;
  for (const seg of STATUSLINE_PATH_ALLOWLIST) {
    if (p.includes(seg)) return true;
  }
  return false;
}

function cmdStatusline(sub) {
  switch (sub) {
    case 'status': return statuslineStatus();
    case 'install': return statuslineInstall();
    case 'compose': return statuslineCompose();
    case 'disable': return statuslineDisable();
    case 'recompute': return statuslineRecompute();
    default:
      console.log('Usage: ijfw statusline --install|--compose|--disable|--status|--recompute');
      process.exit(1);
  }
}

function statuslineStatus() {
  const settings = readSettings();
  const claude = readClaudeSettings();
  const claudeStatusline = claude.data.statusLine;

  console.log('IJFW statusline status:');
  console.log(`  IJFW setting: ${(settings.statusline && settings.statusline.enabled) || 'auto'}`);
  console.log(`  IJFW mode:    ${(settings.statusline && settings.statusline.mode) || 'compose'}`);
  if (claudeStatusline) {
    const cmd = claudeStatusline.command || '(none)';
    const owner = cmd.includes('ijfw-statusline.js') ? 'IJFW'
      : isPathInAllowlist(cmd) ? 'allowlisted (compose-eligible)'
      : 'unknown (will skip on next install)';
    console.log(`  Claude statusLine: ${cmd}`);
    console.log(`  Owner classification: ${owner}`);
  } else {
    console.log('  Claude statusLine: (not set)');
  }
  console.log('');
  console.log('Run ijfw statusline --install to take ownership, --compose to coexist with another tool, --disable to remove.');
}

function statuslineInstall() {
  const ijfwScript = statuslineScriptPath();
  if (!existsSync(ijfwScript)) {
    console.error(`statusline script not found at ${ijfwScript}`);
    process.exit(1);
  }
  const claude = readClaudeSettings();
  const prev = claude.data.statusLine;
  if (prev && prev.command && !prev.command.includes('ijfw-statusline.js')) {
    console.log(`Existing statusLine found: ${prev.command}`);
    console.log(`  -> backing up to ~/.claude/settings.json (statusLine field replaced)`);
  }
  claude.data.statusLine = { type: 'command', command: `node ${ijfwScript}` };
  if (writeClaudeSettings(claude.path, claude.data)) {
    setIjfwStatuslineSetting('enabled', 'on');
    setIjfwStatuslineSetting('mode', 'own');
    console.log(`statusline installed -- IJFW now owns the slot.`);
    console.log(`Open a new Claude Code session to see it.`);
  }
}

function statuslineCompose() {
  const claude = readClaudeSettings();
  const prev = claude.data.statusLine;
  if (!prev || !prev.command) {
    console.error('No existing statusLine to compose with. Run --install instead.');
    process.exit(1);
  }
  if (prev.command.includes('ijfw-statusline.js')) {
    console.log('IJFW already owns the slot. Nothing to compose with.');
    return;
  }
  if (!isPathInAllowlist(prev.command)) {
    console.error(`Existing statusLine command not in allowlist for safe compose: ${prev.command}`);
    console.error('Refusing for security. Use --install to replace, or contact the existing tool maintainer.');
    process.exit(1);
  }
  // Persist compose target (the IJFW script reads this from settings.json)
  setIjfwStatuslineSetting('mode', 'compose');
  setIjfwStatuslineSetting('composed_command', prev.command);
  setIjfwStatuslineSetting('enabled', 'on');
  // Wrap the existing command so IJFW renders alongside it
  const ijfwScript = statuslineScriptPath();
  claude.data.statusLine = { type: 'command', command: `node ${ijfwScript}` };
  if (writeClaudeSettings(claude.path, claude.data)) {
    console.log(`statusline composed -- IJFW renders alongside ${prev.command}.`);
    console.log('Open a new Claude Code session to see it.');
  }
}

function statuslineDisable() {
  const claude = readClaudeSettings();
  const prev = claude.data.statusLine;
  if (prev && prev.command && prev.command.includes('ijfw-statusline.js')) {
    delete claude.data.statusLine;
    writeClaudeSettings(claude.path, claude.data);
  }
  setIjfwStatuslineSetting('enabled', 'off');
  console.log('statusline disabled.');
}

function statuslineRecompute() {
  // Force statusline to re-read everything (cache + settings) -- a no-op for
  // the script itself (it reads on every invocation), but useful as a UX hook
  // after the user changes settings.json manually.
  console.log('statusline will re-read cache + settings on the next render.');
  console.log('Open a new Claude Code session to see the change.');
}

function cmdConfig(sub) {
  if (sub === 'audit') {
    console.log('ijfw config --audit -- this feature is queued for a later release.');
    console.log('Track progress: https://github.com/FerroxLabs/ijfw/issues');
    return;
  }
  console.log('Usage: ijfw config --audit');
  console.log('  --audit   Show the active configuration resolution hierarchy (queued for a later release).');
}

function cmdInsight(sub) {
  // Alias for `ijfw dashboard start` -- context-mode parity per v3 CLI table.
  cmdDashboard(sub === 'start' || !sub ? 'start' : sub);
}

// ---------------------------------------------------------------------------
// Receipt -- `ijfw receipt last`  (polish 8)
// ---------------------------------------------------------------------------
//
// Prints a redacted, shareable block from the most recent Trident run.
// Strips absolute paths + project basenames so the user can paste it in
// PR comments / Slack without leaking environment detail.

const RECEIPT_SUBS = new Set(['last']);

function cmdReceipt(sub = 'last') {
  if (!RECEIPT_SUBS.has(sub)) {
    console.log(`Unknown receipt sub-command: ${sub}`);
    console.log(`Usage: ijfw receipt <${[...RECEIPT_SUBS].join('|')}>`);
    process.exit(1);
  }
  const receipts = readReceipts(process.cwd());
  if (receipts.length === 0) {
    console.log('No Trident runs on record yet. Try `ijfw cross audit <file>` first.');
    return;
  }
  const last = receipts[receipts.length - 1];
  // Receipts schema: { findings: { items: [...] } }. Earlier draft read
  // merged.findings -- caught by Trident audit on the polish pass.
  const findings = Array.isArray(last.findings?.items) ? last.findings.items : [];
  const auditors = Array.isArray(last.auditors)
    ? last.auditors.map(a => a.id).filter(Boolean)
    : [];

  const lines = [];
  lines.push('```');
  lines.push(`Trident -- ${last.mode || 'audit'} -- ${(last.timestamp || '').slice(0, 10)}`);
  lines.push(`Auditors: ${auditors.join(', ') || 'n/a'}`);
  lines.push(`Findings: ${findings.length}`);
  for (const f of findings.slice(0, 5)) {
    const sev = f.severity ? `[${String(f.severity).toLowerCase()}] ` : '';
    const claim = redact(String(f.claim || f.issue || ''));
    if (claim) lines.push(`  ${sev}${claim.slice(0, 140)}`);
  }
  if (findings.length > 5) lines.push(`  ... ${findings.length - 5} more.`);
  lines.push(`Receipt: ijfw status`);
  lines.push('```');
  console.log(lines.join('\n'));
}

// Redact absolute paths + git directories so the receipt is safe to paste.
function redact(s) {
  return s
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/\/var\/folders\/[^/]+\/[^/]+\/T\//g, '/tmp/')
    .replace(/\/run\/user\/\d+\//g, '/run/user/<uid>/')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/g, '%USERPROFILE%');
}

// ---------------------------------------------------------------------------
// ijfw help -- open the full guide (terminal paged or rendered HTML)
// ---------------------------------------------------------------------------
async function handleGuide(useBrowser) {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(__dir, '..', '..', 'docs', 'GUIDE.md'),
    resolve(__dir, '..', '..', '..', 'docs', 'GUIDE.md'),
    join(homedir(), '.ijfw', 'docs', 'GUIDE.md'),
  ];
  const guidePath = candidates.find(p => existsSync(p));
  if (!guidePath) {
    console.error('[ijfw] Guide not found. Visit https://github.com/FerroxLabs/ijfw/blob/main/docs/GUIDE.md');
    process.exit(1);
  }
  const md = readFileSync(guidePath, 'utf8');

  if (useBrowser) {
    const outDir = join(homedir(), '.ijfw', 'guide');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, 'index.html');
    const esc = md.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>IJFW Guide</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown-dark.min.css">
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<style>
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:2rem}
.markdown-body{max-width:1000px;margin:0 auto;padding:2.5rem 3rem;background:#161b22;border-radius:12px;border:1px solid #30363d}
img{max-width:100%;border-radius:8px}
.brand{position:fixed;top:1rem;right:1.25rem;font-size:0.8rem;color:#8b949e;font-family:'SF Mono',Menlo,monospace}
</style></head>
<body>
<div class="brand">ijfw help --browser</div>
<article class="markdown-body" id="content"></article>
<script>
// Trusted source: GUIDE.md is shipped with IJFW; no user input in this path.
const md = \`${esc}\`;
const host = document.getElementById('content');
const range = document.createRange();
range.selectNodeContents(host);
host.appendChild(range.createContextualFragment(marked.parse(md)));
</script></body></html>`;
    writeFileSync(outFile, html);
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32'  ? 'start'
                 : 'xdg-open';
    spawnSync(opener, [outFile], { stdio: 'ignore', detached: true });
    console.log(`[ijfw] Guide rendered to ${outFile}`);
    return;
  }

  // Terminal: pipe through less -R when available + interactive, else dump to stdout.
  // If less exits non-zero (e.g. user hits q, or less is broken), fall back to
  // plain stdout so the content is never silently swallowed.
  const lessAvailable = spawnSync('less', ['--version'], { stdio: 'ignore' }).status === 0;
  if (lessAvailable && process.stdout.isTTY) {
    const lessRes = spawnSync('less', ['-R'], { input: md, stdio: ['pipe', 'inherit', 'inherit'] });
    if (lessRes.status !== 0 && lessRes.status !== null) {
      process.stdout.write(md);
    }
  } else {
    process.stdout.write(md);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Only dispatch when run directly. When imported as a module (e.g. by tests),
// skip the CLI entry so the test runner can use exported helpers.

// Two-layer check:
//   1. pathToFileURL normalizes Windows drive paths (C:\...) and MSYS-style
//      paths (/c/...) into the same file:///C:/... form that import.meta.url
//      uses on Git Bash / MINGW64, where literal string interpolation breaks.
//   2. Realpath fallback for macOS symlink hops (/tmp -> /private/tmp etc.)
//      that would otherwise make a string-equality check spuriously false.
const isMainModule = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    let argvPath = process.argv[1];
    let metaPath = fileURLToPath(import.meta.url);
    try { argvPath = realpathSync(argvPath); } catch { /* */ }
    try { metaPath = realpathSync(metaPath); } catch { /* */ }
    return argvPath === metaPath;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const parsed = parseArgs(process.argv);

  if (parsed.cmd === 'guide') {
    await handleGuide(parsed.browser);
    process.exit(0);
  }

  if (parsed.cmd === 'help') {
    // v1.5.1 W1.D+E: orchestrator-side help is handled by the installer
    // (`ijfw --help` for the primary surface, `ijfw commands` for full).
    // Print a pointer instead of the old stale Usage block.
    console.log('Run `ijfw --help` for the user-facing command list, or `ijfw commands` for the full surface.');
    process.exit(0);
  }

  if (parsed.cmd === 'memory-help') {
    printMemoryHelp();
    process.exit(0);
  }

  if (parsed.cmd === 'memory-unknown') {
    console.error(`Unknown memory subcommand: ${parsed.sub}`);
    console.error('');
    printMemoryHelp();
    process.exit(1);
  }

  if (parsed.cmd === 'status') {
    cmdStatus(process.cwd(), parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'demo') {
    cmdDemo().catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'cross') {
    cmdCross(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'cross-project-audit') {
    cmdCrossProjectAudit(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'command-alias') {
    cmdCommandAlias(parsed.alias);
  } else if (parsed.cmd === 'metrics-benchmark') {
    cmdMetricsBenchmark(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'import') {
    cmdImport(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'doctor') {
    cmdDoctor(parsed);
  } else if (parsed.cmd === 'update') {
    cmdUpdate(parsed);
  } else if (parsed.cmd === 'version') {
    cmdVersion(parsed);
  } else if (parsed.cmd === 'statusline') {
    cmdStatusline(parsed.sub);
  } else if (parsed.cmd === 'config') {
    cmdConfig(parsed.sub);
  } else if (parsed.cmd === 'insight') {
    cmdInsight(parsed.sub);
  } else if (parsed.cmd === 'receipt') {
    cmdReceipt(parsed.sub);
  } else if (parsed.cmd === 'purge-receipts') {
    cmdPurgeReceipts(process.cwd());
  } else if (parsed.cmd === 'install') {
    cmdInstall();
  } else if (parsed.cmd === 'uninstall') {
    cmdUninstall();
  } else if (parsed.cmd === 'preflight') {
    cmdPreflight();
  } else if (parsed.cmd === 'dashboard') {
    cmdDashboard(parsed.sub);
  } else if (parsed.cmd === 'design') {
    cmdDesign(parsed.sub);
  } else if (parsed.cmd === 'ui-review') {
    cmdUiReview(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'blackboard') {
    cmdBlackboard(parsed.sub);
  } else if (parsed.cmd === 'team') {
    cmdTeam(parsed.sub);
  } else if (parsed.cmd === 'override') {
    cmdOverride(parsed.sub, parsed.rest || []);
  } else if (parsed.cmd === 'extension') {
    cmdExtension(parsed.sub, parsed.rest || []);
  } else if (parsed.cmd === 'swarm') {
    cmdSwarm(parsed.sub);
  } else if (parsed.cmd === 'codex') {
    cmdCodex(parsed.sub);
  } else if (parsed.cmd === 'memory-checkpoint') {
    cmdMemoryCheckpoint(parsed.label);
  } else if (parsed.cmd === 'memory-reindex') {
    cmdMemoryReindex(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'env') {
    cmdEnv();
  } else if (parsed.cmd === 'recover') {
    cmdRecover(parsed.sub);
  } else if (parsed.cmd === 'personalize') {
    cmdPersonalize(parsed.sub, parsed.rest || []).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'worktree') {
    // Top-level alias forwarding to `swarm worktree`. cmdSwarmWorktree reads its
    // own sub + args from the parsed tail (not process.argv) so the alias and
    // the canonical `swarm worktree` path stay identical.
    cmdSwarmWorktree(parsed.sub, parsed.rest || []);
  } else {
    // v1.5.1 W1.D+E: clean unknown-command message; no stale usage dump.
    printUnknownCommand(parsed.raw);
    process.exit(1);
  }
}

// --- install / uninstall / preflight / dashboard ---
// These shell out to the existing scripts/installer modules so there is one
// CLI entry point that covers every command named in the README, regardless
// of how the user installed (git clone + install.sh OR npm @ijfw/install).
// Resolve internal assets across both the repo-clone layout and the
// post-install ~/.ijfw layout. Same shape as installer/src/ijfw.js findInTree.
// Without this, dispatch paths fail for any user whose CLI shim originates
// from npm-global without a sibling scripts/ tree.
function repoRootFromCli() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}
function findCliAsset(...rel) {
  // F-C-4 (Lens 3): probe XDG_DATA_HOME and XDG_CONFIG_HOME in addition to
  // ~/.ijfw and IJFW_HOME. Users who installed via a distro-aware packager
  // (e.g. dotfiles repo, nix, distro RPM, or any wrapper that honours XDG
  // base-dir spec) land their ijfw tree under $XDG_DATA_HOME/ijfw rather
  // than ~/.ijfw, and were silently invisible to the doctor fallback.
  const xdgData = process.env.XDG_DATA_HOME;
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const candidates = [
    join(repoRootFromCli(), ...rel),
    process.env.IJFW_HOME ? join(process.env.IJFW_HOME, ...rel) : null,
    join(homedir(), '.ijfw', ...rel),
    xdgData ? join(xdgData, 'ijfw', ...rel) : null,
    xdgConfig ? join(xdgConfig, 'ijfw', ...rel) : null,
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}
function cmdInstall() {
  const script = findCliAsset('scripts', 'install.sh');
  if (!script) {
    console.error('install.sh not found. Run `ijfw-install` to deploy ~/.ijfw/, or set IJFW_HOME to your IJFW tree.');
    process.exit(1);
  }
  const res = spawnSync('bash', [script, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}
function cmdUninstall() {
  const script = findCliAsset('installer', 'src', 'uninstall.js');
  if (!script) {
    console.error('uninstall.js not found. Remove ~/.ijfw manually and strip ijfw keys from ~/.claude/settings.json.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}
function cmdPreflight() {
  const script = findCliAsset('installer', 'src', 'preflight.js');
  if (!script) {
    console.error('preflight.js not found. Run `ijfw-install` to deploy ~/.ijfw/, or set IJFW_HOME to your IJFW tree.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}
function cmdDashboard(sub) {
  // `ijfw dashboard start|stop|status` is the localhost SSE web dashboard
  // documented in the README (binds 127.0.0.1:37891, port-walks to 37900).
  // It is served by mcp-server/bin/ijfw-dashboard, NOT scripts/dashboard/bin.js
  // (that one is the terminal text digest, surfaced via `ijfw status`). Routing
  // `dashboard` at the text renderer silently no-op'd start/stop/status: the
  // web server never bound and stop/status never reported true state.
  const launcher = findCliAsset('mcp-server', 'bin', 'ijfw-dashboard');
  if (!launcher) {
    console.error('Dashboard server not found. Run `ijfw-install` to deploy ~/.ijfw/, or set IJFW_HOME to your IJFW tree.');
    process.exit(1);
  }
  // Forward the verb plus any passthrough flags (--no-open, --port N) supplied
  // after `dashboard` on the command line, so the launcher's own argv handling
  // stays authoritative. argv = [node, cli, 'dashboard', <sub>, ...flags].
  const passthrough = process.argv.slice(4);
  const res = spawnSync(process.execPath, [launcher, sub, ...passthrough], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

function dashboardPort() {
  try {
    const n = Number.parseInt(readFileSync(join(homedir(), '.ijfw', 'dashboard.port'), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 37891;
  } catch {
    return 37891;
  }
}

function openDesignUrl(url) {
  if (process.env.CI || process.env.NO_OPEN) return;
  const res = process.platform === 'darwin'
    ? spawnSync('open', [url], { stdio: 'ignore' })
    : process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
      : spawnSync('xdg-open', [url], { stdio: 'ignore' });
  return res.status ?? 0;
}

// v1.5.0 wire-W1.D — `ijfw ui-review` production CLI. Wires the 7-pillar
// audit runner into a user-facing command. Args:
//   --spec <UI-SPEC.md path>           required
//   --scope <comma-sep dirs>           required (e.g. "src,components")
//   --no-write                         skip writing UI-REVIEW.md (preview mode)
//   --gc-sketches                      run sketches-gc as the finalizer
//   --peer-inputs <json-path>          optional axe / lighthouse / playwright
//                                      pre-computed outputs (JSON file)
//   --json                             machine-readable output (skip narrative)
async function cmdUiReview(parsed) {
  if (!parsed.spec) {
    console.error('Usage: ijfw ui-review --spec <UI-SPEC.md> --scope <dirs> [--no-write] [--gc-sketches] [--peer-inputs <path>]');
    process.exit(1);
  }
  if (!parsed.scope) {
    console.error('ui-review: --scope is required (comma-separated dirs, e.g. "src,components")');
    process.exit(1);
  }
  const specPath = isAbsolute(parsed.spec) ? parsed.spec : resolve(process.cwd(), parsed.spec);
  if (!existsSync(specPath)) {
    console.error(`ui-review: UI-SPEC not found at ${specPath}`);
    process.exit(1);
  }

  let peerInputs = {};
  if (parsed.peerInputs) {
    const ppath = isAbsolute(parsed.peerInputs) ? parsed.peerInputs : resolve(process.cwd(), parsed.peerInputs);
    try { peerInputs = JSON.parse(readFileSync(ppath, 'utf8')); }
    catch (err) {
      console.error(`ui-review: failed to read --peer-inputs JSON: ${err.message}`);
      process.exit(1);
    }
  }

  const { runUiReview } = await import('./lib/ui-review-runner.js');
  const result = await runUiReview({
    uiSpecPath: specPath,
    sourceScope: parsed.scope,
    projectRoot: process.cwd(),
    peerInputs,
    write: parsed.write !== false,
    gcSketches: !!parsed.gcSketches,
  });

  if (parsed.json) {
    console.log(JSON.stringify({
      topVerdict: result.topVerdict,
      pillarVerdicts: result.pillarVerdicts,
      reviewPath: result.reviewPath,
      parallel: result.parallel,
    }, null, 2));
  } else {
    console.log(`UI review: top-level ${result.topVerdict}`);
    for (const [pillar, verdict] of Object.entries(result.pillarVerdicts)) {
      console.log(`  - ${pillar.padEnd(12)} ${verdict}`);
    }
    if (result.reviewPath) console.log(`Review written to: ${result.reviewPath}`);
    console.log(`Parallel grader run: wall=${result.parallel.wallMs}ms parallelism=${result.parallel.parallelism}`);
  }
  // Exit code: PASS=0, FLAG=0 (advisory), BLOCK=2 (ship-blocker)
  process.exit(result.topVerdict === 'BLOCK' ? 2 : 0);
}

function cmdDesign(sub) {
  const contentDir = join(homedir(), '.ijfw', 'design-companion', 'content');
  mkdirSync(contentDir, { recursive: true });

  if (sub === 'start' || sub === 'open') {
    const dash = findCliAsset('mcp-server', 'bin', 'ijfw-dashboard');
    if (!dash) {
      console.error('Design companion server not found. Run `ijfw-install` to deploy ~/.ijfw/, or set IJFW_HOME to your IJFW tree.');
      process.exit(1);
    }
    const noOpen = process.argv.includes('--no-open');
    const res = spawnSync(process.execPath, [dash, 'start', '--no-open'], { stdio: sub === 'start' ? 'inherit' : 'ignore' });
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
    const url = `http://localhost:${dashboardPort()}/design`;
    if (!noOpen) openDesignUrl(url);
    console.log(`Design companion running at ${url}`);
    process.exit(0);
  }

  if (sub === 'status' || sub === 'stop') {
    const dash = findCliAsset('mcp-server', 'bin', 'ijfw-dashboard');
    if (!dash) {
      console.error('Design companion server not found. Run `ijfw-install` to deploy ~/.ijfw/, or set IJFW_HOME to your IJFW tree.');
      process.exit(1);
    }
    const res = spawnSync(process.execPath, [dash, sub === 'status' ? 'status' : 'stop'], { stdio: 'inherit' });
    if (sub === 'status' && (res.status ?? 1) === 0) console.log(`Design companion URL: http://localhost:${dashboardPort()}/design`);
    process.exit(res.status ?? 0);
  }

  if (sub === 'push') {
    const filePaths = process.argv.slice(4);
    if (filePaths.length === 0) {
      console.error('Usage: ijfw design push <file.html> [more.html ...]');
      process.exit(1);
    }
    for (const filePath of filePaths) {
      const abs = resolve(filePath);
      if (!abs.toLowerCase().endsWith('.html')) {
        console.error('Design companion accepts standalone .html files.');
        process.exit(1);
      }
      if (!existsSync(abs)) {
        console.error(`File not found: ${abs}`);
        process.exit(1);
      }
      const dest = join(contentDir, basename(abs));
      copyFileSync(abs, dest);
      console.log(`Design pushed: ${dest}`);
    }
    console.log(`Preview: http://localhost:${dashboardPort()}/design`);
    process.exit(0);
  }

  if (sub === 'clear') {
    for (const f of readdirSync(contentDir)) rmSync(join(contentDir, f), { force: true });
    console.log('Design companion content cleared.');
    process.exit(0);
  }

  if (sub === 'init') {
    const path = join(process.cwd(), 'DESIGN.md');
    if (existsSync(path) && !process.argv.includes('--force')) {
      console.log(`DESIGN.md already exists: ${path}`);
      console.log('Use --force to replace it.');
      process.exit(1);
    }
    const name = optionValue(process.argv.slice(4), ['--name']) || basename(process.cwd());
    const direction = optionValue(process.argv.slice(4), ['--direction']) || '';
    writeFileSync(path, initialDesignMarkdown({ projectName: name, direction }), { mode: 0o644 });
    console.log(`Created ${path}`);
    process.exit(0);
  }

  if (DESIGN_ACTIONS.includes(sub)) {
    const context = loadDesignContext(process.cwd());
    const target = optionValue(process.argv.slice(4), ['--file', '-f']);
    const guide = designActionGuide(sub, context);
    console.log(`Design ${sub}`);
    console.log(`DESIGN.md: ${context.exists ? context.path : 'not found'}`);
    for (const line of guide.guidance) console.log(`- ${line}`);
    console.log(`- ${guide.reminder}`);
    if (context.exists) {
      console.log('');
      console.log(context.summary);
    }
    if (sub === 'audit' && target) {
      const abs = resolve(target);
      if (!existsSync(abs)) {
        console.error(`File not found: ${abs}`);
        process.exit(1);
      }
      const audit = auditDesignText(readFileSync(abs, 'utf8'));
      console.log('');
      console.log(`Static audit: ${audit.summary}`);
      for (const item of audit.findings) console.log(`- [${item.severity}] ${item.rule}: ${item.message}`);
    }
    process.exit(0);
  }

  console.log('Usage: ijfw design start [--no-open] | open | status | stop | push <file.html> [more.html ...] | clear | init [--force] [--name <name>] [--direction <text>] | plan|audit|critique|polish|normalize|bolder|quieter|handoff [--file <artifact>]');
  process.exit(1);
}

function optionValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && args[i + 1]) return args[i + 1];
    for (const name of names) {
      const prefix = `${name}=`;
      if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
    }
  }
  return null;
}

function printBlackboardStatus(status) {
  console.log(`Blackboard: ${status.initialized ? status.dir : 'not initialized'}`);
  console.log(`Tasks: ${status.tasks.open} open / ${status.tasks.total} total`);
  console.log(`Claims: ${status.claims.active} active / ${status.claims.total} total`);
  for (const claim of status.claims.active_items) {
    const claimPaths = claim.paths.length ? ` (${claim.paths.join(', ')})` : '';
    console.log(`  ${claim.artifact_id} -> ${claim.agent}${claimPaths}`);
  }
  const blockerCount = status.recent.blockers.length;
  if (blockerCount) console.log(`Recent blockers: ${blockerCount}`);
  if (status.health.tasks !== 'ok' || status.health.claims !== 'ok') {
    console.log(`Health: tasks=${status.health.tasks}, claims=${status.health.claims}`);
  }
}

function cmdBlackboard(sub) {
  const args = process.argv.slice(4);

  if (sub === 'init') {
    const result = initBlackboard(process.cwd());
    console.log(`Blackboard initialized: ${result.dir}`);
    process.exit(0);
  }

  if (sub === 'status') {
    printBlackboardStatus(blackboardStatus(process.cwd()));
    process.exit(0);
  }

  if (sub === 'claim') {
    const artifact = optionValue(args, ['--artifact', '-a']) || args[0];
    const owner = optionValue(args, ['--owner', '-o']);
    const paths = optionValue(args, ['--paths', '-p']);
    const note = optionValue(args, ['--note']);
    const result = claimArtifact(process.cwd(), { artifact, owner, paths, note });
    if (!result.ok) {
      if (result.error === 'conflict') {
        console.error(`Claim conflict for ${artifact}:`);
        for (const conflict of result.conflicts) {
          console.error(`  ${(conflict.artifact_id || conflict.artifact)} -> ${(conflict.agent || conflict.owner)}`);
        }
      } else {
        console.error(`Claim failed: ${result.error}`);
      }
      process.exit(1);
    }
    console.log(`Claimed ${result.claim.artifact_id} for ${result.claim.agent}`);
    process.exit(0);
  }

  if (sub === 'release') {
    const artifact = optionValue(args, ['--artifact', '-a']) || args[0];
    const owner = optionValue(args, ['--owner', '-o']);
    const result = releaseClaim(process.cwd(), { artifact, owner });
    if (!result.ok) {
      console.error(`Release failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`Released ${result.released} claim(s) for ${artifact}`);
    process.exit(0);
  }

  if (sub === 'note' || sub === 'finding' || sub === 'decision' || sub === 'blocker') {
    const kind = sub === 'note' ? (optionValue(args, ['--kind', '-k']) || 'note') : sub;
    const author = optionValue(args, ['--author', '--owner', '-o']) || 'cli';
    const artifact = optionValue(args, ['--artifact', '-a']);
    const message = optionValue(args, ['--message', '-m']) || args.filter((arg) => !arg.startsWith('--')).join(' ');
    const result = addBlackboardNote(process.cwd(), { kind, author, artifact, message });
    if (!result.ok) {
      console.error(`Note failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`Recorded ${result.entry.kind}: ${result.entry.message}`);
    process.exit(0);
  }

  if (sub === 'handoff') {
    const message = optionValue(args, ['--message', '-m']) || args.join(' ');
    const result = writeHandoff(process.cwd(), message);
    if (!result.ok) {
      console.error(`Handoff failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`Handoff written: ${result.path}`);
    process.exit(0);
  }

  console.log('Usage: ijfw blackboard init | status | claim --artifact <id> --owner <agent> [--paths <globs>] | release --artifact <id> [--owner <agent>] | note|finding|decision|blocker --message <text> | handoff --message <markdown>');
  process.exit(1);
}

function cmdTeam(sub) {
  const args = process.argv.slice(4);
  if (sub === 'init' || sub === 'create') {
    const archetype = optionValue(args, ['--archetype', '--type', '-t']);
    const teamName = optionValue(args, ['--name']);
    // F-FUN-1: --brief lets the Discovery hand-off carry domain signal
    // when filesystem detection would otherwise collapse to mixed/unknown.
    const brief = optionValue(args, ['--brief', '-b']) || '';
    const force = args.includes('--force');
    const result = createTeamAssembly(process.cwd(), { archetype, teamName, brief, force });
    if (!result.ok) {
      if (result.error === 'exists') {
        console.error('Team assembly already exists. Re-run with --force to replace .ijfw/team/charter.json and workflow.json.');
      } else {
        console.error(`Team assembly failed: ${result.error}`);
      }
      process.exit(1);
    }
    console.log(`Team ready: ${result.team_name}`);
    console.log(`Archetype: ${result.archetype}`);
    console.log(`Agents: ${result.agentFiles.length} saved to ${result.agentsDir}`);
    if (result.codexAgents?.ok) console.log(`Codex agents: ${result.codexAgents.count} saved to ${result.codexAgents.agentsDir}`);
    console.log(`Charter: ${result.charterPath}`);
    console.log(`Workflow: ${result.workflowPath}`);
    createCheckpoint(process.cwd(), 'team-init', { actor: 'ijfw', message: 'Team assembly initialized' });
    process.exit(0);
  }

  if (sub === 'status') {
    const state = readTeamAssembly(process.cwd());
    if (!state.ok) {
      console.log('No complete team assembly found. Run: ijfw team init');
      if (state.validation.charter.errors.length) console.log(`Charter: ${state.validation.charter.errors.join('; ')}`);
      if (state.validation.workflow.errors.length) console.log(`Workflow: ${state.validation.workflow.errors.join('; ')}`);
      process.exit(1);
    }
    console.log(`Team: ${state.charter.team_name}`);
    console.log(`Archetypes: ${state.charter.project_archetypes.join(', ')}`);
    console.log(`Roles: ${state.charter.roles.map((role) => role.name).join(', ')}`);
    console.log(`Artifacts: ${state.workflow.artifacts.length}`);
    console.log(`Agents: ${state.agents.length} in ${state.agentsDir}`);
    process.exit(0);
  }

  // F-FUN-4 (audit-MED-teams-#7): ijfw team list -- enumerate roles.
  if (sub === 'list') {
    const result = listTeamRoles(process.cwd());
    if (!result.ok) {
      console.error(`team list failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`Team: ${result.team_name || '(unnamed)'}`);
    if (result.project_archetypes.length) console.log(`Archetypes: ${result.project_archetypes.join(', ')}`);
    console.log(`Roles (${result.roles.length}):`);
    for (const role of result.roles) {
      console.log(`  - ${role.name} [${role.role_type}] model=${role.model} effort=${role.effort}`);
    }
    process.exit(0);
  }

  // F-FUN-4: ijfw team add <role-name> --charter <path>
  if (sub === 'add') {
    const name = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const charterPath = optionValue(args, ['--charter', '-c']);
    if (!charterPath) {
      console.error('Usage: ijfw team add <role-name> --charter <path-to-role.json>');
      process.exit(1);
    }
    const result = addTeamRole(process.cwd(), { charterPath });
    if (!result.ok) {
      console.error(`team add failed: ${result.error}`);
      if (result.errors) result.errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    }
    console.log(`Added role: ${result.role.name}`);
    if (name && name !== result.role.name) {
      console.log(`  note: charter declared name "${result.role.name}", ignoring CLI argument "${name}"`);
    }
    if (result.codex?.ok) console.log(`Codex agents resynced: ${result.codex.count} (${result.codex.skipped ?? 0} unchanged)`);
    process.exit(0);
  }

  // F-FUN-4: ijfw team remove <role-name>
  if (sub === 'remove' || sub === 'rm') {
    const name = args[0] && !args[0].startsWith('--') ? args[0] : null;
    if (!name) {
      console.error('Usage: ijfw team remove <role-name>');
      process.exit(1);
    }
    const result = removeTeamRole(process.cwd(), { name });
    if (!result.ok) {
      console.error(`team remove failed: ${result.error}`);
      if (result.errors) result.errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    }
    console.log(`Removed role: ${result.removed}`);
    if (result.codex?.ok) console.log(`Codex agents resynced: ${result.codex.count} (${result.codex.skipped ?? 0} unchanged)`);
    process.exit(0);
  }

  // F-FUN-4: ijfw team swap <old-role-name> --charter <path>
  if (sub === 'swap') {
    const oldName = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const charterPath = optionValue(args, ['--charter', '-c']);
    if (!oldName || !charterPath) {
      console.error('Usage: ijfw team swap <old-role-name> --charter <path-to-role.json>');
      process.exit(1);
    }
    const result = swapTeamRole(process.cwd(), { oldName, charterPath });
    if (!result.ok) {
      console.error(`team swap failed: ${result.error}`);
      if (result.errors) result.errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    }
    console.log(`Swapped ${result.swapped.old} -> ${result.swapped.new}`);
    if (result.codex?.ok) console.log(`Codex agents resynced: ${result.codex.count} (${result.codex.skipped ?? 0} unchanged)`);
    process.exit(0);
  }

  // F-FUN-5 (audit-MED-teams-#13): ijfw team check -- standalone validator.
  if (sub === 'check' || sub === 'validate') {
    const report = checkTeamAssembly(process.cwd());
    if (report.ok) {
      console.log(`Team assembly OK: ${report.role_count} role(s), ${report.artifact_count} artifact(s)`);
      process.exit(0);
    }
    console.error('Team assembly has issues:');
    if (!report.has_charter || !report.charter.ok) {
      console.error('  charter.json:');
      for (const err of report.charter.errors) console.error(`    - ${err}`);
    }
    if (!report.has_workflow || !report.workflow.ok) {
      console.error('  workflow.json:');
      for (const err of report.workflow.errors) console.error(`    - ${err}`);
    }
    process.exit(1);
  }

  console.log('Usage: ijfw team init [--archetype <type>] [--name <team-name>] [--force] | status | list | add <role> --charter <path> | remove <role> | swap <old> --charter <path> | check');
  process.exit(1);
}

function cmdCodex(sub) {
  if (sub === 'sync-agents') {
    const result = syncCodexAgents(process.cwd());
    if (!result.ok) {
      console.log(`Codex agent sync halted: ${result.error}`);
      console.log('Run: ijfw team init');
      process.exit(1);
    }
    console.log(`Codex agents synced: ${result.count}`);
    console.log(`Directory: ${result.agentsDir}`);
    process.exit(0);
  }

  if (sub === 'doctor' || sub === 'status') {
    const result = codexDoctor(process.cwd());
    console.log('IJFW Codex doctor');
    for (const item of result.checks) {
      const mark = item.ok ? '[ ok ]' : item.required ? '[ !! ]' : '[ .. ]';
      console.log(`  ${mark} ${item.name} -- ${item.message}`);
      if (!item.ok && item.fix) console.log(`         fix: ${item.fix}`);
    }
    process.exit(result.ok ? 0 : 1);
  }

  console.log('Usage: ijfw codex doctor | sync-agents');
  process.exit(1);
}

// F4.1/F4.2: resolve the canonical IJFW version with explicit source labelling
// and a corrupt-vs-missing distinction. Exported so the codex-doctor tests can
// exercise the fallback matrix without spawning the CLI against synthetic
// repo trees. Inputs are absolute paths (or null) so callers can stub them.
//
// Returns: { canonicalVersion, canonicalSource, canonicalParseError } where
//   canonicalVersion : string | null  (first source whose JSON parses)
//   canonicalSource  : 'installer' | 'mcp-server' | null
//   canonicalParseError : string | null  (only set if installer pkg corrupt)
export function resolveCanonicalVersion({ installerPkg, selfPkg } = {}) {
  let canonicalVersion = null;
  let canonicalSource = null;
  let canonicalParseError = null;
  for (const [src, p] of [['installer', installerPkg], ['mcp-server', selfPkg]]) {
    if (!p || !existsSync(p)) continue;
    let raw;
    try {
      raw = readFileSync(p, 'utf8');
    } catch { continue; }
    try {
      canonicalVersion = JSON.parse(raw).version;
      canonicalSource = src;
      break;
    } catch (e) {
      // F-C-2 (Lens 3): capture parse error from whichever source was attempted
      // and label the source. Previously only installer parse errors surfaced,
      // so a corrupt mcp-server/package.json (e.g. partial pnpm install) caused
      // the doctor to render misleading "install @ijfw/install" fix text.
      if (canonicalParseError == null) {
        canonicalParseError = `${src}: ${e.message}`;
      }
    }
  }
  return { canonicalVersion, canonicalSource, canonicalParseError };
}

function codexDoctor(projectRoot) {
  const root = resolve(projectRoot);
  const checks = [];
  const pluginPath = findFirstExisting(
    join(root, 'codex', '.codex-plugin', 'plugin.json'),
    findCliAsset('codex', '.codex-plugin', 'plugin.json'),
  );
  const hooksPath = findFirstExisting(
    join(homedir(), '.codex', 'hooks.json'),
    join(root, 'codex', '.codex', 'hooks.json'),
    findCliAsset('codex', '.codex', 'hooks.json'),
  );
  const configPath = findFirstExisting(
    join(homedir(), '.codex', 'config.toml'),
    join(root, 'codex', '.codex', 'config.toml'),
    findCliAsset('codex', '.codex', 'config.toml'),
  );
  const skillsDirs = [
    join(homedir(), '.codex', 'skills'),
    join(root, 'codex', 'skills'),
    findCliAsset('codex', 'skills'),
  ].filter(Boolean);
  const projectAgents = join(root, '.codex', 'agents');
  const repoAgents = join(root, 'codex', '.codex', 'agents');
  const agentsMd = join(root, 'AGENTS.md');

  const plugin = readJsonFile(pluginPath);
  // v1.5.2.1: read the canonical version dynamically from
  // installer/package.json instead of comparing against a hardcoded literal.
  // The previous hardcoded '1.3.2' check drifted out of sync on every
  // release (latest observed: project at 1.5.1, doctor still expecting
  // 1.3.2 → false-positive failures on every fresh install). Reading from
  // installer/package.json keeps the doctor honest as long as that file
  // and the codex plugin.json are bumped together at ship-gate.
  //
  // F4.1: standalone @ijfw/memory-server installs do not ship installer/.
  // F4.3: regressing against the established findCliAsset() convention. Reuse it.
  // F4.2: differentiate ENOENT (missing) from SyntaxError (corrupt).
  const { canonicalVersion, canonicalSource, canonicalParseError } =
    resolveCanonicalVersion({
      installerPkg: findCliAsset('installer', 'package.json'),
      // F-C-1 (Lens 3): IJFW_HOME fallback was previously installer-only; make
      // mcp-server resolution symmetric so a custom-checkout user with IJFW_HOME
      // pointed at a partial tree also gets a working fallback.
      selfPkg: findCliAsset('mcp-server', 'package.json')
        ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    });
  checks.push({
    name: 'plugin metadata',
    ok: !!plugin && !!canonicalVersion && plugin.version === canonicalVersion,
    required: true,
    message: plugin
      ? (canonicalVersion
          ? `version ${plugin.version}${plugin.version === canonicalVersion ? '' : ` (expected ${canonicalVersion} per ${canonicalSource}/package.json)`}`
          : canonicalParseError
            ? `version ${plugin.version} (canonical source corrupt: ${canonicalParseError})`
            : `version ${plugin.version} (canonical version unreadable -- install @ijfw/install or set IJFW_HOME)`)
      : 'missing plugin.json',
    // F-C-9 (Lens 3): if plugin.json itself is missing, the fix text needs
    // to point at restoring plugin.json, NOT at the canonical-version dance.
    // canonicalParseError is now source-labelled by F-C-2 ("installer: ..."
    // or "mcp-server: ..."), so derive the specific package.json to restore.
    fix: !plugin
      ? `restore codex/.codex-plugin/plugin.json (try \`git checkout codex/.codex-plugin/plugin.json\`)`
      : canonicalVersion
        ? (plugin.version !== canonicalVersion
            ? `update codex/.codex-plugin/plugin.json version to ${canonicalVersion}`
            : null)
        : canonicalParseError
          ? `restore canonical source (try \`git checkout ${canonicalParseError.split(':')[0]}/package.json\`)`
          : `install @ijfw/install (npm i -g @ijfw/install), or set IJFW_HOME=<ijfw-repo-checkout>`,
  });

  const hooks = readJsonFile(hooksPath);
  const hookEvents = hooks?.hooks && typeof hooks.hooks === 'object' ? Object.keys(hooks.hooks) : [];
  const missingHooks = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse'].filter((event) => !hookEvents.includes(event));
  checks.push({
    name: 'hooks',
    ok: missingHooks.length === 0,
    required: true,
    message: missingHooks.length ? `missing ${missingHooks.join(', ')}` : 'six Codex hook events configured',
    fix: 'restore codex/.codex/hooks.json and hook scripts',
  });

  // C11 — the message MUST track the same condition `ok` does. Previously the
  // message said "ijfw-memory configured" whenever config.toml merely existed,
  // so a config.toml present-but-missing-the-ijfw-memory-block printed the
  // [ !! ] failure glyph (ok=false) next to success text. Branch all three
  // states: file absent, file present-but-unconfigured, file configured.
  const _codexConfigExists = existsSync(configPath);
  const _codexMemoryConfigured =
    _codexConfigExists && readFileSync(configPath, 'utf8').includes('ijfw-memory');
  checks.push({
    name: 'MCP config',
    ok: _codexMemoryConfigured,
    required: true,
    message: _codexMemoryConfigured
      ? 'ijfw-memory configured'
      : _codexConfigExists
        ? 'config.toml present but ijfw-memory not configured'
        : 'missing config.toml',
    fix: 'run ijfw install or restore codex/.codex/config.toml',
  });

  const skills = maxSkillCount(skillsDirs);
  checks.push({
    name: 'skills',
    ok: skills.count >= 19,
    required: true,
    message: `${skills.count} skill(s) found${skills.dir ? ` in ${skills.dir}` : ''}`,
    fix: 'run ijfw install or restore codex/skills',
  });

  checks.push({
    name: 'custom agents',
    ok: existsSync(projectAgents) || existsSync(repoAgents),
    required: false,
    message: existsSync(projectAgents) ? '.codex/agents present' : existsSync(repoAgents) ? 'repo agent templates present' : 'not generated yet',
    fix: 'run ijfw team init or ijfw codex sync-agents',
  });

  checks.push({
    name: 'AGENTS.md',
    ok: existsSync(agentsMd) && readFileSync(agentsMd, 'utf8').includes('IJFW-MEMORY-START'),
    required: false,
    message: existsSync(agentsMd) ? 'AGENTS.md memory block present' : 'missing AGENTS.md',
    fix: 'start a new IJFW-enabled session or run ijfw install',
  });

  return { ok: checks.every((item) => item.ok || !item.required), checks };
}

function findFirstExisting(...paths) {
  return paths.filter(Boolean).find((path) => existsSync(path)) || paths.filter(Boolean)[0] || '';
}

function maxSkillCount(dirs) {
  let best = { count: 0, dir: null };
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    const count = readdirSync(dir).filter((name) => existsSync(join(dir, name, 'SKILL.md'))).length;
    if (count > best.count) best = { count, dir };
  }
  return best;
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// IJFW v1.4.0 (W3/t16): override + extension CLI commands.
// Delegate to the colon-syntax dispatch handlers for the actual logic;
// this thin wrapper only handles argv parsing + result printing.
function cmdOverride(sub, rest) {
  const projectRoot = process.env.IJFW_PROJECT_DIR || process.cwd();
  const args = (rest || []).join(' ');
  import('./dispatch/override.js')
    .then(m => m.overrideDispatch({ command: sub, args, projectRoot }))
    .then(r => {
      if (r && r.ok === false) {
        console.error(`[ijfw override] ${r.command}: ${r.error}`);
        process.exit(1);
      }
      console.log(JSON.stringify(r, null, 2));
    })
    .catch(err => {
      console.error(`[ijfw override] ${err.message}`);
      process.exit(1);
    });
}

function cmdExtension(sub, rest) {
  const projectRoot = process.env.IJFW_PROJECT_DIR || process.cwd();
  const args = (rest || []).join(' ');
  import('./dispatch/extension.js')
    .then(m => m.extensionDispatch({ command: sub, args, projectRoot }))
    .then(r => {
      if (r && r.ok === false) {
        console.error(`[ijfw extension] ${r.command}: ${r.error}`);
        process.exit(1);
      }
      console.log(JSON.stringify(r, null, 2));
    })
    .catch(err => {
      console.error(`[ijfw extension] ${err.message}`);
      process.exit(1);
    });
}

function cmdSwarm(sub) {
  const args = process.argv.slice(4);
  if (sub === 'worktree') {
    cmdSwarmWorktree(args[0] || 'list', args.slice(1));
    return;
  }

  if (sub === 'plan') {
    const plan = buildSwarmPlan(process.cwd());
    console.log(swarmPlanSummary(plan));
    process.exit(plan.ok ? 0 : 1);
  }

  if (sub === 'status') {
    const plan = buildSwarmPlan(process.cwd());
    if (!plan.ok) {
      console.log(swarmPlanSummary(plan));
      process.exit(1);
    }
    const blackboard = readBlackboard(process.cwd());
    const preparedTasks = blackboard.tasks.data.tasks || [];
    const ready = preparedTasks.length
      ? preparedTasks.filter((task) => task.status === 'ready').length
      : plan.waves.reduce((n, wave) => n + wave.tasks.filter((task) => !task.blocked).length, 0);
    const blocked = preparedTasks.length
      ? preparedTasks.filter((task) => task.status === 'blocked').length
      : plan.waves.reduce((n, wave) => n + wave.tasks.filter((task) => task.blocked).length, 0);
    const inProgress = preparedTasks.filter((task) => task.status === 'in_progress').length;
    const done = preparedTasks.filter((task) => task.status === 'done').length;
    console.log(`Swarm: planned, not executing`);
    console.log(`Team: ${plan.team_name}`);
    console.log(`Prepared tasks: ${preparedTasks.length}`);
    console.log(`Ready tasks: ${ready}`);
    if (preparedTasks.length) console.log(`In progress tasks: ${inProgress}`);
    if (preparedTasks.length) console.log(`Done tasks: ${done}`);
    console.log(`Blocked tasks: ${blocked}`);
    console.log(`Next: run 'ijfw swarm plan' for the wave breakdown, or dispatch ready tasks.`);
    process.exit(blocked ? 2 : 0);
  }

  if (sub === 'prepare') {
    const replace = !process.argv.includes('--append');
    const includeReviews = process.argv.includes('--reviews');
    const result = prepareSwarmTasks(process.cwd(), { replace, includeReviews });
    if (!result.ok) {
      console.log(result.message || `Swarm prepare failed: ${result.error}`);
      process.exit(1);
    }
    const ready = result.tasks.filter((task) => task.status === 'ready').length;
    const blocked = result.tasks.filter((task) => task.status === 'blocked').length;
    console.log(`Swarm tasks prepared: ${result.written}`);
    console.log(`Ready: ${ready}`);
    console.log(`Blocked: ${blocked}`);
    console.log(`Blackboard tasks: ${result.total}`);
    createCheckpoint(process.cwd(), 'swarm-prepare', { actor: 'ijfw', message: 'Swarm tasks prepared' });
    process.exit(blocked ? 2 : 0);
  }

  if (sub === 'tasks' || sub === 'list') {
    const result = listSwarmTasks(process.cwd());
    if (!result.ok) {
      console.log(`Swarm tasks unavailable: ${result.error}`);
      process.exit(1);
    }
    if (!result.tasks.length) {
      console.log('No prepared swarm tasks. Run: ijfw swarm prepare');
      process.exit(0);
    }
    for (const task of result.tasks) {
      const artifacts = (task.artifact_ids || []).join(',');
      console.log(`${task.id} [${task.status}] ${task.owner} -> ${artifacts}`);
    }
    process.exit(0);
  }

  if (sub === 'prompt' || sub === 'dispatch-prompt') {
    const taskId = args[0];
    const codex = args.includes('--codex');
    const result = listSwarmTasks(process.cwd());
    if (!result.ok) {
      console.log(`Swarm tasks unavailable: ${result.error}`);
      process.exit(1);
    }
    const task = result.tasks.find((item) => item.id === taskId);
    if (!task) {
      console.log(`Swarm prompt unavailable: task-not-found`);
      process.exit(1);
    }
    console.log(renderSwarmDispatchPrompt(task, { projectRoot: process.cwd(), codex }));
    process.exit(0);
  }

  if (sub === 'start') {
    const taskId = args[0];
    const owner = optionValue(args.slice(1), ['--owner', '-o']);
    const result = startSwarmTask(process.cwd(), taskId, { owner });
    if (!result.ok) {
      console.log(`Swarm start halted: ${result.error}`);
      if (result.dependency) console.log(`Dependency pending: ${result.dependency.id} [${result.dependency.status}]`);
      if (result.claim?.conflicts) {
        for (const conflict of result.claim.conflicts) console.log(`Claim held: ${conflict.artifact_id} -> ${conflict.agent}`);
      }
      process.exit(1);
    }
    console.log(`Started ${result.task.id} for ${result.task.active_owner || result.task.owner}`);
    createCheckpoint(process.cwd(), 'task-start', { actor: result.task.active_owner || result.task.owner, message: result.task.id });
    process.exit(0);
  }

  if (sub === 'complete' || sub === 'done') {
    const taskId = args[0];
    const owner = optionValue(args.slice(1), ['--owner', '-o']);
    const message = optionValue(args.slice(1), ['--message', '-m']) || positionalMessage(args.slice(1), ['--owner', '-o']);
    const commitSha = optionValue(args.slice(1), ['--commit', '--sha']);
    const filesChanged = Number(optionValue(args.slice(1), ['--files-changed']));
    const skipEvidence = args.includes('--skip-evidence');
    // V155-006: caller must produce a filesystem witness (sha OR diffStats) OR
    // explicitly opt out via --skip-evidence (admin overrides, dry-run flows).
    // The planner records `task.completed-no-evidence` for downstream audit.
    const evidence = commitSha
      ? { commitSha }
      : Number.isFinite(filesChanged) && filesChanged >= 1
        ? { diffStats: { filesChanged } }
        : undefined;
    const result = completeSwarmTask(process.cwd(), taskId, { owner, message, evidence, skipEvidence });
    if (!result.ok) {
      console.log(`Swarm complete halted: ${result.error}`);
      process.exit(1);
    }
    console.log(`Completed ${result.task.id}`);
    createCheckpoint(process.cwd(), 'task-complete', { actor: result.task.active_owner || result.task.owner, message: result.task.id });
    process.exit(0);
  }

  if (sub === 'block') {
    const taskId = args[0];
    const owner = optionValue(args.slice(1), ['--owner', '-o']);
    const message = optionValue(args.slice(1), ['--message', '-m']) || args.slice(1).filter((arg) => !arg.startsWith('--')).join(' ');
    const result = blockSwarmTask(process.cwd(), taskId, { owner, message });
    if (!result.ok) {
      console.log(`Swarm block halted: ${result.error}`);
      process.exit(1);
    }
    console.log(`Blocked ${result.task.id}: ${result.task.blocker}`);
    createCheckpoint(process.cwd(), 'task-block', { actor: owner || result.task.owner, message: result.task.id });
    process.exit(0);
  }

  if (sub === 'ready') {
    const taskId = args[0];
    const result = readySwarmTask(process.cwd(), taskId);
    if (!result.ok) {
      console.log(`Swarm ready halted: ${result.error}`);
      process.exit(1);
    }
    console.log(`Ready ${result.task.id}`);
    createCheckpoint(process.cwd(), 'task-ready', { actor: 'ijfw', message: result.task.id });
    process.exit(0);
  }

  // F-REL-1 (H5.3): orphan eviction. Walks active claims and releases any
  // whose freshness anchor (claimed_at or heartbeat_at) is older than the
  // TTL. Default TTL is 30 minutes; override with --ttl-min N.
  if (sub === 'evict-orphans' || sub === 'evict') {
    const minRaw = optionValue(args, ['--ttl-min', '--ttl', '-t']);
    const min = Number.parseFloat(minRaw);
    const ttlMs = Number.isFinite(min) && min > 0 ? Math.floor(min * 60 * 1000) : DEFAULT_CLAIM_TTL_MS;
    const result = evictOrphanedClaims(process.cwd(), { ttlMs });
    if (!result.ok) {
      console.log(`Swarm evict halted: ${result.error}`);
      process.exit(1);
    }
    console.log(`Evicted ${result.count} orphan claim(s) (TTL ${Math.round(ttlMs / 60000)}min)`);
    for (const item of result.evicted) {
      console.log(`  ${item.id} (${item.agent} -> ${item.artifact_id}, age ${Math.round(item.age_ms / 1000)}s)`);
    }
    process.exit(0);
  }

  // F-REL-1 (H5.3): manual heartbeat ping. Subagents normally invoke this
  // via the programmatic surface (updateClaimHeartbeat); the CLI form is
  // for forensic dogfooding from tests + the dashboard preview.
  if (sub === 'heartbeat') {
    const taskOrClaim = args[0];
    const owner = optionValue(args.slice(1), ['--owner', '-o']);
    const claimId = optionValue(args.slice(1), ['--claim', '--id']);
    const input = claimId
      ? { claim_id: claimId }
      : { artifact_id: taskOrClaim, agent: owner };
    const result = updateClaimHeartbeat(process.cwd(), input);
    if (!result.ok) {
      console.log(`Heartbeat halted: ${result.error}`);
      process.exit(1);
    }
    console.log(`Heartbeat ${result.claim.id} at ${result.claim.heartbeat_at}`);
    process.exit(0);
  }

  console.log('Usage: ijfw swarm plan | prepare [--append] [--reviews] | tasks | prompt <task-id> [--codex] | start <task-id> [--owner <agent>] | complete <task-id> [--message <text>] | block <task-id> --message <why> | ready <task-id> | status | evict-orphans [--ttl-min N] | heartbeat <artifact-id> --owner <agent>');
  process.exit(1);
}

function positionalMessage(args, valueOptions = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueOptions.includes(arg)) {
      i++;
      continue;
    }
    if (valueOptions.some((name) => arg.startsWith(`${name}=`))) continue;
    if (!arg.startsWith('--')) out.push(arg);
  }
  return out.join(' ').trim() || null;
}

function cmdSwarmWorktree(sub, args) {
  if (sub === 'create') {
    const taskId = args[0];
    const force = args.includes('--force');
    const allowDirty = args.includes('--allow-dirty');
    const result = createTaskWorktree(process.cwd(), taskId, { force, allowDirty });
    if (!result.ok) {
      console.log(`Worktree create halted: ${result.error}`);
      if (result.detail) for (const line of result.detail.slice(0, 10)) console.log(`  ${line}`);
      process.exit(1);
    }
    console.log(`Worktree created: ${result.path}`);
    console.log(`Branch: ${result.branch}`);
    process.exit(0);
  }

  if (sub === 'list') {
    const result = listTaskWorktrees(process.cwd());
    if (!result.worktrees.length) {
      console.log('No swarm worktrees recorded.');
      process.exit(0);
    }
    for (const wt of result.worktrees) console.log(`${wt.task_id} [${wt.status}] ${wt.branch} -> ${wt.path}`);
    process.exit(0);
  }

  if (sub === 'integrate') {
    const taskId = args[0];
    const cleanup = args.includes('--cleanup');
    const result = integrateTaskWorktree(process.cwd(), taskId, { cleanup });
    if (!result.ok) {
      console.log(`Worktree integrate halted: ${result.error}`);
      if (result.stderr) console.log(result.stderr.trim());
      if (result.stdout) console.log(result.stdout.trim());
      process.exit(1);
    }
    console.log(`Worktree integrated: ${taskId}`);
    process.exit(0);
  }

  if (sub === 'cleanup') {
    const taskId = args[0];
    const force = args.includes('--force');
    const result = cleanupTaskWorktree(process.cwd(), taskId, { force });
    if (!result.ok) {
      console.log(`Worktree cleanup halted: ${result.error}`);
      process.exit(1);
    }
    console.log(`Worktree cleaned: ${taskId}`);
    process.exit(0);
  }

  console.log('Usage: ijfw swarm worktree create <task-id> [--force] [--allow-dirty] | list | integrate <task-id> [--cleanup] | cleanup <task-id> [--force]');
  process.exit(1);
}

function cmdMemoryCheckpoint(label) {
  const result = createCheckpoint(process.cwd(), label || 'manual', {
    actor: 'cli',
    message: process.argv.slice(4).join(' ') || undefined,
  });
  if (!result.ok) {
    console.log(`Checkpoint unavailable: ${result.error}`);
    process.exit(1);
  }
  console.log(`Checkpoint created: ${result.id}`);
  console.log(`Markdown: ${result.mdPath}`);
  console.log(`JSON: ${result.jsonPath}`);
  process.exit(0);
}

// v1.5.1 R5-1.2 -- `ijfw memory reindex [--m2]`. Closes Trident r5 finding
// 1.2: memory written during v1.5.0 (before Round-4 Fix-1 wired M1/M2 into
// the production write path) has empty memory_links / memory_tags /
// memory_meta. Migration 009 already backfills M1 once on upgrade; this verb
// is the manual re-run path AND the only way to opt into the M2 (A-Mem
// auto-link) backfill, which is budget-gated because it makes one LLM call
// per row.
async function cmdMemoryReindex(parsed) {
  const projectRoot = process.cwd();
  // Lazy import: better-sqlite3 is heavy; only pay for it on this verb.
  const { openDb, closeDb, dbPathFor } = await import('./memory/fts5.js');
  const { backfillObsidianIndex } = await import('./memory/obsidian-parser.js');
  const { backfillAutoLink } = await import('./memory/auto-linker.js');

  let db;
  try {
    db = await openDb(projectRoot);
  } catch (e) {
    console.error(`Memory db unavailable: ${e.message}`);
    process.exit(1);
  }

  try {
    console.log(`Reindexing memory at ${dbPathFor(projectRoot)}`);
    // M1 -- always. Free + idempotent obsidian indexing.
    const m1 = backfillObsidianIndex(db);
    console.log(
      `M1 obsidian-index backfill: ${m1.rows} entries re-indexed ` +
      `(${m1.links} links, ${m1.tags} tags, ${m1.meta} meta` +
      `${m1.errors ? `, ${m1.errors} errors` : ''}).`,
    );

    // M2 -- opt-in via --m2. Budget-gated; backfillAutoLink internally
    // forces past the IJFW_AUTOLINK_BACKFILL opt-in (the --m2 flag IS the
    // explicit opt-in) but still honours IJFW_AUTOLINK_OFF, the budget cap,
    // and the API-key requirement.
    if (parsed.m2) {
      const m2 = await backfillAutoLink(db, { force: true });
      if (m2.skipped) {
        console.log(
          `M2 auto-link backfill skipped (${m2.reason}). ` +
          `M2 backfill needs a positive IJFW_AUTOLINK_BUDGET_USD cap and an ` +
          `API key (IJFW_AUTOLINK_API_KEY or ANTHROPIC_API_KEY).`,
        );
      } else {
        console.log(
          `M2 auto-link backfill: ${m2.linked}/${m2.rows} entries linked ` +
          `(${m2.links_added} links, ${m2.neighbor_tags_added} neighbor tags)` +
          `${m2.stopped_early ? ' -- stopped early (budget / kill switch)' : ''}.`,
        );
      }
    } else {
      console.log(
        'M2 auto-link backfill not run. Re-run with --m2 (budget-gated) to ' +
        'auto-link old entries via the A-Mem LLM pass.',
      );
    }
  } finally {
    closeDb(db);
  }
  process.exit(0);
}

function cmdRecover(sub) {
  if (sub === 'latest') {
    const latest = latestCheckpoint(process.cwd());
    if (!latest.ok) {
      console.log('No checkpoint found. Run: ijfw memory checkpoint <label>');
      process.exit(1);
    }
    console.log(latest.markdown || `Latest checkpoint: ${latest.id}`);
    process.exit(0);
  }

  if (sub === 'status') {
    const status = recoveryStatus(process.cwd());
    console.log(`Recovery status`);
    console.log(`Latest checkpoint: ${status.latest ? status.latest.id : 'none'}`);
    console.log(`Team: ${status.team.ok ? status.team.name : 'not assembled'}`);
    console.log(`Tasks: ${status.tasks.ready} ready, ${status.tasks.in_progress} in progress, ${status.tasks.blocked} blocked, ${status.tasks.done} done`);
    console.log(`Active claims: ${status.claims.active}`);
    console.log(`Next: ${status.next}`);
    process.exit(0);
  }

  console.log('Usage: ijfw recover status | latest');
  process.exit(1);
}
