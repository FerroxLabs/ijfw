// Tests for src/lib/tmp-suffix.js
//
// Covers:
//   - default shape: pid + 16 hex chars (8 bytes)
//   - explicit bytes opt: 4 bytes => 8 hex chars
//   - includePid:false strips the pid prefix
//   - tmpPathFor composes `${target}.tmp.${suffix}` shape
//   - uniqueness: 1000 calls yield 1000 distinct suffixes

import assert from 'node:assert/strict';
import { tmpSuffix, tmpPathFor } from './src/lib/tmp-suffix.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    failed++;
  }
}

test('default suffix shape: <pid>.<16-hex>', () => {
  const s = tmpSuffix();
  const m = s.match(/^(\d+)\.([0-9a-f]{16})$/);
  assert.ok(m, `suffix did not match pattern: ${s}`);
  assert.equal(Number(m[1]), process.pid);
});

test('bytes:4 yields 8 hex chars', () => {
  const s = tmpSuffix({ bytes: 4 });
  const m = s.match(/^(\d+)\.([0-9a-f]{8})$/);
  assert.ok(m, `suffix did not match 4-byte pattern: ${s}`);
});

test('includePid:false strips the pid prefix', () => {
  const s = tmpSuffix({ includePid: false });
  assert.ok(/^[0-9a-f]{16}$/.test(s), `expected pure hex, got ${s}`);
});

test('tmpPathFor composes target + .tmp. + suffix', () => {
  const p = tmpPathFor('/tmp/example.json');
  assert.ok(p.startsWith('/tmp/example.json.tmp.'), `unexpected path: ${p}`);
  const tail = p.slice('/tmp/example.json.tmp.'.length);
  assert.ok(/^\d+\.[0-9a-f]{16}$/.test(tail), `unexpected tail: ${tail}`);
});

test('uniqueness over 1000 calls', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(tmpSuffix());
  assert.equal(seen.size, 1000, `collisions in 1000 calls (got ${seen.size})`);
});

test('bytes:0 falls back to default (8)', () => {
  const s = tmpSuffix({ bytes: 0 });
  const m = s.match(/^(\d+)\.([0-9a-f]{16})$/);
  assert.ok(m, `bytes:0 should fall back to default 8 bytes; got ${s}`);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
