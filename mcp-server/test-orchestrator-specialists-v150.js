// v1.5.0 W11-D1 — registration tests for the 8 new specialists (5 S9 IJFW + 3
// F1 GSD) plus the retroactive `since: '1.4.4'` tag on the v1.4.4 N6 roster.
//
// These tests are the wire between the .md files in claude/agents/ and the
// DEFAULT_SPECIALISTS table in mcp-server/src/swarm-config.js. If either side
// drifts (file deleted, missing frontmatter, untagged version, ID collision)
// this suite fails before the orchestrator can dispatch a ghost specialist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_SPECIALISTS } from './src/swarm-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, 'claude', 'agents');

// 8 new specialists landed in v1.5.0 W11-D1.
const V150_FILES = [
  'ijfw-ralph-loop-runner',
  'ijfw-plan-checker',
  'ijfw-dep-audit',
  'ijfw-e2e-runner',
  'ijfw-llm-budget-watcher',
  'ijfw-release-eng',
  'ijfw-doc-writer',
  'ijfw-accessibility-eng',
];

// 5 v1.4.4 N6 specialists that need retroactive `since: '1.4.4'`.
const V144_FILES = [
  'ijfw-doc-verifier',
  'ijfw-pattern-mapper',
  'ijfw-security-auditor',
  'ijfw-integration-checker',
  'ijfw-nyquist-auditor',
];

// Tools the Claude harness exposes to subagents. allowed-tools entries
// must be a subset of this set (modulo whitespace).
const LEGAL_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit',
  'WebFetch', 'WebSearch', 'TodoWrite',
]);

function readFrontmatter(stem) {
  const path = join(AGENTS_DIR, `${stem}.md`);
  const body = readFileSync(path, 'utf8');
  const m = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${stem}: missing YAML frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2], path };
}

test('1. All 5 new IJFW + 3 GSD specialist .md files exist at claude/agents/', () => {
  for (const stem of V150_FILES) {
    const path = join(AGENTS_DIR, `${stem}.md`);
    assert.ok(existsSync(path), `missing: ${path}`);
  }
});

test('2. Each v1.5.0 specialist declares since: \'1.5.0\' in frontmatter', () => {
  for (const stem of V150_FILES) {
    const { fm } = readFrontmatter(stem);
    // Accept both quoted and bare forms.
    const since = String(fm.since || '').replace(/['"]/g, '');
    assert.equal(since, '1.5.0', `${stem}: since field is "${fm.since}", want '1.5.0'`);
  }
});

test('3. v1.4.4 specialists declare since: \'1.4.4\' in frontmatter (regression)', () => {
  for (const stem of V144_FILES) {
    const { fm } = readFrontmatter(stem);
    const since = String(fm.since || '').replace(/['"]/g, '');
    assert.equal(since, '1.4.4', `${stem}: since field is "${fm.since}", want '1.4.4'`);
  }
});

test('4. allowed-tools on every specialist is a subset of LEGAL_TOOLS', () => {
  const all = [...V150_FILES, ...V144_FILES];
  for (const stem of all) {
    const { fm } = readFrontmatter(stem);
    const raw = String(fm['allowed-tools'] || '');
    assert.ok(raw.length > 0, `${stem}: allowed-tools missing`);
    const tools = raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const t of tools) {
      assert.ok(LEGAL_TOOLS.has(t), `${stem}: illegal tool "${t}" (not in LEGAL_TOOLS)`);
    }
  }
});

test('5. Each new specialist body has ROLE / PROCESS / OUTPUT CONTRACT sections', () => {
  for (const stem of V150_FILES) {
    const { body } = readFrontmatter(stem);
    assert.match(body, /^# ROLE\b/m,            `${stem}: missing # ROLE`);
    assert.match(body, /^# PROCESS\b/m,         `${stem}: missing # PROCESS`);
    assert.match(body, /^# OUTPUT CONTRACT\b/m, `${stem}: missing # OUTPUT CONTRACT`);
  }
});

test('6. ijfw-e2e-runner declares HARD CONTRACT in DO NOT section', () => {
  const { body } = readFrontmatter('ijfw-e2e-runner');
  assert.match(body, /# DO NOT[\s\S]*HARD CONTRACT/, 'HARD CONTRACT missing under # DO NOT');
  assert.match(body, /e2e\.fixture\.json/, 'fixture path commitment missing');
});

// audit-MED-teams-#6 deliberately gives book/content/marketing/research/design
// domain-specific benches (story-architect, campaign-strategist, ...) that do
// NOT carry the software-oriented v1.5.0 specialist roster. The 8 v1.5.0
// specialists register only for the software-family project types.
// v1.5.1 W1.5.D: `business` and `mixed` were re-mapped off SOFTWARE_BENCH
// (BUSINESS_BENCH / MIXED_BENCH) because the prior software mapping was a
// mis-map -- they no longer carry the v1.5.0 software specialist roster.
const SOFTWARE_FAMILY = ['node', 'python', 'typed', 'go', 'rust', 'other', 'software'];
const DOMAIN_FAMILY = ['book', 'content', 'marketing', 'research', 'design'];

test('7. All 8 new specialists registered in DEFAULT_SPECIALISTS for every software-family project type', () => {
  const expectedAgentTypes = V150_FILES; // file stems match agent_type values.
  for (const projectType of SOFTWARE_FAMILY) {
    const list = DEFAULT_SPECIALISTS[projectType];
    assert.ok(list, `software-family project_type ${projectType} missing from DEFAULT_SPECIALISTS`);
    const have = new Set(list.map(s => s.agent_type));
    for (const at of expectedAgentTypes) {
      assert.ok(have.has(at), `project_type ${projectType}: missing agent_type ${at}`);
    }
    // Confirm since:'1.5.0' tag persists through to the registered object.
    for (const s of list) {
      if (expectedAgentTypes.includes(s.agent_type)) {
        assert.equal(s.since, '1.5.0', `${projectType}/${s.agent_type}: since=${s.since}`);
      }
    }
  }
});

test('7b. Domain benches carry domain specialists, not the software v1.5.0 roster', () => {
  // audit-MED-teams-#6 contract: a non-software archetype yields a bench
  // tailored to the domain. Guard against the software roster leaking back in.
  for (const projectType of DOMAIN_FAMILY) {
    const list = DEFAULT_SPECIALISTS[projectType];
    assert.ok(list, `domain project_type ${projectType} missing from DEFAULT_SPECIALISTS`);
    const have = new Set(list.map(s => s.agent_type));
    for (const at of V150_FILES) {
      assert.ok(!have.has(at), `${projectType}: software specialist ${at} leaked into the domain bench`);
    }
  }
});

test('8. No ID collision between v1.5.0 specialists and v1.4.4 N6 roster', () => {
  // Pull a representative project type; all share the same roster shape.
  const list = DEFAULT_SPECIALISTS.node;
  const ids = list.map(s => s.id);
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `ID collision: ${id} appears twice in DEFAULT_SPECIALISTS.node`);
    seen.add(id);
  }
  // And the explicit ids of the new 8 don't match any of the v1.4.4 ids.
  const v144Ids = ['doc-verifier', 'pattern-mapper', 'security-auditor', 'integration-checker', 'nyquist-auditor'];
  const v150Ids = ['ralph-loop-runner', 'plan-checker', 'dep-audit', 'e2e-runner', 'llm-budget-watcher',
                   'release-eng', 'doc-writer', 'accessibility-eng'];
  for (const id of v150Ids) {
    assert.ok(!v144Ids.includes(id), `v1.5.0 id "${id}" collides with v1.4.4 roster`);
  }
});
