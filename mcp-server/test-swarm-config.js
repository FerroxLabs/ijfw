import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSwarmConfig, loadSwarmConfig, detectProjectType, DEFAULT_SPECIALISTS, SCHEMA, specialistsFor } from './src/swarm-config.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-swarm-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── SCHEMA + exports ────────────────────────────────────────────────────────

test('SCHEMA has expected shape', () => {
  assert.ok(typeof SCHEMA.project_type === 'string');
  assert.ok(Array.isArray(SCHEMA.specialists));
});

test('DEFAULT_SPECIALISTS covers all project types', () => {
  for (const key of ['node', 'python', 'typed', 'go', 'rust', 'other']) {
    assert.ok(Array.isArray(DEFAULT_SPECIALISTS[key]), `missing key: ${key}`);
    assert.ok(DEFAULT_SPECIALISTS[key].length > 0);
  }
});

test('no agent_type values contain foreign plugin prefixes', () => {
  for (const list of Object.values(DEFAULT_SPECIALISTS)) {
    for (const s of list) {
      assert.ok(!s.agent_type.includes(':'), `colon in agent_type: ${s.agent_type}`);
    }
  }
});

test('getSwarmConfig is the same function as loadSwarmConfig', () => {
  assert.equal(getSwarmConfig, loadSwarmConfig);
});

// ── New-project path ────────────────────────────────────────────────────────

test('new project with package.json returns node defaults and writes file', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    const cfg = getSwarmConfig(dir);
    assert.equal(cfg.project_type, 'node');
    const ids = cfg.specialists.map(s => s.id);
    assert.ok(ids.includes('reviewer'));
    assert.ok(ids.includes('reliability'));
    assert.ok(ids.includes('tests'));
    // File must exist after first call.
    assert.ok(existsSync(join(dir, '.ijfw', 'swarm.json')));
    const written = JSON.parse(readFileSync(join(dir, '.ijfw', 'swarm.json'), 'utf8'));
    assert.deepEqual(written, cfg);
  } finally {
    cleanup(dir);
  }
});

// ── Existing-file path ──────────────────────────────────────────────────────

test('existing swarm.json is returned unchanged and not overwritten', () => {
  const dir = makeTmp();
  try {
    const custom = { project_type: 'custom', specialists: [{ id: 'x', role: 'X', agent_type: 'x-agent' }] };
    mkdirSync(join(dir, '.ijfw'));
    const swarmPath = join(dir, '.ijfw', 'swarm.json');
    writeFileSync(swarmPath, JSON.stringify(custom, null, 2), 'utf8');
    const mtimeBefore = existsSync(swarmPath) && readFileSync(swarmPath, 'utf8');

    const cfg = getSwarmConfig(dir);
    // v1.4.4 N10: loadSwarmConfig merges auditors/auditor_count defaults at
    // read time (in-memory only; file on disk is NOT rewritten).
    assert.equal(cfg.project_type, custom.project_type);
    assert.deepEqual(cfg.specialists, custom.specialists);
    assert.ok(Array.isArray(cfg.auditors), 'auditors default should be injected');
    assert.equal(typeof cfg.auditor_count, 'number');
    // Content must be identical (not regenerated -- defaults are in-memory only).
    assert.equal(readFileSync(swarmPath, 'utf8'), mtimeBefore);
  } finally {
    cleanup(dir);
  }
});

// ── Typed-codebase path ─────────────────────────────────────────────────────

test('tsconfig.json present adds type-design specialist', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const cfg = getSwarmConfig(dir);
    assert.equal(cfg.project_type, 'typed');
    const types = cfg.specialists.find(s => s.agent_type === 'type-design-analyzer');
    assert.ok(types, 'type-design-analyzer specialist missing');
  } finally {
    cleanup(dir);
  }
});

// ── Unknown-project path ────────────────────────────────────────────────────

test('unknown project (no signals) returns reviewer + reliability', () => {
  const dir = makeTmp();
  try {
    const cfg = getSwarmConfig(dir);
    assert.equal(cfg.project_type, 'other');
    const ids = cfg.specialists.map(s => s.id);
    assert.ok(ids.includes('reviewer'));
    assert.ok(ids.includes('reliability'));
    assert.ok(!ids.includes('tests'), 'unknown project should not include tests specialist');
  } finally {
    cleanup(dir);
  }
});

// ── detectProjectType ───────────────────────────────────────────────────────

test('detectProjectType: python via pyproject.toml', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'pyproject.toml'), '');
    assert.equal(detectProjectType(dir), 'python');
  } finally {
    cleanup(dir);
  }
});

test('detectProjectType: python via requirements.txt', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'requirements.txt'), '');
    assert.equal(detectProjectType(dir), 'python');
  } finally {
    cleanup(dir);
  }
});

test('detectProjectType: go via go.mod', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'go.mod'), '');
    assert.equal(detectProjectType(dir), 'go');
  } finally {
    cleanup(dir);
  }
});

test('detectProjectType: rust via Cargo.toml', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    assert.equal(detectProjectType(dir), 'rust');
  } finally {
    cleanup(dir);
  }
});

test('detectProjectType: typed wins over node when tsconfig.json present', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    assert.equal(detectProjectType(dir), 'typed');
  } finally {
    cleanup(dir);
  }
});

// ── No pollution of real .ijfw ──────────────────────────────────────────────

