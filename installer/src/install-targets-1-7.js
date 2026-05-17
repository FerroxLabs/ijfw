// IJFW v1.3.0 -- per-platform install functions, slice 1/2 (platforms 1-7).
//
// Owner: Agent B. Companion file: install-targets-8-14.js (Agent C).
// These two files are merged by the integrator into the final
// installer/src/install-targets.js.
//
// Source of truth being ported: scripts/install.sh:1018-1525.
// Each export carries the bash line range in JSDoc.
//
// Style:
//   - ESM, sync filesystem APIs, no external deps.
//   - Every function takes a ctx (shape documented in PORT-SPEC.md) and
//     returns { status: 'ok' | 'noop', restart?: boolean } or throws.
//   - Custom-dir guard FIRST in every function (mirrors install.sh:1020-1026).
//   - Project-scoped writes (cursor, windsurf, copilot) also honor
//     ctx.isIjfwSource so an in-source install does not litter the repo.
//
// This module imports merge helpers + logging from install-helpers.js
// (Agent A). Per the spec, those exports are: mergeJson, mergeToml,
// mergeYamlMcp, mergeYamlPluginsEnabled, opencodeMerge, openclawMerge,
// clineMerge, backup, installHook, writeAtomic, isLive, prettyName,
// printOk, printNote, printInfo, printWarn.

/* eslint-disable security/detect-non-literal-fs-filename -- Per-target
 * installer functions operate on validated IJFW home, repo, and platform
 * config paths supplied by install-flow. Dynamic filesystem calls here are
 * the intentional installer write surface. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  cpSync,
  chmodSync,
} from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { platform } from 'node:os';

import {
  mergeJson,
  mergeToml,
  mergeYamlMcp,
  mergeYamlPluginsEnabled,
  mergeYamlHook,
  backup,
  installHook,
  writeAtomic,
  isLive,
  prettyName,
} from './install-helpers.js';

// ----------------------------------------------------------------------
// Local utilities (kept here so this slice has no helper duplication risk
// when merged with Agent C's slice -- these are private to per-target work).
// ----------------------------------------------------------------------

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch { /* best-effort */ }
}

// Copy file only if destination is absent. Mirrors `[ ! -f "$dst" ] && cp`.
function copyIfAbsent(src, dst) {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) return false;
  ensureDir(dirname(dst));
  try { copyFileSync(src, dst); return true; } catch { return false; }
}

// Copy a directory tree only if destination directory is absent.
// Mirrors `[ ! -d "$dst" ] && cp -r "$src" "$dst"`.
function copyDirIfAbsent(src, dst) {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) return false;
  ensureDir(dirname(dst));
  try { cpSync(src, dst, { recursive: true }); return true; } catch { return false; }
}

// Iterate immediate child directories of a parent dir; returns array of
// { name, path } pairs. Empty if parent doesn't exist.
function listSubdirs(parent) {
  if (!existsSync(parent)) return [];
  let names;
  try { names = readdirSync(parent); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name === '__pycache__') continue;
    const path = join(parent, name);
    try { if (statSync(path).isDirectory()) out.push({ name, path }); } catch { /* skip */ }
  }
  return out;
}

// Iterate immediate child files of a parent dir matching a glob-like
// extension filter. Empty if parent doesn't exist.
function listFiles(parent, extFilter) {
  if (!existsSync(parent)) return [];
  let names;
  try { names = readdirSync(parent); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (extFilter && !name.endsWith(extFilter)) continue;
    const path = join(parent, name);
    try { if (statSync(path).isFile()) out.push({ name, path }); } catch { /* skip */ }
  }
  return out;
}

// Standard custom-dir noop response, plus the matching log line. Returns
// `{ status: 'noop' }` so the orchestrator can bucket into LIVE/STANDBY
// without bookkeeping here.
function customDirNoop(ctx, targetId, displayName, reason) {
  ctx.log.info(reason);
  ctx.log.ok(`${displayName}: real platform config left untouched.`);
  return { status: 'noop' };
}

// ----------------------------------------------------------------------
// 1. Claude Code -- install.sh:1018-1135
// ----------------------------------------------------------------------

