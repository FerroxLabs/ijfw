#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..');
const capPath = join(repo, 'platform-capabilities.json');
const caps = JSON.parse(readFileSync(capPath, 'utf8'));

// --- counters ---------------------------------------------------------------

function countSkillDirs(rel) {
  const abs = join(repo, rel);
  assert.ok(existsSync(abs), `missing skills path: ${rel}`);
  return readdirSync(abs, { withFileTypes: true }).filter((d) => (
    d.isDirectory() && d.name.startsWith('ijfw-') && existsSync(join(abs, d.name, 'SKILL.md'))
  )).length;
}

function countHookEvents(rel) {
  const abs = join(repo, rel);
  assert.ok(existsSync(abs), `missing hooks path: ${rel}`);
  const doc = JSON.parse(readFileSync(abs, 'utf8'));
  return Object.values(doc.hooks || {}).filter((groups) => Array.isArray(groups) && groups.length > 0).length;
}

// Count plain files in a directory (optionally filtered by extension,
// optionally recursive). Returns 0 if the directory does not exist.
function countFiles(rel, { ext = null, recursive = false } = {}) {
  const abs = join(repo, rel);
  if (!existsSync(abs)) return 0;
  let total = 0;
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (recursive) total += countFiles(join(rel, d.name), { ext, recursive });
      continue;
    }
    if (!d.isFile()) continue;
    if (ext && !d.name.endsWith(ext)) continue;
    total += 1;
  }
  return total;
}

// Count `commands:` entries declared in a platform plugin manifest.
// hermes/wayland ship commands as Python handlers declared in plugin.yaml,
// not as files on disk.
function countYamlCommands(rel) {
  const abs = join(repo, rel);
  assert.ok(existsSync(abs), `missing plugin manifest: ${rel}`);
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  let inCommands = false;
  let total = 0;
  for (const line of lines) {
    if (/^commands:\s*$/.test(line)) { inCommands = true; continue; }
    if (inCommands) {
      if (/^\s*-\s+\S/.test(line)) { total += 1; continue; }
      if (/^\S/.test(line)) break; // next top-level key ends the block
    }
  }
  return total;
}

// --- disk resolvers ---------------------------------------------------------
// Maps platform name -> a closure that returns the true on-disk count for
// each count field. A platform absent from the map (mcp-only / rules-only
// tiers) is expected to declare 0 for every directory-backed field; that is
// enforced below by the zero-check.
const resolvers = {
  claude: {
    agents: () => countFiles('claude/agents', { ext: '.md' }),
    commands: () => countFiles('claude/commands', { ext: '.md' }),
    // claude hooks ship as .sh + .js only; the extension filter keeps stray
    // files (.DS_Store, editor swap files) from inflating the count.
    hooks: () => countFiles('claude/hooks/scripts', { ext: '.sh' })
      + countFiles('claude/hooks/scripts', { ext: '.js' })
  },
  codex: {
    agents: () => 0, // no codex/agents dir — runtime-generated only
    commands: () => countFiles('codex/commands', { ext: '.md' }),
    hooks: () => countFiles('codex/.codex/hooks', { ext: '.sh', recursive: true })
  },
  gemini: {
    agents: () => countFiles('gemini/extensions/ijfw/agents', { ext: '.md' }),
    commands: () => countFiles('gemini/extensions/ijfw/commands', { ext: '.toml' }),
    hooks: () => countFiles('gemini/extensions/ijfw/hooks', { ext: '.sh', recursive: true })
  },
  shared: {
    agents: () => 0,
    commands: () => 0,
    hooks: () => 0
  },
  hermes: {
    agents: () => 0,
    commands: () => countYamlCommands('hermes/plugins/ijfw/plugin.yaml'),
    hooks: () => countFiles('hermes/plugins/ijfw/hooks', { ext: '.py' })
  },
  wayland: {
    agents: () => 0,
    commands: () => countYamlCommands('wayland/plugins/ijfw/plugin.yaml'),
    hooks: () => countFiles('wayland/plugins/ijfw/hooks', { ext: '.py' })
  }
};

// --- drift checks -----------------------------------------------------------

const COUNT_FIELDS = ['agents', 'commands', 'hooks'];

for (const [name, cfg] of Object.entries(caps.platforms || {})) {
  // skills (directory-backed, tier-1/tier-2 entries carry skillsPath)
  if (cfg.skillsPath) {
    const got = countSkillDirs(cfg.skillsPath);
    assert.equal(got, cfg.skills, `${name}: skill count drift (${got} != ${cfg.skills})`);
  }
  // hookEvents (manifest-backed, tier-1 entries carry hooksPath)
  if (cfg.hooksPath) {
    const got = countHookEvents(cfg.hooksPath);
    assert.equal(got, cfg.hookEvents, `${name}: hook-event count drift (${got} != ${cfg.hookEvents})`);
  }
  // agents / commands / hooks — validated against disk for every platform.
  const resolver = resolvers[name];
  for (const field of COUNT_FIELDS) {
    const declared = cfg[field];
    if (typeof declared !== 'number') {
      throw new Error(`${name}: missing required count field "${field}"`);
    }
    if (resolver && typeof resolver[field] === 'function') {
      const got = resolver[field]();
      assert.equal(got, declared, `${name}: ${field} count drift (disk ${got} != json ${declared})`);
    } else {
      // No disk surface for this platform (mcp-only / rules-only tiers).
      // Such entries MUST declare 0 — a non-zero count would be phantom.
      assert.equal(
        declared, 0,
        `${name}: ${field} declared ${declared} but platform has no on-disk ${field} surface (must be 0)`
      );
    }
  }
}

// --- platform manifest cross-checks (string-embedded counts) ----------------

const codex = caps.platforms.codex;
const codexPlugin = readFileSync(join(repo, 'codex/.codex-plugin/plugin.json'), 'utf8');
assert.match(codexPlugin, new RegExp(`${codex.skills} workflow skills`), 'codex plugin skill count drift');
assert.match(codexPlugin, new RegExp(`${codex.hookEvents} hook events`), 'codex plugin hook count drift');

const codexMarket = readFileSync(join(repo, 'codex/.agents/plugins/marketplace.json'), 'utf8');
assert.match(codexMarket, new RegExp(`${codex.skills} workflow skills`), 'codex marketplace skill count drift');
assert.match(codexMarket, new RegExp(`${codex.hookEvents} hook events`), 'codex marketplace hook count drift');

const gemini = caps.platforms.gemini;
const geminiManifest = readFileSync(join(repo, 'gemini/extensions/ijfw/gemini-extension.json'), 'utf8');
assert.match(geminiManifest, new RegExp(`${gemini.skills} workflow skills`), 'gemini manifest skill count drift');
assert.match(geminiManifest, new RegExp(`${gemini.hookEvents}-event hooks`), 'gemini manifest hook count drift');

console.log('PASS: platform capabilities match skill, agent, command, hook, and hook-event surfaces');
