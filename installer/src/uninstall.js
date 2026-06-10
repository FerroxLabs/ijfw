// @ijfw/install -- reverse install. Preserves ~/.ijfw/memory/ unless --purge.

import { existsSync, rmSync, cpSync, mkdtempSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unmergeMarketplace, claudeSettingsPath } from './marketplace.js';
import { readLedger, isEmptyDir } from './install-ledger.js';

// Repo root, resolved relative to this module (installer/src/uninstall.js ->
// repo root is two dirs up). Used to byte-compare shipped Aider templates
// against the user's installed copies before any deletion.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

// resolveAiderTemplate -- locate a shipped Aider convention template across the
// two layouts this module runs from:
//
//   (a) git clone  -> <repoRoot>/aider/<name>            (REPO_ROOT/aider/...)
//   (b) npm tarball -> dist/uninstall.js, templates staged by build.js at
//                      <pkgRoot>/templates/aider/<name>  (i.e. ../templates from dist)
//
// The published @ijfw/install package does NOT ship the repo's top-level
// `aider/` dir, and dist/uninstall.js's REPO_ROOT points two dirs above
// `dist/` (the package root's parent) -- so the (a) path does not exist in a
// pure-tarball install. build.js copies the templates into templates/aider/,
// which IS in package.json "files"; this resolver finds them there.
//
// Returns the first existing candidate path, or '' if none found (caller then
// treats the file as un-provable -> KEEPS it, never deletes).
//
// `repoRoot` is injectable so tests can point at the repo layout explicitly.
function resolveAiderTemplate(name, repoRoot) {
  // Order matters. An explicitly-injected repoRoot is authoritative and is
  // checked FIRST -- tests rely on this to pin a specific layout, and it lets a
  // caller override the auto-detected location. The __dirname-relative
  // candidates are the production fallback for a pure tarball (where no
  // repoRoot/aider exists). They come LAST so the package's own staged-template
  // location can never shadow an explicit caller choice.
  const root = repoRoot || REPO_ROOT;
  const candidates = [
    // (a) git clone: top-level aider/ under the (injected) repo root.
    join(root, 'aider', name),
    // (a') repo root with staged templates under installer/.
    join(root, 'installer', 'templates', 'aider', name),
    // (b) tarball/dist fallback: templates staged next to the package root.
    //   dist/uninstall.js -> __dirname=<pkg>/dist -> <pkg>/templates/aider/<name>
    //   src/uninstall.js  -> __dirname=<pkg>/src  -> <pkg>/templates/aider/<name>
    //   (__dirname's parent is the package root in both layouts)
    resolve(__dirname, '..', 'templates', 'aider', name),
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* skip */ }
  }
  return '';
}

// Atomic write: write to a temp sibling, then rename into place.
// Prevents mid-write truncation from leaving a half-written config.
function writeAtomic(target, content) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`atomic write failed for ${target}: ${err.message}`);
  }
}

function parseArgs(argv) {
  const out = { dir: null, purge: false, noMarketplace: false, yes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--purge') out.purge = true;
    else if (a === '--no-marketplace') out.noMarketplace = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`ijfw-uninstall -- reverse IJFW install
Usage: ijfw-uninstall [--dir <path>] [--purge] [--no-marketplace] [--yes]
  --purge           also remove memory/ (destructive)
  --no-marketplace  skip ~/.claude/settings.json edits
  --yes, -y         skip the confirmation prompt (for scripted use)
`);
}

// Interactive yes/no confirmation. Resolves true only on an explicit "y"/"yes".
// Used to guard the destructive uninstall (`ijfw off` / `ijfw uninstall`).
function confirm(question) {
  return new Promise((res) => {
    process.stdout.write(question);
    const onData = (chunk) => {
      process.stdin.removeListener('data', onData);
      try { process.stdin.pause(); } catch {}
      const answer = String(chunk).trim().toLowerCase();
      res(answer === 'y' || answer === 'yes');
    };
    try { process.stdin.resume(); } catch {}
    process.stdin.once('data', onData);
  });
}

const HOME = homedir();
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

