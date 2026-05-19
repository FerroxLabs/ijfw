/**
 * test-cost-anomaly.js -- v1.5.0 N4.obs M4.
 *
 * Validates rolling z-score anomaly detection on the daily-cost series.
 * Zero deps, Node built-ins only.
 */

import { detectCostAnomaly } from './src/observability/cost-anomaly.js';

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok ' + label); pass++; }
  else { console.error('  FAIL ' + label + (detail !== undefined ? ' -- ' + detail : '')); fail++; }
}

// Helper: build a daily series of length n with given costs.
function series(costs) {
  const out = [];
  for (let i = 0; i < costs.length; i++) {
    const d = new Date('2026-01-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    out.push({ date: d.toISOString().slice(0, 10), cost: costs[i] });
  }
  return out;
}

console.log('\n-- 1. Empty / malformed series --');
{
  const r = detectCostAnomaly({ daily: [] });
  ok('no_data when empty', r.reason === 'no_data');
  ok('not anomalous on empty', r.anomalous === false);
}
{
  const r = detectCostAnomaly({});
  ok('no_data when daily missing', r.reason === 'no_data');
}
{
  const r = detectCostAnomaly({ daily: [{ date: 'bad', cost: 'NaN' }] });
  ok('malformed entries filtered out', r.reason === 'no_data');
}

console.log('\n-- 2. Insufficient history --');
{
  const r = detectCostAnomaly({ daily: series([10, 20]) });
  ok('insufficient_history when only 1 trailing day', r.reason === 'insufficient_history');
  ok('today still reported', r.today === 20);
  ok('not flagged anomalous', r.anomalous === false);
}

console.log('\n-- 3. Normal day (within 2σ) --');
{
  // Baseline: 10,11,9,10,11,9,10 ; today: 11 -- typical.
  const r = detectCostAnomaly({ daily: series([10, 11, 9, 10, 11, 9, 10, 11]) });
  ok('not anomalous', r.anomalous === false, JSON.stringify(r));
  ok('z is small', Math.abs(r.z) < 2);
  ok('factor near 1', r.factor > 0.9 && r.factor < 1.2);
}

console.log('\n-- 4. Spike day (3.4x baseline, z >> 2) --');
{
  const r = detectCostAnomaly({
    daily: series([10, 10, 10, 10, 10, 10, 10, 34]),
    todayDrivers: [
      { name: 'ijfw_memory_search', cost: 18 },
      { name: 'ijfw_run',           cost: 9 },
      { name: 'ijfw_metrics',       cost: 7 },
    ],
    threshold: 2.0,
  });
  ok('anomalous', r.anomalous === true, JSON.stringify(r));
  ok('factor ~3.4', r.factor > 3 && r.factor < 4);
  ok('top driver is ijfw_memory_search',
    r.topDriver && r.topDriver.name === 'ijfw_memory_search');
  ok('top driver share ~53%',
    r.topDriver && r.topDriver.sharePct >= 50 && r.topDriver.sharePct <= 55);
  ok('reason mentions top driver',
    /ijfw_memory_search/.test(r.reason),
    r.reason);
}

console.log('\n-- 5. Flat baseline (stdev = 0) -- 2x trigger --');
{
  // All baseline days = 10, today = 25 -- stdev=0 but factor=2.5 ⇒ flagged.
  const r = detectCostAnomaly({ daily: series([10, 10, 10, 10, 10, 10, 10, 25]) });
  ok('flat-baseline 2.5x flagged', r.anomalous === true, JSON.stringify(r));
  ok('z is null when stdev=0', r.z === null);
}
{
  // Flat baseline, today = 11 (1.1x) ⇒ NOT flagged.
  const r = detectCostAnomaly({ daily: series([10, 10, 10, 10, 10, 10, 10, 11]) });
  ok('flat-baseline 1.1x NOT flagged', r.anomalous === false);
}

console.log('\n-- 6. Zero baseline, non-zero today --');
{
  const r = detectCostAnomaly({ daily: series([0, 0, 0, 0, 0, 0, 0, 5]) });
  ok('zero->5 anomalous', r.anomalous === true);
  ok('reason mentions quiet stretch', /quiet/.test(r.reason));
}
{
  const r = detectCostAnomaly({ daily: series([0, 0, 0, 0, 0, 0, 0, 0]) });
  ok('all zero not anomalous', r.anomalous === false);
}

console.log('\n-- 7. Threshold override --');
{
  // With threshold=10 the same spike from test 4 should be quiet.
  const r = detectCostAnomaly({
    daily: series([10, 10, 10, 10, 10, 10, 10, 15]),
    threshold: 10,
  });
  ok('high threshold suppresses flag', r.anomalous === false);
}

console.log('\n-- 8. windowDays override --');
{
  // windowDays=3, give 4 days incl today. trailing = last 3 before today.
  const r = detectCostAnomaly({
    daily: series([10, 12, 11, 30]),
    windowDays: 3,
  });
  ok('window=3 uses 3 trailing days', r.baseline.days === 3);
  ok('window=3 still flags spike', r.anomalous === true);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
