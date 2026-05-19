// H5.5 — fact extractor tests.
//
// Coverage: each pattern type fires, empty input is a no-op, no-match input
// returns [], and intra-call dedup collapses overlapping pattern matches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, factToJsonl } from './src/memory/fact-extractor.js';

test('extractFacts: empty input returns []', () => {
  assert.deepEqual(extractFacts(''), []);
  assert.deepEqual(extractFacts('   \n\n  '), []);
  assert.deepEqual(extractFacts(null), []);
  assert.deepEqual(extractFacts(undefined), []);
  assert.deepEqual(extractFacts(42), []);
});

test('extractFacts: pure prose with no patterns returns []', () => {
  const text = 'hello there friend, how was your weekend';
  assert.deepEqual(extractFacts(text), []);
});

test('extractFacts: extracts ship date with high confidence', () => {
  const facts = extractFacts('ship date: 2026-06-01');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].subject, 'project');
  assert.equal(facts[0].predicate, 'ship_date');
  assert.equal(facts[0].object, '2026-06-01');
  assert.ok(facts[0].confidence >= 0.9);
});

test('extractFacts: extracts owner: name with high confidence', () => {
  const facts = extractFacts('owner: Sean Donahoe');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].predicate, 'owner');
  assert.equal(facts[0].object, 'Sean Donahoe');
  assert.ok(facts[0].confidence >= 0.9);
});

test('extractFacts: extracts decided to <verb> phrase', () => {
  const facts = extractFacts('We decided to use Postgres for the warm tier');
  // Should fire the "decided to" pattern with confidence ~0.85.
  const dec = facts.find(f => f.predicate === 'decided_to');
  assert.ok(dec, 'expected a decided_to fact');
  assert.match(dec.object, /use Postgres/);
  assert.ok(dec.confidence >= 0.8);
});

test('extractFacts: extracts "<Name> uses <Tool>" with capitalised both ends', () => {
  const facts = extractFacts('IJFW uses SQLite for the warm tier');
  const usesFact = facts.find(f => f.predicate === 'uses');
  assert.ok(usesFact, 'expected a uses fact');
  assert.equal(usesFact.subject, 'IJFW');
  assert.match(usesFact.object, /SQLite/);
});

test('extractFacts: extracts "<X> is <Y>" copular sentences', () => {
  const facts = extractFacts('Sean is helpful');
  const isFact = facts.find(f => f.predicate === 'is');
  assert.ok(isFact, 'expected an is-fact');
  assert.equal(isFact.subject, 'Sean');
});

test('extractFacts: skips pronoun subjects in is-pattern', () => {
  // "It is fine" / "This is broken" should NOT extract a fact.
  const facts = extractFacts('It is fine\nThis is broken\nThey are gone');
  const pronoun = facts.find(f => /^(it|this|that|they)$/i.test(f.subject));
  assert.equal(pronoun, undefined, 'pronouns must not become subjects');
});

test('extractFacts: dedups overlapping pattern matches', () => {
  // Same fact stated twice should collapse to one entry.
  const facts = extractFacts('owner: Sean\nowner: Sean');
  assert.equal(facts.length, 1, 'identical fact lines must dedup');
});

test('extractFacts: caps output at MAX_FACTS_PER_CALL', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`owner: person${i}`);
  const facts = extractFacts(lines.join('\n'));
  assert.ok(facts.length <= 64, `expected <= 64 facts, got ${facts.length}`);
});

test('factToJsonl: serializes one fact as JSON line', () => {
  const line = factToJsonl(
    { subject: 'project', predicate: 'owner', object: 'Sean', confidence: 0.95 },
    { ts: '2026-05-19T00:00:00.000Z', memory_id: 'm-abc', source: 'memory_store' }
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.subject, 'project');
  assert.equal(parsed.predicate, 'owner');
  assert.equal(parsed.object, 'Sean');
  assert.equal(parsed.confidence, 0.95);
  assert.equal(parsed.memory_id, 'm-abc');
  assert.equal(parsed.source, 'memory_store');
  assert.equal(parsed.ts, '2026-05-19T00:00:00.000Z');
});
