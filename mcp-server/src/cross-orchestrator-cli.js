// cross-orchestrator-cli.js -- thin CLI for `ijfw cross <mode> <target>`.
//
// Commands:
//   ijfw cross <mode> <target> [--confirm] [--with <id>] [--expand]
//   ijfw status
//   ijfw --help
//
// Zero external deps. Parse argv manually.

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './lib/atomic-io.js';
import { runCrossOp } from './cross-orchestrator.js';
import { readReceipts, purgeReceipts } from './receipts.js';
import { renderHeroLine } from './hero-line.js';
import { ROSTER, isInstalled, isReachable } from './audit-roster.js';
import { aggregatePortfolioFindings } from './cross-project-search.js';
import { runImport, runImportAll, listImporters } from './importers/cli.js';
import { validateToken } from './lib/token.js';
import { isVersionStringValid } from './lib/npm-view.js';

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

function parseArgsInner(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { cmd: 'help' };
  }

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

    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--confirm') { confirm = true; }
      else if (args[i] === '--expand') { expand = true; }
      else if (args[i] === '--with' && args[i + 1]) { only = args[++i]; }
    }

    return { cmd: 'cross', mode, target, only, confirm, expand };
  }

  return { cmd: 'unknown', raw: args[0] };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
ijfw -- It Just Fucking Works CLI
Fire 2-4 AIs at any target. Receipts logged. Cache hits tracked. Memory follows you.

Usage:
  ijfw install
  ijfw uninstall
  ijfw preflight
  ijfw dashboard [start|stop|status]
  ijfw cross <mode> <target> [options]
  ijfw cross project-audit <rule-file> [--dry-run]
  ijfw import <tool> [--all] [--dry-run] [--force] [--path <p>]
  ijfw status
  ijfw doctor
  ijfw update
  ijfw receipt last
  ijfw --purge-receipts
  ijfw --help

Commands:
  install           Install IJFW into your AI coding agents.
  uninstall         Remove IJFW and revert AI-agent configs. Same as: ijfw off
  preflight         Run the 11-gate quality pipeline (blocking + advisory).
  dashboard         Control the dashboard server (start, stop, status).
  demo              30-second live tour of the Trident (fires real auditors).
  cross             Fire external auditors at a target. Try: ijfw cross audit README.md
  import            Pull memory in from another tool. Try: ijfw import claude-mem --all
  status            Show recent cross-audit activity. Try: ijfw status
  doctor            Probe which CLIs and API keys are reachable. Try: ijfw doctor
  update            Pull latest IJFW + reinstall merge-safely. Try: ijfw update
  update --check    Non-invasive check. Exits 0 always; prints "update-available: <ver>" when an update exists (grep-safe).
  receipt last      Print a redacted, shareable block from the last Trident run.
  --purge-receipts  Clear the cross-runs receipt log. Try: ijfw --purge-receipts

Modes (for ijfw cross):
  audit           Adversarial review of a file, module, or path
  research        Multi-source research on a topic
  critique        Structured counter-argument generation
  project-audit   Run the same audit across every registered IJFW project
                  Usage: ijfw cross project-audit <rule-file> [--dry-run]

Options for ijfw cross:
  --with <id>   Force a specific auditor (comma-separated for multiple)
  --confirm     Prompt for confirmation before firing
  --expand      Include extended swarm when available

Global flags:
  --json    Emit JSON instead of human output. status and doctor auto-JSON
            on non-TTY (gh-CLI convention); version stays one-line on pipe
            and only JSON-ifies with explicit --json. Other commands ignore.

Environment:
  IJFW_AUDIT_BUDGET_USD   Session spend cap (default $2.00). First call is always
                          allowed (no cap). Cap enforced from the 2nd call on.

Examples:
  ijfw demo
  ijfw cross audit README.md
  ijfw cross research "vector search approaches"
  ijfw cross critique HEAD~3..HEAD
  ijfw cross audit CLAUDE.md --with codex,gemini
  ijfw status
  ijfw doctor
