// install-helpers.js -- shared utilities for the Node-native IJFW installer.
//
// Pure ESM, sync filesystem APIs, zero external deps. Mirrors helpers from
// scripts/install.sh that originally shelled out to bash + node -e heredocs.
// See .planning/1.3.0/PORT-SPEC.md for the porting contract.

/* eslint-disable security/detect-non-literal-fs-filename -- Installer helper
 * APIs intentionally accept validated install paths from higher-level target
 * installers. They centralize filesystem writes, backups, checksums, hook
 * installation, and platform-presence probes for IJFW-managed paths. */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  chmodSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, basename, join, normalize, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const IS_WIN = process.platform === 'win32';

// ============================================================================
// Logging  (install.sh:510-512 + 1004-1006 + 1019)
// ============================================================================

export function printOk(msg)      { process.stdout.write(`  [ok] ${msg}\n`); }
export function printNote(msg)    { process.stdout.write(`  [--] ${msg}\n`); }
export function printInfo(msg)    { process.stdout.write(`  -- ${msg}\n`); }
export function printWarn(msg)    { process.stdout.write(`  [!] ${msg}\n`); }
export function printSection(name) { process.stdout.write(`\n[${name}]\n`); }

// ============================================================================
// Path helpers
// ============================================================================

/**
 * expandHome -- resolve `~` and `%USERPROFILE%`-style env into an absolute
 * path. Pure string work; does not touch the filesystem.
 */
export function expandHome(p) {
  if (!p) return p;
  let out = String(p);
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = homedir() + out.slice(1);
  }
  // Replace %USERPROFILE% (Windows) -- handle case-insensitively.
  out = out.replace(/%([^%]+)%/g, (m, name) => {
    if (name.toUpperCase() === 'USERPROFILE') return homedir();
    // eslint-disable-next-line security/detect-object-injection -- name comes from an environment-variable token in a path string; reads only process.env and falls back unchanged.
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    return v != null ? v : m;
  });
  // Expand $HOME / ${HOME} too -- bash carryover.
  out = out.replace(/\$\{?HOME\}?/g, homedir());
  return normalize(out);
}

/**
 * homeReal -- canonical $HOME via realpathSync. Mirrors install.sh:24
 *   HOME_REAL="$(cd -P "$HOME" 2>/dev/null && pwd || printf '%s' "$HOME")"
 * Falls back to os.homedir() if realpath fails (broken HOME, sandboxed env).
 */
export function homeReal() {
  const h = homedir();
  try { return realpathSync(h); } catch { return h; }
}

/**
 * nativePath -- normalize separators per process.platform. Pure Node, no
 * cygpath shell-out (Windows-native installers don't run inside Git Bash).
 * Mirrors install.sh:524-530.
 */
export function nativePath(p) {
  if (p == null) return p;
  return normalize(String(p));
}

// ============================================================================
// Atomic writes + backup  (install.sh:585-590)
// ============================================================================

/**
 * writeAtomic -- write to `${path}.tmp.${pid}`, then rename. Default mode
 * 0o600 to match install.sh's chmod-after-write pattern. Creates parent dirs
 * if missing.
 */
export function writeAtomic(path, contents, opts = {}) {
  const mode = opts.mode ?? 0o600;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, { mode });
  renameSync(tmp, path);
  // renameSync preserves the tmp's mode but re-apply for clarity in case the
  // OS or umask interfered.
  try { chmodSync(path, mode); } catch { /* best-effort */ }
}

/**
 * backup -- if `path` exists as a file, copy to `${path}.bak.${ts}`.
 * Returns the backup path (or null if nothing to back up). Mirrors
 * install.sh:585-590.
 */
export function backup(path, ts) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
  } catch { return null; }
  const dst = `${path}.bak.${ts}`;
  try {
    copyFileSync(path, dst);
    printInfo(`backup: ${basename(path)}.bak.${ts}`);
    return dst;
  } catch { return null; }
}

// ============================================================================
// Checksum + hook installation  (install.sh:592-629)
// ============================================================================

/**
 * safeChecksum -- sha1 hex of file contents. Replaces the bash's
 * md5sum/md5/sha1sum cascade with Node crypto -- POSIX-portable, zero shell
 * dependency. Returns '' if the file can't be read (matches the bash's
 * fall-through-to-empty behaviour on missing util).
 */