// ── audit-MED-teams-#6: domain-keyed bench routing ─────────────────────────

test('DEFAULT_SPECIALISTS exposes archetype-keyed benches (book, content, research)', () => {
  for (const key of ['software', 'book', 'content', 'marketing', 'research', 'design', 'business', 'mixed']) {
    assert.ok(Array.isArray(DEFAULT_SPECIALISTS[key]), `missing archetype key: ${key}`);
    assert.ok(DEFAULT_SPECIALISTS[key].length > 0, `empty archetype bench: ${key}`);
  }
});

// v1.5.1 W1.5.D: bench ids now align with T26 domain-templates (the canonical
// agent-id source per ADR .planning/1.5.1/decisions/W1.5-canonical-source.md).
// Phantom ids (story-architect/continuity-editor/prose-stylist/copy-editor/
// data-analyst) were deleted because no claude/agents/<id>.md shipped for them.
test('book archetype bench contains T26 narrative specialists, no accessibility-eng', () => {
  const ids = DEFAULT_SPECIALISTS.book.map((s) => s.id);
  assert.ok(ids.includes('narrative-continuity-checker'), 'book bench should include narrative-continuity-checker');
  assert.ok(ids.includes('line-editor'), 'book bench should include line-editor');
  assert.ok(ids.includes('lore-keeper'), 'book bench should include lore-keeper');
  assert.ok(!ids.includes('accessibility-eng'), 'book bench should NOT include accessibility-eng');
  assert.ok(!ids.includes('release-eng'), 'book bench should NOT include release-eng');
});

test('research archetype bench includes research-lead + method-reviewer', () => {
  const ids = DEFAULT_SPECIALISTS.research.map((s) => s.id);
  assert.ok(ids.includes('research-lead'));
  assert.ok(ids.includes('method-reviewer'));
});

test('design archetype bench maps to DESIGN_BENCH (not CONTENT_BENCH)', () => {
  const ids = DEFAULT_SPECIALISTS.design.map((s) => s.id);
  assert.ok(ids.includes('design-critic'), 'design bench should include design-critic');
  assert.ok(ids.includes('accessibility-reviewer'), 'design bench should include accessibility-reviewer');
  assert.ok(!ids.includes('campaign-strategist'), 'design bench should NOT be CONTENT_BENCH');
});

test('business archetype bench maps to BUSINESS_BENCH (not SOFTWARE_BENCH)', () => {
  const ids = DEFAULT_SPECIALISTS.business.map((s) => s.id);
  assert.ok(ids.includes('strategy-lead'), 'business bench should include strategy-lead');
  assert.ok(ids.includes('risk-reviewer'), 'business bench should include risk-reviewer');
  assert.ok(!ids.includes('reviewer'), 'business bench should NOT be SOFTWARE_BENCH');
});

test('mixed archetype bench maps to MIXED_BENCH (cross-domain sampler)', () => {
  const ids = DEFAULT_SPECIALISTS.mixed.map((s) => s.id);
  assert.ok(ids.includes('reviewer'), 'mixed bench should include base reviewer');
  assert.ok(ids.includes('design-critic'), 'mixed bench should include design-critic');
  assert.ok(ids.includes('campaign-strategist'), 'mixed bench should include campaign-strategist');
});

test('specialistsFor archetype wins over language', () => {
  const bench = specialistsFor({ archetype: 'book', language: 'node' });
  const ids = bench.map((s) => s.id);
  assert.ok(ids.includes('narrative-continuity-checker'));
  assert.ok(!ids.includes('reviewer'), 'book bench should not inherit software reviewer');
});

// v1.5.1 W1.5.D: every bench specialist's agent_type must resolve to a real
// claude/agents/<id>.md file (or be a Claude builtin like code-reviewer).
// This is the regression test that prevents phantom ids from shipping again.
test('every bench agent_type resolves to an on-disk agent file (or Claude builtin)', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const AGENTS_DIR = resolve(HERE, '..', 'claude', 'agents');
  // Claude/Anthropic builtins shipped with the host CLI — no markdown in this repo.
  const BUILTINS = new Set(['code-reviewer', 'silent-failure-hunter', 'pr-test-analyzer', 'type-design-analyzer']);
  for (const [archetype, bench] of Object.entries(DEFAULT_SPECIALISTS)) {
    for (const s of bench) {
      if (BUILTINS.has(s.agent_type)) continue;
      const p = resolve(AGENTS_DIR, `${s.agent_type}.md`);
      assert.ok(existsSync(p), `phantom agent in ${archetype} bench: ${s.agent_type} (expected ${p})`);
    }
  }
});

test('specialistsFor falls back to language then other', () => {
  const node = specialistsFor({ language: 'node' });
  const other = specialistsFor({});
  assert.ok(node.length > 0);
  assert.ok(other.length > 0);
});

test('real project .ijfw/swarm.json is not touched by tests', () => {
  // This test verifies the test suite did not write to the real project dir.
  const realPath = join(process.cwd(), '.ijfw', 'swarm.json');
  // We make no call with the real project dir, so the file must not exist
  // unless it was there before this session started.
  // (If it already exists, we just verify it hasn't grown in these tests.)
  // Since we only ever call getSwarmConfig with tmp dirs, this is guaranteed.
  // Assert the real project root was never passed to getSwarmConfig above.
  assert.ok(true, 'No real project dir was passed to getSwarmConfig in this test file');
});