/**
 * Install IJFW into Claude Code.
 *
 * Ports install.sh:1018-1135.
 *
 * Writes:
 *   - $HOME/.claude/settings.json  (enabledPlugins + extraKnownMarketplaces +
 *                                   mcpServers.ijfw-memory)
 *   - $HOME/.claude/plugins/known_marketplaces.json
 *   - chmod +x on the launcher script (POSIX only).
 *
 * Tradeoff: bash uses `pgrep -x claude` to detect a running Claude Code and
 * surface a "needs restart" hint. The cross-platform equivalent is messy
 * (no pgrep on Windows), and the v1.3.0 spec accepts deferring this. We
 * always return `restart: false`; the user can manually restart. Tracked as
 * a TODO so we can add proper detection later.
 */
export async function installClaude(ctx) {
  if (ctx.ijfwCustomDir) {
    return customDirNoop(
      ctx,
      'claude',
      'Claude Code',
      'Custom-dir install -- skipping ~/.claude/settings.json merge.',
    );
  }

  const claudePluginPath = join(ctx.home, '.ijfw', 'claude');
  const claudeSettings = join(ctx.home, '.claude', 'settings.json');
  const claudeMarketplaces = join(
    ctx.home, '.claude', 'plugins', 'known_marketplaces.json',
  );

  ensureDir(join(ctx.home, '.claude', 'plugins'));

  // Backup before mutating.
  backup(claudeSettings, ctx.ts);

  // --- settings.json: enabledPlugins + extraKnownMarketplaces ---
  let settings = {};
  if (existsSync(claudeSettings)) {
    try {
      settings = JSON.parse(readFileSync(claudeSettings, 'utf8') || '{}');
    } catch { settings = {}; }
  }
  if (!settings || typeof settings !== 'object') settings = {};
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins['ijfw@ijfw'] = true;
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces['ijfw'] = {
    source: { source: 'directory', path: claudePluginPath },
  };

  // --- known_marketplaces.json ---
  const now = new Date().toISOString();
  let mp = {};
  if (existsSync(claudeMarketplaces)) {
    try {
      mp = JSON.parse(readFileSync(claudeMarketplaces, 'utf8') || '{}');
    } catch { mp = {}; }
  }
  if (!mp || typeof mp !== 'object') mp = {};
  mp['ijfw'] = {
    source: { source: 'directory', path: claudePluginPath },
    installLocation: claudePluginPath,
    lastUpdated: now,
  };

  writeAtomic(claudeMarketplaces, JSON.stringify(mp, null, 2) + '\n');

  // --- mcpServers registration in settings.json (with stale-path detection) ---
  // Re-read in case of intervening writes; same logic as the second node -e
  // heredoc in the bash port (install.sh:1080-1116). Stale absolute-path
  // launchers get dropped before we write a fresh node-direct registration.
  const existing = settings.mcpServers && settings.mcpServers['ijfw-memory'];
  if (existing && existing.command) {
    const cmd = existing.command;
    if (isAbsolute(cmd) && !existsSync(cmd)) {
      delete settings.mcpServers['ijfw-memory'];
    }
  }
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers['ijfw-memory'] = {
    command: 'node',
    args: [ctx.serverJsNative],
    env: {},
  };

  writeAtomic(claudeSettings, JSON.stringify(settings, null, 2) + '\n');

  // --- ensure launcher executable (install.sh:1118-1124) ---
  // POSIX only; Windows has no chmod equivalent for shebang scripts.
  const launcherPath = join(ctx.repoRoot, 'mcp-server', 'bin', 'ijfw-memory');
  if (platform() !== 'win32' && existsSync(launcherPath)) {
    try { chmodSync(launcherPath, 0o755); } catch { /* best-effort */ }
  }

  ctx.log.ok('Claude Code ready.');
  ctx.log.note(`.claudeignore template at ${ctx.repoRoot}/claude/.claudeignore`);
  ctx.log.note('  Copy to your project root for instant context savings.');

  // TODO(v1.3.x): port pgrep -x claude detection to a cross-platform
  // process-list check (see install.sh:1132). For now the user manually
  // restarts Claude Code if it was running.
  return { status: 'ok', restart: false };
}

// ----------------------------------------------------------------------
// 2. Codex CLI -- install.sh:1136-1252
// ----------------------------------------------------------------------