export function safeChecksum(path) {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * installHook -- always deploys the latest hook. If dst exists and differs
 * from src, back the user's copy up to dst.bak.ts before overwriting. If
 * neither file produces a checksum (impossible in pure-Node land but kept
 * for parity with install.sh:617-619), still back up before copy.
 * Replaces `chmod +x` with fs.chmodSync(dst, 0o755) on POSIX, no-op on
 * Windows.
 *
 * install.sh:606-629
 */
export function installHook(src, dst, ts) {
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    const srcSum = safeChecksum(src);
    const dstSum = safeChecksum(dst);
    if (!srcSum || !dstSum) {
      try { copyFileSync(dst, `${dst}.bak.${ts}`); } catch { /* best-effort */ }
      printNote(`Updated ${basename(dst)} (no checksum util on host -- precautionary backup)`);
    } else if (srcSum === dstSum) {
      return; // identical -- nothing to do
    } else {
      try { copyFileSync(dst, `${dst}.bak.${ts}`); } catch { /* best-effort */ }
      printNote(`Updated ${basename(dst)} (your custom version backed up to ${basename(dst)}.bak.${ts})`);
    }
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  if (!IS_WIN) {
    try { chmodSync(dst, 0o755); } catch { /* best-effort */ }
  }
}

// ============================================================================
// Detection: isLive + prettyName  (install.sh:535-583)
// ============================================================================

/**
 * which -- POSIX-portable executable lookup. Returns the absolute path of
 * `bin` on PATH, or null. Used to replace `command -v X` in install.sh.
 */
function which(bin) {
  if (!bin) return null;
  const path = process.env.PATH || '';
  const parts = path.split(delimiter).filter(Boolean);
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase())
    : [''];
  for (const dir of parts) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch { /* continue */ }
    }
  }
  return null;
}

function hasBin(bin) {
  return which(bin) != null;
}

/**
 * isLive -- runtime-presence heuristic per platform. True -> "Live now",
 * False -> "Standing by". Mirrors install.sh:535-563. `home` defaults to
 * `homeReal()` for callers that don't pass one.
 */
