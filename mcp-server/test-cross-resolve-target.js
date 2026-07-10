import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget } from './src/cross-orchestrator-cli.js';

// Fixture dir -- one per test run, cleaned up on process exit.
const FIXTURES = mkdtempSync(join(tmpdir(), 'ijfw-resolve-target-'));
process.on('exit', () => { try { rmSync(FIXTURES, { recursive: true, force: true }); } catch {} });

test('resolveTarget: reads real file and embeds contents', () => {
  const p = join(FIXTURES, 'real.js');
  writeFileSync(p, 'function add(a, b) { return a + b; }\n');
  const out = resolveTarget(p);
  assert.match(out, /^File: .*real\.js\n\n/, 'output has File: header');
  assert.match(out, /function add\(a, b\)/, 'output contains real file body');
});

test('resolveTarget: non-existent path passes through unchanged', () => {
  const topic = 'vector search approaches';
  assert.equal(resolveTarget(topic), topic);
});

// Issue #20: valid git ranges no longer pass through verbatim — they are
// materialized to inline diff text (read-only) so auditors never need repo
// access. Materialization itself is covered in test-cross-roster-spawn.js;
// here we pin the passthrough for ranges that CANNOT resolve.
test('resolveTarget: git range passes through unchanged outside a git repo', () => {
  const range = 'HEAD~3..HEAD';
  assert.equal(resolveTarget(range, { cwd: FIXTURES }), range,
    'no repo at cwd → range cannot materialize → passthrough');
});

test('resolveTarget: unresolvable sha range passes through unchanged', () => {
  const range = 'abc1234..def5678'; // refs that exist in no repo
  assert.equal(resolveTarget(range), range);
});

test('resolveTarget: directory passes through unchanged (not a regular file)', () => {
  assert.equal(resolveTarget(FIXTURES), FIXTURES);
});

test('resolveTarget: oversize file is truncated with a marker', () => {
  const p = join(FIXTURES, 'big.js');
  const bigContent = 'x'.repeat(10 * 1024); // 10 KB
  writeFileSync(p, bigContent);
  // Force a 1 KB cap to trigger truncation
  const out = resolveTarget(p, { sizeCap: 1024 });
  assert.match(out, /^File: .*big\.js\n\n/, 'output has File: header');
  assert.match(out, /\[\.\.\. truncated: file is \d+ bytes, showing first 1024 \.\.\.\]/, 'has truncation marker');
  // The embedded contents should not exceed cap + reasonable marker overhead
  const body = out.split('\n\n').slice(1).join('\n\n');
  assert.ok(body.length < 1024 + 200, 'truncated body under cap + marker');
});

test('resolveTarget: empty or non-string input returns input', () => {
  assert.equal(resolveTarget(''), '');
  assert.equal(resolveTarget(null), null);
  assert.equal(resolveTarget(undefined), undefined);
  assert.equal(resolveTarget(42), 42);
});

test('resolveTarget: relative path resolves against cwd', () => {
  const p = join(FIXTURES, 'rel.md');
  writeFileSync(p, '# rel\n');
  // Pretend we cd'd into FIXTURES and asked for 'rel.md'
  const origCwd = process.cwd();
  try {
    process.chdir(FIXTURES);
    const out = resolveTarget('rel.md');
    assert.match(out, /^File: rel\.md\n\n/);
    assert.match(out, /# rel/);
  } finally {
    process.chdir(origCwd);
  }
});

test('issue #6 regression: bare path is never passed through if file exists', () => {
  // The exact failure mode: auditor prompt would contain just the path.
  const p = join(FIXTURES, 'issue6.js');
  const body = 'const { readFileSync } = require("fs");\n// real code\n';
  writeFileSync(p, body);
  const out = resolveTarget(p);
  assert.notEqual(out, p, 'MUST NOT equal raw path when file exists');
  assert.ok(out.includes(body), 'contents present in resolved target');
});