/**
 * Install IJFW into Codex CLI.
 *
 * Ports install.sh:1136-1252.
 *
 * Writes:
 *   - $HOME/.codex/config.toml (mergeToml)
 *   - $HOME/.codex/hooks.json  (idempotent matcher-group merge)
 *   - $HOME/.codex/hooks/*.sh  (installHook -- backs up user-modified)
 *   - $HOME/.codex/IJFW.md     (if absent)
 *   - $HOME/.codex/skills/*    (per-skill copy-if-absent)
 *   - ./.codex/skills/*        (project skills, if cwd looks like a project)
 */
export async function installCodex(ctx) {
  if (ctx.ijfwCustomDir) {
    return customDirNoop(
      ctx,
      'codex',
      'Codex',
      'Custom-dir install -- skipping ~/.codex/ merges.',
    );
  }

  // 1. config.toml -- MCP block.
  const configToml = join(ctx.home, '.codex', 'config.toml');
  ensureDir(dirname(configToml));
  mergeToml(configToml, ctx.serverJsNative);

  // 2. hooks.json -- idempotent IJFW matcher-group merge.
  const hooksDst = join(ctx.home, '.codex', 'hooks.json');
  const hooksSrc = join(ctx.repoRoot, 'codex', '.codex', 'hooks.json');
  const hooksBase = join(ctx.home, '.codex', 'hooks');
  ensureDir(hooksBase);

  if (existsSync(hooksSrc)) {
    let doc = {};
    let rawForBackup = null;
    if (existsSync(hooksDst)) {
      rawForBackup = readFileSync(hooksDst, 'utf8');
      try { doc = JSON.parse(rawForBackup || '{}'); } catch { doc = {}; }
    }

    // Detect legacy shape (bare array, or hooks-as-array). Codex moved to
    // {hooks: {EventName: [...]}}; prior shapes do not survive the
    // structural shift, but we never silently drop user data -- snapshot
    // the file before rewriting.
    const isLegacyShape =
      Array.isArray(doc) ||
      (doc && typeof doc === 'object' && doc.hooks &&
        (Array.isArray(doc.hooks) || typeof doc.hooks !== 'object'));
    if (isLegacyShape && rawForBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bk = `${hooksDst}.legacy.bak.${ts}`;
      try {
        writeFileSync(bk, rawForBackup);
        ctx.log.note(`preserved legacy hooks.json at ${bk}`);
      } catch { /* best-effort */ }
    }

    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
    if (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) {
      doc.hooks = {};
    }

    const VALID_EVENTS = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'PermissionRequest',
    ];
    for (const ev of VALID_EVENTS) {
      if (!Array.isArray(doc.hooks[ev])) doc.hooks[ev] = [];
      // Drop any prior IJFW matcher-group (idempotent re-run).
      doc.hooks[ev] = doc.hooks[ev].filter((g) => {
        if (!g || !Array.isArray(g.hooks)) return true;
        return !g.hooks.some((h) => h && h._ijfw);
      });
    }

    // Codex shell-parses the command value. Quote unless the path is fully
    // POSIX-safe (alphanum + . _ / @ -). POSIX single-quote escape: end-quote +
    // backslash-single-quote + start-quote to embed a literal single quote.
    const shellQuote = (p) => {
      if (/^[A-Za-z0-9_./@-]+$/.test(p)) return p;
      return "'" + p.replace(/'/g, "'\\''") + "'";
    };

    let ijfw = {};
    try { ijfw = JSON.parse(readFileSync(hooksSrc, 'utf8')); }
    catch { ijfw = {}; }
    const srcHooks = (ijfw && ijfw.hooks) ? ijfw.hooks : {};
    for (const [ev, groups] of Object.entries(srcHooks)) {
      if (!VALID_EVENTS.includes(ev)) continue;
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g || !Array.isArray(g.hooks)) continue;
        const rewritten = g.hooks.map((h) => {
          if (!h || h.type !== 'command' || !h.command) return h;
          const rel = String(h.command).replace(/^hooks\//, '');
          const cmd = shellQuote(`${hooksBase}/${rel}`);
          return { ...h, command: cmd };
        });
        doc.hooks[ev].push({
          ...(g.matcher ? { matcher: g.matcher } : {}),
          hooks: rewritten,
        });
      }
    }

    writeAtomic(hooksDst, JSON.stringify(doc, null, 2) + '\n');
  }

  // 3. Hook scripts -- always deploy latest; back up user-modified.
  const hookScriptsDir = join(ctx.repoRoot, 'codex', '.codex', 'hooks');
  for (const f of listFiles(hookScriptsDir, '.sh')) {
    installHook(f.path, join(hooksBase, f.name), ctx.ts);
  }

  // 3a. B7 tier-2 extension check script (codex/.codex/scripts/ subdir).
  const codexScriptsSrc = join(ctx.repoRoot, 'codex', '.codex', 'scripts');
  const codexScriptsDst = join(hooksBase, 'scripts');
  ensureDir(codexScriptsDst);
  for (const f of listFiles(codexScriptsSrc, '.sh')) {
    installHook(f.path, join(codexScriptsDst, f.name), ctx.ts);
  }

  // 4. IJFW.md context file (if absent).
  const codexCtx = join(ctx.home, '.codex', 'IJFW.md');
  copyIfAbsent(join(ctx.repoRoot, 'codex', '.codex', 'IJFW.md'), codexCtx);

  // 5. User-level skills.
  const userSkills = join(ctx.home, '.codex', 'skills');
  ensureDir(userSkills);
  const repoSkills = join(ctx.repoRoot, 'codex', 'skills');
  for (const sd of listSubdirs(repoSkills)) {
    copyDirIfAbsent(sd.path, join(userSkills, sd.name));
  }

  // 6. User-level command aliases. Codex currently treats skills as the
  // primary extension surface, but these files keep parity with Claude and
  // are ready for hosts that index command packs.
  const userCommands = join(ctx.home, '.codex', 'commands');
  ensureDir(userCommands);
  const repoCommands = join(ctx.repoRoot, 'codex', 'commands');
  for (const f of listFiles(repoCommands, '.md')) {
    copyIfAbsent(f.path, join(userCommands, f.name));
  }

  // 7. Project-level skills and command aliases (only if we look like a project).
  const cwd = ctx.cwd || process.cwd();
  if (existsSync(join(cwd, '.codex', 'config.toml')) || existsSync(join(cwd, '.ijfw'))) {
    const projSkills = join(cwd, '.codex', 'skills');
    ensureDir(projSkills);
    for (const sd of listSubdirs(repoSkills)) {
      copyDirIfAbsent(sd.path, join(projSkills, sd.name));
    }
    const projCommands = join(cwd, '.codex', 'commands');
    ensureDir(projCommands);
    for (const f of listFiles(repoCommands, '.md')) {
      copyIfAbsent(f.path, join(projCommands, f.name));
    }
  }

  ctx.log.ok('Installed Codex bundle: MCP + hooks + 19 skills + 22 command aliases + context');
  return { status: 'ok' };
}

