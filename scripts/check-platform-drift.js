#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..');
const capPath = join(repo, 'platform-capabilities.json');
const caps = JSON.parse(readFileSync(capPath, 'utf8'));

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

for (const [name, cfg] of Object.entries(caps.platforms || {})) {
  if (cfg.skillsPath) {
    const got = countSkillDirs(cfg.skillsPath);
    assert.equal(got, cfg.skills, `${name}: skill count drift (${got} != ${cfg.skills})`);
  }
  if (cfg.hooksPath) {
    const got = countHookEvents(cfg.hooksPath);
    assert.equal(got, cfg.hookEvents, `${name}: hook-event count drift (${got} != ${cfg.hookEvents})`);
  }
}

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

console.log('PASS: platform capabilities match skill and hook surfaces');
