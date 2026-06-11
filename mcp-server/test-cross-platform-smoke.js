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
// Discipline: ESM, zero new prod deps, LC_ALL=C. As of v1.3.0 Wave 2, the
// installer is pure Node (installer/src/install-flow.js) -- no bash, no child
// process. We drive runInstall() in-process against an isolated sandbox HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInstall, CANONICAL_ORDER } from '../installer/src/install-flow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER_JS = join(REPO_ROOT, 'mcp-server', 'src', 'server.js');

// Canonical TARGETS list -- mirrors installer/src/install-flow.js:CANONICAL_ORDER.
// 16 platforms.
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
  // Platform #15 (v1.5.1) -- Antigravity.
  { id: 'antigravity', tier: 'mcp-config', name: 'Antigravity' },
  // Platform #16 -- Pi (rules-only; no native MCP, ~/.pi/agent/AGENTS.md).
  { id: 'pi', tier: 'rules-only', name: 'Pi' },
];

assert.equal(PLATFORMS.length, 16, '16-platform matrix invariant');

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
  wayland:  (h) => [join(h, '.wayland', 'plugins', 'ijfw', 'plugin.toml')],
  windsurf: (h) => [join(h, '.codeium', 'windsurf', 'mcp_config.json')],
  opencode: (h) => [join(h, '.config', 'opencode', 'opencode.json')],
  qwen:     (h) => [join(h, '.qwen', 'settings.json')],
  kimi:     (h) => [join(h, '.kimi', 'mcp.json')],
  openclaw: (h) => [join(h, '.openclaw', 'openclaw.json')],
  aider:    (h) => [join(h, '.aider.conf.yml'), join(h, 'CONVENTIONS.md')],
  pi:       (h) => [join(h, '.pi', 'agent', 'AGENTS.md')],
};

// Project-scoped writes (Cursor, Copilot land config inside PWD).
const PROJECT_PATHS = {
  cursor:  (p) => [join(p, '.cursor', 'mcp.json')],
  copilot: (p) => [join(p, '.vscode', 'mcp.json')],
};

