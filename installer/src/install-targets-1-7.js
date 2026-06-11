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
  rmSync,
} from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { platform } from 'node:os';

import {
  mergeJson,
  mergeToml,
  mergeYamlPluginsEnabled,
  mergeYamlHook,
  requireBackup,
  installHook,
  writeAtomic,
  isLive,
  prettyName,
  guardProjectWrite,
} from './install-helpers.js';

// ----------------------------------------------------------------------
// Local utilities (kept here so this slice has no helper duplication risk
// when merged with Agent C's slice -- these are private to per-target work).
// ----------------------------------------------------------------------

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch { /* best-effort */ }
}

// Strip a UTF-8 BOM. Windows editors (Notepad, some PowerShell redirects)
// commonly emit one, and JSON.parse rejects BOM-prefixed input.
function stripBom(s) {
  return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
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

  // Backup before mutating. requireBackup throws if an existing
  // settings.json cannot be backed up -- never rewrite without a recovery
  // copy (the bare backup() return was previously ignored).
  const settingsBak = requireBackup(claudeSettings, ctx.ts);

  // --- settings.json: enabledPlugins + extraKnownMarketplaces ---
  let settings = {};
  if (existsSync(claudeSettings)) {
    try {
      settings = JSON.parse(stripBom(readFileSync(claudeSettings, 'utf8')) || '{}');
    } catch {
      // A corrupt settings.json must NOT be silently replaced with an
      // IJFW-only file -- that would drop the user's permissions allowlist,
      // hooks, env, statusLine and model config. Refuse loudly instead.
      ctx.log.warn('~/.claude/settings.json could not be parsed as JSON -- IJFW will not modify it.');
      if (settingsBak) {
        ctx.log.warn(`A copy of the current file was preserved at ${settingsBak}.`);
      }
      ctx.log.warn('Fix the JSON syntax error and re-run `ijfw install`.');
      return { status: 'noop' };
    }
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
      mp = JSON.parse(stripBom(readFileSync(claudeMarketplaces, 'utf8')) || '{}');
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

  // Deferred: port pgrep -x claude detection to a cross-platform process-list
  // check (see install.sh:1132). For now the user manually restarts Claude
  // Code if it was running. Tracked for v1.6.0 cross-platform completeness.
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
  mergeToml(configToml, ctx.serverJsNative, ctx.ts);

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
  // cwd-parity guard: a project marker like `.ijfw` also exists at ~/.ijfw, so
  // without this guard a `cwd == $HOME` install would author ~/.codex/skills and
  // ~/.codex/commands as if home were a project (global bleed). guardProjectWrite
  // refuses cwd == home / '/'.
  const cwd = ctx.cwd || process.cwd();
  if (
    guardProjectWrite(cwd, ctx.home, {
      platformLabel: 'Codex project skills/commands',
      log: ctx.log,
    }) &&
    (existsSync(join(cwd, '.codex', 'config.toml')) || existsSync(join(cwd, '.ijfw')))
  ) {
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
  mergeJson(dst, ctx.serverJsNative, ctx.ts);

  // 2. Extension bundle.
  const extDst = join(ctx.home, '.gemini', 'extensions', 'ijfw');
  const extSrc = join(ctx.repoRoot, 'gemini', 'extensions', 'ijfw');
  for (const sub of ['hooks', 'skills', 'commands', 'agents', 'policies']) {
    ensureDir(join(extDst, sub));
  }

  // Manifest + hook registration -- refresh on every install with
  // installHook semantics: expand {{extensionPath}} in memory, skip when
  // identical, back up a user-modified copy, then overwrite. Copy-if-absent
  // froze these at first-install state, so hooks added in later releases
  // shipped their .sh scripts (step 4 force-refreshes those) but were never
  // registered in the user's hooks.json.
  for (const rel of ['gemini-extension.json', 'hooks/hooks.json']) {
    const srcFile = join(extSrc, rel);
    if (!existsSync(srcFile)) continue;
    let desired = '';
    try { desired = readFileSync(srcFile, 'utf8'); } catch { continue; }
    desired = desired.split('{{extensionPath}}').join(extDst);
    const dstFile = join(extDst, rel);
    let current = null;
    try { current = existsSync(dstFile) ? readFileSync(dstFile, 'utf8') : null; }
    catch { current = null; }
    if (current === desired) continue;
    if (current !== null) {
      try { copyFileSync(dstFile, `${dstFile}.bak.${ctx.ts}`); } catch { /* best-effort */ }
      ctx.log.note(`Updated ${rel} (previous copy backed up to ${rel}.bak.${ctx.ts})`);
    }
    ensureDir(dirname(dstFile));
    writeAtomic(dstFile, desired);
  }

  // Context file + policy -- copy if absent (user-tunable surfaces).
  for (const rel of ['IJFW.md', 'policies/ijfw.toml']) {
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
 * Install IJFW into Wayland Core.
 *
 * Wayland Core discovers on-disk *declarative* plugins at
 * `~/.wayland/plugins/<name>/plugin.toml` -- a manifest with NO executable
 * `entry` that declares an MCP server + lifecycle hooks. Wayland connects the
 * declared MCP server and deterministically fires the declared hooks into the
 * model's context (SessionStart memory prelude, PrePrompt recall). This is the
 * only IJFW surface Wayland can actually load: it reads TOML (not YAML) and
 * cannot run Python plugins/hooks, so we drop a single declarative plugin.toml
 * here instead of the old config.yaml + Python plugin tree.
 *
 * Writes:
 *   - $HOME/.wayland/plugins/ijfw/plugin.toml (declarative manifest: MCP server
 *     `ijfw-memory` via `node <serverJs>` + session_start / pre_prompt hooks)
 *   - $HOME/.wayland/WAYLAND.md (if absent)
 *   - $HOME/.wayland/skills/* (per-skill copy-if-absent from shared/skills/)
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

  // Declarative plugin manifest. Overwrite on upgrade so the schema stays
  // current (mirror semantics, matching the other Wayland mirror writes).
  const pluginToml = join(ctx.home, '.wayland', 'plugins', 'ijfw', 'plugin.toml');
  ensureDir(dirname(pluginToml));
  writeFileSync(pluginToml, renderWaylandPluginToml(ctx), { encoding: 'utf8' });

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

  ctx.log.ok('Installed Wayland bundle: declarative plugin.toml + WAYLAND.md + skills');
  return { status: 'ok' };
}

// Read the IJFW version from installer/package.json (the same source of truth
// install-flow seeds state from). ctx carries no `version`, so resolve it from
// ctx.repoRoot. Falls back to '0.0.0' only if the file is unreadable -- the
// manifest still parses; Wayland does not gate on the version value.
function ijfwVersion(ctx) {
  try {
    const pkg = JSON.parse(
      readFileSync(join(ctx.repoRoot, 'installer', 'package.json'), 'utf8'),
    );
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch { /* fall through to default */ }
  return '0.0.0';
}

// Escape a value for a TOML basic ("...") string: backslashes first, then
// double-quotes. Same escaping mergeToml() uses for the Codex config.toml args
// path, so a Windows absolute path (C:\Users\...\server.js) stays valid TOML.
function tomlBasicString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Render the Wayland declarative plugin.toml. Must match Wayland's
// PluginManifest schema exactly -- Wayland deserializes with
// deny_unknown_fields and rejects declared hooks / mcp_server without the
// matching [permissions] flags, so do NOT add keys outside this schema.
function renderWaylandPluginToml(ctx) {
  const serverJs = tomlBasicString(ctx.serverJsNative);
  const version = tomlBasicString(ijfwVersion(ctx));
  return [
    '[plugin]',
    'name = "wayland-ijfw"',
    `version = "${version}"`,
    'description = "IJFW memory + lifecycle hooks for Wayland Core"',
    'license = "MIT"',
    '',
    '[permissions]',
    'register_hooks = true',
    'register_mcp_server = true',
    '',
    '[runtime]',
    'kind = "declarative"',
    '',
    '[mcp_server]',
    'name = "ijfw-memory"',
    '',
    '[mcp_server.transport]',
    'kind = "stdio"',
    'command = "node"',
    `args = ["${serverJs}"]`,
    '',
    // Only session_start and pre_prompt dispatch in Wayland today; the
    // post_tool_use / session_end / pre_compact phases are registered-but-
    // log-only on the Wayland side, so they are intentionally omitted. Add
    // them here once Wayland wires those phases.
    '[[hooks]]',
    'phase = "session_start"',
    'tool = "ijfw_memory_prelude"',
    '',
    '[[hooks]]',
    'phase = "pre_prompt"',
    'tool = "ijfw_memory_recall"',
    '',
  ].join('\n');
}

// ----------------------------------------------------------------------
// 5. Hermes -- install.sh:1386-1420
// ----------------------------------------------------------------------

const HERMES_MCP_BEGIN = '# IJFW-MCP-BEGIN ijfw-memory';
const HERMES_MCP_END = '# IJFW-MCP-END ijfw-memory';

// Local copy of the helper-private sentinel stripper (install-helpers.js
// does not export it).
function stripSentinelLines(text, beginMark, endMark) {
  const lines = text.split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (line === beginMark) { skip = true; continue; }
    if (line === endMark) { skip = false; continue; }
    if (skip) continue;
    out.push(line);
  }
  return out.join('\n');
}

// Hermes config.yaml MCP merge. Supersedes install-helpers.mergeYamlMcp for
// this target with two corrections:
//   1. Anchoring: the shared helper appended the indented `ijfw-memory:`
//      mapping at EOF whenever `mcp_servers:` existed anywhere in the file.
//      On a re-install the plugins:/hooks: blocks from the previous run sit
//      between `mcp_servers:` and EOF, so the mapping re-attached to the
//      wrong parent and mcp_servers parsed as null. We splice the block
//      immediately below the `mcp_servers:` line instead.
//   2. Escaping: backslash IS the escape character inside a YAML
//      double-quoted scalar, so an unescaped Windows path (C:\Users\...)
//      made the whole config.yaml unparseable. Escape backslashes first,
//      same as mergeToml.
// Returns true if the file was written.
function hermesMergeYamlMcp(ctx, dst, serverJs) {
  ensureDir(dirname(dst));
  // V155-009: refuse to rewrite an existing config without a verified backup.
  requireBackup(dst, ctx.ts);

  let text = '';
  try { text = existsSync(dst) ? stripBom(readFileSync(dst, 'utf8')) : ''; }
  catch { text = ''; }

  text = stripSentinelLines(text, HERMES_MCP_BEGIN, HERMES_MCP_END);

  const escaped = String(serverJs).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const block = [
    HERMES_MCP_BEGIN,
    '  ijfw-memory:',
    '    command: "node"',
    `    args: ["${escaped}"]`,
    '    enabled: true',
    HERMES_MCP_END,
  ];

  const lines = text.split('\n');
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded numeric index into this function's own split() output.
    const line = lines[i];
    // String ops, not regex: eslint-security flags \s*(?:#.*)? shapes as
    // potentially-unsafe backtracking. Anchor key, then classify the rest.
    if (line.startsWith('mcp_servers:')) {
      const rest = line.slice('mcp_servers:'.length).trim();
      if (rest === '' || rest.startsWith('#')) { anchorIdx = i; break; }
      // Empty inline map ({} with optional inner space / trailing comment) --
      // convert to block form so we can attach a child.
      const beforeComment = rest.split('#')[0].replace(/\s/g, '');
      if (beforeComment === '{}') {
        // eslint-disable-next-line security/detect-object-injection -- same bounded index.
        lines[i] = 'mcp_servers:';
        anchorIdx = i;
        break;
      }
    }
  }

  let merged;
  if (anchorIdx >= 0) {
    lines.splice(anchorIdx + 1, 0, ...block);
    merged = lines.join('\n');
  } else if (/^mcp_servers:/m.test(text)) {
    // Non-empty inline map (mcp_servers: {...}) -- a spliced block child
    // would corrupt the file. Fail safe: leave the user's config untouched.
    ctx.log.warn('Hermes config.yaml uses an inline mcp_servers map -- cannot merge safely.');
    ctx.log.warn('Add an "ijfw-memory" entry to mcp_servers manually (command: node, args: [server.js path]).');
    return false;
  } else {
    const prefix = text.trim() === ''
      ? ''
      : (text.endsWith('\n') ? text : `${text}\n`) + '\n';
    merged = `${prefix}mcp_servers:\n${block.join('\n')}`;
  }
  if (!merged.endsWith('\n')) merged += '\n';
  writeAtomic(dst, merged, { mode: 0o600 });
  return true;
}

