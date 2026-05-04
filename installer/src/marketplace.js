// Deep-merge ~/.claude/settings.json to register the ijfw marketplace + enable plugin.
// Atomic write via .tmp + rename. Never deletes unrelated keys.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function claudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

// Resolve the plugin install location. Mirrors the bash installer
// (scripts/install.sh: CLAUDE_PLUGIN_PATH="$HOME/.ijfw/claude") and honors
// --dir / IJFW_HOME the same way installer/src/install.js's resolveTarget does.
// Caller can pass an explicit rootDir to short-circuit the env lookup.
export function pluginInstallPath(rootDir) {
  if (rootDir) return resolve(rootDir, 'claude');
  if (process.env.IJFW_HOME) return resolve(process.env.IJFW_HOME, 'claude');
  return join(homedir(), '.ijfw', 'claude');
}

// C3 (audit R1) + R2-F -- tokenizer-aware JSONC comment strip. A naive
// regex was corrupting string values containing //, /*, */. R2-F also
// handles: leading BOM (U+FEFF), CR-only and U+2028/U+2029 line
// separators inside `//` line comments, and unterminated `/* */`.
function stripJsoncComments(raw) {
  // Strip a leading UTF-8 BOM -- common when settings.json was saved by
  // a Windows editor. JSON.parse chokes on it too.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let out = '';
  let i = 0;
  const n = raw.length;
  const isLineBreak = (code) =>
    code === 0x0A || code === 0x0D || code === 0x2028 || code === 0x2029;
  while (i < n) {
    const c = raw[i];
    const c2 = raw[i + 1];
    // String literal -- copy verbatim including any escaped chars.
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        const k = raw[i];
        out += k;
        if (k === '\\' && i + 1 < n) { out += raw[i + 1]; i += 2; continue; }
        i++;
        if (k === '"') break;
      }
      continue;
    }
    // Line comment -- terminate at \n, \r, U+2028, U+2029, or EOF.
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && !isLineBreak(raw.charCodeAt(i))) i++;
      continue;
    }
    // Block comment -- tolerate unterminated (EOF closes).
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      if (i < n) i += 2; // consume the closing */
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function tolerantJsonParse(raw, filepath) {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // JSONC recovery: tokenizer-aware comment strip + trailing-comma fixup.
  // Strings are preserved verbatim so values containing //, /* */, or URL
  // fragments are not corrupted.
  const stripped = stripJsoncComments(raw).replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(stripped); }
  catch (e) {
    const err = new Error(`settings.json at ${filepath} is not valid JSON or recoverable JSONC: ${e.message}`);
    err.code = 'IJFW_SETTINGS_UNPARSEABLE';
    throw err;
  }
}

// mergeMarketplace registers the ijfw plugin marketplace as a *directory*
// source. The directory shape matches what scripts/install.sh writes and what
// known_marketplaces.json caches at runtime; using the github shape here was
// the bug behind "Marketplace file not found at .../TheRealSeanDonahoe-ijfw/
// .claude-plugin/marketplace.json" -- Claude Code expected a clone at that
// path but the install only ever writes the local directory.
//
// options.pluginPath -- absolute path to the plugin directory (~/.ijfw/claude
// by default, or <rootDir>/claude when --dir is in play). Resolved via
// pluginInstallPath() if omitted.
export function mergeMarketplace(settingsPath = claudeSettingsPath(), options = {}) {
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    settings = tolerantJsonParse(raw, settingsPath);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  const pluginPath = options.pluginPath || pluginInstallPath(options.rootDir);

  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  // Self-heal: prior installs (<= 1.2.6) wrote a github source pointing at
  // TheRealSeanDonahoe/ijfw. Claude Code never clones that repo into the
  // marketplaces cache, so the entry resolves to a missing file. Overwrite
  // with the correct directory source on every install. Idempotent.
  settings.extraKnownMarketplaces.ijfw = {
    source: { source: 'directory', path: pluginPath },
  };
  settings.enabledPlugins = settings.enabledPlugins || {};
  // Opportunistically clean up the legacy key written by v1.0.0-1.0.2.
  if ('ijfw-core@ijfw' in settings.enabledPlugins) {
    delete settings.enabledPlugins['ijfw-core@ijfw'];
  }
  settings.enabledPlugins['ijfw@ijfw'] = true;

  const tmp = settingsPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, settingsPath);
  return settings;
}

export function unmergeMarketplace(settingsPath = claudeSettingsPath()) {
  if (!existsSync(settingsPath)) return null;
  // Y1 -- use tolerantJsonParse for symmetry with mergeMarketplace so uninstall
  // doesn't crash on JSONC-flavored settings.
  const settings = tolerantJsonParse(readFileSync(settingsPath, 'utf8'), settingsPath);
  if (settings.extraKnownMarketplaces?.ijfw) delete settings.extraKnownMarketplaces.ijfw;
  if (settings.enabledPlugins) {
    // Delete both the legacy key (v1.0.0-1.0.2) and the current key.
    if ('ijfw-core@ijfw' in settings.enabledPlugins) delete settings.enabledPlugins['ijfw-core@ijfw'];
    if ('ijfw@ijfw' in settings.enabledPlugins) delete settings.enabledPlugins['ijfw@ijfw'];
  }
  const tmp = settingsPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, settingsPath);
  return settings;
}