// ----------------------------------------------------------------------
// 3. Gemini CLI -- install.sh:1253-1328
// (spec table cites 1301-1360; the actual gemini case in install.sh runs
// 1253-1328. Range correction noted; the bash being ported is identical.)
// ----------------------------------------------------------------------

/**
 * Install IJFW into Gemini CLI.
 *
 * Ports the gemini case in install.sh (the case body in the install.sh range
 * surrounding line 1253-1328 in current HEAD; the spec table lists 1301-1360
 * approximately).
 *
 * Writes:
 *   - $HOME/.gemini/settings.json (mergeJson)
 *   - $HOME/.gemini/extensions/ijfw/* (manifest, hooks, skills, commands, agents)
 *   - Expands {{extensionPath}} in hooks.json to the absolute install dir.
 */
export async function installGemini(ctx) {
  if (ctx.ijfwCustomDir) {
    return customDirNoop(
      ctx,
      'gemini',
      'Gemini',
      'Custom-dir install -- skipping ~/.gemini/ merges.',
    );
  }

  // 1. MCP merge into settings.json.
  const dst = join(ctx.home, '.gemini', 'settings.json');
  ensureDir(dirname(dst));
  mergeJson(dst, ctx.serverJsNative);

  // 2. Extension bundle.
  const extDst = join(ctx.home, '.gemini', 'extensions', 'ijfw');
  const extSrc = join(ctx.repoRoot, 'gemini', 'extensions', 'ijfw');
  for (const sub of ['hooks', 'skills', 'commands', 'agents', 'policies']) {
    ensureDir(join(extDst, sub));
  }

  // Manifest, context file, hooks.json, policy -- copy if absent.
  for (const rel of [
    'gemini-extension.json',
    'IJFW.md',
    'hooks/hooks.json',
    'policies/ijfw.toml',
  ]) {
    const dstFile = join(extDst, rel);
    if (!existsSync(dstFile)) {
      ensureDir(dirname(dstFile));
      const srcFile = join(extSrc, rel);
      try { if (existsSync(srcFile)) copyFileSync(srcFile, dstFile); }
      catch { /* best-effort */ }
    }
  }

  // 3. Expand {{extensionPath}} in hooks.json (Gemini CLI does not expand
  // this template variable -- verified empirically). Idempotent: only
  // touches the file when the literal placeholder is still present.
  const hooksJson = join(extDst, 'hooks', 'hooks.json');
  if (existsSync(hooksJson)) {
    let raw = '';
    try { raw = readFileSync(hooksJson, 'utf8'); } catch { raw = ''; }
    if (raw.includes('{{extensionPath}}')) {
      // No regex: split/join is robust against any metachar in extDst
      // (including & | \\ which trip sed/awk on POSIX hosts).
      const replaced = raw.split('{{extensionPath}}').join(extDst);
      writeAtomic(hooksJson, replaced);
    }
  }

  // 4. Hook scripts -- always deploy latest; back up user-modified.
  const hookScriptsDir = join(extSrc, 'hooks');
  for (const f of listFiles(hookScriptsDir, '.sh')) {
    installHook(f.path, join(extDst, 'hooks', f.name), ctx.ts);
  }

  // 4a. B7 tier-2 extension check script (hooks/scripts/ subdir).
  const geminiHookScriptsSrc = join(extSrc, 'hooks', 'scripts');
  const geminiHookScriptsDst = join(extDst, 'hooks', 'scripts');
  ensureDir(geminiHookScriptsDst);
  for (const f of listFiles(geminiHookScriptsSrc, '.sh')) {
    installHook(f.path, join(geminiHookScriptsDst, f.name), ctx.ts);
  }

  // 5. Skills, commands, agents -- copy if absent.
  const skillsSrc = join(extSrc, 'skills');
  for (const sd of listSubdirs(skillsSrc)) {
    copyDirIfAbsent(sd.path, join(extDst, 'skills', sd.name));
  }
  const cmdSrc = join(extSrc, 'commands');
  for (const f of listFiles(cmdSrc, '.toml')) {
    copyIfAbsent(f.path, join(extDst, 'commands', f.name));
  }
  const agentSrc = join(extSrc, 'agents');
  for (const f of listFiles(agentSrc, '.md')) {
    copyIfAbsent(f.path, join(extDst, 'agents', f.name));
  }

  ctx.log.ok('Installed Gemini bundle: MCP + extension + 19 skills + 11 hooks + policy');
  return { status: 'ok' };
}

