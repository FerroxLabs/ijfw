// @ijfw/install -- shared install ledger + plan manifest.
//
// Single source of truth, consumed by BOTH install and uninstall, so the two
// can never drift apart (issue #17). Two concerns:
//
//  1. PLATFORM_OWNED_DIRS -- the home-relative top-level dir each platform
//     target may create. The installer snapshots which of these existed BEFORE
//     it ran, then records the ones it created into the ledger. `--purge` then
//     removes a created dir ONLY if it is empty after IJFW content is stripped,
//     so a dir IJFW made for a non-installed CLI is removed while a dir the user
//     already had (or later populated) is never deleted.
//
//  2. INSTALL_PLAN -- a static, per-platform manifest of the paths the installer
//     touches, used by `ijfw-install --dry-run` to print every file it would
//     modify before writing anything.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Top-level home-relative dirs each platform target may create from scratch.
// Project-scoped targets (cursor, copilot) never create a home dir and are
// omitted. Claude (~/.claude) and Windsurf (~/.codeium) are omitted on purpose:
// IJFW only ever merges into those tools' own config, never owns the dir.
export const PLATFORM_OWNED_DIRS = {
  codex: ['.codex'],
  gemini: ['.gemini'],
  hermes: ['.hermes'],
  wayland: ['.wayland'],
  openclaw: ['.openclaw'],
  qwen: ['.qwen'],
  kimi: ['.kimi'],
  opencode: ['.config/opencode'],
  pi: ['.pi'],
};

export function ledgerPath(ijfwHome) {
  return join(ijfwHome, 'install-ledger.json');
}

// Set of every home-relative dir IJFW might create, flattened + deduped.
export function allOwnedDirs() {
  const set = new Set();
  for (const dirs of Object.values(PLATFORM_OWNED_DIRS)) {
    for (const d of dirs) set.add(d);
  }
  return [...set];
}

// Snapshot which owned dirs already exist under `home`. Call BEFORE install.
export function snapshotPreExistingDirs(home) {
  const pre = [];
  for (const rel of allOwnedDirs()) {
    if (existsSync(join(home, rel))) pre.push(rel);
  }
  return pre;
}

// After install: record the owned dirs that now exist but were NOT pre-existing
// (i.e. IJFW created them). Written 0o600 inside ijfwHome.
export function writeLedger({ home, ijfwHome, preExisting }) {
  const preSet = new Set(preExisting || []);
  const owned = allOwnedDirs();
  const created = [];
  for (const rel of owned) {
    if (!preSet.has(rel) && existsSync(join(home, rel))) created.push(rel);
  }
  // Merge with the existing ledger (issue #17 regression guard): on an
  // upgrade, dirs IJFW created during the FIRST install are seen as
  // pre-existing by this run's snapshot, so without the union every re-run
  // rewrote createdDirs as [] and --purge stopped tracking them. Prior
  // entries are kept only while they are still known owned dirs that exist.
  const prev = readLedger(ijfwHome).createdDirs.filter(
    (rel) => owned.includes(rel) && existsSync(join(home, rel)),
  );
  const ledger = { version: 1, createdDirs: [...new Set([...prev, ...created])] };
  try {
    mkdirSync(ijfwHome, { recursive: true, mode: 0o700 });
    writeFileSync(ledgerPath(ijfwHome), JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* best-effort: a missing ledger just means purge falls back to empty-check */
  }
  return ledger;
}

export function readLedger(ijfwHome) {
  try {
    const raw = readFileSync(ledgerPath(ijfwHome), 'utf8');
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.createdDirs)) return doc;
  } catch { /* absent / unreadable */ }
  return { version: 1, createdDirs: [] };
}

// True if a dir exists and is empty (safe to remove a dir IJFW created once its
// content is stripped). A dir the user populated will be non-empty -> kept.
export function isEmptyDir(p) {
  try { return existsSync(p) && readdirSync(p).length === 0; } catch { return false; }
}

