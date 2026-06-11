/**
 * test-metrics-session-dedupe.js -- audit fix: quadratic metrics overcount.
 *
 * The Stop hook fires after EVERY assistant turn and appends one CUMULATIVE
 * row per turn (schema v5: session_id + turn). handleMetrics must take the
 * LATEST row per session_id, not sum all rows -- and must still count
 * old-format rows (no session_id) one-row-per-session as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the project dir to a temp sandbox BEFORE server.js evaluates its
// module-level PROJECT_DIR / IJFW_DIR constants.
const sandbox = mkdtempSync(join(tmpdir(), 'ijfw-metrics-dedupe-'));
process.env.IJFW_PROJECT_DIR = sandbox;

const { handleMetrics } = await import('./src/server.js');

const metricsDir = join(sandbox, '.ijfw', 'metrics');
mkdirSync(metricsDir, { recursive: true });

const TS = '2026-06-11T00:00:0';
function row(extra) {
  return JSON.stringify({ v: 1, routing: 'native', ...extra });
}

// Session A: three cumulative turns -- only turn 3 (300 in / 30 out, $0.03,
// 3 memory_stores) may count. Rows deliberately out of order to prove the
// turn counter (not file order) wins.
// Session B: single turn.
// Legacy: one old-format row without session_id -- counts as its own session.
writeFileSync(join(metricsDir, 'sessions.jsonl'), [
  row({ timestamp: `${TS}1Z`, session_id: 'A', turn: 1, input_tokens: 100, output_tokens: 10, cost_usd: 0.01, memory_stores: 1 }),
  row({ timestamp: `${TS}3Z`, session_id: 'A', turn: 3, input_tokens: 300, output_tokens: 30, cost_usd: 0.03, memory_stores: 3, handoff: true }),
  row({ timestamp: `${TS}2Z`, session_id: 'A', turn: 2, input_tokens: 200, output_tokens: 20, cost_usd: 0.02, memory_stores: 2 }),
  row({ timestamp: `${TS}4Z`, session_id: 'B', turn: 1, input_tokens: 50, output_tokens: 5, cost_usd: 0.005, memory_stores: 1 }),
  row({ timestamp: `${TS}5Z`, input_tokens: 10, output_tokens: 1, cost_usd: 0.001, memory_stores: 1 }),
].join('\n') + '\n');

test('tokens: latest row per session_id, legacy rows pass through', () => {
  const r = handleMetrics({ period: 'all', metric: 'tokens' });
  // 300 + 50 + 10 in, 30 + 5 + 1 out => 396 total tokens
  assert.match(r.text, /Total: 396 tokens \(360 in \/ 36 out/);
  // The naive all-rows sum would have been 660 in -- make sure it is gone.
  assert.doesNotMatch(r.text, /660/);
});

test('cost: sums latest-row cost only and reports 3 sessions', () => {
  const r = handleMetrics({ period: 'all', metric: 'cost' });
  assert.match(r.text, /Total: \$0\.0360 across 3 session\(s\)/);
});

test('sessions: counts 3 sessions and latest-row memory_stores', () => {
  const r = handleMetrics({ period: 'all', metric: 'sessions' });
  assert.match(r.text, /Sessions in all: 3/);
  assert.match(r.text, /Handoffs preserved: 1/);
  // 3 (A latest) + 1 (B) + 1 (legacy) = 5, not the all-rows 8.
  assert.match(r.text, /Memory entries logged: 5/);
});

test('routing: one vote per session, not per turn', () => {
  const r = handleMetrics({ period: 'all', metric: 'routing' });
  assert.match(r.text, /native: 3/);
});

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
