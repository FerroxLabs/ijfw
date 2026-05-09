/**
 * Gemini bundle smoke tests.
 * Verifies: extension manifest, skill files, TOML commands, hook scripts,
 * policy TOML presence, agent files, ASCII-only, no LLM calls in hooks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BASH } from './test/win-bash-helper.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const GEMINI_EXT = join(REPO, 'gemini', 'extensions', 'ijfw');

// ---- Extension manifest -----------------------------------------------------

test('gemini: gemini-extension.json is valid JSON', () => {
  const p = join(GEMINI_EXT, 'gemini-extension.json');
  assert.ok(existsSync(p), 'gemini-extension.json missing');
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(typeof obj.name === 'string', 'manifest missing name');
  assert.ok(typeof obj.version === 'string', 'manifest missing version');
  assert.ok(typeof obj.description === 'string', 'manifest missing description');
  assert.ok(typeof obj.contextFileName === 'string', 'manifest missing contextFileName');
  assert.ok(obj.mcpServers && typeof obj.mcpServers === 'object', 'manifest missing mcpServers');
});

test('gemini: gemini-extension.json is ASCII-only', () => {
  const content = readFileSync(join(GEMINI_EXT, 'gemini-extension.json'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(content), 'gemini-extension.json contains non-ASCII');
});

// ---- hooks.json -------------------------------------------------------------

test('gemini: hooks/hooks.json is valid JSON', () => {
  const p = join(GEMINI_EXT, 'hooks', 'hooks.json');
  assert.ok(existsSync(p), 'hooks/hooks.json missing');
  JSON.parse(readFileSync(p, 'utf8'));
});

test('gemini: hooks.json references expected Gemini hook events', () => {
  const obj = JSON.parse(readFileSync(join(GEMINI_EXT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(typeof obj.hooks === 'object' && !Array.isArray(obj.hooks), 'hooks.json: top-level "hooks" must be a keyed object');
  const events = Object.keys(obj.hooks);
  for (const expected of ['SessionStart', 'SessionEnd', 'BeforeModel', 'BeforeAgent']) {
    assert.ok(events.includes(expected), `hooks.json missing event: ${expected}`);
  }
});

test('gemini: all hook scripts pass bash syntax check', () => {
  const hooksDir = join(GEMINI_EXT, 'hooks');
  const scripts = readdirSync(hooksDir).filter(f => f.endsWith('.sh'));
  assert.ok(scripts.length >= 6, `expected at least 6 hook scripts, found ${scripts.length}`);
  for (const s of scripts) {
    const abs = join(hooksDir, s);
    assert.doesNotThrow(
      () => execFileSync(BASH, ['-n', abs], { stdio: 'pipe' }),
      `bash -n failed: ${s}`
    );
  }
});

// ---- Session-start hook fires memory injection ------------------------------

test('gemini: session-start hook references ijfw memory path', () => {
  const src = readFileSync(join(GEMINI_EXT, 'hooks', 'session-start.sh'), 'utf8');
  assert.ok(
    src.includes('.ijfw') || src.includes('ijfw_memory'),
    'session-start.sh does not reference ijfw memory'
  );
});

test('gemini: before-model hook exists (BeforeModel injection)', () => {
  assert.ok(existsSync(join(GEMINI_EXT, 'hooks', 'before-model.sh')), 'before-model.sh missing');
});

// ---- TOML slash commands ----------------------------------------------------

const EXPECTED_COMMANDS = [
  'ijfw-workflow', 'ijfw-handoff', 'ijfw-cross-audit', 'ijfw-commit',
  'ijfw-status', 'ijfw-doctor', 'ijfw-recall', 'ijfw-team',
  'ijfw-compress', 'ijfw-review', 'ijfw-debug', 'ijfw-summarize'
];

test('gemini: all expected TOML command files exist', () => {
  for (const cmd of EXPECTED_COMMANDS) {
    const p = join(GEMINI_EXT, 'commands', `${cmd}.toml`);
    assert.ok(existsSync(p), `TOML command file missing: ${cmd}.toml`);
  }
});

test('gemini: TOML command files contain description and prompt fields', () => {
  for (const cmd of EXPECTED_COMMANDS) {
    const p = join(GEMINI_EXT, 'commands', `${cmd}.toml`);
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      assert.ok(content.includes('description'), `${cmd}.toml missing description`);
      assert.ok(content.includes('prompt'), `${cmd}.toml missing prompt`);
    }
  }
});

// ---- Skills -----------------------------------------------------------------

const EXPECTED_SKILLS = [
  'ijfw-workflow', 'ijfw-handoff', 'ijfw-cross-audit', 'ijfw-commit',
  'ijfw-status', 'ijfw-doctor', 'ijfw-recall', 'ijfw-team',
  'ijfw-compress', 'ijfw-review', 'ijfw-debug', 'ijfw-summarize',
  'ijfw-critique', 'ijfw-memory-audit', 'ijfw-plan-check', 'ijfw-update'
];

test('gemini: all expected skill directories exist', () => {
  for (const skill of EXPECTED_SKILLS) {
    const p = join(GEMINI_EXT, 'skills', skill);
    assert.ok(existsSync(p), `skill dir missing: ${skill}`);
  }
});

test('gemini: every skill directory contains SKILL.md', () => {
  for (const skill of EXPECTED_SKILLS) {
    const p = join(GEMINI_EXT, 'skills', skill, 'SKILL.md');
    assert.ok(existsSync(p), `SKILL.md missing in: ${skill}`);
  }
});

// ---- Gemini bonus features --------------------------------------------------

test('gemini: policy engine file exists (policies/ijfw.toml)', () => {
  assert.ok(existsSync(join(GEMINI_EXT, 'policies', 'ijfw.toml')), 'policies/ijfw.toml missing');
});

test('gemini: policy file contains at least one [[rules]] block', () => {
  const content = readFileSync(join(GEMINI_EXT, 'policies', 'ijfw.toml'), 'utf8');
  assert.ok(content.includes('[[rules]]'), 'policy file has no [[rules]] blocks');
});

test('gemini: pre-compress hook exists (mirrors Claude PreCompact)', () => {
  assert.ok(existsSync(join(GEMINI_EXT, 'hooks', 'pre-compress.sh')), 'pre-compress.sh missing');
});

test('gemini: at least one agent file present', () => {
  const agentsDir = join(GEMINI_EXT, 'agents');
  assert.ok(existsSync(agentsDir), 'agents/ directory missing');
  const files = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  assert.ok(files.length >= 1, 'no agent .md files found');
});

// ---- ASCII and framing in IJFW.md ------------------------------------------

test('gemini: IJFW.md is ASCII-only', () => {
  const content = readFileSync(join(GEMINI_EXT, 'IJFW.md'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(content), 'IJFW.md contains non-ASCII characters');
});

// ---- No LLM calls in hooks --------------------------------------------------

test('gemini: hooks do not contain calls to AI endpoints', () => {
  const hooksDir = join(GEMINI_EXT, 'hooks');
  const scripts = readdirSync(hooksDir).filter(f => f.endsWith('.sh'));
  const aiPattern = /curl|wget.*(openai|anthropic|googleapis|gemini)/i;
  for (const s of scripts) {
    const content = readFileSync(join(hooksDir, s), 'utf8');
    assert.ok(!aiPattern.test(content), `hook makes LLM call: ${s}`);
  }
});