function backupFile(p) {
  if (existsSync(p)) {
    const bak = p + '.bak.' + TS;
    cpSync(p, bak);
    return bak;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Project marker-region stripping (the headline P3 honesty gap).
//
// IJFW injects managed marker regions into project CLAUDE.md / AGENTS.md
// (and into rules files). Uninstall must remove exactly those regions and
// preserve every user-authored line. This mirrors
// claude/hooks/scripts/global-cleanup.sh's `ijfw_strip_blocks` node payload
// verbatim, ported to in-process JS so uninstall.js needs no subprocess.
// ---------------------------------------------------------------------------

// Pure string -> { text, changed }. Never throws. Strips the five IJFW marker
// regions, the autogen comment, and the AGENTS.md explainer paragraph, then
// collapses blank-line runs. START tags are PREFIX-matched (the MEMORY start
// tag carries a "(managed -- do not edit manually)" suffix in CLAUDE.md but is
// bare in AGENTS.md.tmpl) so both shapes are caught.
function stripIjfwRegions(src) {
  if (typeof src !== 'string') return { text: src, changed: false };
  const before = src;
  let out = src;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regions = [
    ['<!-- IJFW-MEMORY-START', '<!-- IJFW-MEMORY-END -->'],
    ['<!-- IJFW-ROUTING-START', '<!-- IJFW-ROUTING-END -->'],
    ['<!-- IJFW-AGENTS-START', '<!-- IJFW-AGENTS-END -->'],
    ['<!-- IJFW-BLACKBOARD-START', '<!-- IJFW-BLACKBOARD-END -->'],
    ['<!-- IJFW-DISCIPLINE-START', '<!-- IJFW-DISCIPLINE-END -->'],
  ];
  for (const [start, end] of regions) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- start/end are hardcoded IJFW sentinel literals, regex-escaped before use.
    const re = new RegExp('\\n*' + esc(start) + '[\\s\\S]*?' + esc(end) + '[^\\n]*', 'g');
    out = out.replace(re, '');
  }
  // IJFW autogen comment (CLAUDE.md).
  out = out.replace(/\n*<!-- Auto-generated by IJFW from repo scan\.[^\n]*-->/g, '');
  // AGENTS.md explainer paragraph for the managed regions. The count word has
  // drifted ("Four" -> "Five") across versions; match either so we strip the
  // IJFW-authored explainer regardless of which template version wrote it.
  out = out.replace(/\n*(?:Four|Five) IJFW-managed regions live in this file\.[\s\S]*?IJFW will never touch it\./g, '');
  // Collapse blank-line runs; keep a single trailing newline.
  out = out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  if (out.length) out += '\n';
  return { text: out, changed: out !== before };
}

// Does this text carry any IJFW marker region? Cheap pre-check so we only back
// up + rewrite files we actually authored into.
function hasIjfwMarker(text) {
  return /IJFW-MEMORY-START|IJFW-ROUTING-START|IJFW-AGENTS-START|IJFW-BLACKBOARD-START|IJFW-DISCIPLINE-START/.test(text);
}

// Strip IJFW marker regions from a project markdown file, preserving user
// content. Guarded end-to-end: never throws. Backs up before editing.
// When `deleteIfEmpty` is set, a file whose post-strip body is whitespace-only
// is removed entirely (used for rules files that are wholly IJFW-managed apart
// from optional user additions). Returns a human-readable status or null.
function stripMarkerFile(p, opts = {}) {
  try {
    if (!existsSync(p)) return null;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { return null; }
    if (!hasIjfwMarker(text)) return null;
    const { text: stripped, changed } = stripIjfwRegions(text);
    if (!changed) return null;
    backupFile(p);
    if (opts.deleteIfEmpty && stripped.trim() === '') {
      rmSync(p, { force: true });
      return `${opts.label || p}  (removed -- became empty after IJFW region strip)`;
    }
    writeAtomic(p, stripped);
    return `${opts.label || p}  (stripped IJFW marker regions, user content preserved)`;
  } catch {
    return null;
  }
}

// Remove [mcp_servers.ijfw-memory] section from a TOML file.
function removeTomlSection(p) {
  if (!existsSync(p)) return false;
  backupFile(p);
  const lines = readFileSync(p, 'utf8').split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (/^\[mcp_servers\.ijfw-memory\]\s*$/.test(line)) { skip = true; continue; }
    if (skip && line.startsWith('[') && !line.startsWith('[mcp_servers.ijfw-memory]')) skip = false;
    if (!skip) out.push(line);
  }
  writeAtomic(p, out.join('\n') + '\n');
  return true;
}

// Remove ijfw-memory key from a JSON mcpServers object.
function removeJsonMcpEntry(p) {
  if (!existsSync(p)) return false;
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { return false; }
  if (!doc || typeof doc !== 'object') return false;
  let changed = false;
  if (doc.mcpServers && doc.mcpServers['ijfw-memory']) {
    backupFile(p);
    delete doc.mcpServers['ijfw-memory'];
    writeAtomic(p, JSON.stringify(doc, null, 2) + '\n');
    changed = true;
  }
  return changed;
}

