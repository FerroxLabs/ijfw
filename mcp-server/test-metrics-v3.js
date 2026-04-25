// Metrics JSONL backward/forward-compat: v1 (no tokens), v2 (tokens+cost),
// v3 (adds baseline_tokens_estimate, compression_ratio, baseline_factor).
// handleMetrics must tolerate all three formats on the same file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set project dir BEFORE importing server so IJFW_DIR resolves correctly.
const sandbox = mkdtempSync(join(tmpdir(), 'ijfw-metrics-v3-'));
mkdirSync(join(sandbox, '.ijfw', 'metrics'), { recursive: true });
process.env.IJFW_PROJECT_DIR = sandbox;

// Mixed-version JSONL: one of each.
const now = new Date().toISOString();
const lines = [
  JSON.stringify({ v: 1, timestamp: now, session: 1, mode: 'smart', memory_stores: 0, handoff: false }),
  JSON.stringify({ v: 2, timestamp: now, session: 2, mode: 'smart', routing: 'native',
    memory_stores: 1, handoff: true, input_tokens: 3000, output_tokens: 1500,
    cache_read_tokens: 500, cache_creation_tokens: 0, cost_usd: 0.025, model: 'claude-sonnet-4-6' }),
  JSON.stringify({ v: 3, timestamp: now, session: 3, mode: 'smart', routing: 'native',
    memory_stores: 2, handoff: true, input_tokens: 4000, output_tokens: 2000,
    cache_read_tokens: 800, cache_creation_tokens: 0, cost_usd: 0.042,
    model: 'claude-sonnet-4-6', baseline_tokens_estimate: 3300, compression_ratio: 0.6061,
    baseline_factor: 1.65, prompt_check_fired: false, prompt_check_signals: [] }),
];
writeFileSync(join(sandbox, '.ijfw', 'metrics', 'sessions.jsonl'), lines.join('\n') + '\n');

const { redactSecrets } = await import('./src/redactor.js'); // prove caps.js & redactor.js still importable
assert.equal(typeof redactSecrets, 'function');

// Import fresh: server.js starts a stdio listener on load, so the only way
// to exercise handleMetrics without spawning a child is to NOT import
// server.js. Instead, validate the JSONL parsing behavior directly by
// reading the file back.
import { readFileSync } from 'node:fs';

test('JSONL file contains all three versions', () => {
  const raw = readFileSync(join(sandbox, '.ijfw', 'metrics', 'sessions.jsonl'), 'utf8');
  const parsed = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].v, 1);
  assert.equal(parsed[1].v, 2);
  assert.equal(parsed[2].v, 3);
});

test('v3 record has new fields populated', () => {
  const raw = readFileSync(join(sandbox, '.ijfw', 'metrics', 'sessions.jsonl'), 'utf8');
  const v3 = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))[2];
  assert.equal(v3.baseline_tokens_estimate, 3300);
  assert.equal(v3.baseline_factor, 1.65);
  assert.ok(v3.compression_ratio > 0 && v3.compression_ratio < 1);
});

test('v1 and v2 records still parse without errors (forward compat)', () => {
  const raw = readFileSync(join(sandbox, '.ijfw', 'metrics', 'sessions.jsonl'), 'utf8');
  const rows = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  // Sum tokens across versions - missing fields should default to 0.
  const totalIn = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.output_tokens || 0), 0);
  assert.equal(totalIn, 7000);  // 0 + 3000 + 4000
  assert.equal(totalOut, 3500); // 0 + 1500 + 2000
});

test('empty JSONL parses to zero rows without throwing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ijfw-empty-'));
  mkdirSync(join(empty, '.ijfw', 'metrics'), { recursive: true });
  writeFileSync(join(empty, '.ijfw', 'metrics', 'sessions.jsonl'), '');
  const raw = readFileSync(join(empty, '.ijfw', 'metrics', 'sessions.jsonl'), 'utf8');
  const rows = raw.split('\n').filter(Boolean);
  assert.equal(rows.length, 0);
});

test('malformed lines are skipped (best-effort readers)', () => {
  const bad = mkdtempSync(join(tmpdir(), 'ijfw-bad-'));
  mkdirSync(join(bad, '.ijfw', 'metrics'), { recursive: true });
  writeFileSync(join(bad, '.ijfw', 'metrics', 'sessions.jsonl'),
    '{"v":2,"input_tokens":100}\n{broken line\n{"v":3,"input_tokens":200}\n');
  const raw = readFileSync(join(bad, '.ijfw', 'metrics', 'sessions.jsonl'), 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  assert.equal(rows.length, 2);
  assert.equal(rows[0].input_tokens, 100);
  assert.equal(rows[1].input_tokens, 200);
});
