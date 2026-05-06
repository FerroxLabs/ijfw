// @ijfw/install -- reverse install. Preserves ~/.ijfw/memory/ unless --purge.

import { existsSync, rmSync, cpSync, mkdtempSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { unmergeMarketplace, claudeSettingsPath } from './marketplace.js';

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
  const out = { dir: null, purge: false, noMarketplace: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--purge') out.purge = true;
    else if (a === '--no-marketplace') out.noMarketplace = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`ijfw-uninstall -- reverse IJFW install
Usage: ijfw-uninstall [--dir <path>] [--purge] [--no-marketplace]
  --purge           also remove memory/ (destructive)
  --no-marketplace  skip ~/.claude/settings.json edits
`);
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
    /^  ijfw-memory:\n(?:    .*\n)*(?:# IJFW-MCP-END ijfw-memory\n)?/m,
    ''
  ).replace(
    /# IJFW-MCP-BEGIN ijfw-memory\n(?:.*\n)*?# IJFW-MCP-END ijfw-memory\n/,
    ''
  );
  if (stripped === raw) return false;
  backupFile(p);
  writeAtomic(p, stripped);
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

function cleanPlatforms() {
  const removed = [];

  // Codex: config.toml MCP section
  if (removeTomlSection(join(HOME, '.codex', 'config.toml'))) {
    removed.push('~/.codex/config.toml  (removed [mcp_servers.ijfw-memory])');
  }
  // Codex: hooks.json IJFW entries
  if (removeCodexHooks(join(HOME, '.codex', 'hooks.json'))) {
    removed.push('~/.codex/hooks.json  (removed IJFW hook entries)');
  }
  // Codex: skill dirs
  const codexSkills = removeIjfwSkills(join(HOME, '.codex', 'skills'));
  if (codexSkills > 0) removed.push(`~/.codex/skills/ijfw-*  (removed ${codexSkills} skill dirs)`);
  // Codex: IJFW.md context file
  const codexMd = join(HOME, '.codex', 'IJFW.md');
  if (existsSync(codexMd)) { rmSync(codexMd, { force: true }); removed.push('~/.codex/IJFW.md'); }

  // Gemini: settings.json MCP entry
  if (removeJsonMcpEntry(join(HOME, '.gemini', 'settings.json'))) {
    removed.push('~/.gemini/settings.json  (removed ijfw-memory)');
  }
  // Gemini: extension dir
  const geminiExt = join(HOME, '.gemini', 'extensions', 'ijfw');
  if (existsSync(geminiExt)) {
    rmSync(geminiExt, { recursive: true, force: true });
    removed.push('~/.gemini/extensions/ijfw/');
  }

  // Cursor: project .cursor/mcp.json
  const cursorMcp = join('.cursor', 'mcp.json');
  if (removeJsonMcpEntry(cursorMcp)) removed.push('.cursor/mcp.json  (removed ijfw-memory)');

  // Windsurf: global mcp_config.json
  if (removeJsonMcpEntry(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'))) {
    removed.push('~/.codeium/windsurf/mcp_config.json  (removed ijfw-memory)');
  }

  // Copilot / VS Code: project .vscode/mcp.json
  const vscodeMcp = join('.vscode', 'mcp.json');
  if (removeJsonMcpEntry(vscodeMcp)) removed.push('.vscode/mcp.json  (removed ijfw-memory)');

  // Hermes: config.yaml MCP entry + skills + context file
  if (removeYamlMcpEntry(join(HOME, '.hermes', 'config.yaml'))) {
    removed.push('~/.hermes/config.yaml  (removed ijfw-memory)');
  }
  const hermesSkills = removeIjfwSkills(join(HOME, '.hermes', 'skills'));
  if (hermesSkills > 0) removed.push(`~/.hermes/skills/ijfw-*  (removed ${hermesSkills} skill dirs)`);
  const hermesMd = join(HOME, '.hermes', 'HERMES.md');
  if (existsSync(hermesMd)) { rmSync(hermesMd, { force: true }); removed.push('~/.hermes/HERMES.md'); }

  // Wayland: config.yaml MCP entry + skills + context file
  if (removeYamlMcpEntry(join(HOME, '.wayland', 'config.yaml'))) {
    removed.push('~/.wayland/config.yaml  (removed ijfw-memory)');
  }
  const waylandSkills = removeIjfwSkills(join(HOME, '.wayland', 'skills'));
  if (waylandSkills > 0) removed.push(`~/.wayland/skills/ijfw-*  (removed ${waylandSkills} skill dirs)`);
  const waylandMd = join(HOME, '.wayland', 'WAYLAND.md');
  if (existsSync(waylandMd)) { rmSync(waylandMd, { force: true }); removed.push('~/.wayland/WAYLAND.md'); }

  return removed;
}

function resolveTarget(opt) {
  if (opt.dir) return resolve(opt.dir);
  if (process.env.IJFW_HOME) return resolve(process.env.IJFW_HOME);
  return join(homedir(), '.ijfw');
}

async function main() {
  const opts = parseArgs(process.argv);
  const target = resolveTarget(opts);

  console.log('This will remove IJFW configuration. Your memory at ~/.ijfw/memory/ will be preserved. Delete manually if desired.');
  console.log('');

  if (!existsSync(target)) {
    console.log(`IJFW directory absent (${target}); platform cleanup only.`);
  } else if (opts.purge) {
    rmSync(target, { recursive: true, force: true });
    console.log(`  removed ${target} (purged).`);
  } else {
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

  // Clean up platform configs across all 13 platforms -- canonical only.
  if (isCanonical) {
    const cleaned = cleanPlatforms();
    if (cleaned.length > 0) {
      console.log('  platform configs cleaned:');
      for (const line of cleaned) console.log(`    ${line}`);
    }
  } else {
    console.log(`  custom-dir uninstall (${target}) -- platform configs in your real home left untouched.`);
  }

  console.log('\nIJFW uninstalled. Thanks for trying it.');
  process.exit(0);
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