export function isLive(targetId, home) {
  const H = home || homeReal();
  const APPDATA = process.env.APPDATA || '';
  const appdataOr = (rel) => APPDATA ? join(APPDATA, rel) : null;

  switch (targetId) {
    case 'claude':
      return hasBin('claude') || existsSync(join(H, '.claude'));
    case 'codex':
      return hasBin('codex') || existsSync(join(H, '.codex'));
    case 'gemini':
      return hasBin('gemini') || existsSync(join(H, '.gemini'));
    case 'cursor':
      return hasBin('cursor');
    case 'windsurf':
      return hasBin('windsurf') || existsSync(join(H, '.codeium', 'windsurf'));
    case 'copilot': {
      if (hasBin('code')) return true;
      const candidates = [
        join(H, '.vscode'),
        join(H, '.config', 'Code'),
        join(H, 'Library', 'Application Support', 'Code'),
        appdataOr('Code'),
      ].filter(Boolean);
      return candidates.some(p => existsSync(p));
    }
    case 'hermes':
      return hasBin('hermes') || existsSync(join(H, '.hermes'));
    case 'wayland':
      return hasBin('wayland') || existsSync(join(H, '.wayland'));
    case 'opencode':
      return hasBin('opencode') || existsSync(join(H, '.config', 'opencode'));
    case 'qwen':
      return hasBin('qwen') || existsSync(join(H, '.qwen'));
    case 'cline': {
      const ext = 'saoudrizwan.claude-dev';
      const candidates = [
        // macOS
        join(H, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', ext),
        join(H, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', ext),
        join(H, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', ext),
        // Linux
        join(H, '.config', 'Code', 'User', 'globalStorage', ext),
        join(H, '.config', 'VSCodium', 'User', 'globalStorage', ext),
        join(H, '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User', 'globalStorage', ext),
        join(H, 'snap', 'code', 'current', '.config', 'Code', 'User', 'globalStorage', ext),
        // Windows
        appdataOr(join('Code', 'User', 'globalStorage', ext)),
        appdataOr(join('Code - Insiders', 'User', 'globalStorage', ext)),
        appdataOr(join('VSCodium', 'User', 'globalStorage', ext)),
        // Catch-all extensions dir
        join(H, '.vscode', 'extensions'),
      ].filter(Boolean);
      return candidates.some(p => existsSync(p));
    }
    case 'kimi':
      return hasBin('kimi') || existsSync(join(H, '.kimi'));
    case 'openclaw':
      return hasBin('openclaw') || existsSync(join(H, '.openclaw'));
    case 'aider':
      return hasBin('aider') || existsSync(join(H, '.aider.conf.yml'));
    default:
      return false;
  }
}

/**
 * prettyName -- display name lookup. install.sh:565-583.
 */
export function prettyName(targetId) {
  const map = {
    claude:   'Claude Code',
    codex:    'Codex',
    gemini:   'Gemini',
    cursor:   'Cursor',
    windsurf: 'Windsurf',
    copilot:  'Copilot',
    hermes:   'Hermes',
    wayland:  'Wayland',
    opencode: 'OpenCode',
    qwen:     'Qwen Code',
    cline:    'Cline',
    kimi:     'Kimi Code',
    openclaw: 'OpenClaw',
    aider:    'Aider',
  };
  // eslint-disable-next-line security/detect-object-injection -- targetId is a platform id; unknown ids fall back to String(targetId).
  return map[targetId] || String(targetId);
}

// ============================================================================
// Merge helpers
//
// In install.sh, each merge invokes node -e with positional argv. Here we
// call them as plain JS functions; the mutation logic is identical.
// Every merge runs `backup(dst, ts)` first so the user's prior config lands
// in dst.bak.ts even on idempotent reruns. Atomic writes via writeAtomic.
// ============================================================================

function readJsonOrEmpty(path) {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8') || '{}';
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    // Corrupt existing config -- caller already wrote a backup, start fresh.
    return {};
  }
}

/**
 * mergeJson -- Gemini / Cursor / Windsurf / Copilot / Qwen / Kimi.
 * install.sh:763-796.
 *
 * Sets mcpServers['ijfw-memory'] = { command: 'node', args: [serverJs], env? }.
 * On non-Windows hosts we also populate env.PATH because macOS Claude strips
 * PATH for spawned MCPs (harmless elsewhere). On Windows we omit PATH (Path
 * uses different separator + node is on Path after preflight).
 */
export function mergeJson(dst, serverJs, ts) {
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  const doc = readJsonOrEmpty(dst);
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object') doc.mcpServers = {};

  const isWin = IS_WIN;
  const nodeDir = dirname(process.execPath);
  const home = homedir();
  const candidatePaths = isWin ? [] : [
    nodeDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.nvm/versions/node/${process.version}/bin`,
    '/usr/bin',
    '/bin',
  ];
  const envPath = candidatePaths
    .filter(d => {
      try { return typeof d === 'string' && d.length > 0 && existsSync(d); }
      catch { return false; }
    })
    .join(':');

  const entry = { command: 'node', args: [serverJs] };
  if (envPath) entry.env = { PATH: envPath };
  doc.mcpServers['ijfw-memory'] = entry;

  writeAtomic(dst, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

/**
 * mergeToml -- Codex `~/.codex/config.toml`. install.sh:798-857.
 *
 * Idempotent block insertion:
 *   1. Strip any existing [mcp_servers.ijfw-memory] section.
 *   2. Upsert codex_hooks=true inside [features].
 *   3. Upsert top-level suppress_unstable_features_warning=true.
 *   4. Append fresh [mcp_servers.ijfw-memory] block.
 */
export function mergeToml(dst, serverJs, ts) {
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  let text = '';
  try { text = existsSync(dst) ? readFileSync(dst, 'utf8') : ''; }
  catch { text = ''; }

  // 1. Strip the existing [mcp_servers.ijfw-memory] section.
  // Section runs from its header to the next [section] header (or EOF).
  text = stripTomlSection(text, 'mcp_servers.ijfw-memory');

  // 2. Upsert [features] codex_hooks = true.
  if (/^\[features\]/m.test(text)) {
    if (!/^codex_hooks\s*=/m.test(text)) {
      text = text.replace(/^(\[features\][^\n]*\n)/m, '$1codex_hooks = true\n');
    }
  } else {
    text = text.replace(/\n+$/, '') + '\n\n[features]\ncodex_hooks = true\n';
  }

  // 3. Upsert top-level suppress_unstable_features_warning = true.
  if (!/^suppress_unstable_features_warning\s*=/m.test(text)) {
    if (/^\[/m.test(text)) {
      text = text.replace(/^(\[)/m, 'suppress_unstable_features_warning = true\n\n$1');
    } else {
      text = text.replace(/\n+$/, '') + '\nsuppress_unstable_features_warning = true\n';
    }
  }

  // 4. Append fresh [mcp_servers.ijfw-memory] block.
  // Escape backslashes + double-quotes in the path to keep TOML valid on
  // Windows (C:\Users\...\server.js).
  const escaped = String(serverJs).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let block = '';
  if (text && !text.endsWith('\n')) block += '\n';
  block += '\n[mcp_servers.ijfw-memory]\n';
  block += 'command = "node"\n';
  block += `args = ["${escaped}"]\n`;
  block += 'enabled = true\n';
  block += 'startup_timeout_sec = 10\n';
  block += 'tool_timeout_sec = 30\n';

  writeAtomic(dst, text + block, { mode: 0o600 });
}

function stripTomlSection(text, sectionName) {
  // Escape regex metachars in the section name.
  const safe = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = text.split('\n');
  const out = [];
  let skip = false;
  // eslint-disable-next-line security/detect-non-literal-regexp -- sectionName is escaped before constructing the exact TOML section header matcher.
  const headerRe = new RegExp(`^\\[${safe}\\][\\s]*$`);
  for (const line of lines) {
    if (headerRe.test(line)) { skip = true; continue; }
    if (skip && line.startsWith('[') && !headerRe.test(line)) skip = false;
    if (skip) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * mergeYamlMcp -- Hermes/Wayland `~/.<name>/config.yaml`,
 * mcp_servers.ijfw-memory block. install.sh:864-917.
 *
 * Pure-Node port of the python3+PyYAML branch + the sentinel-anchored
 * fallback. Because we can't depend on PyYAML (zero-deps promise), we use
 * the sentinel-anchored strip-and-append path unconditionally. Sentinels:
 *   # IJFW-MCP-BEGIN ijfw-memory
 *   # IJFW-MCP-END ijfw-memory
 * Idempotent across re-runs: a previous IJFW-anchored block is stripped
 * before the new one is appended.
 */
export function mergeYamlMcp(dst, serverJs, ts) {
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  let text = '';
  try { text = existsSync(dst) ? readFileSync(dst, 'utf8') : ''; }
  catch { text = ''; }

  text = stripSentinelBlock(text, '# IJFW-MCP-BEGIN ijfw-memory', '# IJFW-MCP-END ijfw-memory');

  // Ensure mcp_servers: top-level key exists.
  if (!/^mcp_servers:/m.test(text)) {
    if (text && !text.endsWith('\n')) text += '\n';
    text += '\nmcp_servers:\n';
  }

  // Escape only double-quotes in the YAML scalar string. Backslashes don't
  // need escaping inside a YAML double-quoted scalar -- they're literal --
  // but install.sh:907 only escapes double-quote, so we match.
  const escaped = String(serverJs).replace(/"/g, '\\"');
  let block = '';
  if (!text.endsWith('\n')) block += '\n';
  block += '# IJFW-MCP-BEGIN ijfw-memory\n';
  block += '  ijfw-memory:\n';
  block += '    command: "node"\n';
  block += `    args: ["${escaped}"]\n`;
  block += '    enabled: true\n';
  block += '# IJFW-MCP-END ijfw-memory\n';

  writeAtomic(dst, text + block, { mode: 0o600 });
}

function stripSentinelBlock(text, beginMark, endMark) {
  const lines = text.split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (line === beginMark) { skip = true; continue; }
    if (line === endMark)   { skip = false; continue; }
    if (skip) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * mergeYamlPluginsEnabled -- Hermes opt-in plugin allow-list.
 * install.sh:919-995.
 *
 * Adds plugin_name to plugins.enabled[]. Deduplicates if already present.
 * Pure-Node port of the python3 branch via line-oriented parsing of the
 * `plugins:` / `enabled:` keys. We do NOT attempt full YAML parsing --
 * Hermes config files are flat enough that line-based edits are safe and
 * sentinel-anchored where possible.
 */
export function mergeYamlPluginsEnabled(dst, pluginName, ts) {
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  let text = '';
  try { text = existsSync(dst) ? readFileSync(dst, 'utf8') : ''; }
  catch { text = ''; }

  // Strip any prior IJFW-PLUGINS sentinel block (idempotent re-run).
  text = stripSentinelBlock(text, '# IJFW-PLUGINS-BEGIN', '# IJFW-PLUGINS-END');

  // Walk the file line by line. Track:
  //   - whether `plugins:` exists at column 0
  //   - whether `enabled:` exists nested under it
  //   - whether pluginName already appears in the enabled list
  const lines = text.split('\n');
  let pluginsLineIdx = -1;
  let enabledLineIdx = -1;
  let inPluginsBlock = false;
  let alreadyListed = false;
  // Match `- pluginName` (any indent) within plugins.enabled.
  // eslint-disable-next-line security/detect-non-literal-regexp -- pluginName is escaped before constructing the exact YAML list-item matcher.
  const itemRe = new RegExp(`^\\s+-\\s+${pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

  for (let i = 0; i < lines.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded numeric index in this function's own split() output.
    const line = lines[i];
    if (/^plugins:\s*$/.test(line)) {
      pluginsLineIdx = i;
      inPluginsBlock = true;
      continue;
    }
    if (inPluginsBlock) {
      if (/^\S/.test(line) && line.trim() !== '') {
        // Hit a new top-level key -- end of plugins block.
        inPluginsBlock = false;
      } else if (isIndentedEnabledLine(line)) {
        enabledLineIdx = i;
      } else if (enabledLineIdx >= 0 && itemRe.test(line)) {
        alreadyListed = true;
      }
    }
  }

  // Ensure `plugins:` exists.
  if (pluginsLineIdx < 0) {
    if (text && !text.endsWith('\n')) text += '\n';
    text += '\nplugins:\n';
    // Recompute lines after mutation.
    const newLines = text.split('\n');
    pluginsLineIdx = newLines.length - 2; // line index of "plugins:"
    enabledLineIdx = -1;
  }

  // Re-split lines for surgical edits.
  let cur = text.split('\n');

  // Ensure `enabled:` exists immediately under `plugins:`.
  if (enabledLineIdx < 0) {
    cur.splice(pluginsLineIdx + 1, 0, '  enabled: []');
    enabledLineIdx = pluginsLineIdx + 1;
  }

  // Insert the plugin name into the list if not already present.
  if (!alreadyListed) {
    // eslint-disable-next-line security/detect-object-injection -- enabledLineIdx is computed from cur, which is this function's own split() output.
    const enabledLine = cur[enabledLineIdx];
    if (/^\s+enabled:\s*\[\s*\]\s*$/.test(enabledLine)) {
      // Replace empty inline list with a multi-line list.
      // eslint-disable-next-line security/detect-object-injection -- enabledLineIdx is computed from cur, which is this function's own split() output.
      cur[enabledLineIdx] = '  enabled:';
      cur.splice(enabledLineIdx + 1, 0, `    - ${pluginName}`);
    } else if (/^\s+enabled:\s*\[.+\]\s*$/.test(enabledLine)) {
      // Inline non-empty list -- append before the closing bracket.
      // eslint-disable-next-line security/detect-object-injection -- enabledLineIdx is computed from cur, which is this function's own split() output.
      cur[enabledLineIdx] = enabledLine.replace(/\]\s*$/, `, ${pluginName}]`);
    } else {
      // Multi-line list form.
      cur.splice(enabledLineIdx + 1, 0, `    - ${pluginName}`);
    }
  }

  // Append the IJFW-PLUGINS sentinel comment block (matches install.sh:969-973).
  let outText = cur.join('\n');
  if (outText && !outText.endsWith('\n')) outText += '\n';
  outText += '# IJFW-PLUGINS-BEGIN\n';
  outText += `# plugin ${pluginName} registered by IJFW installer\n`;
  outText += '# IJFW-PLUGINS-END\n';

  writeAtomic(dst, outText, { mode: 0o600 });
}

function isIndentedEnabledLine(line) {
  if (!line || !/\s/.test(line[0])) return false;
  const trimmed = line.trim();
  return trimmed === 'enabled:' || trimmed === 'enabled: []' || (trimmed.startsWith('enabled: [') && trimmed.endsWith(']'));
}

// ============================================================================
// OpenCode / OpenClaw / Cline merges  (install.sh:631-757)
// ============================================================================

/**
 * opencodeMerge -- top-level "mcp.<name>" with type:"local",
 * command:["node", serverJs]. install.sh:634-654.
 */
export function opencodeMerge(dst, serverJs, ts) {
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  const doc = readJsonOrEmpty(dst);
  if (!doc.mcp || typeof doc.mcp !== 'object') doc.mcp = {};
  doc.mcp['ijfw-memory'] = { type: 'local', command: ['node', serverJs] };

  writeAtomic(dst, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

/**
 * openclawMerge -- ~/.openclaw/openclaw.json,
 * mcp.servers.<name> = { command:'node', args:[serverJs] }. install.sh:660-680.
 */
export function openclawMerge(dst, serverJs, ts) {
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  const doc = readJsonOrEmpty(dst);
  if (!doc.mcp || typeof doc.mcp !== 'object') doc.mcp = {};
  if (!doc.mcp.servers || typeof doc.mcp.servers !== 'object') doc.mcp.servers = {};
  doc.mcp.servers['ijfw-memory'] = { command: 'node', args: [serverJs] };

  writeAtomic(dst, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

/**
 * clineMerge -- VS Code globalStorage per-extension settings.
 * install.sh:688-757.
 *
 * Walks OS-specific globalStorage candidates; first existing dir wins.
 * Falls back to the OS default if no install detected. Returns the
 * destination path so the caller can log it.
 */
export function clineMerge(serverJs, home, ts) {
  const H = home || homeReal();
  const APPDATA = process.env.APPDATA || join(H, 'AppData', 'Roaming');
  const ext = 'saoudrizwan.claude-dev';

  let candidates;
  let osDefault;
  if (process.platform === 'darwin') {
    candidates = [
      join(H, 'Library', 'Application Support', 'Code', 'User'),
      join(H, 'Library', 'Application Support', 'Code - Insiders', 'User'),
      join(H, 'Library', 'Application Support', 'VSCodium', 'User'),
    ];
    osDefault = join(H, 'Library', 'Application Support', 'Code', 'User');
  } else if (IS_WIN) {
    candidates = [
      join(APPDATA, 'Code', 'User'),
      join(APPDATA, 'Code - Insiders', 'User'),
      join(APPDATA, 'VSCodium', 'User'),
    ];
    osDefault = join(APPDATA, 'Code', 'User');
  } else {
    candidates = [
      join(H, '.config', 'Code', 'User'),
      join(H, '.config', 'VSCodium', 'User'),
      join(H, '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User'),
      join(H, 'snap', 'code', 'current', '.config', 'Code', 'User'),
    ];
    osDefault = join(H, '.config', 'Code', 'User');
  }

  let userDir = '';
  for (const c of candidates) {
    if (existsSync(join(c, 'globalStorage', ext))) { userDir = c; break; }
  }
  if (!userDir) userDir = osDefault;

  const dst = join(userDir, 'globalStorage', ext, 'settings', 'cline_mcp_settings.json');
  mkdirSync(dirname(dst), { recursive: true });
  if (ts) backup(dst, ts);

  const doc = readJsonOrEmpty(dst);
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object') doc.mcpServers = {};
  doc.mcpServers['ijfw-memory'] = {
    type: 'stdio',
    command: 'node',
    args: [serverJs],
    disabled: false,
    autoApprove: [],
    timeout: 60,
  };

  writeAtomic(dst, JSON.stringify(doc, null, 2), { mode: 0o600 });
  return dst;
}