// Cline writes into VS Code globalStorage; on macOS that's
// $HOME/Library/Application Support/Code/User/globalStorage/...
function clineLandingPath(home) {
  // Match clineMerge's platform branches in install-helpers.js.
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
// Drive runInstall() against an isolated HOME with a single platform target.
// runInstall is in-process Node, so we override HOME/USERPROFILE on
// process.env (os.homedir() reads them fresh on each call), pass an explicit
// ijfwHome rooted in the sandbox so seedState/linkPlugin can't leak into the
// real ~/.ijfw, and chdir into the sandbox project so cursor/copilot/windsurf
// project-scoped writes land in an isolated tree, not the IJFW source repo.
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

async function installInSandbox(target, sandbox) {
  // Snapshot env + cwd, override for this run, restore in finally.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCwd = process.cwd();

  process.env.HOME = sandbox.home;
  process.env.USERPROFILE = sandbox.home;
  try {
    process.chdir(sandbox.proj);
  } catch {
    // best-effort -- chdir may fail on some sandboxed FS; project-scoped
    // tests will then write to the test runner's CWD, but that's caught by
    // the per-target assertions.
  }

  // Silence the installer's stdout chatter during tests.
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  try {
    return await runInstall({
      targets: [target],
      ijfwHome: join(sandbox.home, '.ijfw'),
      ijfwCustomDir: false,
      repoRoot: REPO_ROOT,
      noninteractive: true,
    });
  } finally {
    process.stdout.write = origWrite;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { process.chdir(prevCwd); } catch { /* best-effort */ }
  }
}

// Cleanup helper -- best-effort, with Windows-friendly retry semantics.
function cleanup(sandbox) {
  try { rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort */ }
}

// -------------------------------------------------------------------------
// Per-platform assertions. Each test runs runInstall() with one target,
// asserts the documented config file lands, and validates the MCP entry shape
// OR (rules-only tier) validates the conventions doc lands.
// -------------------------------------------------------------------------

test('matrix: 16 platforms canonical (no drift)', () => {
  // Mirror installer/src/install-flow.js:CANONICAL_ORDER. If this drifts, the
  // matrix is out of sync and Phase 5 docs (PHASE-5-SMOKE-MATRIX.md) need
  // updating.
  assert.equal(CANONICAL_ORDER.length, 16, 'CANONICAL_ORDER must list 16 platforms');
  const canonicalSet = new Set(CANONICAL_ORDER);
  for (const p of PLATFORMS) {
    assert.ok(canonicalSet.has(p.id), `CANONICAL_ORDER missing platform '${p.id}'`);
  }
  // Order parity: PLATFORMS list must mirror CANONICAL_ORDER exactly.
  for (let i = 0; i < CANONICAL_ORDER.length; i++) {
    assert.equal(
      PLATFORMS[i].id,
      CANONICAL_ORDER[i],
      `PLATFORMS[${i}] (${PLATFORMS[i].id}) drift from CANONICAL_ORDER[${i}] (${CANONICAL_ORDER[i]})`,
    );
  }
});

test('claude: ~/.claude/settings.json registers ijfw-memory + plugin', async () => {
  const sb = isolatedSandbox('claude');
  try {
    await installInSandbox('claude', sb);
    const settings = HOME_PATHS.claude(sb.home)[0];
    assert.ok(existsSync(settings), `settings.json missing at ${settings}`);
    const doc = readJSON(settings);
    assert.ok(doc.enabledPlugins?.['ijfw@ijfw'], 'enabledPlugins missing');
    assert.ok(doc.extraKnownMarketplaces?.ijfw?.source?.path, 'marketplace missing');
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
  } finally { cleanup(sb); }
});

test('codex: ~/.codex/config.toml gets [mcp_servers.ijfw-memory] block', async () => {
  const sb = isolatedSandbox('codex');
  try {
    mkdirSync(join(sb.proj, '.ijfw'), { recursive: true });
    await installInSandbox('codex', sb);
    const cfg = HOME_PATHS.codex(sb.home)[0];
    assert.ok(existsSync(cfg), `config.toml missing at ${cfg}`);
    const text = readText(cfg);
    assert.ok(text.includes('[mcp_servers.ijfw-memory]'), 'mcp block missing');
    // mergeToml escapes backslashes for valid TOML on Windows
    // (C:\Users -> "C:\\Users"). Mirror that escape here so the assertion
    // works on every platform.
    const escapedServerJs = SERVER_JS.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    assert.ok(text.includes(`args = ["${escapedServerJs}"]`), 'args path mismatch');
    // Idempotency: second run keeps a single block.
    await installInSandbox('codex', sb);
    const text2 = readText(cfg);
    const occurrences = text2.split('[mcp_servers.ijfw-memory]').length - 1;
    assert.equal(occurrences, 1, `expected 1 mcp block, got ${occurrences}`);
    assert.ok(existsSync(join(sb.home, '.codex', 'commands', 'cross-audit.md')), 'user command alias missing');
    assert.ok(existsSync(join(sb.proj, '.codex', 'commands', 'cross-audit.md')), 'project command alias missing');
  } finally { cleanup(sb); }
});

test('gemini: ~/.gemini/settings.json + extension bundle land', async () => {
  const sb = isolatedSandbox('gemini');
  try {
    await installInSandbox('gemini', sb);
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

test('wayland: ~/.wayland/plugins/ijfw/plugin.toml + plugin tree land', async () => {
  const sb = isolatedSandbox('wayland');
  try {
    await installInSandbox('wayland', sb);
    const cfg = HOME_PATHS.wayland(sb.home)[0];
    assert.ok(existsSync(cfg), `wayland plugin.toml missing`);
    const text = readText(cfg);
    assert.ok(text.includes('ijfw-memory'), 'mcp entry missing');
    assert.ok(existsSync(join(sb.home, '.wayland', 'plugins', 'ijfw')), 'plugin tree missing');
    assert.ok(existsSync(join(sb.home, '.wayland', 'WAYLAND.md')), 'WAYLAND.md missing');
  } finally { cleanup(sb); }
});

test('hermes: ~/.hermes/config.yaml + plugin opt-in enabled', async () => {
  const sb = isolatedSandbox('hermes');
  try {
    await installInSandbox('hermes', sb);
    const cfg = HOME_PATHS.hermes(sb.home)[0];
    assert.ok(existsSync(cfg), `hermes config.yaml missing`);
    const text = readText(cfg);
    assert.ok(text.includes('ijfw-memory'), 'mcp entry missing');
    assert.ok(text.includes('ijfw'), 'plugins.enabled entry missing');
    assert.ok(existsSync(join(sb.home, '.hermes', 'plugins', 'ijfw')), 'plugin tree missing');
    assert.ok(existsSync(join(sb.home, '.hermes', 'HERMES.md')), 'HERMES.md missing');
  } finally { cleanup(sb); }
});

test('cursor: project ./.cursor/mcp.json + rule land', async () => {
  const sb = isolatedSandbox('cursor');
  try {
    await installInSandbox('cursor', sb);
    const cfg = PROJECT_PATHS.cursor(sb.proj)[0];
    assert.ok(existsSync(cfg), `cursor mcp.json missing at ${cfg}`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
    assert.ok(existsSync(join(sb.proj, '.cursor', 'rules', 'ijfw.mdc')), 'cursor rule missing');
  } finally { cleanup(sb); }
});

test('windsurf: ~/.codeium/windsurf/mcp_config.json + project rules land', async () => {
  const sb = isolatedSandbox('windsurf');
  try {
    await installInSandbox('windsurf', sb);
    const cfg = HOME_PATHS.windsurf(sb.home)[0];
    assert.ok(existsSync(cfg), `windsurf mcp_config.json missing`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    // Project rules landed in PWD.
    assert.ok(existsSync(join(sb.proj, '.windsurfrules')), '.windsurfrules missing in project');
  } finally { cleanup(sb); }
});

test('copilot: project ./.vscode/mcp.json + .github/copilot-instructions.md land', async () => {
  const sb = isolatedSandbox('copilot');
  try {
    await installInSandbox('copilot', sb);
    const cfg = PROJECT_PATHS.copilot(sb.proj)[0];
    assert.ok(existsSync(cfg), `copilot mcp.json missing at ${cfg}`);
    const doc = readJSON(cfg);
    // VS Code's workspace mcp.json schema keys servers under `servers`,
    // not `mcpServers` (the old key was why Copilot MCP never loaded).
    assert.equal(doc.servers?.['ijfw-memory']?.command, 'node');
    assert.equal(doc.mcpServers, undefined, 'legacy mcpServers key must not be written');
    assert.ok(existsSync(join(sb.proj, '.github', 'copilot-instructions.md')),
      'copilot-instructions.md missing in project .github/');
  } finally { cleanup(sb); }
});

test('opencode: ~/.config/opencode/opencode.json uses mcp.local schema', async () => {
  const sb = isolatedSandbox('opencode');
  try {
    await installInSandbox('opencode', sb);
    const cfg = HOME_PATHS.opencode(sb.home)[0];
    assert.ok(existsSync(cfg), `opencode.json missing`);
    const doc = readJSON(cfg);
    // OpenCode-specific shape: top-level mcp (NOT mcpServers), type:"local".
    assert.equal(doc.mcp?.['ijfw-memory']?.type, 'local');
    assert.deepEqual(doc.mcp?.['ijfw-memory']?.command, ['node', SERVER_JS]);
  } finally { cleanup(sb); }
});

test('qwen: ~/.qwen/settings.json registers ijfw-memory', async () => {
  const sb = isolatedSandbox('qwen');
  try {
    await installInSandbox('qwen', sb);
    const cfg = HOME_PATHS.qwen(sb.home)[0];
    assert.ok(existsSync(cfg), `qwen settings.json missing`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
  } finally { cleanup(sb); }
});

test('cline: VS Code globalStorage settings.json registers ijfw-memory', async () => {
  const sb = isolatedSandbox('cline');
  try {
    await installInSandbox('cline', sb);
    const cfg = clineLandingPath(sb.home);
    assert.ok(existsSync(cfg), `cline settings.json missing at ${cfg}`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcpServers?.['ijfw-memory']?.args, [SERVER_JS]);
    // Cline-specific schema requires type:"stdio".
    assert.equal(doc.mcpServers?.['ijfw-memory']?.type, 'stdio');
  } finally { cleanup(sb); }
});

test('kimi: ~/.kimi/mcp.json registers ijfw-memory', async () => {
  const sb = isolatedSandbox('kimi');
  try {
    await installInSandbox('kimi', sb);
    const cfg = HOME_PATHS.kimi(sb.home)[0];
    assert.ok(existsSync(cfg), `kimi mcp.json missing`);
    const doc = readJSON(cfg);
    assert.equal(doc.mcpServers?.['ijfw-memory']?.command, 'node');
  } finally { cleanup(sb); }
});

test('openclaw: ~/.openclaw/openclaw.json uses mcp.servers schema', async () => {
  const sb = isolatedSandbox('openclaw');
  try {
    await installInSandbox('openclaw', sb);
    const cfg = HOME_PATHS.openclaw(sb.home)[0];
    assert.ok(existsSync(cfg), `openclaw.json missing`);
    const doc = readJSON(cfg);
    // OpenClaw-specific shape: nested mcp.servers.<name>.
    assert.equal(doc.mcp?.servers?.['ijfw-memory']?.command, 'node');
    assert.deepEqual(doc.mcp?.servers?.['ijfw-memory']?.args, [SERVER_JS]);
  } finally { cleanup(sb); }
});

test('aider: rules-only tier lands ~/.aider.conf.yml + ~/CONVENTIONS.md', async () => {
  // Aider has no native MCP client. Tier-3: ship rules + conventions docs
  // through Aider's documented config files. Universal paste-block (universal/
  // ijfw-rules.md) covers all rules-only platforms by reference.
  const sb = isolatedSandbox('aider');
  try {
    await installInSandbox('aider', sb);
    const [conf, conv] = HOME_PATHS.aider(sb.home);
    assert.ok(existsSync(conf), `~/.aider.conf.yml missing at ${conf}`);
    assert.ok(existsSync(conv), `~/CONVENTIONS.md missing at ${conv}`);
    const confText = readText(conf);
    assert.ok(confText.includes('CONVENTIONS.md'), 'aider.conf.yml does not reference CONVENTIONS.md');
  } finally { cleanup(sb); }
});

test('pi: rules-only tier lands ~/.pi/agent/AGENTS.md', async () => {
  // Pi has no native MCP client. Tier-3: ship the AGENTS.md rules doc to Pi's
  // documented config path. installPi copies pi/AGENTS.md -> ~/.pi/agent/AGENTS.md.
  const sb = isolatedSandbox('pi');
  try {
    await installInSandbox('pi', sb);
    const [agents] = HOME_PATHS.pi(sb.home);
    assert.ok(existsSync(agents), `~/.pi/agent/AGENTS.md missing at ${agents}`);
    const text = readText(agents);
    assert.ok(text.includes('IJFW') || text.includes('ijfw'), 'pi AGENTS.md missing IJFW rules');
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