// ----------------------------------------------------------------------
// 4. Wayland -- install.sh:1421-1452
// ----------------------------------------------------------------------

/**
 * Install IJFW into Wayland CLI.
 *
 * Ports install.sh:1421-1452.
 *
 * Writes:
 *   - $HOME/.wayland/config.yaml (mergeYamlMcp)
 *   - $HOME/.wayland/WAYLAND.md (if absent)
 *   - $HOME/.wayland/skills/* (per-skill copy-if-absent from shared/skills/)
 *   - $HOME/.wayland/plugins/ijfw/* (plugin tree, excluding __pycache__)
 */
export async function installWayland(ctx) {
  if (ctx.ijfwCustomDir) {
    return customDirNoop(
      ctx,
      'wayland',
      'Wayland',
      'Custom-dir install -- skipping ~/.wayland/ merges.',
    );
  }

  const dst = join(ctx.home, '.wayland', 'config.yaml');
  ensureDir(dirname(dst));
  mergeYamlMcp(dst, ctx.serverJsNative);

  // WAYLAND.md (copy if absent).
  ensureDir(join(ctx.home, '.wayland'));
  copyIfAbsent(
    join(ctx.repoRoot, 'wayland', 'WAYLAND.md'),
    join(ctx.home, '.wayland', 'WAYLAND.md'),
  );

  // Skills.
  ensureDir(join(ctx.home, '.wayland', 'skills'));
  const sharedSkills = join(ctx.repoRoot, 'shared', 'skills');
  for (const sd of listSubdirs(sharedSkills)) {
    copyDirIfAbsent(sd.path, join(ctx.home, '.wayland', 'skills', sd.name));
  }

  // Plugin tree (mirrors `find ... -mindepth 1 -maxdepth 1 ! -name __pycache__`).
  const pluginSrc = join(ctx.repoRoot, 'wayland', 'plugins', 'ijfw');
  if (existsSync(pluginSrc)) {
    const pluginDst = join(ctx.home, '.wayland', 'plugins', 'ijfw');
    ensureDir(pluginDst);
    let entries;
    try { entries = readdirSync(pluginSrc); } catch { entries = []; }
    for (const name of entries) {
      if (name === '__pycache__') continue;
      const src = join(pluginSrc, name);
      const dstEntry = join(pluginDst, name);
      try {
        const st = statSync(src);
        if (st.isDirectory()) {
          // bash `cp -r` overwrites; cpSync with force/recursive matches that.
          cpSync(src, dstEntry, { recursive: true, force: true });
        } else if (st.isFile()) {
          copyFileSync(src, dstEntry);
        }
      } catch { /* skip on stat/copy failure */ }
    }
  }

  // B7: wire tier-2 hook registration into config.yaml.
  mergeYamlHook(dst, 'plugins/ijfw/hooks/pre_tool_use_extension_check.py', ctx.ts);

  ctx.log.ok('Installed Wayland bundle: MCP + WAYLAND.md + skills + plugin + tier-2 hook');
  return { status: 'ok' };
}

