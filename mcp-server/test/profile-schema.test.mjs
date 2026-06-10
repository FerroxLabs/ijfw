// P0.1 — Schema atom + (de)serialization.
//
// Covers: Inference/UserProfile factories, markdown+YAML-frontmatter
// round-trip identity, unknown-field tolerance, schema_version always present.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  makeInference,
  makeProfile,
  serializeProfile,
  parseProfile,
  STYLE_AXES,
} from '../src/profile/schema.js';

test('makeInference fills the full atom with defaults', () => {
  const inf = makeInference({ kind: 'preference', subject: 'tests', value: 'TDD' });
  assert.equal(inf.kind, 'preference');
  assert.equal(inf.subject, 'tests');
  assert.equal(inf.value, 'TDD');
  assert.ok(typeof inf.confidence === 'number' && inf.confidence >= 0 && inf.confidence <= 1);
  assert.equal(inf.evidence_count, 0);
  assert.equal(typeof inf.last_confirmed, 'string'); // ISO8601
  assert.ok(Array.isArray(inf.source_sessions));
  assert.ok(Array.isArray(inf.source_hosts));
  assert.ok(['low', 'med', 'high'].includes(inf.sensitivity));
  // stable id derived from kind+subject so dedupe is possible
  assert.equal(typeof inf.id, 'string');
  assert.ok(inf.id.length > 0);
});

test('makeInference rejects an invalid sensitivity', () => {
  assert.throws(() => makeInference({ kind: 'k', subject: 's', value: 'v', sensitivity: 'nope' }));
});

test('makeProfile produces the partitioned schema with all four style axes', () => {
  const p = makeProfile();
  assert.equal(p.schema_version, SCHEMA_VERSION);
  assert.ok(p.global && p.global.style);
  for (const axis of STYLE_AXES) {
    const a = p.global.style[axis];
    assert.ok(a, `axis ${axis} present`);
    assert.equal(typeof a.ema, 'number');
    assert.equal(typeof a.alpha, 'number'); // Beta(alpha,beta)
    assert.equal(typeof a.beta, 'number');
  }
  assert.ok(Array.isArray(p.global.dialectic));
  assert.ok(p.overlays && typeof p.overlays === 'object');
  assert.ok(p.expertise && typeof p.expertise === 'object');
  assert.ok(p.provenance && typeof p.provenance === 'object');
  assert.ok('egress_log_ref' in p);
});

test('serialize -> parse is an identity round-trip', () => {
  const p = makeProfile();
  p.global.style.terseness.ema = 0.73;
  p.global.style.terseness.alpha = 4;
  p.global.style.terseness.beta = 2;
  p.global.dialectic.push(makeInference({
    kind: 'trait', subject: 'communication', value: 'terse', confidence: 0.78,
    evidence_count: 12, source_sessions: ['s1', 's2'], source_hosts: ['claude'],
    sensitivity: 'med',
  }));
  p.overlays['project:ijfw'] = { style: { terseness: { ema: 0.9, alpha: 3, beta: 1 } } };
  p.expertise.rust = { wilsonLB: 0.61, n: 9, accepts: 7 };
  p.provenance.created = '2026-06-07T00:00:00.000Z';

  const text = serializeProfile(p);
  assert.ok(text.startsWith('---\n'), 'has YAML frontmatter');
  assert.match(text, /schema_version:/);

  const back = parseProfile(text);
  assert.deepEqual(back, p);
});

test('parse tolerates unknown fields without dropping known ones', () => {
  const p = makeProfile();
  p.future_field = { something: 'new' };
  p.global.future_axis = 'preserved';
  const back = parseProfile(serializeProfile(p));
  assert.equal(back.future_field.something, 'new');
  assert.equal(back.global.future_axis, 'preserved');
  assert.equal(back.schema_version, SCHEMA_VERSION);
});

test('parse always yields a schema_version even if missing in input', () => {
  // a hand-edited file with no schema_version frontmatter still parses, and
  // gets a schema_version stamped (forward-compat / never-undefined invariant).
  const body = '---\nfoo: bar\n---\n\n```json\n{"global":{"style":{}}}\n```\n';
  const back = parseProfile(body);
  assert.equal(back.schema_version, SCHEMA_VERSION);
  assert.ok(back.global);
});

test('parseProfile throws on structurally unrecoverable input', () => {
  assert.throws(() => parseProfile('not a profile at all, no json block'));
});
