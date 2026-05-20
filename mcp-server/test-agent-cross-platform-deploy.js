// T30: agent cross-platform deploy smoke test.
//
// Asserts the v1.5.0 G7 specialist roster — 4 software-core +
// 7 domain-specialist agents — is fully wired and reachable through the
// established deploy paths:
//
//   - The 4 software-core ids exist as `claude/agents/<id>.md`.
//   - The 7 domain-specialist ids exist as `claude/agents/<id>.md`.
//   - The T26 domain templates' `agent_ids` all resolve to existing
//     files (no phantom ids in the templates).
//   - The Claude deploy path (`$HOME/.ijfw/claude` — the install mirror
//     of the repo's `claude/` directory) carries every agent file by
//     construction: any `.md` under `claude/agents/` is reachable from
//     a user install. We assert the source-of-truth shape that backs
//     that contract.
//   - For platforms with no native agent construct (Codex / Cursor /
//     Windsurf / Copilot / Hermes / Wayland — see
//     `docs/ENFORCEMENT-MATRIX.md`), the team engine in the MCP server
//     is the universal deployment path. We assert the team engine
//     modules exist as the universal layer.
//
// Sibling file `test-cross-platform-smoke.js` covers config-landing
// across the 14 install platforms; this file is narrower — it covers
// the agent-file deployment contract specifically.
//
// Zero new deps. Pure node:test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_SPECIALIST_AGENT_IDS,
  SOFTWARE_CORE_AGENT_IDS,
} from './src/team/generator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CLAUDE_AGENTS_DIR = join(REPO_ROOT, 'claude', 'agents');
const TEMPLATES_DIR = resolve(HERE, 'src/team/domain-templates');

// ---------------------------------------------------------------------------
// Canonical expected agent ids — the T30 contract.
//
// We re-list the 7 specialist ids here (rather than only flattening
// DOMAIN_SPECIALIST_AGENT_IDS) so a failure points at the T30 contract,
// not at a downstream re-export drift.
// ---------------------------------------------------------------------------

const EXPECTED_SPECIALIST_IDS = [
  // book domain (3)
  'ijfw-narrative-continuity-checker',
  'ijfw-line-editor',
  'ijfw-lore-keeper',
  // content / campaign domain (2)
  'ijfw-campaign-strategist',
  'ijfw-copy-reviewer',
  // design domain (2)
  'ijfw-design-critic',
  'ijfw-accessibility-reviewer',
];

// ---------------------------------------------------------------------------
// Helper: parse the YAML-ish frontmatter for the `name:` field. Format is
// fixed for IJFW agent files; no YAML lib needed.
// ---------------------------------------------------------------------------

function parseAgentName(filePath) {
  const text = readFileSync(filePath, 'utf8');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const fm = text.slice(4, end);
  const m = fm.match(/^name:\s*([A-Za-z0-9-]+)\s*$/m);
  return m ? m[1] : null;
}

// ===========================================================================
// Tests — software-core deployment
// ===========================================================================

test('claude/agents/ directory exists', () => {
  assert.ok(
    existsSync(CLAUDE_AGENTS_DIR),
    `expected claude/agents/ directory at ${CLAUDE_AGENTS_DIR}`,
  );
  assert.ok(statSync(CLAUDE_AGENTS_DIR).isDirectory());
});

for (const id of SOFTWARE_CORE_AGENT_IDS) {
  test(`software-core: claude/agents/${id}.md exists and frontmatter name matches`, () => {
    const file = join(CLAUDE_AGENTS_DIR, `${id}.md`);
    assert.ok(existsSync(file), `missing software-core agent file: ${file}`);
    const name = parseAgentName(file);
    assert.equal(name, id, `frontmatter name in ${id}.md must equal "${id}", got "${name}"`);
  });
}

// ===========================================================================
// Tests — domain-specialist deployment
// ===========================================================================

for (const id of EXPECTED_SPECIALIST_IDS) {
  test(`domain-specialist: claude/agents/${id}.md exists and frontmatter name matches`, () => {
    const file = join(CLAUDE_AGENTS_DIR, `${id}.md`);
    assert.ok(existsSync(file), `missing domain-specialist agent file: ${file}`);
    const name = parseAgentName(file);
    assert.equal(name, id, `frontmatter name in ${id}.md must equal "${id}", got "${name}"`);
  });
}