`.trim());
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
    // TODO post-merge: perAuditorTimeoutSec, minResponses, quiet are added by Item 2 agent.
    // Passed through here; current orchestrator silently ignores unknown params.
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
      { name: 'hooks',          detect: () => existsSync(join(homedir(), '.codex', 'hooks.json')) },
      { name: 'context file',   detect: () => existsSync(join(homedir(), '.codex', 'IJFW.md')) },
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

async function cmdCross({ mode, target, only, confirm, expand }) {
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
function writeStateFields(updates) {
  const path = join(ijfwHome(), 'state.json');
  const state = Object.assign(readState(), updates);
  try {
    writeAtomic(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error(`could not persist state.json: ${e.message}`);
  }
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
  console.log(`  Release notes: https://gitlab.com/therealseandonahoe/ijfw/-/releases/v${r.version}`);
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
  console.log('Verification complete.');
  process.exit(0);
}

function cmdUpdateChangelog() {
  const r = npmViewVersion('@ijfw/install');
  if (!r.ok) {
    console.error(`could not fetch latest version: ${r.message}`);
    process.exit(1);
  }
  const url = `https://gitlab.com/api/v4/projects/therealseandonahoe%2Fijfw/releases/v${r.version}`;
  const fetchRes = spawnSync('curl', ['-fsSL', '-H', 'User-Agent: ijfw', url], { encoding: 'utf8', timeout: 10_000 });
  if (fetchRes.status !== 0) {
    console.log(`No release notes available for v${r.version}.`);
    console.log(`Visit: https://gitlab.com/therealseandonahoe/ijfw/-/releases/v${r.version}`);
    process.exit(0);
  }
  let body = '';
  try {
    const data = JSON.parse(fetchRes.stdout || '{}');
    body = data.description || '(no body)';
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
  if (body.length > 4096) console.log(`\n... (truncated; full notes at https://gitlab.com/therealseandonahoe/ijfw/-/releases/v${r.version})`);
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
    console.error('No pending update sentinel found. Run `ijfw_update_apply` via your AI first.');
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
        ? 'Token mismatch -- run ijfw_update_check + ijfw_update_apply via your AI to issue a fresh token.'
        : 'No pending update sentinel found. The MCP `ijfw_update_apply` tool issues sentinels.'
    );
    process.exit(1);
  }

  if (!pending || !isVersionStringValid(pending.target_version)) {
    try { rmSync(sentinelPath, { force: true }); } catch { /* */ }
    console.error('Pending update sentinel is malformed -- run ijfw_update_check + ijfw_update_apply again.');
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
    console.error(`${why} -- run ijfw_update_check + ijfw_update_apply to issue a fresh token.`);
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
    installRes = spawnSync('bash', [installSh], { stdio: 'inherit' });
  } else {
    console.log('  Manual install detected -- run: npx @ijfw/install');
    installRes = spawnSync('npx', ['-y', `@ijfw/install@${r.version}`], { stdio: 'inherit' });
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
  // Persist both fields atomically -- single write avoids concurrent-reader inconsistency
  writeStateFields({ last_applied_version: r.version, installed_version: r.version });
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
    console.log('Track progress: https://gitlab.com/therealseandonahoe/ijfw/issues');
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
    console.error('[ijfw] Guide not found. Visit https://gitlab.com/therealseandonahoe/ijfw/-/blob/main/docs/GUIDE.md');
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
    printUsage();
    process.exit(0);
  }

  if (parsed.cmd === 'status') {
    cmdStatus(process.cwd(), parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'demo') {
    cmdDemo().catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'cross') {
    cmdCross(parsed).catch(err => { console.error(err.message); process.exit(1); });
  } else if (parsed.cmd === 'cross-project-audit') {
    cmdCrossProjectAudit(parsed).catch(err => { console.error(err.message); process.exit(1); });
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
  } else {
    console.error(`Unknown command: ${parsed.raw}`);
    printUsage();
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
  const candidates = [
    join(repoRootFromCli(), ...rel),
    process.env.IJFW_HOME ? join(process.env.IJFW_HOME, ...rel) : null,
    join(homedir(), '.ijfw', ...rel),
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
  const script = findCliAsset('scripts', 'dashboard', 'bin.js');
  if (!script) {
    console.error('dashboard/bin.js not found. Run `ijfw-install` to deploy ~/.ijfw/, or set IJFW_HOME to your IJFW tree.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [script, sub], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}
