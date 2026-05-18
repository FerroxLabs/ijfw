import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'claude', 'skills', 'ijfw-agents-md', 'templates');
const SKILL_MD = join(REPO_ROOT, 'claude', 'skills', 'ijfw-agents-md', 'SKILL.md');

const ADAPTERS = [
  { file: 'CLAUDE.md.adapter.tmpl',  ide: 'Claude' },
  { file: 'GEMINI.md.adapter.tmpl',  ide: 'Gemini' },
  { file: 'HERMES.md.adapter.tmpl',  ide: 'Hermes' },
  { file: 'WAYLAND.md.adapter.tmpl', ide: 'Wayland' },
];

// ---------------------------------------------------------------------------

test('all 4 IDE adapter template files exist', () => {
  for (const { file } of ADAPTERS) {
    const path = join(TEMPLATES_DIR, file);
    assert.ok(existsSync(path), `${file} missing at ${path}`);
  }
});

test('each adapter template references AGENTS.md as the canonical source', () => {
  for (const { file } of ADAPTERS) {
    const content = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
    assert.match(content, /AGENTS\.md/, `${file}: missing AGENTS.md reference`);
  }
});

test('each adapter template has its IDE name in the H1 heading', () => {
  for (const { file, ide } of ADAPTERS) {
    const content = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
    const h1Pattern = new RegExp(`^#\\s+${ide}\\b`, 'm');
    assert.match(content, h1Pattern, `${file}: H1 missing IDE name "${ide}"`);
  }
});

test('ijfw-agents-md SKILL.md contains the BLACKBOARD Block Population section', () => {
  const content = readFileSync(SKILL_MD, 'utf8');
  assert.match(
    content,
    /##\s+BLACKBOARD\s+Block\s+Population/i,
    'SKILL.md missing "BLACKBOARD Block Population" section heading',
  );
});

test('ijfw-agents-md SKILL.md preserves the four-block marker convention', () => {
  const content = readFileSync(SKILL_MD, 'utf8');
  // The "Marker Block Taxonomy" section + the four block names must remain
  assert.match(content, /Marker Block Taxonomy/, 'SKILL.md missing "Marker Block Taxonomy" section');
  for (const name of ['MEMORY', 'ROUTING', 'AGENTS', 'BLACKBOARD']) {
    assert.match(content, new RegExp(`\\b${name}\\b`), `SKILL.md missing reserved block name "${name}"`);
  }
});

test('BLACKBOARD section names the wave-state.js populator', () => {
  const content = readFileSync(SKILL_MD, 'utf8');
  assert.match(
    content,
    /wave-state\.js/,
    'BLACKBOARD section must reference the orchestrator/wave-state.js populator',
  );
});
