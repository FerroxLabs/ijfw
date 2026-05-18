import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SPECIALISTS } from './src/swarm-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, 'claude', 'agents');

const NEW_SPECIALISTS = [
  'ijfw-doc-verifier',
  'ijfw-pattern-mapper',
  'ijfw-security-auditor',
  'ijfw-integration-checker',
  'ijfw-nyquist-auditor',
];

const LEGAL_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'TodoWrite',
]);

// Tiny YAML frontmatter parser — flat key:value only (matches the subset our
// agent files actually use; same shape pattern as orchestrator/wave-state.js).
function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    throw new Error('missing frontmatter');
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) throw new Error('unclosed frontmatter');
  const block = content.slice(4, end);
  const out = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------

test('all 5 new specialist agent .md files exist at expected paths', () => {
  for (const name of NEW_SPECIALISTS) {
    const path = join(AGENTS_DIR, `${name}.md`);
    assert.ok(existsSync(path), `${name}.md missing at ${path}`);
  }
});

test('each new specialist .md has required frontmatter keys', () => {
  const required = ['name', 'description', 'model', 'allowed-tools'];
  for (const name of NEW_SPECIALISTS) {
    const content = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf8');
    const fm = parseFrontmatter(content);
    for (const key of required) {
      assert.ok(key in fm, `${name}: missing frontmatter key "${key}"`);
      assert.ok(fm[key].length > 0, `${name}: empty value for "${key}"`);
    }
  }
});

test('each specialist name: field matches its filename', () => {
  for (const expectedName of NEW_SPECIALISTS) {
    const content = readFileSync(join(AGENTS_DIR, `${expectedName}.md`), 'utf8');
    const fm = parseFrontmatter(content);
    assert.equal(fm.name, expectedName, `${expectedName}.md: name field mismatch`);
  }
});

test('each specialist allowed-tools is a subset of legal tools', () => {
  for (const name of NEW_SPECIALISTS) {
    const content = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf8');
    const fm = parseFrontmatter(content);
    const tools = fm['allowed-tools'].split(',').map((t) => t.trim()).filter(Boolean);
    assert.ok(tools.length > 0, `${name}: allowed-tools empty`);
    for (const t of tools) {
      assert.ok(LEGAL_TOOLS.has(t), `${name}: illegal tool "${t}"`);
    }
  }
});

test('each specialist .md contains ROLE, PROCESS, OUTPUT CONTRACT sections', () => {
  for (const name of NEW_SPECIALISTS) {
    const content = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf8');
    assert.match(content, /^#+\s*ROLE/m, `${name}: missing ROLE section`);
    assert.match(content, /^#+\s*PROCESS/m, `${name}: missing PROCESS section`);
    assert.match(content, /^#+\s*OUTPUT CONTRACT/m, `${name}: missing OUTPUT CONTRACT section`);
  }
});

test('DEFAULT_SPECIALISTS includes all 5 new specialists in node project type', () => {
  const nodeSpecs = DEFAULT_SPECIALISTS.node;
  const agentTypes = new Set(nodeSpecs.map((s) => s.agent_type));
  for (const name of NEW_SPECIALISTS) {
    assert.ok(agentTypes.has(name), `node specialists missing ${name}`);
  }
});

test('DEFAULT_SPECIALISTS spreads new specialists across every project type', () => {
  for (const type of Object.keys(DEFAULT_SPECIALISTS)) {
    const agentTypes = new Set(DEFAULT_SPECIALISTS[type].map((s) => s.agent_type));
    for (const name of NEW_SPECIALISTS) {
      assert.ok(agentTypes.has(name), `${type}: missing new specialist ${name}`);
    }
  }
});

test('DEFAULT_SPECIALISTS has no duplicate ids within any project type', () => {
  for (const type of Object.keys(DEFAULT_SPECIALISTS)) {
    const ids = DEFAULT_SPECIALISTS[type].map((s) => s.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `${type}: duplicate specialist ids found`);
  }
});

test('existing pre-v1.4.4 specialists still present (regression)', () => {
  // BASE specialists + TESTS_SPECIALIST + TYPES_SPECIALIST should survive
  const nodeAgentTypes = new Set(DEFAULT_SPECIALISTS.node.map((s) => s.agent_type));
  assert.ok(nodeAgentTypes.has('pr-test-analyzer'), 'TESTS_SPECIALIST regressed from node');

  const typedAgentTypes = new Set(DEFAULT_SPECIALISTS.typed.map((s) => s.agent_type));
  assert.ok(typedAgentTypes.has('type-design-analyzer'), 'TYPES_SPECIALIST regressed from typed');
});
