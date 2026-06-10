#!/usr/bin/env node
/**
 * run-functional-smoke.mjs — the FUNCTIONAL-SMOKE RELEASE GATE.
 *
 * Discovers and runs every `functional-smoke*.mjs` harness in this directory
 * SEQUENTIALLY (they spawn the MCP server / bind dashboard sockets, so parallel
 * runs would contend on ports), then aggregates pass/fail and exits non-zero if
 * ANY harness fails.
 *
 * Why this is a release gate: IJFW's unit/`--help`/route tests assert PARSE +
 * DISPATCH shape, not real behaviour — which let memory recall, the dashboard,
 * the workflow surface, doctor, and cross-audit ship SILENTLY BROKEN while every
 * unit test stayed green. The functional smokes drive each feature end-to-end
 * through its REAL interface. Folding them into the ship gate makes "green"
 * finally mean "the product works".
 *
 *   node scripts/run-functional-smoke.mjs            # run all
 *   node scripts/run-functional-smoke.mjs --list     # list discovered harnesses
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

// Discover sibling harnesses: functional-smoke.mjs + functional-smoke-*.mjs.
// Exclude this runner itself. Stable alphabetical order for reproducibility.
const harnesses = readdirSync(__dirname)
  .filter(f => /^functional-smoke.*\.mjs$/.test(f) && f !== SELF)
  .sort();

if (process.argv.includes('--list')) {
  console.log(harnesses.join('\n'));
  process.exit(0);
}

if (harnesses.length === 0) {
  console.error('run-functional-smoke: no functional-smoke*.mjs harnesses found');
  process.exit(1);
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(process.execPath, [join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', (code) => {
      resolve({ file, code: code == null ? 1 : code, ms: Date.now() - started, out });
    });
    proc.on('error', (err) => {
      resolve({ file, code: 1, ms: Date.now() - started, out: `spawn error: ${err.message}` });
    });
  });
}

console.log(`=== functional-smoke gate: ${harnesses.length} harness(es) ===\n`);
const results = [];
for (const file of harnesses) {
  process.stdout.write(`-> ${file} ... `);
  const r = await runOne(file);          // sequential on purpose (port contention)
  results.push(r);
  // Surface the harness's own WORKS/BROKEN tally line if present.
  const tally = (r.out.match(/^=== .*(?:WORKS|pass|PASS).*===$/m) || [])[0] || '';
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} (${r.ms}ms)${tally ? '  ' + tally.replace(/^=== | ===$/g, '') : ''}`);
  if (r.code !== 0) {
    // On failure, dump the harness output so the gate is debuggable in CI logs.
    console.log('   --- harness output ---');
    console.log(r.out.split('\n').map(l => '   ' + l).join('\n'));
  }
}

const failed = results.filter(r => r.code !== 0);
console.log(`\n=== functional-smoke gate: ${results.length - failed.length}/${results.length} harnesses PASS ===`);
if (failed.length) {
  console.log('FAILED harnesses:');
  for (const f of failed) console.log(`  - ${f.file} (exit ${f.code})`);
  process.exit(1);
}
process.exit(0);
