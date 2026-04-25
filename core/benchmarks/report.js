#!/usr/bin/env node
// Read JSONL run records, emit markdown table per research sec6.
// Usage: node report.js runs/*.jsonl

import { readFileSync } from 'node:fs';

function load(files) {
  const rows = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return rows;
}

function bucket(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.task}::${r.arm}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function pairedBootstrapDelta(a, b, iters = 2000) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { delta: 0, lo: 0, hi: 0, n: 0 };
  const diffs = [];
  for (let i = 0; i < n; i++) diffs.push(a[i] - b[i]);
  const samples = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(Math.random() * n)];
    samples.push(s / n);
  }
  samples.sort((x, y) => x - y);
  return {
    delta: mean(diffs),
    lo: samples[Math.floor(iters * 0.025)],
    hi: samples[Math.floor(iters * 0.975)],
    n,
  };
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: report.js <jsonl...>'); process.exit(1); }
  const rows = load(files);
  if (!rows.length) { console.log('_no runs_'); return; }
  const b = bucket(rows);
  const tasks = [...new Set(rows.map((r) => r.task))].sort();

  console.log('# IJFW Benchmark Report\n');
  console.log(`Runs: ${rows.length} | Tasks: ${tasks.length} | Generated: ${new Date().toISOString()}\n`);
  console.log('> Scaffold results. Wide CIs expected at n=2 epochs. Full suite in Phase 3.5.\n');

  console.log('| Task | Arm | n | mean cost | mean duration ms |');
  console.log('|------|-----|---|-----------|------------------|');
  for (const t of tasks) {
    for (const arm of ['A', 'B', 'C']) {
      const k = `${t}::${arm}`;
      const xs = b.get(k) ?? [];
      if (!xs.length) continue;
      const mc = mean(xs.map((r) => r.cost_usd || 0));
      const md = mean(xs.map((r) => r.duration_ms || 0));
      console.log(`| ${t} | ${arm} | ${xs.length} | $${mc.toFixed(4)} | ${md.toFixed(0)} |`);
    }
  }

  console.log('\n## Paired deltas (cost_usd, 95% bootstrap CI)\n');
  console.log('| Task | Contrast | delta mean | 95% CI | n |');
  console.log('|------|----------|--------|--------|---|');
  for (const t of tasks) {
    const A = (b.get(`${t}::A`) ?? []).map((r) => r.cost_usd || 0);
    const B = (b.get(`${t}::B`) ?? []).map((r) => r.cost_usd || 0);
    const C = (b.get(`${t}::C`) ?? []).map((r) => r.cost_usd || 0);
    for (const [label, x, y] of [['C-A', C, A], ['C-B', C, B], ['B-A', B, A]]) {
      const r = pairedBootstrapDelta(x, y);
      if (!r.n) continue;
      console.log(`| ${t} | ${label} | ${r.delta.toFixed(4)} | [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}] | ${r.n} |`);
    }
  }
}

main();
