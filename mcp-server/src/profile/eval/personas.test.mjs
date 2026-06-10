// Gate B v2 — Task T3: persona loaders. Real authors (document-disjoint train/test,
// seed-only selection) + synthetic (downgrade-only). The selection-bias guard is the
// load-bearing test: persona order must NOT depend on the authorship distance under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAuthorDocs, makePersona, loadRealPersonas,
} from './real-personas.mjs';
import { makePersonas, generatePersonaText } from './synthetic-personas.js';
import { fullStyleVector, fullStyleDistance } from './stylometry.js';

const SMALL = { minTrainTokens: 15, minTestTokens: 8, seed: 1 };

function makeAuthor(id, variant) {
  // 4 unique docs, ~13 tokens each — clears the small floors with a disjoint split.
  return {
    id,
    docs: Array.from({ length: 4 }, (_, i) => `${variant} document number ${i} with several extra filler words placed here to clear the token floor.`),
  };
}

test('splitAuthorDocs produces DISJOINT train/test slices that clear the floors', () => {
  const a = makeAuthor('a', 'alpha');
  const s = splitAuthorDocs(a, SMALL);
  assert.ok(s.trainTokens >= SMALL.minTrainTokens);
  assert.ok(s.testTokens >= SMALL.minTestTokens);
  const inter = s.trainDocs.filter((d) => s.testDocs.includes(d));
  assert.equal(inter.length, 0, 'no document appears in both slices');
  assert.ok(s.trainDocs.length + s.testDocs.length === 4, 'every doc allocated exactly once');
});

test('makePersona THROWS on an author too short to split with power', () => {
  const tiny = { id: 'tiny', docs: ['hi there', 'ok then'] };
  assert.throws(() => makePersona(tiny, SMALL), /too short|< \d+ tokens/);
});

test('persona.fingerprint is the held-out TEST fingerprint (not train)', () => {
  const p = makePersona(makeAuthor('a', 'alpha'), SMALL);
  assert.equal(p.fingerprint.__full, true);
  const fromTest = fullStyleVector(p.testDocs.join('\n'));
  assert.equal(fullStyleDistance(p.fingerprint, fromTest), 0, 'fingerprint == fullStyleVector(testDocs)');
  assert.equal(p.synthetic, false);
  assert.equal(p.headlineEligible, true);
});

test('SELECTION-BIAS GUARD: persona order is a pure function of seed, not of content/distance', () => {
  const ids = ['zeta', 'alpha', 'mike', 'delta'];
  const corpusA = ids.map((id) => makeAuthor(id, 'alpha-content'));
  // SAME ids, DIFFERENT text → different mutual fullStyleDistances
  const corpusB = ids.map((id) => makeAuthor(id, 'totally different wording entirely'));
  const orderA = loadRealPersonas(corpusA, SMALL).map((p) => p.id);
  const orderB = loadRealPersonas(corpusB, SMALL).map((p) => p.id);
  assert.deepEqual(orderA, orderB, 'identical ids ⇒ identical order regardless of content');
  // and changing the seed changes the order (it really is seed-driven)
  const orderSeed2 = loadRealPersonas(corpusA, { ...SMALL, seed: 99 }).map((p) => p.id);
  assert.notDeepEqual(orderA, orderSeed2);
});

test('loadRealPersonas THROWS (abort-and-ingest) when too few authors qualify', () => {
  const corpus = [makeAuthor('a', 'x'), { id: 'short', docs: ['too', 'short'] }];
  assert.throws(() => loadRealPersonas(corpus, { ...SMALL, nAuthors: 2 }), /ingest more authors/);
});

test('synthetic personas are stamped downgrade-only and deterministic', () => {
  const p1 = makePersonas(4, 7);
  const p2 = makePersonas(4, 7);
  assert.equal(p1.length, 4);
  for (const p of p1) {
    assert.equal(p.synthetic, true);
    assert.equal(p.headlineEligible, false);
    assert.equal(p.fingerprint.__full, true);
  }
  // deterministic by seed
  assert.deepEqual(p1.map((p) => p.testDocs), p2.map((p) => p.testDocs));
  // mutually distinct fingerprints (different archetypes/content)
  assert.ok(fullStyleDistance(p1[0].fingerprint, p1[1].fingerprint) > 0);
});

test('generatePersonaText: same style+content seed is deterministic; train/test differ', () => {
  assert.equal(generatePersonaText(0, 123, 5), generatePersonaText(0, 123, 5));
  assert.notEqual(generatePersonaText(0, 1, 5), generatePersonaText(0, 9001, 5));
});
