// install-flow.js -- IJFW v1.3.0 install orchestrator (pure Node).
//
// Sequences the 12 steps of the install pipeline and dispatches to per-target
// installers in install-targets-*.js. This is the Node-native replacement for
// scripts/install.sh (1938 lines), eliminating the bash dependency on Windows.
//
// Public API:
//   runInstall({ targets, ijfwHome, ijfwCustomDir, repoRoot, noninteractive })
//     -> { live, standby, failed, claudeNeedsRestart }
//
// Source bash mappings (line ranges in scripts/install.sh):
//   Step 1  -- env detection                : 17-100
//   Step 2  -- preflight (Node 18+, repo)   : 117-185
//   Step 3  -- plugin link ~/.ijfw/claude   : 218-277
//   Step 4  -- state seed + settings        : 279-345
//   Step 5  -- statusline detection         : 347-399
//   Step 6  -- plugin .mcp.json patch       : 401-448
//   Step 7  -- plugin cache nuke            : 450-460
//   Step 8  -- mcp-server sibling link      : 462-501
//   Step 9  -- backup pruning               : 503-508
//   Step 10 -- per-target loop              : 1011-1564
//   Step 11 -- summary                      : 1578-1612
//   Step 12 -- post-commit hook (opt-in)    : 1614-1660

/* eslint-disable security/detect-non-literal-fs-filename -- This installer
 * orchestrator intentionally operates on validated repo-root and IJFW home
 * paths. Inputs are constrained by install target selection and install-flow
 * arguments; dynamic filesystem calls here are the expected installer surface,
 * not arbitrary path execution. */

import fs from 'node:fs';
import path from 'node:path';

import {
  homeReal,
  nativePath,
  writeAtomic,
  isLive,
  prettyName,
  printOk,
  printNote,
  printInfo,
  printWarn,
  printSection,
} from './install-helpers.js';

import * as targets1to7 from './install-targets-1-7.js';
import * as targets8to14 from './install-targets-8-14.js';

// ============================================================
// Canonical platform order (must match install.sh:199 default TARGETS)
// ============================================================
export const CANONICAL_ORDER = [
  'claude',
  'codex',
  'gemini',
  'wayland',
  'hermes',
  'cursor',
  'windsurf',
  'copilot',
  'opencode',
  'qwen',
  'cline',
  'kimi',
  'openclaw',
  'aider',
  'antigravity',
];

// Per-target dispatcher. Agents B + C own these implementations.
const TARGET_FNS = {
  claude: targets1to7.installClaude,
  codex: targets1to7.installCodex,
  gemini: targets1to7.installGemini,
  wayland: targets1to7.installWayland,
  hermes: targets1to7.installHermes,
  cursor: targets1to7.installCursor,
  windsurf: targets1to7.installWindsurf,
  copilot: targets8to14.installCopilot,
  opencode: targets8to14.installOpencode,
  qwen: targets8to14.installQwen,
  cline: targets8to14.installCline,
  kimi: targets8to14.installKimi,
  openclaw: targets8to14.installOpenclaw,
  aider: targets8to14.installAider,
  antigravity: targets8to14.installAntigravity,
};

// ============================================================
// Helpers local to the orchestrator
// ============================================================

// YYYYMMDD-HHmmss -- mirrors install.sh:214 `date +%Y%m%d-%H%M%S`.
function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function isWindows() {
  return process.platform === 'win32';
}

// Realpath with passthrough fallback when path does not yet exist.
function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Mirror of install.sh:535-563 logic but using helpers' isLive when available.
// We re-export through helpers; this is just the local reference for clarity.

// ============================================================
// Step implementations
// ============================================================

// Step 2 -- Preflight. Throws on hard failures.
function preflight({ repoRoot, serverJs }) {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
    throw new Error(
      `Preflight: Node.js ${process.versions.node} is too old (need 18+).`
    );
  }
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('Preflight: repoRoot is required and must be a string.');
  }
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`Preflight: repoRoot does not exist at ${repoRoot}`);
  }
  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `Preflight: MCP server.js missing at ${serverJs} -- re-clone the IJFW source tree.`
    );
  }
}

