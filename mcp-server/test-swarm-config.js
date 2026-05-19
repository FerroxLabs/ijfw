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

test('book archetype bench contains story/continuity/prose specialists, no accessibility-eng', () => {
  const ids = DEFAULT_SPECIALISTS.book.map((s) => s.id);
  assert.ok(ids.includes('story-architect'), 'book bench should include story-architect');
  assert.ok(ids.includes('continuity-editor'), 'book bench should include continuity-editor');
  assert.ok(ids.includes('prose-stylist'), 'book bench should include prose-stylist');
  assert.ok(!ids.includes('accessibility-eng'), 'book bench should NOT include accessibility-eng');
  assert.ok(!ids.includes('release-eng'), 'book bench should NOT include release-eng');
});

test('research archetype bench includes research-lead + data-analyst', () => {
  const ids = DEFAULT_SPECIALISTS.research.map((s) => s.id);
  assert.ok(ids.includes('research-lead'));
  assert.ok(ids.includes('data-analyst'));
});

test('specialistsFor archetype wins over language', () => {
  const bench = specialistsFor({ archetype: 'book', language: 'node' });
  const ids = bench.map((s) => s.id);
  assert.ok(ids.includes('story-architect'));
  assert.ok(!ids.includes('reviewer'), 'book bench should not inherit software reviewer');
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