// The flat-set of declared specialists in generator.js must match the
// expected list — guards against silent drift between schemas.js and T30.
test('DOMAIN_SPECIALIST_AGENT_IDS flat-set matches T30 expected specialists', () => {
  const flat = new Set();
  for (const arr of Object.values(DOMAIN_SPECIALIST_AGENT_IDS)) {
    for (const id of arr) flat.add(id);
  }
  const expected = new Set(EXPECTED_SPECIALIST_IDS);
  assert.deepEqual(
    [...flat].sort(),
    [...expected].sort(),
    'DOMAIN_SPECIALIST_AGENT_IDS values must equal the T30 specialist roster',
  );
});

// ===========================================================================
// Tests — template cross-reference (no phantom ids)
// ===========================================================================

test('every domain-template agent_id resolves to a claude/agents/<id>.md file', () => {
  assert.ok(existsSync(TEMPLATES_DIR), `templates dir missing: ${TEMPLATES_DIR}`);
  const templateFiles = readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  assert.ok(templateFiles.length > 0, 'no domain templates found');

  const missing = [];
  for (const filename of templateFiles) {
    const tpl = JSON.parse(readFileSync(join(TEMPLATES_DIR, filename), 'utf8'));
    if (!Array.isArray(tpl.agent_ids)) continue;
    for (const id of tpl.agent_ids) {
      const file = join(CLAUDE_AGENTS_DIR, `${id}.md`);
      if (!existsSync(file)) missing.push(`${filename}: ${id} -> ${file}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `domain-template agent_ids without claude/agents file:\n  - ${missing.join('\n  - ')}`,
  );
});

// ===========================================================================
// Tests — full roster count (4 + 7 = 11)
// ===========================================================================

test('claude/agents/ carries at least 11 ijfw-* agent files (4 core + 7 specialist)', () => {
  const ijfwAgents = readdirSync(CLAUDE_AGENTS_DIR)
    .filter((f) => f.startsWith('ijfw-') && f.endsWith('.md'));
  assert.ok(
    ijfwAgents.length >= 11,
    `expected ≥11 ijfw-* agent files, found ${ijfwAgents.length}: ${ijfwAgents.join(', ')}`,
  );
});

// ===========================================================================
// Tests — universal team-engine deploy path (MCP-only platforms)
// ===========================================================================
//
// Per docs/ENFORCEMENT-MATRIX.md, Gemini / Cursor / Windsurf / Copilot /
// Hermes / Wayland have no native subagent construct comparable to Claude's
// agents/*.md system. For those platforms the team engine in the MCP server
// is the universal deployment layer — `ijfw_team` MCP tool + the team
// generator module. We assert the entrypoints exist.

test('team engine generator module exists at mcp-server/src/team/generator.js', () => {
  const file = resolve(HERE, 'src/team/generator.js');
  assert.ok(existsSync(file), `team engine generator missing: ${file}`);
});

test('team engine schemas module exists at mcp-server/src/team/schemas.js', () => {
  const file = resolve(HERE, 'src/team/schemas.js');
  assert.ok(existsSync(file), `team engine schemas missing: ${file}`);
});

test('team engine modify module exists at mcp-server/src/team/modify.js', () => {
  const file = resolve(HERE, 'src/team/modify.js');
  assert.ok(existsSync(file), `team engine modify missing: ${file}`);
});

test('team engine domain-templates dir is populated', () => {
  const dir = resolve(HERE, 'src/team/domain-templates');
  assert.ok(existsSync(dir), `templates dir missing: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(
    files.length >= 3,
    `expected ≥3 domain templates, found ${files.length}`,
  );
});

// ===========================================================================
// Test — Gemini agent path. Gemini's extension has an `agents/` dir; per
// installer/src/install-targets-1-7.js the installer copies every *.md
// in `gemini/extensions/ijfw/agents/` into `$HOME/.gemini/extensions/ijfw/agents/`.
// Absence of the source dir would silently break Gemini agent deploy.
// ===========================================================================

test('gemini agent deploy path exists at gemini/extensions/ijfw/agents/', () => {
  const dir = join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'agents');
  assert.ok(existsSync(dir), `gemini agents dir missing: ${dir}`);
  assert.ok(statSync(dir).isDirectory(), 'gemini agents path is not a directory');
});
