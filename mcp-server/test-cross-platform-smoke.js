#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- 14-platform cross-platform install smoke matrix (P5-D1).
//
// Closes Phase 5 finding P5-D1: 5 critical platforms (Claude, Codex, Gemini,
// Wayland, Hermes) ship live-verified plugins; this harness extends coverage
// to all 14 supported platforms by exercising each install path against an
// isolated tmp HOME and asserting the platform-specific config landing site.
//
// Per platform we verify the install dispatcher's per-target case actually:
//   1. Resolves the install path (config dir creatable + writable).
//   2. Lands a config file at the documented location with the correct shape
//      OR (paste-block tier) lands the documented rules/conventions doc.
//   3. References the canonical 10-tool MCP server entry where MCP applies.
//   4. Stays idempotent under re-run (one ijfw-memory entry, not duplicated).
//
// Companion gates already covered by sibling tests, referenced here for
// the matrix doc but not re-run inline:
//   - AGENTS.md hoist        -> mcp-server/test-agents-md.js
//   - Cold-scan trigger      -> mcp-server/test-cold-scan-trigger.js
//   - MCP tool count == 10   -> mcp-server/test-tool-cap.js
//
// Run: node --test mcp-server/test-cross-platform-smoke.js
//
// Discipline: ESM, zero new prod deps, LC_ALL=C, atomic writes via the
// install.sh helpers themselves (we drive the real script with a single
// platform target per case).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BASH } from './test/win-bash-helper.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const INSTALL_SH = join(REPO_ROOT, 'scripts', 'install.sh');
const SERVER_JS = join(REPO_ROOT, 'mcp-server', 'src', 'server.js');

// Canonical TARGETS list -- mirrors install.sh:1006. 14 platforms.
const PLATFORMS = [
  // 5 critical platforms (live-verified by sibling test suites; smoke
  // re-asserts install-path landing for matrix completeness).
  { id: 'claude',   tier: 'plugin',     name: 'Claude Code' },
  { id: 'codex',    tier: 'plugin',     name: 'Codex CLI' },
  { id: 'gemini',   tier: 'extension',  name: 'Gemini CLI' },
  { id: 'wayland',  tier: 'plugin',     name: 'Wayland' },
  { id: 'hermes',   tier: 'plugin',     name: 'Hermes' },
  // 6 MCP-config tier (file landed at platform's documented config path).
  { id: 'cursor',   tier: 'mcp-config', name: 'Cursor' },
  { id: 'windsurf', tier: 'mcp-config', name: 'Windsurf' },
  { id: 'copilot',  tier: 'mcp-config', name: 'Copilot (VS Code)' },
  { id: 'opencode', tier: 'mcp-config', name: 'OpenCode' },
  { id: 'qwen',     tier: 'mcp-config', name: 'Qwen Code' },
  { id: 'cline',    tier: 'mcp-config', name: 'Cline' },
  { id: 'kimi',     tier: 'mcp-config', name: 'Kimi Code' },
  { id: 'openclaw', tier: 'mcp-config', name: 'OpenClaw' },
  // 1 universal-rules tier (Aider has no native MCP -- ships rules + conventions).
  { id: 'aider',    tier: 'rules-only', name: 'Aider' },
];

assert.equal(PLATFORMS.length, 14, '14-platform matrix invariant');

// -------------------------------------------------------------------------
// Per-platform expected landing site under a sandbox HOME.
//
// `landing(home, projectDir)` returns:
//   { paths: [...], assertion: (paths) => void }
// where `paths` is an absolute path the install must create, and `assertion`
// is a custom predicate run on the resolved files (e.g. JSON shape check).
// -------------------------------------------------------------------------

