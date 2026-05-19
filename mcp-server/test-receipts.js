import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { RECEIPTS_FILE, writeReceipt, readReceipts, purgeReceipts } from './src/receipts.js';
import { renderHeroLine } from './src/hero-line.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ijfw-receipts-test-'));
}

function makeReceipt(overrides = {}) {
  return {
    v: 1,
    timestamp: new Date().toISOString(),
    run_stamp: 'test-stamp-001',
    mode: 'audit',
    auditors: [
      { id: 'codex', family: 'openai', model: '' },
      { id: 'gemini', family: 'google', model: '' },
    ],
    findings: { consensus: 2, contested: 1, unique: 3 },
    duration_ms: 47000,
    input_tokens: 12000,
    cost_usd: 0.05,
    model: null,
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    v: 3,
    timestamp: new Date().toISOString(),
    input_tokens: 30000,
    output_tokens: 8000,
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

// --- TASK-6-1 tests ---

test('writeReceipt creates file and parent dirs', () => {
  const dir = tmpDir();
  try {
    writeReceipt(dir, makeReceipt());
    const file = RECEIPTS_FILE(dir);
    assert.ok(fs.existsSync(file), 'cross-runs.jsonl should exist');
    assert.ok(fs.existsSync(path.dirname(file)), 'receipts dir should exist');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two sequential writes produce two lines', () => {
  const dir = tmpDir();
  try {
    writeReceipt(dir, makeReceipt({ run_stamp: 'a' }));
    writeReceipt(dir, makeReceipt({ run_stamp: 'b' }));
    const raw = fs.readFileSync(RECEIPTS_FILE(dir), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).run_stamp, 'a');
    assert.equal(JSON.parse(lines[1]).run_stamp, 'b');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readReceipts skips malformed lines', () => {
  const dir = tmpDir();
  try {
    writeReceipt(dir, makeReceipt({ run_stamp: 'good' }));
    // Inject a malformed line directly.
    fs.appendFileSync(RECEIPTS_FILE(dir), 'NOT_JSON\n');
    writeReceipt(dir, makeReceipt({ run_stamp: 'also-good' }));
    const records = readReceipts(dir);
    assert.equal(records.length, 2);
    assert.equal(records[0].run_stamp, 'good');
    assert.equal(records[1].run_stamp, 'also-good');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readReceipts returns [] when file does not exist', () => {
  const dir = tmpDir();
  try {
    const records = readReceipts(dir);
    assert.deepEqual(records, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- TASK-6-2 tests ---

test('renderHeroLine([]) returns safe empty-state string', () => {
  const out = renderHeroLine([]);
  assert.ok(out.includes('Trident') || out.includes('cross audit'), 'empty state should point to next step');
});

test('renderHeroLine with real receipt and no sessions omits delta', () => {
  const out = renderHeroLine([makeReceipt()], []);
  assert.ok(out.includes('findings'), 'should include findings count');
  assert.ok(!out.includes('measured'), 'should NOT include measured delta');
  assert.ok(!out.includes('%'), 'should NOT include a percentage');
});

test('renderHeroLine with real receipt and sufficient sessions includes measured delta', () => {
  const receipt = makeReceipt({ input_tokens: 12000 });
  const sessions = [
    makeSession({ input_tokens: 30000 }),
    makeSession({ input_tokens: 28000 }),
    makeSession({ input_tokens: 32000 }),
  ];
  const out = renderHeroLine([receipt], sessions);
  assert.ok(out.includes('measured'), `expected measured delta in: ${out}`);
  assert.ok(out.includes('%'), `expected % in: ${out}`);
  assert.ok(out.includes('3x'), `expected sample count in: ${out}`);
});

test('renderHeroLine with only 1 session (insufficient) omits delta', () => {
  const receipt = makeReceipt({ input_tokens: 12000 });
  const sessions = [makeSession({ input_tokens: 30000 })];
  const out = renderHeroLine([receipt], sessions);
  assert.ok(!out.includes('measured'), 'single sample must not produce delta');
});

test('renderHeroLine with null input_tokens on receipt omits delta', () => {
  const receipt = makeReceipt({ input_tokens: null });
  const sessions = [
    makeSession({ input_tokens: 30000 }),
    makeSession({ input_tokens: 28000 }),
    makeSession({ input_tokens: 32000 }),
  ];
  const out = renderHeroLine([receipt], sessions);
  assert.ok(!out.includes('measured'), 'null receipt tokens must not produce delta');
});

test('renderHeroLine aggregates auditor count and findings across multiple receipts', () => {
  const r1 = makeReceipt({ auditors: [{ id: 'codex', family: 'openai', model: '' }], findings: { consensus: 1, contested: 0, unique: 1 } });
  const r2 = makeReceipt({ auditors: [{ id: 'gemini', family: 'google', model: '' }], findings: { consensus: 1, contested: 1, unique: 2 } });
  const out = renderHeroLine([r1, r2], []);
  // 2 unique auditors
  assert.ok(out.startsWith('2 AIs'), `expected '2 AIs', got: ${out}`);
  // total findings = 1+0+1 + 1+1+2 = 6
  assert.ok(out.includes('6 findings'), `expected 6 findings, got: ${out}`);
  // consensus = 1+1 = 2
  assert.ok(out.includes('2 consensus-critical'), `expected 2 consensus-critical, got: ${out}`);
});

test('renderHeroLine duration <1000ms uses ms unit', () => {
  const r = makeReceipt({ duration_ms: 850 });
  const out = renderHeroLine([r], []);
  assert.ok(out.includes('850ms'), `expected ms unit, got: ${out}`);
});

test('renderHeroLine duration ≥1000ms uses seconds unit', () => {
  const r = makeReceipt({ duration_ms: 47000 });
  const out = renderHeroLine([r], []);
  assert.ok(out.includes('47s'), `expected s unit, got: ${out}`);
});

test('concurrent writers each append exactly once (5 processes)', async () => {
  const dir = tmpDir();
  try {
    // Write a tiny worker script to a temp file that each child will run.
    const workerPath = path.join(dir, 'worker.mjs');
    const receiptsPath = new URL('./src/receipts.js', import.meta.url).pathname;
    fs.writeFileSync(workerPath, [
      `import { writeReceipt } from ${JSON.stringify(receiptsPath)};`,
      `const dir = process.argv[2];`,
      `const stamp = process.argv[3];`,
      `writeReceipt(dir, { v:1, run_stamp: stamp, mode:'audit', auditors:[], findings:{ items:[] }, duration_ms:0 });`,
    ].join('\n'));

    const N = 5;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = fork(workerPath, [dir, `stamp-${i}`], { execArgv: [] });
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`child ${i} exited ${code}`)));
        child.on('error', reject);
      })
    ));

    const records = readReceipts(dir);
    assert.equal(records.length, N, `expected ${N} records, got ${records.length}`);
    const stamps = new Set(records.map(r => r.run_stamp));
    assert.equal(stamps.size, N, `expected ${N} unique run_stamps, got ${stamps.size}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Pruning tests ---

test('writeReceipt prunes to last 100 entries after 101 writes', () => {
  const dir = tmpDir();
  try {
    for (let i = 0; i < 101; i++) {
      writeReceipt(dir, makeReceipt({ run_stamp: `stamp-${i}` }));
    }
    const records = readReceipts(dir);
    assert.equal(records.length, 100, `expected 100 entries after 101 writes, got ${records.length}`);
    // Last entry should be stamp-100 (the 101st write)
    assert.equal(records[records.length - 1].run_stamp, 'stamp-100');
    // First entry should be stamp-1 (oldest surviving)
    assert.equal(records[0].run_stamp, 'stamp-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReceipt does not prune when at or under 100 entries', () => {
  const dir = tmpDir();
  try {
    for (let i = 0; i < 100; i++) {
      writeReceipt(dir, makeReceipt({ run_stamp: `stamp-${i}` }));
    }
    const records = readReceipts(dir);
    assert.equal(records.length, 100);
    assert.equal(records[0].run_stamp, 'stamp-0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('purgeReceipts empties the file and returns count removed', () => {
  const dir = tmpDir();
  try {
    writeReceipt(dir, makeReceipt({ run_stamp: 'a' }));
    writeReceipt(dir, makeReceipt({ run_stamp: 'b' }));
    const removed = purgeReceipts(dir);
    assert.equal(removed, 2);
    const records = readReceipts(dir);
    assert.deepEqual(records, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('purgeReceipts returns 0 when file does not exist', () => {
  const dir = tmpDir();
  try {
    const removed = purgeReceipts(dir);
    assert.equal(removed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderHeroLine with findings.items shape reports correct count (not 0)', () => {
  const r = makeReceipt({
    findings: { items: [{ counterArg: 'a', severity: 'high' }, { counterArg: 'b', severity: 'medium' }] },
  });
  const out = renderHeroLine([r], []);
  assert.ok(out.includes('2 findings'), `expected 2 findings, got: ${out}`);
});

// --- 10D hero-line cache savings tests ---

test('renderHeroLine: no cache_stats -> no cache suffix', () => {
  const r = makeReceipt(); // no cache_stats field
  const out = renderHeroLine([r], []);
  assert.ok(!out.includes('cache hit'), `expected no cache suffix, got: ${out}`);
});

test('renderHeroLine: cache_read_input_tokens=0 -> no cache suffix', () => {
  const r = makeReceipt({ cache_stats: { cache_eligible: true, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 } });
  const out = renderHeroLine([r], []);
  assert.ok(!out.includes('cache hit'), `expected no cache suffix when reads=0, got: ${out}`);
});

test('renderHeroLine: cache_read_input_tokens>0 -> savings suffix appended', () => {
  // 1,000,000 tokens * $2.70/M = $2.70 savings
  const r = makeReceipt({ cache_stats: { cache_eligible: true, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 } });
  const out = renderHeroLine([r], []);
  assert.ok(out.includes('prompt cache hit'), `expected cache hit in: ${out}`);
  assert.ok(out.includes('$2.70 saved'), `expected savings amount in: ${out}`);
});

test('renderHeroLine: cache savings accumulate across multiple receipts', () => {
  const r1 = makeReceipt({ cache_stats: { cache_eligible: true, cache_read_input_tokens: 500_000 } });
  const r2 = makeReceipt({ cache_stats: { cache_eligible: true, cache_read_input_tokens: 500_000 } });
  const out = renderHeroLine([r1, r2], []);
  // 1,000,000 tokens total -> $2.70
  assert.ok(out.includes('$2.70 saved'), `expected $2.70 saved, got: ${out}`);
});

// v1.5.0 audit-LOW-obs-L5: cover the cache_eligible:false branch of
// renderReceipt -- prior tests only exercised the cache-hit path, so a
// regression there could land silently.
test('renderReceipt: cache_eligible:false emits "cache-eligible: false" line with reason', async () => {
  const { renderReceipt } = await import('./src/receipts.js');
  const r = {
    timestamp: '2026-05-19T12:00:00.000Z',
    mode: 'cross',
    duration_ms: 1200,
    cache_stats: { cache_eligible: false, cache_eligible_reason: 'prompt < 1024 tokens' },
  };
  const out = renderReceipt(r);
  assert.ok(out.includes('cache-eligible: false'), `expected ineligible line, got: ${out}`);
  assert.ok(out.includes('prompt < 1024 tokens'), `expected reason, got: ${out}`);
  // ensure no "cache created" / "cache read" lines leaked from the eligible branch
  assert.ok(!out.includes('cache created'), 'should NOT emit cache-created line on ineligible');
  assert.ok(!out.includes('cache read'), 'should NOT emit cache-read line on ineligible');
});

test('renderReceipt: cache_eligible:false with no reason uses default', async () => {
  const { renderReceipt } = await import('./src/receipts.js');
  const r = {
    timestamp: '2026-05-19T12:00:00.000Z',
    mode: 'cross',
    duration_ms: 1200,
    cache_stats: { cache_eligible: false }, // no reason supplied
  };
  const out = renderReceipt(r);
  assert.ok(out.includes('cache-eligible: false'), `expected ineligible line, got: ${out}`);
  assert.ok(out.includes('prompt < 1024 tokens'), `expected default reason, got: ${out}`);
});

test('renderHeroLine: cache suffix appended after delta when both present', () => {
  const r = makeReceipt({ input_tokens: 12000, cache_stats: { cache_eligible: true, cache_read_input_tokens: 1_000_000 } });
  const sessions = [
    makeSession({ input_tokens: 30000 }),
    makeSession({ input_tokens: 28000 }),
    makeSession({ input_tokens: 32000 }),
  ];
  const out = renderHeroLine([r], sessions);
  assert.ok(out.includes('measured'), `expected delta in: ${out}`);
  assert.ok(out.includes('cache hit'), `expected cache suffix in: ${out}`);
  // cache suffix should come after delta
  assert.ok(out.indexOf('measured') < out.indexOf('cache hit'), 'delta must precede cache suffix');
});
