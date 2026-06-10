import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = resolve(ROOT, 'scripts/bench/master-analysis.mjs');
const OUT = '/tmp/ma-cli-test.md';
const CELLS_GLOB = resolve(ROOT, 'test/fixtures/cells/**/cell.json');

test('master-analysis CLI: produces markdown with all four section headers', () => {
  execFileSync(process.execPath, [CLI, '--cells', CELLS_GLOB, '--out', OUT], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  const md = readFileSync(OUT, 'utf8');

  assert.ok(md.includes('## Accuracy'), 'missing ## Accuracy');
  assert.ok(md.includes('## Cost frontier'), 'missing ## Cost frontier');
  assert.ok(md.includes('## Retrieval grounding'), 'missing ## Retrieval grounding');
  assert.ok(md.includes('## Reliability'), 'missing ## Reliability');
});

test('master-analysis CLI: at least one > source: footnote', () => {
  const md = readFileSync(OUT, 'utf8');
  assert.ok(md.includes('> source:'), 'missing > source: footnote');
});

test('master-analysis CLI: contains system names sysA and sysB', () => {
  const md = readFileSync(OUT, 'utf8');
  assert.ok(md.includes('sysA'), 'missing sysA');
  assert.ok(md.includes('sysB'), 'missing sysB');
});

test('master-analysis CLI: prints output path to stdout', () => {
  const stdout = execFileSync(process.execPath, [CLI, '--cells', CELLS_GLOB, '--out', OUT], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.ok(stdout.trim().length > 0, 'stdout should contain out path');
  assert.ok(stdout.includes(OUT) || stdout.includes('ma-cli-test'), 'stdout should mention output path');
});
