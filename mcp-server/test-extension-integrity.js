#!/usr/bin/env node
/**
 * test-extension-integrity.js -- IJFW 1.4.0 W4/t19
 *
 * Static, in-memory tests for canonicalise / computeIntegrity / verifyIntegrity.
 * No filesystem state, no Trident, no HOME dependency. Pure data round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalise,
  computeIntegrity,
  verifyIntegrity,
} from './src/extension-signer.js';

const INTEGRITY_HEX_RE = /^sha256:[a-f0-9]{64}$/;

function baseManifest(overrides = {}) {
  return {
    schema_version: '1.0',
    name: 'demo-ext',
    version: '1.0.0',
    type: 'skill-only',
    skills: [{ name: 'hello', file: 'skills/hello.md' }],
    permissions: { reads: ['./README.md'], writes: ['memory:write'] },
    ...overrides,
  };
}

test('computeIntegrity / verifyIntegrity round-trip is valid', () => {
  const m = computeIntegrity(baseManifest());
  assert.ok(INTEGRITY_HEX_RE.test(m.integrity), `integrity must match sha256:<64 hex>, got ${m.integrity}`);
  const v = verifyIntegrity(m);
  assert.equal(v.valid, true);
  assert.equal(v.expected, m.integrity);
  assert.equal(v.got, m.integrity);
});

test('tamper after computeIntegrity is detected', () => {
  const m = computeIntegrity(baseManifest());
  const tampered = { ...m, name: 'mutated' };
  const v = verifyIntegrity(tampered);
  assert.equal(v.valid, false);
  assert.ok(typeof v.expected === 'string' && INTEGRITY_HEX_RE.test(v.expected));
  assert.ok(typeof v.got === 'string' && INTEGRITY_HEX_RE.test(v.got));
  assert.notEqual(v.expected, v.got);
});

test('canonical: top-level key order is stable', () => {
  const a = computeIntegrity({ b: 2, a: 1, c: 3 });
  const b = computeIntegrity({ c: 3, a: 1, b: 2 });
  assert.equal(a.integrity, b.integrity);
});

test('canonical: integrity field is excluded from the hash', () => {
  const a = computeIntegrity({ a: 1 });
  // Manually set a bogus integrity field on the same body and recompute.
  const planted = computeIntegrity({ a: 1, integrity: 'sha256:' + 'f'.repeat(64) });
  assert.equal(a.integrity, planted.integrity);
});

test('canonical: nested object key order is stable', () => {
  const a = computeIntegrity({ a: { x: 1, y: 2 } });
  const b = computeIntegrity({ a: { y: 2, x: 1 } });
  assert.equal(a.integrity, b.integrity);
});

test('verifyIntegrity on manifest without integrity field returns valid:false', () => {
  const obj = baseManifest();
  // intentionally NOT computing integrity
  const v = verifyIntegrity(obj);
  assert.equal(v.valid, false);
  // got should be null when integrity field is absent
  assert.equal(v.got, null);
});

test('canonicalise is deterministic byte-for-byte across calls', () => {
  const obj = { z: [3, 2, 1], a: { q: 'hello', m: 42 }, b: true };
  const s1 = canonicalise(obj);
  const s2 = canonicalise(obj);
  assert.equal(s1, s2);
});