// Remove ijfw-memory from a NESTED JSON MCP container. `keyPath` is the chain
// of object keys leading to the map that holds the 'ijfw-memory' entry, e.g.
//   ['mcp']            -> OpenCode  (doc.mcp['ijfw-memory'])
//   ['mcp','servers']  -> OpenClaw  (doc.mcp.servers['ijfw-memory'])
// Backs up before editing; atomic write. Never throws.
function removeNestedMcpEntry(p, keyPath) {
  try {
    if (!existsSync(p)) return false;
    let doc;
    try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { return false; }
    if (!doc || typeof doc !== 'object') return false;
    let node = doc;
    for (const k of keyPath) {
      if (!node[k] || typeof node[k] !== 'object') return false;
      node = node[k];
    }
    if (!node['ijfw-memory']) return false;
    backupFile(p);
    delete node['ijfw-memory'];
    writeAtomic(p, JSON.stringify(doc, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Resolve the Cline cline_mcp_settings.json path for the given home, returning
// only an EXISTING globalStorage location (read-only discovery -- unlike the
// installer we never fall back to an OS default we'd then create). Mirrors the
// candidate list in install-helpers.clineMerge. Returns the settings file path
// or null if no Cline globalStorage dir is present.
function resolveClineSettingsPath(home) {
  const H = home;
  const APPDATA = process.env.APPDATA || join(H, 'AppData', 'Roaming');
  const ext = 'saoudrizwan.claude-dev';
  let userDirs;
  if (process.platform === 'darwin') {
    userDirs = [
      join(H, 'Library', 'Application Support', 'Code', 'User'),
      join(H, 'Library', 'Application Support', 'Code - Insiders', 'User'),
      join(H, 'Library', 'Application Support', 'VSCodium', 'User'),
    ];
  } else if (process.platform === 'win32') {
    userDirs = [
      join(APPDATA, 'Code', 'User'),
      join(APPDATA, 'Code - Insiders', 'User'),
      join(APPDATA, 'VSCodium', 'User'),
    ];
  } else {
    userDirs = [
      join(H, '.config', 'Code', 'User'),
      join(H, '.config', 'VSCodium', 'User'),
      join(H, '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User'),
      join(H, 'snap', 'code', 'current', '.config', 'Code', 'User'),
    ];
  }
  for (const d of userDirs) {
    const settings = join(d, 'globalStorage', ext, 'settings', 'cline_mcp_settings.json');
    if (existsSync(settings)) return settings;
  }
  return null;
}

// Remove ~/.aider.conf.yml / ~/CONVENTIONS.md ONLY when the on-disk file is a
// byte-for-byte match of the shipped template. Aider files carry no markers and
// were copy-if-missing at install, so we cannot distinguish IJFW-authored from
// user-edited any other way. If the bytes differ (user edited, or a pre-existing
// file install never touched), we LEAVE the file and signal so the caller can
// log honestly. Returns 'removed' | 'kept-modified' | 'absent'.
function removeAiderFileIfPristine(installedPath, templatePath) {
  try {
    if (!existsSync(installedPath)) return 'absent';
    if (!existsSync(templatePath)) return 'kept-modified'; // can't prove pristine
    let a, b;
    try {
      a = readFileSync(installedPath);
      b = readFileSync(templatePath);
    } catch { return 'kept-modified'; }
    if (a.equals(b)) {
      backupFile(installedPath);
      rmSync(installedPath, { force: true });
      return 'removed';
    }
    return 'kept-modified';
  } catch {
    return 'kept-modified';
  }
}

// Remove IJFW matcher-groups from ~/.codex/hooks.json. Handles three shapes:
//   (a) current: { hooks: { EventName: [MatcherGroup, ...] } }
//       -- walk every event, drop MatcherGroups whose inner hooks[] contains an _ijfw entry.
//   (b) legacy v1 object: { hooks: [HookEntry, ...] } -- drop _ijfw items from the array.
//   (c) legacy v2 bare array: [HookEntry, ...] -- same as (b).
// Backwards-compat so uninstall works no matter which schema a user is on.
function removeCodexHooks(p) {
  if (!existsSync(p)) return false;
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { return false; }

  // Shape (c): top-level array.
  if (Array.isArray(doc)) {
    const before = doc.length;
    const after = doc.filter(h => !(h && h._ijfw));
    if (after.length === before) return false;
    backupFile(p);
    writeAtomic(p, JSON.stringify(after, null, 2) + '\n');
    return true;
  }

  if (!doc || typeof doc !== 'object' || !doc.hooks) return false;

  // Shape (a): nested map.
  if (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)) {
    let changed = false;
    for (const ev of Object.keys(doc.hooks)) {
      const groups = doc.hooks[ev];
      if (!Array.isArray(groups)) continue;
      const before = groups.length;
      doc.hooks[ev] = groups.filter(g => {
        if (!g || !Array.isArray(g.hooks)) return true;
        return !g.hooks.some(h => h && h._ijfw);
      });
      if (doc.hooks[ev].length !== before) changed = true;
    }
    if (!changed) return false;
    backupFile(p);
    writeAtomic(p, JSON.stringify(doc, null, 2) + '\n');
    return true;
  }

  // Shape (b): legacy array-under-hooks.
  if (Array.isArray(doc.hooks)) {
    const before = doc.hooks.length;
    doc.hooks = doc.hooks.filter(h => !(h && h._ijfw));
    if (doc.hooks.length === before) return false;
    backupFile(p);
    writeAtomic(p, JSON.stringify(doc, null, 2) + '\n');
    return true;
  }

  return false;
}

// Remove mcp_servers.ijfw-memory from a YAML file (Hermes / Wayland).
// Prefers python3+PyYAML for parser-safe removal; falls back to regex.
function removeYamlMcpEntry(p) {
  if (!existsSync(p)) return false;
  // Cheap pre-check: skip the fork if the key isn't even present.
  const raw = readFileSync(p, 'utf8');
  if (!/\bijfw-memory\b/.test(raw)) return false;

  // Try python3+PyYAML first.
  const py = spawnSync('python3', ['-c', `
import sys, yaml
p = sys.argv[1]
with open(p) as f: raw = f.read()
doc = yaml.safe_load(raw) if raw.strip() else {}
if not isinstance(doc, dict): sys.exit(2)
srv = doc.get("mcp_servers")
if not isinstance(srv, dict) or "ijfw-memory" not in srv: sys.exit(3)
del srv["ijfw-memory"]
if not srv: del doc["mcp_servers"]
with open(p + ".tmp", "w") as f:
    yaml.safe_dump(doc, f, sort_keys=False, default_flow_style=False)
import os; os.replace(p + ".tmp", p)
`, p], { encoding: 'utf8' });
  if (py.status === 0) { backupFile(p); return true; }

  // Fallback: regex-strip the ijfw-memory block under mcp_servers.
  // Matches 2-space indented key plus its 4-space indented body until the next
  // same-indent sibling or end-of-file. Best-effort; ok for IJFW-shaped YAML.
  const stripped = raw.replace(
    // eslint-disable-next-line security/detect-unsafe-regex -- raw is a small local YAML config file; pattern is line-anchored to the IJFW-owned block.
    /^  ijfw-memory:\n(?:    .*\n)*(?:# IJFW-MCP-END ijfw-memory\n)?/m,
    ''
  ).replace(
    // eslint-disable-next-line security/detect-unsafe-regex -- raw is a small local YAML config file; pattern is bounded by exact IJFW sentinel markers.
    /# IJFW-MCP-BEGIN ijfw-memory\n(?:.*\n)*?# IJFW-MCP-END ijfw-memory\n/,
    ''
  );
  if (stripped === raw) return false;
  backupFile(p);
  writeAtomic(p, stripped);
  return true;
}

// Locate a shipped template across git-clone and tarball layouts (mirrors the
// Aider resolver). Used to prove a copy-if-missing file is pristine before
// deleting it.
function resolveShippedTemplate(rel, repoRoot) {
  const root = repoRoot || REPO_ROOT;
  const candidates = [
    join(root, rel),
    join(root, 'installer', 'templates', rel),
    resolve(__dirname, '..', 'templates', rel),
  ];
  for (const c of candidates) { try { if (existsSync(c)) return c; } catch { /* skip */ } }
  return '';
}

// Comprehensive Hermes config.yaml cleanup (issue #17). The installer writes
// THREE ijfw surfaces: mcp_servers.ijfw-memory, plugins.enabled[ijfw], and a
// hooks.pre_tool_use entry referencing plugins/ijfw/. The MCP-only remover left
// the latter two behind -- and because PyYAML round-trips drop comments, the
// sentinel markers vanish on the first edit, so sentinel-based removal cannot
// catch them. This removes all three at the DATA level. PyYAML preferred;
// regex fallback for hosts without python3.
function removeHermesIjfwWiring(p) {
  if (!existsSync(p)) return false;
  const raw = readFileSync(p, 'utf8');
  if (!/\bijfw\b/i.test(raw)) return false;

  const py = spawnSync('python3', ['-c', `
import sys, yaml
p = sys.argv[1]
with open(p) as f: raw = f.read()
doc = yaml.safe_load(raw) if raw.strip() else {}
if not isinstance(doc, dict): sys.exit(2)
changed = False
srv = doc.get('mcp_servers')
if isinstance(srv, dict) and 'ijfw-memory' in srv:
    del srv['ijfw-memory']; changed = True
    if not srv: del doc['mcp_servers']
pl = doc.get('plugins')
if isinstance(pl, dict) and isinstance(pl.get('enabled'), list) and 'ijfw' in pl['enabled']:
    pl['enabled'] = [x for x in pl['enabled'] if x != 'ijfw']; changed = True
    if not pl['enabled']: del pl['enabled']
    if not pl: del doc['plugins']
hk = doc.get('hooks')
if isinstance(hk, dict):
    for ev in list(hk.keys()):
        items = hk[ev]
        if isinstance(items, list):
            new = [it for it in items if not (isinstance(it, dict) and 'ijfw' in str(it.get('script','')))]
            if len(new) != len(items):
                changed = True
                if new: hk[ev] = new
                else: del hk[ev]
    if isinstance(doc.get('hooks'), dict) and not doc['hooks']: del doc['hooks']
if not changed: sys.exit(3)
with open(p + '.tmp', 'w') as f:
    if doc: yaml.safe_dump(doc, f, sort_keys=False, default_flow_style=False)
    else: f.write('')
import os; os.replace(p + '.tmp', p)
`, p], { encoding: 'utf8' });
  if (py.status === 0) { backupFile(p); return true; }

  // Regex fallback (no python3 / PyYAML). Strip the sentinel blocks and the real
  // YAML entries the installer wrote. [\s\S]*? (star height 1) is used instead of
  // (?:.*\n)*? to stay clear of detect-unsafe-regex; the input is a small local
  // config file, never attacker-controlled at scale. Empty plugins:/hooks:
  // scaffolds may remain but they carry zero ijfw references.
  const out = raw
    .replace(/# IJFW-MCP-BEGIN ijfw-memory\n[\s\S]*?# IJFW-MCP-END ijfw-memory\n/g, '')
    .replace(/# IJFW-PLUGINS-BEGIN\n[\s\S]*?# IJFW-PLUGINS-END\n/g, '')
    .replace(/# IJFW-HOOK-BEGIN pre_tool_use\n[\s\S]*?# IJFW-HOOK-END pre_tool_use\n/g, '')
    // bare `- ijfw` list item under plugins.enabled
    .replace(/^[ \t]*-[ \t]+ijfw[ \t]*\n/gm, '')
    // a pre_tool_use hook entry's script line referencing plugins/ijfw
    .replace(/^[ \t]*-[ \t]+script:[ \t]*["']?plugins\/ijfw\/[^\n]*\n/gm, '');
  if (out === raw) return false;
  backupFile(p);
  writeAtomic(p, out);
  return true;
}

// Remove all ijfw-* skill dirs from a directory.
function removeIjfwSkills(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('ijfw-')) {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
      count++;
    }
  }
  return count;
}

const CODEX_COMMAND_FILES = [
  'compress.md',
  'consolidate.md',
  'cross-audit.md',
  'cross-critique.md',
  'cross-research.md',
  'doctor.md',
  'handoff.md',
  'ijfw-audit.md',
  'ijfw-execute.md',
  'ijfw-help.md',
  'ijfw-plan.md',
  'ijfw-ship.md',
  'ijfw-verify.md',
  'ijfw.md',
  'memory-audit.md',
  'memory-consent.md',
  'memory-why.md',
  'metrics.md',
  'mode.md',
  'status.md',
  'team.md',
  'workflow.md',
];

function removeCodexCommands(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of CODEX_COMMAND_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      count++;
    }
  }
  return count;
}

// Issue #17: remove the hook SCRIPT FILES IJFW wrote (not just registrations).
// Codex hooks all carry an "IJFW" marker in their header, so we only delete
// files we can prove are ours -- a user's own non-IJFW hook is never touched.
// The ijfw-owned `hooks/scripts/` subdir (tier-2 extension checks) is removed
// wholesale.
function removeCodexHookFiles(hooksDir) {
  if (!existsSync(hooksDir)) return 0;
  let count = 0;
  // Tier-2 scripts subdir is IJFW-only.
  const scriptsDir = join(hooksDir, 'scripts');
  if (existsSync(scriptsDir)) { rmSync(scriptsDir, { recursive: true, force: true }); count++; }
  // Top-level *.sh files that carry the IJFW marker.
  let entries = [];
  try { entries = readdirSync(hooksDir, { withFileTypes: true }); } catch { return count; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.sh')) continue;
    const p = join(hooksDir, e.name);
    let body = '';
    try { body = readFileSync(p, 'utf8'); } catch { continue; }
    if (/\bIJFW\b/.test(body) || /\bijfw\b/.test(body)) {
      rmSync(p, { force: true });
      count++;
    }
  }
  return count;
}

// Remove the `ijfw` entry from ~/.claude/plugins/known_marketplaces.json so the
// host does not keep a stale pointer to a deleted marketplace.
function removeKnownMarketplacesEntry(p) {
  if (!existsSync(p)) return false;
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { return false; }
  if (!doc || typeof doc !== 'object') return false;
  let changed = false;
  // Shape A: flat map { ijfw: {...} }.
  if (doc.ijfw) { delete doc.ijfw; changed = true; }
  // Shape B: { extraKnownMarketplaces: { ijfw: {...} } } (defensive).
  if (doc.extraKnownMarketplaces && typeof doc.extraKnownMarketplaces === 'object'
      && doc.extraKnownMarketplaces.ijfw) {
    delete doc.extraKnownMarketplaces.ijfw;
    if (Object.keys(doc.extraKnownMarketplaces).length === 0) delete doc.extraKnownMarketplaces;
    changed = true;
  }
  if (!changed) return false;
  backupFile(p);
  writeAtomic(p, JSON.stringify(doc, null, 2) + '\n');
  return true;
}

// Clean platform configs across all 15 platforms. `home` and `cwd` are
// injectable so tests can point at a scratch sandbox; production callers use
// the real HOME / process.cwd() defaults. `repoRoot` locates shipped templates
// (Aider byte-match). Never throws -- every helper guards itself.
function cleanPlatforms(opts = {}) {
  const home = opts.home || HOME;
  const cwd = opts.cwd || process.cwd();
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const removed = [];

  // Claude: plugin registry leftover (issue #17). settings.json marketplace
  // keys are handled by unmergeMarketplace() in main(); the mcpServers entry
  // and the known_marketplaces.json pointer were not.
  if (removeJsonMcpEntry(join(home, '.claude', 'settings.json'))) {
    removed.push('~/.claude/settings.json  (removed ijfw-memory mcp entry)');
  }
  if (removeKnownMarketplacesEntry(join(home, '.claude', 'plugins', 'known_marketplaces.json'))) {
    removed.push('~/.claude/plugins/known_marketplaces.json  (removed ijfw entry)');
  }

  // Codex: config.toml MCP section
  if (removeTomlSection(join(home, '.codex', 'config.toml'))) {
    removed.push('~/.codex/config.toml  (removed [mcp_servers.ijfw-memory])');
  }
  // Codex: hooks.json IJFW entries
  if (removeCodexHooks(join(home, '.codex', 'hooks.json'))) {
    removed.push('~/.codex/hooks.json  (removed IJFW hook entries)');
  }
  // Codex: skill dirs
  const codexSkills = removeIjfwSkills(join(home, '.codex', 'skills'));
  if (codexSkills > 0) removed.push(`~/.codex/skills/ijfw-*  (removed ${codexSkills} skill dirs)`);
  // Codex: command alias files. Remove only IJFW's exact command filenames
  // because several are intentionally not ijfw-prefixed.
  const codexCommands = removeCodexCommands(join(home, '.codex', 'commands'));
  if (codexCommands > 0) removed.push(`~/.codex/commands  (removed ${codexCommands} IJFW command aliases)`);
  // Codex: IJFW.md context file
  const codexMd = join(home, '.codex', 'IJFW.md');
  if (existsSync(codexMd)) { rmSync(codexMd, { force: true }); removed.push('~/.codex/IJFW.md'); }
  // Codex: hook SCRIPT FILES on disk (issue #17 -- registrations were cleared
  // above but the .sh files lingered and still referenced ijfw).
  const codexHookFiles = removeCodexHookFiles(join(home, '.codex', 'hooks'));
  if (codexHookFiles > 0) removed.push(`~/.codex/hooks/  (removed ${codexHookFiles} IJFW hook scripts)`);

  // Gemini: settings.json MCP entry
  if (removeJsonMcpEntry(join(home, '.gemini', 'settings.json'))) {
    removed.push('~/.gemini/settings.json  (removed ijfw-memory)');
  }
  // Gemini: extension dir
  const geminiExt = join(home, '.gemini', 'extensions', 'ijfw');
  if (existsSync(geminiExt)) {
    rmSync(geminiExt, { recursive: true, force: true });
    removed.push('~/.gemini/extensions/ijfw/');
  }

  // Cursor: project .cursor/mcp.json
  const cursorMcp = join(cwd, '.cursor', 'mcp.json');
  if (removeJsonMcpEntry(cursorMcp)) removed.push('.cursor/mcp.json  (removed ijfw-memory)');

  // Windsurf: global mcp_config.json
  if (removeJsonMcpEntry(join(home, '.codeium', 'windsurf', 'mcp_config.json'))) {
    removed.push('~/.codeium/windsurf/mcp_config.json  (removed ijfw-memory)');
  }

  // Copilot / VS Code: project .vscode/mcp.json
  const vscodeMcp = join(cwd, '.vscode', 'mcp.json');
  if (removeJsonMcpEntry(vscodeMcp)) removed.push('.vscode/mcp.json  (removed ijfw-memory)');

  // Hermes: config.yaml -- remove mcp_servers + plugins.enabled[ijfw] + hook
  // wiring (issue #17, all three surfaces) + skills + context file.
  if (removeHermesIjfwWiring(join(home, '.hermes', 'config.yaml'))) {
    removed.push('~/.hermes/config.yaml  (removed ijfw-memory + plugin + hook wiring)');
  }
  const hermesSkills = removeIjfwSkills(join(home, '.hermes', 'skills'));
  if (hermesSkills > 0) removed.push(`~/.hermes/skills/ijfw-*  (removed ${hermesSkills} skill dirs)`);
  const hermesMd = join(home, '.hermes', 'HERMES.md');
  if (existsSync(hermesMd)) { rmSync(hermesMd, { force: true }); removed.push('~/.hermes/HERMES.md'); }
  // Hermes: the IJFW plugin tree (issue #17 -- installer copies a full plugin
  // tree to plugins/ijfw/; it is ijfw-namespaced so removing it is safe).
  const hermesPlugin = join(home, '.hermes', 'plugins', 'ijfw');
  if (existsSync(hermesPlugin)) {
    rmSync(hermesPlugin, { recursive: true, force: true });
    removed.push('~/.hermes/plugins/ijfw/  (removed plugin tree)');
  }

  // Wayland: declarative plugin dir + skills + context file. The MCP server
  // and lifecycle hooks are declared inside plugins/ijfw/plugin.toml (no
  // separate config.yaml entry), so removing the plugin dir removes the MCP
  // wiring + hooks in one shot.
  const waylandPluginDir = join(home, '.wayland', 'plugins', 'ijfw');
  if (existsSync(waylandPluginDir)) {
    rmSync(waylandPluginDir, { recursive: true, force: true });
    removed.push('~/.wayland/plugins/ijfw/  (removed plugin.toml + hooks + MCP)');
  }
  // Legacy (<= v1.5.x): the old installer wrote a config.yaml MCP entry. Strip
  // it on upgrade-then-uninstall so stale wiring does not linger.
  if (removeYamlMcpEntry(join(home, '.wayland', 'config.yaml'))) {
    removed.push('~/.wayland/config.yaml  (removed legacy ijfw-memory)');
  }
  const waylandSkills = removeIjfwSkills(join(home, '.wayland', 'skills'));
  if (waylandSkills > 0) removed.push(`~/.wayland/skills/ijfw-*  (removed ${waylandSkills} skill dirs)`);
  const waylandMd = join(home, '.wayland', 'WAYLAND.md');
  if (existsSync(waylandMd)) { rmSync(waylandMd, { force: true }); removed.push('~/.wayland/WAYLAND.md'); }

  // ---- Platforms 8-15 (P3 completeness) -------------------------------------

  // Qwen Code: ~/.qwen/settings.json -- flat mcpServers.
  if (removeJsonMcpEntry(join(home, '.qwen', 'settings.json'))) {
    removed.push('~/.qwen/settings.json  (removed ijfw-memory)');
  }

  // Kimi Code: ~/.kimi/mcp.json -- flat mcpServers.
  if (removeJsonMcpEntry(join(home, '.kimi', 'mcp.json'))) {
    removed.push('~/.kimi/mcp.json  (removed ijfw-memory)');
  }

  // Antigravity: two surfaces, both flat mcpServers (IDE + CLI `agy`).
  if (removeJsonMcpEntry(join(home, '.gemini', 'antigravity', 'mcp_config.json'))) {
    removed.push('~/.gemini/antigravity/mcp_config.json  (removed ijfw-memory)');
  }
  if (removeJsonMcpEntry(join(home, '.gemini', 'config', 'mcp_config.json'))) {
    removed.push('~/.gemini/config/mcp_config.json  (removed ijfw-memory)');
  }

  // OpenCode: ~/.config/opencode/opencode.json -- nested mcp['ijfw-memory'].
  if (removeNestedMcpEntry(join(home, '.config', 'opencode', 'opencode.json'), ['mcp'])) {
    removed.push('~/.config/opencode/opencode.json  (removed mcp.ijfw-memory)');
  }

  // OpenClaw: ~/.openclaw/openclaw.json -- nested mcp.servers['ijfw-memory'].
  if (removeNestedMcpEntry(join(home, '.openclaw', 'openclaw.json'), ['mcp', 'servers'])) {
    removed.push('~/.openclaw/openclaw.json  (removed mcp.servers.ijfw-memory)');
  }

  // Pi: ~/.pi/agent/AGENTS.md. First try marker-region stripping (preserves any
  // user content). If the file has no markers (it is a whole-file copy-if-missing
  // deploy of pi/AGENTS.md), fall back to pristine byte-match removal -- issue
  // #17: without this the IJFW template lingered.
  const piPath = join(home, '.pi', 'agent', 'AGENTS.md');
  const piStatus = stripMarkerFile(piPath, { label: '~/.pi/agent/AGENTS.md' });
  if (piStatus) {
    removed.push(piStatus);
  } else {
    const piPristine = removeAiderFileIfPristine(
      piPath, resolveShippedTemplate(join('pi', 'AGENTS.md'), repoRoot),
    );
    if (piPristine === 'removed') {
      removed.push('~/.pi/agent/AGENTS.md  (removed -- matched shipped template)');
    } else if (piPristine === 'kept-modified') {
      removed.push('~/.pi/agent/AGENTS.md  (KEPT -- differs from shipped template; remove manually if it is IJFW-only)');
    }
  }

  // Cline: VS Code globalStorage cline_mcp_settings.json (OS-specific path).
  // Best-effort: we only touch an EXISTING globalStorage dir. If the extension's
  // storage isn't discoverable we say so honestly rather than claim it's clean.
  const clineSettings = resolveClineSettingsPath(home);
  if (clineSettings) {
    if (removeJsonMcpEntry(clineSettings)) {
      removed.push(`${clineSettings}  (removed ijfw-memory)`);
    }
  } else {
    removed.push('Cline: no globalStorage found -- if you use Cline, remove the ijfw-memory MCP entry manually.');
  }

  // Aider: ~/.aider.conf.yml + ~/CONVENTIONS.md. No markers -> only remove when
  // byte-identical to the shipped template (cannot prove IJFW-authorship
  // otherwise). Leave + log honestly when the user has edited the file.
  const confResult = removeAiderFileIfPristine(
    join(home, '.aider.conf.yml'),
    resolveAiderTemplate('aider.conf.yml', repoRoot),
  );
  if (confResult === 'removed') {
    removed.push('~/.aider.conf.yml  (removed -- matched shipped template)');
  } else if (confResult === 'kept-modified') {
    removed.push('~/.aider.conf.yml  (KEPT -- differs from shipped template; remove manually if it is IJFW-only)');
  }
  const convResult = removeAiderFileIfPristine(
    join(home, 'CONVENTIONS.md'),
    resolveAiderTemplate('CONVENTIONS.md', repoRoot),
  );
  if (convResult === 'removed') {
    removed.push('~/CONVENTIONS.md  (removed -- matched shipped template)');
  } else if (convResult === 'kept-modified') {
    removed.push('~/CONVENTIONS.md  (KEPT -- differs from shipped template; remove manually if it is IJFW-only)');
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Registry-driven project-block stripping (the headline P3 gap).
//
// IJFW's session-start hook appends each opened project to ~/.ijfw/registry.md
// (line shape: `<absolute-path> | <hash> | <iso>`) and injects managed marker
// regions into that project's CLAUDE.md / AGENTS.md. Uninstall walks the
// registry and strips those regions back out, preserving all user content. It
// also cleans rules files in the current working directory.
// ---------------------------------------------------------------------------

// Parse ~/.ijfw/registry.md into a list of absolute project paths. Each line is
// `<path> | <hash> | <iso>`; the path is the first ` | `-delimited field. Blank
// / malformed lines are skipped. Missing file -> []. Never throws.
function parseRegistryPaths(registryPath) {
  try {
    if (!existsSync(registryPath)) return [];
    const raw = readFileSync(registryPath, 'utf8');
    const paths = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const first = trimmed.split('|')[0].trim();
      if (!first) continue;
      // Only accept absolute paths -- a malformed line without a real path is
      // ignored rather than acted on.
      if (!first.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(first)) continue;
      paths.push(first);
    }
    return paths;
  } catch {
    return [];
  }
}

function stripRegisteredProjectBlocks(opts = {}) {
  const home = opts.home || HOME;
  const cwd = opts.cwd || process.cwd();
  const registryPath = opts.registryPath || join(home, '.ijfw', 'registry.md');
  const results = [];

  // 1. Registry-listed projects: strip CLAUDE.md + AGENTS.md marker regions.
  for (const projPath of parseRegistryPaths(registryPath)) {
    let dirExists = false;
    try { dirExists = existsSync(projPath); } catch { dirExists = false; }
    if (!dirExists) continue;
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const filePath = join(projPath, name);
      const status = stripMarkerFile(filePath, { label: join(projPath, name) });
      if (status) results.push(status);
    }
  }

  // 2. Current-cwd rules files.
  //    .cursor/rules/ijfw.mdc is wholly IJFW-authored -> safe to delete.
  try {
    const cursorRule = join(cwd, '.cursor', 'rules', 'ijfw.mdc');
    if (existsSync(cursorRule)) {
      backupFile(cursorRule);
      rmSync(cursorRule, { force: true });
      results.push('.cursor/rules/ijfw.mdc  (removed -- wholly IJFW-authored)');
    }
  } catch { /* best-effort */ }

  //    .windsurfrules + .github/copilot-instructions.md carry IJFW marker
  //    regions amid possible user content -> strip regions, delete if empty.
  const windsurfStatus = stripMarkerFile(join(cwd, '.windsurfrules'), {
    label: '.windsurfrules', deleteIfEmpty: true,
  });
  if (windsurfStatus) results.push(windsurfStatus);

  const copilotStatus = stripMarkerFile(join(cwd, '.github', 'copilot-instructions.md'), {
    label: '.github/copilot-instructions.md', deleteIfEmpty: true,
  });
  if (copilotStatus) results.push(copilotStatus);

  return results;
}

function resolveTarget(opt) {
  if (opt.dir) return resolve(opt.dir);
  if (process.env.IJFW_HOME) return resolve(process.env.IJFW_HOME);
  return join(homedir(), '.ijfw');
}

// Security guard (audit finding): a recursive force-delete of `target` must
// never be allowed to hit the home root, the filesystem root, a shallow path,
// or a directory that is not actually an IJFW install. Without this, a stray
// `--dir ~/projects/foo` or an exported `IJFW_HOME=/important` would rm -rf a
// real user directory. Throws (caught by main) rather than deleting.
function assertSafePurgeTarget(target) {
  // Resolve symlinks so a symlinked target can't smuggle us out of bounds.
  let real = target;
  try { real = realpathSync(target); } catch { /* absent or not a link */ }
  let home = homedir();
  try { home = realpathSync(home); } catch { /* fall back to raw */ }
  if (!real || real === '/' || real === home) {
    throw new Error(`refusing to delete '${target}': it resolves to the home or filesystem root.`);
  }
  // Floor: never delete a path fewer than 2 segments below root.
  if (real.split('/').filter(Boolean).length < 2) {
    throw new Error(`refusing to delete shallow path '${real}'.`);
  }
  // Must look like an IJFW install -- a `.ijfw` basename or a known IJFW
  // artifact inside it. Prevents nuking an arbitrary user dir.
  const looksIjfw = basename(real) === '.ijfw'
    || existsSync(join(real, 'state.json'))
    || existsSync(join(real, 'install-method'))
    || existsSync(join(real, 'install-ledger.json'))
    || existsSync(join(real, 'mcp-server'))
    || existsSync(join(real, 'memory'));
  if (!looksIjfw) {
    throw new Error(`refusing to delete '${target}': it does not look like an IJFW install (no state.json / install-method / mcp-server). Aborting.`);
  }
}

// Issue #17: under --purge, remove platform dirs IJFW created (recorded in the
// install ledger) -- but ONLY if they are empty after cleanPlatforms() stripped
// the IJFW content. A dir the user populated stays non-empty and is kept; a dir
// IJFW made for a CLI that was never installed is now empty and is removed.
function removeCreatedDirs(home, createdDirs) {
  const removed = [];
  for (const rel of createdDirs || []) {
    const abs = join(home, rel);
    if (isEmptyDir(abs)) {
      try { rmSync(abs, { recursive: false, force: true }); removed.push(`~/${rel}  (IJFW-created, now empty)`); }
      catch { /* leave it */ }
    }
  }
  return removed;
}

async function main() {
  const opts = parseArgs(process.argv);
  const target = resolveTarget(opts);

  // Read the created-dir ledger BEFORE the target dir is deleted (the ledger
  // lives inside it). Used after platform cleanup to remove dirs IJFW created.
  const ledgerCreatedDirs = existsSync(target) ? readLedger(target).createdDirs : [];

  console.log('This will remove IJFW configuration. Your memory at ~/.ijfw/memory/ will be preserved. Delete manually if desired.');
  if (opts.purge) {
    console.log('WARNING: --purge will also DELETE ~/.ijfw/memory/ (project memory cannot be recovered).');
  }
  console.log('');

  // Confirmation gate (R4-MED): `ijfw off` / `ijfw uninstall` are destructive.
  // Prompt for explicit confirmation unless --yes/-y is passed. When stdin is
  // not a TTY (scripted / piped use) the prompt would hang, so we skip it but
  // the warning above is always printed -- the user is never surprised.
  if (!opts.yes && process.stdin.isTTY) {
    const ok = await confirm('Proceed with IJFW uninstall? [y/N] ');
    if (!ok) {
      console.log('Uninstall cancelled. Nothing was changed.');
      process.exit(0);
    }
    console.log('');
  }

  if (!existsSync(target)) {
    console.log(`IJFW directory absent (${target}); platform cleanup only.`);
  } else if (opts.purge) {
    assertSafePurgeTarget(target);
    rmSync(target, { recursive: true, force: true });
    console.log(`  removed ${target} (purged).`);
  } else {
    assertSafePurgeTarget(target);
    const memDir = join(target, 'memory');
    let stash = null;
    if (existsSync(memDir)) {
      stash = mkdtempSync(join(tmpdir(), 'ijfw-memory-'));
      cpSync(memDir, stash, { recursive: true });
    }
    rmSync(target, { recursive: true, force: true });
    if (stash) {
      cpSync(stash, memDir, { recursive: true });
      rmSync(stash, { recursive: true, force: true });
      console.log(`  memory/ preserved at ${memDir}`);
    } else {
      console.log('  memory/ was not present; nothing to preserve');
    }
  }

  // Scope guard: only mutate the user's real Claude marketplace and platform
  // configs when uninstalling the canonical install. A scratch/custom-dir
  // uninstall (--dir <other>) MUST NOT strip ~/.codex, ~/.gemini, etc.
  const canonicalDir = join(HOME, '.ijfw');
  const isCanonical = target === canonicalDir;

  if (isCanonical && !opts.noMarketplace) {
    const settingsPath = claudeSettingsPath();
    if (existsSync(settingsPath)) {
      unmergeMarketplace(settingsPath);
      console.log(`  marketplace removed from ${settingsPath}`);
    }
  }

  // Clean up platform configs across all 15 platforms PLUS project-scoped
  // CLAUDE.md / AGENTS.md marker blocks -- canonical only.
  if (isCanonical) {
    const cleaned = cleanPlatforms();
    if (cleaned.length > 0) {
      console.log('  platform configs cleaned:');
      for (const line of cleaned) console.log(`    ${line}`);
    }
    // Registry-driven project-block strip (CLAUDE.md / AGENTS.md / rules files).
    const projectCleaned = stripRegisteredProjectBlocks();
    if (projectCleaned.length > 0) {
      console.log('  project blocks cleaned:');
      for (const line of projectCleaned) console.log(`    ${line}`);
    }
    // Issue #17: remove platform dirs IJFW created (ledger) now that their IJFW
    // content has been stripped and they are empty. Pre-existing dirs are kept.
    if (opts.purge) {
      const dirsRemoved = removeCreatedDirs(HOME, ledgerCreatedDirs);
      if (dirsRemoved.length > 0) {
        console.log('  IJFW-created dirs removed:');
        for (const line of dirsRemoved) console.log(`    ${line}`);
      }
    }
  } else {
    console.log(`  custom-dir uninstall (${target}) -- platform configs in your real home left untouched.`);
  }

  console.log('\nIJFW uninstalled. Thanks for trying it.');
  process.exit(0);
}

// Auto-run only when executed directly (e.g. `node uninstall.js`). Guarded so
// the module can be imported by tests without triggering a destructive run.
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}

export {
  stripIjfwRegions,
  stripMarkerFile,
  cleanPlatforms,
  stripRegisteredProjectBlocks,
  parseRegistryPaths,
  removeNestedMcpEntry,
  removeAiderFileIfPristine,
  resolveAiderTemplate,
  resolveClineSettingsPath,
};