// ----------------------------------------------------------------------
// 5. Hermes -- install.sh:1386-1420
// ----------------------------------------------------------------------

/**
 * Install IJFW into Hermes CLI.
 *
 * Ports install.sh:1386-1420.
 *
 * Writes:
 *   - $HOME/.hermes/config.yaml (mergeYamlMcp + mergeYamlPluginsEnabled)
 *   - $HOME/.hermes/HERMES.md (if absent)
 *   - $HOME/.hermes/skills/* (per-skill copy-if-absent from shared/skills/)
 *   - $HOME/.hermes/plugins/ijfw/* (plugin tree, excluding __pycache__)
 */
export async function installHermes(ctx) {
  if (ctx.ijfwCustomDir) {
    return customDirNoop(
      ctx,
      'hermes',
      'Hermes',
      'Custom-dir install -- skipping ~/.hermes/ merges.',
    );
  }

  const dst = join(ctx.home, '.hermes', 'config.yaml');
  ensureDir(dirname(dst));
  mergeYamlMcp(dst, ctx.serverJsNative);

  // HERMES.md (copy if absent).
  ensureDir(join(ctx.home, '.hermes'));
  copyIfAbsent(
    join(ctx.repoRoot, 'hermes', 'HERMES.md'),
    join(ctx.home, '.hermes', 'HERMES.md'),
  );

  // Skills.
  ensureDir(join(ctx.home, '.hermes', 'skills'));
  const sharedSkills = join(ctx.repoRoot, 'shared', 'skills');
  for (const sd of listSubdirs(sharedSkills)) {
    copyDirIfAbsent(sd.path, join(ctx.home, '.hermes', 'skills', sd.name));
  }

  // Plugin tree.
  const pluginSrc = join(ctx.repoRoot, 'hermes', 'plugins', 'ijfw');
  if (existsSync(pluginSrc)) {
    const pluginDst = join(ctx.home, '.hermes', 'plugins', 'ijfw');
    ensureDir(pluginDst);
    let entries;
    try { entries = readdirSync(pluginSrc); } catch { entries = []; }
    for (const name of entries) {
      if (name === '__pycache__') continue;
      const src = join(pluginSrc, name);
      const dstEntry = join(pluginDst, name);
      try {
        const st = statSync(src);
        if (st.isDirectory()) {
          cpSync(src, dstEntry, { recursive: true, force: true });
        } else if (st.isFile()) {
          copyFileSync(src, dstEntry);
        }
      } catch { /* skip */ }
    }
  }

  // Hermes is opt-in -- add "ijfw" to plugins.enabled[].
  mergeYamlPluginsEnabled(dst, 'ijfw');

  // B7: wire tier-2 hook registration into config.yaml.
  mergeYamlHook(dst, 'plugins/ijfw/hooks/pre_tool_use_extension_check.py', ctx.ts);

  ctx.log.ok('Installed Hermes bundle: MCP + HERMES.md + skills + plugin + tier-2 hook');
  return { status: 'ok' };
}