// Static manifest of what the installer touches per platform, for --dry-run.
// `~` denotes $HOME; `./` denotes the current project dir. m=merge, c=create.
export const INSTALL_PLAN = {
  shared: [
    ['~/.ijfw/', 'c', 'IJFW home (server symlink, scripts, index, logs, settings, ledger)'],
  ],
  claude: [
    ['~/.claude/settings.json', 'm', 'mcpServers.ijfw-memory + enabledPlugins + marketplace'],
    ['~/.claude/plugins/known_marketplaces.json', 'm', 'ijfw marketplace entry'],
  ],
  codex: [
    ['~/.codex/config.toml', 'm', '[mcp_servers.ijfw-memory]'],
    ['~/.codex/hooks.json', 'm', 'IJFW hook entries'],
    ['~/.codex/hooks/*.sh', 'c', 'lifecycle hook scripts'],
    ['~/.codex/IJFW.md', 'c', 'context file'],
    ['~/.codex/skills/, commands/', 'c', 'skills + command aliases'],
  ],
  gemini: [
    ['~/.gemini/settings.json', 'm', 'mcpServers.ijfw-memory'],
    ['~/.gemini/extensions/ijfw/', 'c', 'extension (hooks, skills, commands, agents)'],
  ],
  hermes: [
    ['~/.hermes/config.yaml', 'm', 'mcp_servers.ijfw-memory + plugin + hook'],
    ['~/.hermes/HERMES.md, skills/, plugins/ijfw/', 'c', 'context + skills + plugin tree'],
  ],
  wayland: [
    ['~/.wayland/plugins/ijfw/', 'c', 'plugin.toml (MCP + hooks)'],
    ['~/.wayland/WAYLAND.md, skills/', 'c', 'context + skills'],
  ],
  openclaw: [['~/.openclaw/openclaw.json', 'm', 'mcp.servers.ijfw-memory']],
  qwen: [['~/.qwen/settings.json', 'm', 'mcpServers.ijfw-memory']],
  kimi: [['~/.kimi/mcp.json', 'm', 'mcpServers.ijfw-memory']],
  opencode: [['~/.config/opencode/opencode.json', 'm', 'mcp.ijfw-memory']],
  cline: [['VS Code globalStorage <Code|VSCodium>/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json', 'm', 'mcpServers.ijfw-memory']],
  antigravity: [
    ['~/.gemini/antigravity/mcp_config.json', 'm', 'mcpServers.ijfw-memory (IDE)'],
    ['~/.gemini/config/mcp_config.json', 'm', 'mcpServers.ijfw-memory (CLI agy)'],
  ],
  pi: [['~/.pi/agent/AGENTS.md', 'c', 'context file (rules-only, no MCP)']],
  cursor: [['./.cursor/mcp.json + rules/ijfw.mdc', 'mc', 'project-scoped MCP + rule']],
  windsurf: [
    ['~/.codeium/windsurf/mcp_config.json', 'm', 'mcpServers.ijfw-memory'],
    ['./.windsurfrules', 'c', 'project-scoped rules'],
  ],
  copilot: [['./.vscode/mcp.json + .github/copilot-instructions.md', 'mc', 'project-scoped']],
  aider: [['~/.aider.conf.yml + ~/CONVENTIONS.md', 'c', 'home-level rule files']],
};

// Render the plan for a given target list as printable lines.
export function renderPlan(targetList) {
  const lines = [];
  lines.push('IJFW install plan (dry run) -- nothing will be written.');
  lines.push('  legend: [m]=merge into existing file  [c]=create  [./]=project-scoped');
  lines.push('');
  const emit = (title, rows) => {
    if (!rows || rows.length === 0) return;
    lines.push(title);
    for (const [path, kind, note] of rows) lines.push(`    [${kind}] ${path}  -- ${note}`);
  };
  emit('  shared:', INSTALL_PLAN.shared);
  for (const t of targetList) {
    if (INSTALL_PLAN[t]) emit(`  ${t}:`, INSTALL_PLAN[t]);
  }
  lines.push('');
  lines.push('  Run without --dry-run to apply. Use `ijfw-uninstall --purge` to reverse.');
  return lines.join('\n');
}