// True when plugins.enabled in `dst` is an inline list that already names
// `pluginName`. mergeYamlPluginsEnabled only detects the multi-line "- name"
// form, so without this guard an inline list gains a duplicate per re-install.
function hermesInlineEnabledHas(dst, pluginName) {
  let text = '';
  try { text = existsSync(dst) ? readFileSync(dst, 'utf8') : ''; }
  catch { return false; }
  const esc = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // eslint-disable-next-line security/detect-non-literal-regexp -- pluginName is escaped above.
  const nameRe = new RegExp(`[\\[,]\\s*["']?${esc}["']?\\s*[,\\]]`);
  let inPlugins = false;
  for (const line of text.split('\n')) {
    if (/^plugins:\s*$/.test(line)) { inPlugins = true; continue; }
    if (inPlugins && /^\S/.test(line) && line.trim() !== '') inPlugins = false;
    if (inPlugins && /^\s+enabled:\s*\[.+\]\s*$/.test(line) && nameRe.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Install IJFW into Hermes CLI.
 *
 * Ports install.sh:1386-1420.
 *
 * Writes:
 *   - $HOME/.hermes/config.yaml (hermesMergeYamlMcp + mergeYamlPluginsEnabled)
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
  hermesMergeYamlMcp(ctx, dst, ctx.serverJsNative);

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
    let readdirErr = null;
    try { entries = readdirSync(pluginSrc); } catch (err) { entries = []; readdirErr = err; }
    if (readdirErr) {
      // Skip the mirror entirely: with an empty entries list the dst-only
      // removal below would wipe the user's working plugin tree because of
      // a transient read error on the source.
      ctx.log.warn(`Hermes plugin tree readdir failed: ${readdirErr.message || readdirErr}`);
      ctx.log.warn('Leaving the installed Hermes plugin tree untouched.');
    } else {
      // V155-031: mirror semantics -- remove dst-only files before copy.
      const srcNames = new Set(entries.filter((n) => n !== '__pycache__'));
      let dstEntries = [];
      try { dstEntries = readdirSync(pluginDst); } catch { /* fresh dir */ }
      for (const name of dstEntries) {
        if (name === '__pycache__') continue;
        if (!srcNames.has(name)) {
          try { rmSync(join(pluginDst, name), { recursive: true, force: true }); }
          catch (err) {
            ctx.log.warn(`Hermes plugin: could not remove stale ${name}: ${err.message || err}`);
          }
        }
      }
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
  }

  // Hermes is opt-in -- add "ijfw" to plugins.enabled[]. Skip when an inline
  // enabled list already names ijfw (the helper only detects the multi-line
  // "- ijfw" form and would append a duplicate per re-install).
  //
  // ts is deliberately NOT passed to the two merges below: the pre-run
  // backup of config.yaml was already taken by hermesMergeYamlMcp above, and
  // a second backup at the same ts would overwrite it with mid-run state.
  if (!hermesInlineEnabledHas(dst, 'ijfw')) {
    mergeYamlPluginsEnabled(dst, 'ijfw');
  }

  // B7: wire tier-2 hook registration into config.yaml.
  mergeYamlHook(dst, 'plugins/ijfw/hooks/pre_tool_use_extension_check.py');

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
  // cwd-parity guard: Cursor is entirely project-scoped (./.cursor/...). If cwd
  // is the user's home root, those writes would become ~/.cursor/... -- a global
  // config bleed (installer-side mirror of the SessionStart hook P0 fix). Skip.
  if (!guardProjectWrite(cwd, ctx.home, {
    platformLabel: 'Cursor project rules',
    log: ctx.log,
  })) {
    ctx.log.ok('Cursor: real platform config left untouched.');
    return { status: 'noop' };
  }
  const dst = join(cwd, '.cursor', 'mcp.json');
  ensureDir(dirname(dst));
  mergeJson(dst, ctx.serverJsNative, ctx.ts);

  // Rules file. installHook semantics: skip when identical, back up a
  // user-modified copy before overwriting (a raw copy silently destroyed
  // per-project .mdc frontmatter edits on every re-install).
  const rulesDir = join(cwd, '.cursor', 'rules');
  ensureDir(rulesDir);
  const ruleSrc = join(ctx.repoRoot, 'cursor', '.cursor', 'rules', 'ijfw.mdc');
  if (existsSync(ruleSrc)) {
    try { installHook(ruleSrc, join(rulesDir, 'ijfw.mdc'), ctx.ts); }
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
  mergeJson(dst, ctx.serverJsNative, ctx.ts);

  // .windsurfrules in project root (only if absent). This is the ONLY
  // project-scoped write here -- the MCP config above is home-scoped (correct
  // global config). cwd-parity guard: if cwd is the home root, writing
  // ./.windsurfrules would land ~/.windsurfrules (global bleed). Skip ONLY the
  // project rules; the home MCP merge above already happened.
  const cwd = ctx.cwd || process.cwd();
  if (!guardProjectWrite(cwd, ctx.home, {
    platformLabel: 'Windsurf project rules (.windsurfrules)',
    log: ctx.log,
  })) {
    ctx.log.ok(`Merged MCP into ${dst}`);
    return { status: 'ok' };
  }
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