// ----------------------------------------------------------------------
// 6. Cursor -- install.sh:1329-1343
// ----------------------------------------------------------------------

/**
 * Install IJFW into Cursor (project-scoped).
 *
 * Ports install.sh:1329-1343.
 *
 * Writes (relative to ctx.cwd or process.cwd()):
 *   - ./.cursor/mcp.json (mergeJson)
 *   - ./.cursor/rules/ijfw.mdc
 *
 * Skipped entirely when running from the IJFW source tree (would litter the
 * source repo with project-scoped configs). Custom-dir installs also skip
 * because there's no canonical "project" target in that mode.
 */
export async function installCursor(ctx) {
  // Cursor is project-scoped, but the bash version skips on IS_IJFW_SOURCE
  // rather than IJFW_CUSTOM_DIR. We honor both: ctx.isIjfwSource is the
  // source-tree guard; ctx.ijfwCustomDir is included for parity with the
  // other targets in this slice.
  if (ctx.isIjfwSource) {
    ctx.log.info('IJFW source tree detected -- skipping Cursor project writes (would litter source).');
    ctx.log.ok('Cursor: source tree left untouched.');
    return { status: 'noop' };
  }
  if (ctx.ijfwCustomDir) {
    return customDirNoop(
      ctx,
      'cursor',
      'Cursor',
      'Custom-dir install -- skipping Cursor project writes.',
    );
  }

  const cwd = ctx.cwd || process.cwd();
  const dst = join(cwd, '.cursor', 'mcp.json');
  ensureDir(dirname(dst));
  mergeJson(dst, ctx.serverJsNative);

  // Rules file.
  const rulesDir = join(cwd, '.cursor', 'rules');
  ensureDir(rulesDir);
  const ruleSrc = join(ctx.repoRoot, 'cursor', '.cursor', 'rules', 'ijfw.mdc');
  if (existsSync(ruleSrc)) {
    try { copyFileSync(ruleSrc, join(rulesDir, 'ijfw.mdc')); }
    catch { /* best-effort */ }
  }

  ctx.log.ok('Merged MCP + installed rule to project ./.cursor/');
  return { status: 'ok' };
}

// ----------------------------------------------------------------------
// 7. Windsurf -- install.sh:1344-1363
// ----------------------------------------------------------------------

/**
 * Install IJFW into Windsurf (mixed: home-scoped MCP + project-scoped rules).
 *
 * Ports install.sh:1344-1363.
 *
 * Writes:
 *   - $HOME/.codeium/windsurf/mcp_config.json (mergeJson)
 *   - ./.windsurfrules (project-scoped, copied if absent)
 *
 * Skipped on custom-dir or in-source installs.
 */
export async function installWindsurf(ctx) {
  if (ctx.ijfwCustomDir || ctx.isIjfwSource) {
    return customDirNoop(
      ctx,
      'windsurf',
      'Windsurf',
      'Skipping Windsurf platform writes (custom-dir or IJFW source tree).',
    );
  }

  const dst = join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json');
  ensureDir(dirname(dst));
  mergeJson(dst, ctx.serverJsNative);

  // .windsurfrules in project root (only if absent).
  const cwd = ctx.cwd || process.cwd();
  const projectRules = join(cwd, '.windsurfrules');
  const repoRules = join(ctx.repoRoot, 'windsurf', '.windsurfrules');

  let installedRules = false;
  if (!existsSync(projectRules) && existsSync(repoRules)) {
    try {
      copyFileSync(repoRules, projectRules);
      installedRules = true;
    } catch { /* best-effort -- bash falls back to the bare MCP message */ }
  }

  if (installedRules) {
    ctx.log.ok('Merged MCP + installed .windsurfrules');
  } else {
    ctx.log.ok(`Merged MCP into ${dst}`);
  }
  return { status: 'ok' };
}

// ----------------------------------------------------------------------
// Re-exports for parity with future install-targets.js (Agent C will append).
// We re-export isLive + prettyName here so install-flow.js doesn't have to
// double-import them when bucketing live/standby for these 7 targets.
// ----------------------------------------------------------------------

export { isLive, prettyName };