// Step 3 -- Plugin link: ~/.ijfw/claude -> $repoRoot/claude.
// Bash: install.sh:218-277
function linkPlugin({ repoRoot, ijfwHome, ts }) {
  const pluginSrc = path.join(repoRoot, 'claude');
  const pluginDst = path.join(ijfwHome, 'claude');
  const pluginSrcReal = realpathOrSelf(pluginSrc);
  const pluginDstReal = realpathOrSelf(pluginDst);

  if (pluginSrcReal === pluginDstReal && fs.existsSync(pluginDst)) {
    printOk('Plugin source already at canonical path -- symlink not needed.');
    return;
  }

  fs.mkdirSync(ijfwHome, { recursive: true });

  if (isWindows()) {
    // Windows: copy directory tree (no reliable symlinks without dev mode).
    if (fs.existsSync(pluginDst)) {
      const st = fs.lstatSync(pluginDst);
      if (st.isSymbolicLink()) {
        try {
          fs.unlinkSync(pluginDst);
        } catch {
          /* ignore */
        }
      } else if (st.isDirectory()) {
        // V155-030: rm-then-cpSync to MIRROR rather than MERGE. The previous
        // form added/overwrote src→dst but left dst-only files in place,
        // so retired-skill leftovers from v1.4.x persisted indefinitely on
        // every Windows upgrade. POSIX path uses symlink-replace so it's
        // unaffected.
        try {
          fs.rmSync(pluginDst, { recursive: true, force: true });
        } catch (err) {
          // If rm fails (file locked etc.), fall back to merge — partial is
          // better than crash; surface the failure for the user.
          process.stderr.write(
            `[ijfw] linkPlugin: could not clear ${pluginDst} for mirror ` +
            `(${err && err.message ? err.message : err}); falling back to merge.\n`,
          );
        }
        fs.cpSync(pluginSrc, pluginDst, { recursive: true });
        printOk(`Plugin tree mirrored to ${pluginDst}`);
        return;
      } else {
        try {
          fs.rmSync(pluginDst, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
    fs.cpSync(pluginSrc, pluginDst, { recursive: true });
    printOk(`Plugin tree copied to ${pluginDst}`);
    return;
  }

  // POSIX: symlink, retargeting if wrong, fixing if broken, preserving real dirs.
  let dstStat = null;
  try {
    dstStat = fs.lstatSync(pluginDst);
  } catch {
    dstStat = null;
  }

  if (dstStat && dstStat.isSymbolicLink()) {
    let cur = '';
    try {
      cur = fs.readlinkSync(pluginDst);
    } catch {
      cur = '';
    }
    if (cur !== pluginSrc) {
      try {
        fs.unlinkSync(pluginDst);
      } catch {
        /* ignore */
      }
      fs.symlinkSync(pluginSrc, pluginDst, 'dir');
      printOk(`Plugin link retargeted: ${pluginDst} -> ${pluginSrc}`);
    } else {
      printOk(`Plugin link already correct at ${pluginDst}`);
    }
  } else if (dstStat) {
    // Real directory or file -- preserve via rename.
    const backup = `${pluginDst}.backup.${ts}`;
    fs.renameSync(pluginDst, backup);
    fs.symlinkSync(pluginSrc, pluginDst, 'dir');
    printOk(`Plugin link created (existing dir preserved at ${backup}).`);
  } else {
    fs.symlinkSync(pluginSrc, pluginDst, 'dir');
    printOk(`Plugin link created: ${pluginDst} -> ${pluginSrc}`);
  }

  // Verify manifest reachable.
  const manifest = path.join(pluginDst, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) {
    printWarn(
      `Plugin at ${pluginDst} is missing .claude-plugin/plugin.json -- install may be incomplete.`
    );
  }
}

// Step 4 -- State seed: state.json + settings.json + install-method.
// Bash: install.sh:279-345
function seedState({ ijfwHome, repoRoot, nodeBin: _nodeBin }) {
  const cacheDir = path.join(ijfwHome, 'cache');
  const runDir = path.join(ijfwHome, 'run');
  const logsDir = path.join(ijfwHome, 'logs');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  try {
    fs.chmodSync(ijfwHome, 0o700);
  } catch {
    /* ignore on Windows */
  }

  // Detect install_method.
  let installMethod = 'manual';
  if (fs.existsSync(path.join(repoRoot, '.git'))) {
    installMethod = 'git-clone';
  }
  // npm-global detection: best-effort via NODE_PATH-ish probing.
  try {
    const npmGlobalRoot = process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, 'lib', 'node_modules')
      : null;
    if (
      npmGlobalRoot &&
      repoRoot.startsWith(npmGlobalRoot) &&
      repoRoot !== npmGlobalRoot
    ) {
      installMethod = 'npm-global';
    }
  } catch {
    /* ignore */
  }

  // V155-004: Read installed version from installer/package.json. This is the
  // source of truth for the version-comparison logic in update-check. If we
  // silently fall back to '0.0.0' here, every subsequent update-check thinks
  // the user is on v0.0.0 and tries to "upgrade" them. Refuse to seed state
  // unless we can read a real version.
  const pkgPath = path.join(repoRoot, 'installer', 'package.json');
  let installedVer;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    installedVer = pkg.version;
  } catch (err) {
    throw new Error(
      `Preflight: installer/package.json missing or unreadable at ${pkgPath} ` +
      `(${err && err.message ? err.message : err}). ` +
      `Repo tree incomplete; rerun bootstrap from a clean clone.`,
    );
  }
  if (!installedVer || typeof installedVer !== 'string') {
    throw new Error(
      `Preflight: installer/package.json at ${pkgPath} has no usable "version" field. ` +
      `Rerun bootstrap from a clean clone.`,
    );
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const state = {
    schema_version: 1,
    install_method: installMethod,
    installed_version: installedVer,
    last_applied_version: installedVer,
    last_good_shasum: null,
    settings_reseeded_at: null,
    installed_at: nowTs,
  };
  writeAtomic(
    path.join(ijfwHome, 'state.json'),
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 }
  );

  // settings.json -- seed only if absent.
  const settingsPath = path.join(ijfwHome, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    const seedPath = path.join(
      repoRoot,
      'installer',
      'src',
      'settings-seed.json'
    );
    if (fs.existsSync(seedPath)) {
      const seed = fs.readFileSync(seedPath, 'utf8');
      writeAtomic(settingsPath, seed, { mode: 0o600 });
    }
  }

  // install-method legacy file for back-compat.
  writeAtomic(
    path.join(ijfwHome, 'install-method'),
    `${installMethod}\n`,
    { mode: 0o600 }
  );

  printOk(`State seeded (${installMethod}, v${installedVer})`);
  return { installMethod, installedVer };
}

// Step 5 -- Statusline detection. Mirrors install.sh:347-399.
function detectStatusline({ home, ijfwHome }) {
  const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(claudeSettingsPath)) {
    return;
  }
  let claudeSettings;
  try {
    claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
  } catch {
    return;
  }
  const existingCmd =
    claudeSettings && claudeSettings.statusLine && claudeSettings.statusLine.command
      ? String(claudeSettings.statusLine.command)
      : '';
  if (!existingCmd) {
    printOk(
      "statusLine off by default. Run 'ijfw statusline --install' to enable."
    );
    return;
  }
  const allowed =
    existingCmd.includes('/.claude/') ||
    existingCmd.includes('/.gsd/') ||
    existingCmd.includes('/.ijfw/claude/') ||
    existingCmd.includes('/.cursor/');

  if (!allowed) {
    printWarn(
      `Existing statusLine at ${existingCmd} -- not composing for security.`
    );
    printNote(
      "Run 'ijfw statusline --install' to replace, or '--compose' if trusted."
    );
    return;
  }

  // Silent compose: persist existing command into IJFW settings.json.
  const settingsPath = path.join(ijfwHome, 'settings.json');
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    s = {};
  }
  if (!s.schema_version) s.schema_version = 1;
  if (!s.statusline) s.statusline = {};
  s.statusline.composed_command = existingCmd;
  s.statusline.mode = 'compose';
  s.statusline.enabled = 'auto';
  try {
    writeAtomic(settingsPath, JSON.stringify(s, null, 2) + '\n', {
      mode: 0o600,
    });
    printOk(
      "Composed alongside existing statusLine. Run 'ijfw statusline --disable' to opt out."
    );
  } catch (err) {
    printWarn(`Statusline compose write failed: ${err.message}`);
  }
}