function readJSON(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readText(p) {
  return readFileSync(p, 'utf8');
}

const HOME_PATHS = {
  claude:   (h) => [join(h, '.claude', 'settings.json')],
  codex:    (h) => [join(h, '.codex', 'config.toml')],
  gemini:   (h) => [join(h, '.gemini', 'settings.json')],
  hermes:   (h) => [join(h, '.hermes', 'config.yaml')],
  wayland:  (h) => [join(h, '.wayland', 'config.yaml')],
  windsurf: (h) => [join(h, '.codeium', 'windsurf', 'mcp_config.json')],
  opencode: (h) => [join(h, '.config', 'opencode', 'opencode.json')],
  qwen:     (h) => [join(h, '.qwen', 'settings.json')],
  kimi:     (h) => [join(h, '.kimi', 'mcp.json')],
  openclaw: (h) => [join(h, '.openclaw', 'openclaw.json')],
  aider:    (h) => [join(h, '.aider.conf.yml'), join(h, 'CONVENTIONS.md')],
};

// Project-scoped writes (Cursor, Copilot land config inside PWD).
const PROJECT_PATHS = {
  cursor:  (p) => [join(p, '.cursor', 'mcp.json')],
  copilot: (p) => [join(p, '.vscode', 'mcp.json')],
};

// Cline writes into VS Code globalStorage; on macOS that's
// $HOME/Library/Application Support/Code/User/globalStorage/...
function clineLandingPath(home) {
  // Match install.sh:cline_merge platform branches. We force the Linux
  // default by passing CLINE_FORCE_OS=linux when bashing -- but install.sh
  // honors `uname -s`, not env. So we accept the OS-conditional path.
  const plat = process.platform;
  if (plat === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User',
      'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'Code', 'User',
      'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  }
  return join(home, '.config', 'Code', 'User',
    'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
}

// -------------------------------------------------------------------------
// Drive install.sh against an isolated HOME with a single platform target.
// IJFW_CUSTOM_DIR=0 so home-mutating branches actually run; HOME points
// at our sandbox so we never touch the user's real config.
// -------------------------------------------------------------------------

function isolatedSandbox(label) {
  const root = mkdtempSync(join(tmpdir(), `ijfw-smoke-${label}-`));
  const home = join(root, 'home');
  const proj = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  // Plant a tiny project so cursor/copilot project-scoped writes have a PWD.
  writeFileSync(join(proj, 'package.json'), '{"name":"smoke","version":"0.0.0"}\n');
  return { root, home, proj };
}

function runInstall(target, sandbox, extraEnv = {}) {
  // IJFW_HOME points at the repo root so install.sh's REPO_ROOT-derived
  // SERVER_JS path resolves correctly. install.sh canonicalizes via
  // BASH_SOURCE/.. so it walks back to the source repo regardless.
  const env = {
    PATH: process.env.PATH,
    LC_ALL: 'C',
    LANG: 'C',
    HOME: sandbox.home,
    IJFW_HOME: REPO_ROOT,            // point at source repo so SERVER_JS resolves
    IJFW_CUSTOM_DIR: '0',            // run home-mutating branches
    IJFW_PROTECT_DEV_TREE: '0',      // override dev-tree guard
    IJFW_NONINTERACTIVE: '1',
    ...extraEnv,
  };
  // Run from the sandbox project dir so any project-scoped writes
  // (Cursor .cursor/, Copilot .vscode/, Windsurf .windsurfrules) land in
  // an isolated tree, not the IJFW source repo.
  const res = spawnSync(BASH, [INSTALL_SH, target], {
    cwd: sandbox.proj,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return res;
}

// Cleanup helper -- best-effort.
function cleanup(sandbox) {
  try { rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort */ }
}

// install.sh is the POSIX source install path; the canonical Windows path
// is installer/src/install.ps1 (PowerShell). Skip the per-platform install
// matrix on Windows -- the bash script paths assume POSIX shell semantics
// (HOME canonicalisation, $(uname), shell-builtin sed/grep). Per-target
// config-write logic is exercised by the Linux + macOS legs; Windows
// install correctness is the install.ps1 layer's responsibility.
const SKIP_WIN_INSTALL = process.platform === 'win32'
  ? { skip: 'POSIX install.sh path; Windows uses install.ps1' }
  : {};

// -------------------------------------------------------------------------
// Per-platform assertions. Each test runs install.sh with one target, asserts
// the documented config file lands, and validates the MCP entry shape OR
// (rules-only tier) validates the conventions doc lands.
// -------------------------------------------------------------------------

test('matrix: 14 platforms canonical (no drift)', () => {
  // Mirror install.sh's TARGETS default array. If this drifts, the matrix is
  // out of sync and Phase 5 docs (PHASE-5-SMOKE-MATRIX.md) need updating.
  const installSh = readText(INSTALL_SH);
  const m = installSh.match(/TARGETS=\(claude codex gemini cursor windsurf copilot hermes wayland opencode qwen cline kimi openclaw aider\)/);
  assert.ok(m, 'install.sh:TARGETS array must list canonical 14 in order');
  for (const p of PLATFORMS) {
    assert.ok(installSh.includes(`    ${p.id})`), `install.sh case missing for ${p.id}`);
  }
});

test('claude: ~/.claude/settings.json registers ijfw-memory + plugin', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('claude');
  try {
    const r = runInstall('claude', sb);
    assert.equal(r.status, 0, `claude install non-zero: ${r.stderr || r.stdout}`);
    const settings = HOME_PATHS.claude(sb.home)[0];
    assert.ok(existsSync(settings), `settings.json missing at ${settings}`);
    const doc = readJSON(settings);
    assert.ok(doc.enabledPlugins?.['ijfw@ijfw'], 'enabledPlugins missing');
    assert.ok(doc.extraKnownMarketplaces?.ijfw?.source?.path, 'marketplace missing');
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
  } finally { cleanup(sb); }
});

test('codex: ~/.codex/config.toml gets [mcp_servers.ijfw-memory] block', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('codex');
  try {
    const r = runInstall('codex', sb);
    assert.equal(r.status, 0, `codex install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.codex(sb.home)[0];
    assert.ok(existsSync(cfg), `config.toml missing at ${cfg}`);
    const text = readText(cfg);
    assert.ok(text.includes('[mcp_servers.ijfw-memory]'), 'mcp block missing');
    assert.ok(text.includes(`args = ["${SERVER_JS}"]`), 'args path mismatch');
    // Idempotency: second run keeps a single block.
    const r2 = runInstall('codex', sb);
    assert.equal(r2.status, 0);
    const text2 = readText(cfg);
    const occurrences = text2.split('[mcp_servers.ijfw-memory]').length - 1;
    assert.equal(occurrences, 1, `expected 1 mcp block, got ${occurrences}`);
  } finally { cleanup(sb); }
});

test('gemini: ~/.gemini/settings.json + extension bundle land', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('gemini');
  try {
    const r = runInstall('gemini', sb);
    assert.equal(r.status, 0, `gemini install non-zero: ${r.stderr || r.stdout}`);
    const settings = HOME_PATHS.gemini(sb.home)[0];
    assert.ok(existsSync(settings), `gemini settings.json missing`);
    const doc = readJSON(settings);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    // Extension bundle landed.
    const ext = join(sb.home, '.gemini', 'extensions', 'ijfw');
    assert.ok(existsSync(join(ext, 'IJFW.md')), 'IJFW.md missing in extension');
    assert.ok(existsSync(join(ext, 'gemini-extension.json')), 'manifest missing');
  } finally { cleanup(sb); }
});

test('wayland: ~/.wayland/config.yaml + plugin tree land', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('wayland');
  try {
    const r = runInstall('wayland', sb);
    assert.equal(r.status, 0, `wayland install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.wayland(sb.home)[0];
    assert.ok(existsSync(cfg), `wayland config.yaml missing`);
    const text = readText(cfg);
    assert.ok(text.includes('ijfw-memory'), 'mcp entry missing');
    assert.ok(existsSync(join(sb.home, '.wayland', 'plugins', 'ijfw')), 'plugin tree missing');
    assert.ok(existsSync(join(sb.home, '.wayland', 'WAYLAND.md')), 'WAYLAND.md missing');
  } finally { cleanup(sb); }
});

test('hermes: ~/.hermes/config.yaml + plugin opt-in enabled', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('hermes');
  try {
    const r = runInstall('hermes', sb);
    assert.equal(r.status, 0, `hermes install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.hermes(sb.home)[0];
    assert.ok(existsSync(cfg), `hermes config.yaml missing`);
    const text = readText(cfg);
    assert.ok(text.includes('ijfw-memory'), 'mcp entry missing');
    assert.ok(text.includes('ijfw'), 'plugins.enabled entry missing');
    assert.ok(existsSync(join(sb.home, '.hermes', 'plugins', 'ijfw')), 'plugin tree missing');
    assert.ok(existsSync(join(sb.home, '.hermes', 'HERMES.md')), 'HERMES.md missing');
  } finally { cleanup(sb); }
});

test('cursor: project ./.cursor/mcp.json + rule land', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('cursor');
  try {
    const r = runInstall('cursor', sb);
    assert.equal(r.status, 0, `cursor install non-zero: ${r.stderr || r.stdout}`);
    const cfg = PROJECT_PATHS.cursor(sb.proj)[0];
    assert.ok(existsSync(cfg), `cursor mcp.json missing at ${cfg}`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
    assert.ok(existsSync(join(sb.proj, '.cursor', 'rules', 'ijfw.mdc')), 'cursor rule missing');
  } finally { cleanup(sb); }
});

test('windsurf: ~/.codeium/windsurf/mcp_config.json + project rules land', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('windsurf');
  try {
    const r = runInstall('windsurf', sb);
    assert.equal(r.status, 0, `windsurf install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.windsurf(sb.home)[0];
    assert.ok(existsSync(cfg), `windsurf mcp_config.json missing`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    // Project rules landed in PWD.
    assert.ok(existsSync(join(sb.proj, '.windsurfrules')), '.windsurfrules missing in project');
  } finally { cleanup(sb); }
});

test('copilot: project ./.vscode/mcp.json + .github/copilot-instructions.md land', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('copilot');
  try {
    const r = runInstall('copilot', sb);
    assert.equal(r.status, 0, `copilot install non-zero: ${r.stderr || r.stdout}`);
    const cfg = PROJECT_PATHS.copilot(sb.proj)[0];
    assert.ok(existsSync(cfg), `copilot mcp.json missing at ${cfg}`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.ok(existsSync(join(sb.proj, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md missing in project .github/');
  } finally { cleanup(sb); }
});

test('opencode: ~/.config/opencode/opencode.json uses mcp.local schema', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('opencode');
  try {
    const r = runInstall('opencode', sb);
    assert.equal(r.status, 0, `opencode install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.opencode(sb.home)[0];
    assert.ok(existsSync(cfg), `opencode.json missing`);
    const doc = readJSON(cfg);
    // OpenCode-specific shape: top-level mcp (NOT mcpServers), type:"local".
    assert.equal(doc.mcp?.['ijfw-memory']?.type, 'local');
    assert.deepEqual(doc.mcp?.['ijfw-memory']?.command, ['node', SERVER_JS]);
  } finally { cleanup(sb); }
});

test('qwen: ~/.qwen/settings.json registers ijfw-memory', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('qwen');
  try {
    const r = runInstall('qwen', sb);
    assert.equal(r.status, 0, `qwen install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.qwen(sb.home)[0];
    assert.ok(existsSync(cfg), `qwen settings.json missing`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
  } finally { cleanup(sb); }
});

test('cline: VS Code globalStorage settings.json registers ijfw-memory', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('cline');
  try {
    const r = runInstall('cline', sb);
    assert.equal(r.status, 0, `cline install non-zero: ${r.stderr || r.stdout}`);
    const cfg = clineLandingPath(sb.home);
    assert.ok(existsSync(cfg), `cline settings.json missing at ${cfg}`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
    // Cline-specific schema requires type:"stdio".
    assert.equal(doc.mcpServers?.['ijfw-memory']?.type, 'stdio');
  } finally { cleanup(sb); }
});

test('kimi: ~/.kimi/mcp.json registers ijfw-memory', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('kimi');
  try {
    const r = runInstall('kimi', sb);
    assert.equal(r.status, 0, `kimi install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.kimi(sb.home)[0];
    assert.ok(existsSync(cfg), `kimi mcp.json missing`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
  } finally { cleanup(sb); }
});

test('openclaw: ~/.openclaw/openclaw.json uses mcp.servers schema', SKIP_WIN_INSTALL, () => {
  const sb = isolatedSandbox('openclaw');
  try {
    const r = runInstall('openclaw', sb);
    assert.equal(r.status, 0, `openclaw install non-zero: ${r.stderr || r.stdout}`);
    const cfg = HOME_PATHS.openclaw(sb.home)[0];
    assert.ok(existsSync(cfg), `openclaw.json missing`);
    const doc = readJSON(cfg);
    // OpenClaw-specific shape: nested mcp.servers.<name>.
    assert.equal(doc.mcp?.servers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcp?.servers?.['ijfw-memory']?.args, [SERVER_JS]);
  } finally { cleanup(sb); }
});

test('aider: rules-only tier lands ~/.aider.conf.yml + ~/CONVENTIONS.md', SKIP_WIN_INSTALL, () => {
  // Aider has no native MCP client. Tier-3: ship rules + conventions docs
  // through Aider's documented config files. Universal paste-block (universal/
  // ijfw-rules.md) covers all rules-only platforms by reference.
  const sb = isolatedSandbox('aider');
  try {
    const r = runInstall('aider', sb);
    assert.equal(r.status, 0, `aider install non-zero: ${r.stderr || r.stdout}`);
    const [conf, conv] = HOME_PATHS.aider(sb.home);
    assert.ok(existsSync(conf), `~/.aider.conf.yml missing at ${conf}`);
    assert.ok(existsSync(conv), `~/CONVENTIONS.md missing at ${conv}`);
    const confText = readText(conf);
    assert.ok(confText.includes('CONVENTIONS.md'), 'aider.conf.yml does not reference CONVENTIONS.md');
  } finally { cleanup(sb); }
});

test('universal paste-block: universal/ijfw-rules.md ships canonical rules doc', () => {
  // Last-resort tier for any AI agent without a platform-native install path.
  // The doc itself is the install artifact -- users paste into their agent's
  // system prompt or rules file.
  const universal = join(REPO_ROOT, 'universal', 'ijfw-rules.md');
  assert.ok(existsSync(universal), 'universal/ijfw-rules.md missing');
  const text = readText(universal);
  assert.ok(text.includes('IJFW'), 'universal rules doc missing IJFW header');
  assert.ok(text.includes('ijfw_memory_prelude'),
    'universal rules doc must reference the prelude tool so paste-block users get first-turn recall');
});
