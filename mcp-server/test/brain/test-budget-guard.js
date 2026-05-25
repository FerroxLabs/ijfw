import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveMaxTokens, BudgetGuard } from '../../src/brain/budget-guard.js';

function freshRoot() { return mkdtempSync(join(tmpdir(), 'brain-budget-')); }

test('deriveMaxTokens: scales with remaining usd / price', () => {
  // $0.50 / $1.50 per Mtok output ≈ 333,333 raw → clamps to 8000
  assert.equal(deriveMaxTokens({ remainingUsd: 0.50, outputPricePerMtok: 1.50 }), 8000);
  // $0.001 / $1.50 per Mtok = 666 raw → returned as-is
  assert.equal(deriveMaxTokens({ remainingUsd: 0.001, outputPricePerMtok: 1.50 }), 666);
  // Zero budget → MIN_TOKENS
  assert.equal(deriveMaxTokens({ remainingUsd: 0, outputPricePerMtok: 1.50 }), 1);
});

test('BudgetGuard: defaults from env or hardcoded fallback', () => {
  const root = freshRoot();
  try {
    const g = BudgetGuard({ repoRoot: root, env: {} });
    assert.equal(g._caps.cycle, 0.50);
    assert.equal(g._caps.day, 5.00);
    const g2 = BudgetGuard({ repoRoot: root, env: { IJFW_DREAM_BUDGET_USD: '2.0', IJFW_DREAM_BUDGET_DAY_USD: '20' } });
    assert.equal(g2._caps.cycle, 2.0);
    assert.equal(g2._caps.day, 20);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BudgetGuard.record persists to .ijfw/metrics/brain-spend.jsonl', () => {
  const root = freshRoot();
  try {
    const g = BudgetGuard({ repoRoot: root, cycleId: 'c1', env: {} });
    g.record(0.10);
    g.record(0.05);
    const g2 = BudgetGuard({ repoRoot: root, cycleId: 'c1', env: {} });
    assert.ok(Math.abs(g2.remaining().cycle - (0.50 - 0.15)) < 1e-9);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BudgetGuard.guardCall caps maxTokens by remaining budget', () => {
  const root = freshRoot();
  try {
    const g = BudgetGuard({ repoRoot: root, env: {}, cycleUsd: 0.001, dayUsd: 1.0 });
    const r = g.guardCall({ outputPricePerMtok: 1.50, requestedMaxTokens: 4000 });
    assert.equal(r.allowed, true);
    assert.ok(r.maxTokens < 4000, `expected <4000, got ${r.maxTokens}`);
    assert.equal(r.maxTokens, 666);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BudgetGuard.guardCall returns allowed:false when fully exhausted', () => {
  const root = freshRoot();
  try {
    const g = BudgetGuard({ repoRoot: root, env: {}, cycleUsd: 0.001, dayUsd: 5.0 });
    g.record(0.001);
    const r = g.guardCall({ outputPricePerMtok: 1.5, requestedMaxTokens: 1000 });
    assert.equal(r.allowed, false);
    assert.equal(r.maxTokens, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