// Step 6 -- Plugin .mcp.json absolute-path patch.
// Bash: install.sh:401-448
function patchPluginMcpJson({ ijfwHome, repoRoot, nodeBin, serverJs }) {
  const pluginDst = path.join(ijfwHome, 'claude');
  const mcpJsonPath = path.join(pluginDst, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) return;

  // Skip when PLUGIN_DST resolves into the IJFW source repo (dev installs).
  const pluginDstReal = realpathOrSelf(pluginDst);
  const repoRootReal = realpathOrSelf(repoRoot);
  if (
    fs.existsSync(path.join(repoRoot, '.git')) &&
    pluginDstReal.startsWith(repoRootReal) &&
    pluginDstReal !== repoRootReal
  ) {
    // Resolves into source -- skip to avoid rewriting the source template.
    return;
  }

  let d;
  try {
    d = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  } catch {
    return;
  }
  if (!d || !d.mcpServers || !d.mcpServers['ijfw-memory']) return;

  const nodeDir = path.dirname(nodeBin);
  d.mcpServers['ijfw-memory'].command = nodeBin;
  d.mcpServers['ijfw-memory'].args = [serverJs];
  const envSep = process.platform === 'win32' ? ';' : ':';
  const commonPaths =
    process.platform === 'win32'
      ? [nodeDir, 'C:\\Windows\\System32']
      : [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const dedup = [...new Set(commonPaths.filter((x) => x && fs.existsSync(x)))];
  d.mcpServers['ijfw-memory'].env = { PATH: dedup.join(envSep) };

  try {
    writeAtomic(mcpJsonPath, JSON.stringify(d, null, 2) + '\n');
  } catch (err) {
    printWarn(`Plugin .mcp.json patch failed: ${err.message}`);
  }
}

// Step 7 -- Nuke Claude Code plugin cache so updated .mcp.json lands.
// Bash: install.sh:450-460
function nukePluginCache({ home }) {
  const cacheDir = path.join(home, '.claude', 'plugins', 'cache', 'ijfw');
  if (fs.existsSync(cacheDir)) {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// Step 8 -- MCP sibling link: ~/.ijfw/mcp-server -> $repoRoot/mcp-server.
// Bash: install.sh:462-501
function linkMcpSibling({ repoRoot, ijfwHome, ts }) {
  const mcpSrc = path.join(repoRoot, 'mcp-server');
  const mcpDst = path.join(ijfwHome, 'mcp-server');
  const mcpSrcReal = realpathOrSelf(mcpSrc);
  const mcpDstReal = realpathOrSelf(mcpDst);

  if (mcpSrcReal === mcpDstReal && fs.existsSync(mcpDst)) {
    printOk('MCP source already at canonical path -- symlink not needed.');
    return;
  }

  fs.mkdirSync(ijfwHome, { recursive: true });

  if (isWindows()) {
    if (fs.existsSync(mcpDst)) {
      const st = fs.lstatSync(mcpDst);
      if (st.isSymbolicLink()) {
        try {
          fs.unlinkSync(mcpDst);
        } catch {
          /* ignore */
        }
      } else if (st.isDirectory()) {
        fs.cpSync(mcpSrc, mcpDst, { recursive: true });
        return;
      } else {
        try {
          fs.rmSync(mcpDst, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
    fs.cpSync(mcpSrc, mcpDst, { recursive: true });
    return;
  }

  // POSIX
  let dstStat = null;
  try {
    dstStat = fs.lstatSync(mcpDst);
  } catch {
    dstStat = null;
  }
  if (dstStat && dstStat.isSymbolicLink()) {
    let cur = '';
    try {
      cur = fs.readlinkSync(mcpDst);
    } catch {
      cur = '';
    }
    if (cur !== mcpSrc) {
      try {
        fs.unlinkSync(mcpDst);
      } catch {
        /* ignore */
      }
      fs.symlinkSync(mcpSrc, mcpDst, 'dir');
    }
  } else if (dstStat) {
    const backup = `${mcpDst}.backup.${ts}`;
    fs.renameSync(mcpDst, backup);
    fs.symlinkSync(mcpSrc, mcpDst, 'dir');
  } else {
    fs.symlinkSync(mcpSrc, mcpDst, 'dir');
  }

  if (!fs.existsSync(path.join(mcpDst, 'src', 'server.js'))) {
    printWarn(
      `MCP server at ${mcpDst} is missing src/server.js -- install may be incomplete.`
    );
  }
}

// Step 9 -- Backup pruning. Mirrors install.sh:503-508.
// Delete .bak.* files older than 30 days from common config dirs.
function pruneBackups({ home }) {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const cwd = process.cwd();
  const dirs = [
    path.join(home, '.codex'),
    path.join(home, '.gemini'),
    path.join(home, '.codeium', 'windsurf'),
    path.join(home, '.hermes'),
    path.join(home, '.wayland'),
    path.join(cwd, '.vscode'),
    path.join(cwd, '.cursor'),
  ];
  const cutoff = Date.now() - THIRTY_DAYS_MS;

  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    walkAndPrune(d, 2, cutoff);
  }
}

function walkAndPrune(dir, depth, cutoff) {
  if (depth < 0) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndPrune(full, depth - 1, cutoff);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.includes('.bak.')) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }
}

// Step 11 -- Homebrew-style summary. Mirrors install.sh:1578-1612.
function printSummary({ live, standby, claudeNeedsRestart, repoRoot }) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = useColor
    ? {
        reset: '[0m',
        bold: '[1m',
        dim: '[2m',
        cyan: '[36m',
        green: '[32m',
        yellow: '[33m',
      }
    : { reset: '', bold: '', dim: '', cyan: '', green: '', yellow: '' };

  const nativeRepo = nativePath(repoRoot);

  process.stdout.write('\n');
  process.stdout.write(
    `  ${c.bold}${c.cyan}+----------------------------------------+${c.reset}\n`
  );
  process.stdout.write(
    `  ${c.bold}${c.cyan}|${c.reset}                                        ${c.bold}${c.cyan}|${c.reset}\n`
  );
  process.stdout.write(
    `  ${c.bold}${c.cyan}|${c.reset}  ${c.bold}${c.cyan}IJFW${c.reset}  ${c.dim}It just f*cking works.${c.reset}          ${c.bold}${c.cyan}|${c.reset}\n`
  );
  process.stdout.write(
    `  ${c.bold}${c.cyan}|${c.reset}                                        ${c.bold}${c.cyan}|${c.reset}\n`
  );
  process.stdout.write(
    `  ${c.bold}${c.cyan}+----------------------------------------+${c.reset}\n`
  );
  process.stdout.write('\n');
  process.stdout.write(
    `  ${c.dim}Installed at${c.reset}  ${nativeRepo}\n\n`
  );

  if (live.length) {
    process.stdout.write(
      `  ${c.bold}${c.green}==> LIVE NOW (${live.length})${c.reset}\n`
    );
    for (const p of live) {
      process.stdout.write(`      ${c.green}o${c.reset}  ${p}\n`);
    }
    process.stdout.write('\n');
  }
  if (standby.length) {
    process.stdout.write(
      `  ${c.bold}${c.yellow}==> STANDING BY (${standby.length})${c.reset}  ${c.dim}auto-activate on install${c.reset}\n`
    );
    for (const p of standby) {
      process.stdout.write(`      ${c.yellow}o${c.reset}  ${p}\n`);
    }
    process.stdout.write('\n');
  }
  if (live.length === 0 && standby.length === 0) {
    process.stdout.write(
      `  ${c.yellow}Ready to configure${c.reset}  -- pass a platform name to get started: ${c.bold}ijfw install claude${c.reset}\n\n`
    );
  }
  if (claudeNeedsRestart) {
    process.stdout.write(
      `  ${c.bold}${c.yellow}==> RESTART REQUIRED${c.reset}  Claude Code is running -- ${c.bold}restart your sessions now to activate IJFW.${c.reset}\n\n`
    );
  }
}

// Step 12 -- Post-commit hook (opt-in only). Bash: install.sh:1614-1660.
// Skipped in CI / noninteractive.
function maybeInstallPostCommitHook({ noninteractive }) {
  if (process.env.CI || noninteractive) return;
  if (!fs.existsSync('.git')) return;
  // The bash version only installs when --post-commit-hook is passed. Without
  // an explicit opt-in flag we just print the tip, matching install.sh:1650.
  printNote(
    'Tip: background Trident critique on every commit -- pass --post-commit-hook to enable.'
  );
}

// ============================================================
// Main entry
// ============================================================

export async function runInstall({
  targets,
  ijfwHome,
  ijfwCustomDir,
  repoRoot,
  noninteractive,
} = {}) {
  // ---- Step 1: resolve home + canonicalize -----------------------
  const home = homeReal();
  const resolvedIjfwHome =
    ijfwHome && typeof ijfwHome === 'string' && ijfwHome.length > 0
      ? path.resolve(ijfwHome)
      : path.join(home, '.ijfw');
  const customDir = !!ijfwCustomDir;

  // Canonicalize repoRoot.
  const resolvedRepoRoot =
    repoRoot && typeof repoRoot === 'string'
      ? path.resolve(repoRoot)
      : process.cwd();

  // Build a canonical list of targets.
  let targetList = Array.isArray(targets) && targets.length > 0
    ? targets.filter((t) => CANONICAL_ORDER.includes(t))
    : CANONICAL_ORDER.slice();

  // Preserve canonical order even when caller passed an unordered subset.
  targetList = CANONICAL_ORDER.filter((t) => targetList.includes(t));

  const serverJs = path.join(resolvedRepoRoot, 'mcp-server', 'src', 'server.js');
  const serverJsNative = nativePath(serverJs);
  const nodeBin = process.execPath;
  const ts = timestamp();

  // ---- Step 2: preflight ----------------------------------------
  preflight({ repoRoot: resolvedRepoRoot, serverJs });

  // ---- Step 3: plugin link --------------------------------------
  if (customDir) {
    printOk(
      'Custom-dir install -- skipping ~/.ijfw/ sibling links (canonical-dir feature).'
    );
  } else {
    linkPlugin({ repoRoot: resolvedRepoRoot, ijfwHome: resolvedIjfwHome, ts });
  }

  // ---- Step 4: state seed ---------------------------------------
  // State writes are unconditional even for custom-dir installs. Mirrors
  // install.sh:289-295 reasoning: MCP server resolves homedir()+/.ijfw, so
  // version detection breaks if state.json is absent.
  seedState({
    ijfwHome: resolvedIjfwHome,
    repoRoot: resolvedRepoRoot,
    nodeBin,
  });

  // ---- Step 5: statusline detection -----------------------------
  if (!customDir) {
    detectStatusline({ home, ijfwHome: resolvedIjfwHome });
  }

  // ---- Step 6: plugin .mcp.json patch ---------------------------
  if (!customDir) {
    patchPluginMcpJson({
      ijfwHome: resolvedIjfwHome,
      repoRoot: resolvedRepoRoot,
      nodeBin,
      serverJs,
    });
  }

  // ---- Step 7: plugin cache nuke --------------------------------
  if (!customDir) {
    nukePluginCache({ home });
  }

  // ---- Step 8: MCP sibling link ---------------------------------
  if (!customDir) {
    linkMcpSibling({
      repoRoot: resolvedRepoRoot,
      ijfwHome: resolvedIjfwHome,
      ts,
    });
  }

  // ---- Step 9: backup pruning -----------------------------------
  pruneBackups({ home });

  // ---- Step 10: per-target loop ---------------------------------
  const live = [];
  const standby = [];
  const failed = [];
  let claudeNeedsRestart = false;

  for (const target of targetList) {
    // eslint-disable-next-line security/detect-object-injection -- targetList is filtered against CANONICAL_ORDER; TARGET_FNS is the fixed installer dispatch table.
    const fn = TARGET_FNS[target];
    if (typeof fn !== 'function') {
      // Defensive: should be unreachable because targetList is filtered against
      // CANONICAL_ORDER and TARGET_FNS keys mirror that list.
      printWarn(`No installer registered for target '${target}' -- skipped.`);
      continue;
    }

    printSection(`[${prettyName(target)}]`);

    const ctx = {
      home,
      homeReal: home,
      ijfwHome: resolvedIjfwHome,
      ijfwCustomDir: customDir,
      repoRoot: resolvedRepoRoot,
      serverJs,
      serverJsNative,
      nodeBin,
      ts,
      log: {
        ok: printOk,
        note: printNote,
        info: printInfo,
        warn: printWarn,
      },
    };

    let outcome;
    try {
      outcome = await fn(ctx);
    } catch (err) {
      failed.push(prettyName(target));
      printWarn(
        `${prettyName(target)}: install failed -- ${err && err.message ? err.message : String(err)}`
      );
      continue;
    }

    if (outcome && outcome.restart === true && target === 'claude') {
      claudeNeedsRestart = true;
    }

    // Bucket into live/standby based on runtime presence.
    let liveNow = false;
    try {
      liveNow = !!isLive(target, home);
    } catch {
      liveNow = false;
    }
    const display = prettyName(target);
    if (liveNow) {
      live.push(display);
    } else {
      standby.push(display);
    }
  }

  // ---- Step 11: summary -----------------------------------------
  printSummary({
    live,
    standby,
    claudeNeedsRestart,
    repoRoot: resolvedRepoRoot,
  });

  // ---- Step 12: post-commit hook --------------------------------
  maybeInstallPostCommitHook({ noninteractive: !!noninteractive });

  return { live, standby, failed, claudeNeedsRestart };
}

export default { runInstall, CANONICAL_ORDER };
