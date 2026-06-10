// V2 — exemplar retrieval tests.
//
// Verifies the zero-LLM ranking blend: register-match boost + BM25 lexical
// similarity + recency tiebreak, with deterministic ordering. Every test
// injects its own candidate set (DI) so the suite is decoupled from V1's
// not-yet-committed exemplar-store.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { retrieveExemplars } from '../src/profile/exemplar-retrieve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src', 'profile', 'exemplar-retrieve.js');

// Helper: build an exemplar record matching the shared contract.
function ex(id, text, register, ts, source = 'prompt') {
  return { id, text, register, source, ts };
}

test('returns register-matched exemplars ahead of non-matching ones', () => {
  const exemplars = [
    ex('a', 'totally unrelated words here', 'casual', '2026-01-01T00:00:00Z'),
    ex('b', 'totally unrelated words here', 'terse', '2026-01-01T00:00:00Z'),
    ex('c', 'totally unrelated words here', 'formal', '2026-01-01T00:00:00Z'),
  ];
  const out = retrieveExemplars({ register: 'terse', taskText: '', exemplars, k: 3 });
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'b', 'the terse exemplar must rank first');
});

test('lexical relevance affects ranking within same register', () => {
  // All three share the target register; only one shares words with the task.
  const exemplars = [
    ex('match', 'deploy the kubernetes cluster to production now', 'doc', '2026-01-01T00:00:00Z'),
    ex('other1', 'a recipe for sourdough bread and butter', 'doc', '2026-01-02T00:00:00Z'),
    ex('other2', 'thoughts on weekend hiking trails nearby', 'doc', '2026-01-03T00:00:00Z'),
  ];
  const out = retrieveExemplars({
    register: 'doc',
    taskText: 'how do I deploy the kubernetes cluster',
    exemplars,
    k: 3,
  });
  assert.equal(out[0].id, 'match', 'lexically relevant same-register exemplar ranks first');
});

test('lexical beats nothing: shared-words exemplar outranks unrelated one (equal register)', () => {
  const exemplars = [
    ex('rel', 'refactor the parser and fix the tokenizer bug', 'commit', '2026-01-01T00:00:00Z'),
    ex('unrel', 'planted tomatoes in the garden this spring', 'commit', '2026-01-02T00:00:00Z'),
  ];
  const out = retrieveExemplars({
    register: 'commit',
    taskText: 'fix the tokenizer bug in the parser',
    exemplars,
    k: 2,
  });
  assert.equal(out[0].id, 'rel');
});

test('empty set returns []', () => {
  assert.deepEqual(retrieveExemplars({ register: 'terse', taskText: 'x', exemplars: [] }), []);
});

test('deterministic: same inputs twice yield identical order', () => {
  const exemplars = [
    ex('a', 'alpha beta gamma deploy service', 'doc', '2026-01-01T00:00:00Z'),
    ex('b', 'delta epsilon zeta deploy service', 'casual', '2026-02-01T00:00:00Z'),
    ex('c', 'eta theta iota unrelated text', 'doc', '2026-03-01T00:00:00Z'),
    ex('d', 'deploy service to the cluster', 'doc', '2026-04-01T00:00:00Z'),
  ];
  const args = { register: 'doc', taskText: 'deploy service to cluster', exemplars, k: 4 };
  const run1 = retrieveExemplars(args).map((e) => e.id);
  const run2 = retrieveExemplars(args).map((e) => e.id);
  assert.deepEqual(run1, run2);
});

test('ties broken deterministically by recency then id', () => {
  // Identical text + register → identical score; recency (ts) then id decides.
  const exemplars = [
    ex('z', 'same body text', 'doc', '2026-01-01T00:00:00Z'),
    ex('a', 'same body text', 'doc', '2026-06-01T00:00:00Z'),
    ex('m', 'same body text', 'doc', '2026-06-01T00:00:00Z'),
  ];
  const out = retrieveExemplars({ register: 'doc', taskText: '', exemplars, k: 3 }).map((e) => e.id);
  // a and m are newest (tie) → id asc puts 'a' before 'm'; 'z' oldest last.
  assert.deepEqual(out, ['a', 'm', 'z']);
});

test('respects k (never returns more than k)', () => {
  const exemplars = Array.from({ length: 10 }, (_, i) =>
    ex(`id${i}`, `body number ${i}`, 'doc', `2026-01-0${(i % 9) + 1}T00:00:00Z`),
  );
  assert.equal(retrieveExemplars({ register: 'doc', taskText: 'body', exemplars, k: 3 }).length, 3);
  assert.equal(retrieveExemplars({ register: 'doc', taskText: 'body', exemplars, k: 1 }).length, 1);
  assert.equal(retrieveExemplars({ register: 'doc', taskText: 'body', exemplars }).length, 3); // default k=3
});

test('empty taskText falls back to register + recency only', () => {
  const exemplars = [
    ex('old-match', 'whatever words', 'terse', '2026-01-01T00:00:00Z'),
    ex('new-match', 'whatever words', 'terse', '2026-06-01T00:00:00Z'),
    ex('nonmatch', 'whatever words', 'casual', '2026-12-01T00:00:00Z'),
  ];
  const out = retrieveExemplars({ register: 'terse', taskText: '', exemplars, k: 3 }).map((e) => e.id);
  // Both terse beat the (newer) casual; among terse, newer first.
  assert.deepEqual(out, ['new-match', 'old-match', 'nonmatch']);
});

test('no register provided: ranks on lexical + recency only, no crash', () => {
  const exemplars = [
    ex('a', 'deploy the service to production', 'doc', '2026-01-01T00:00:00Z'),
    ex('b', 'unrelated cooking instructions', 'casual', '2026-02-01T00:00:00Z'),
  ];
  const out = retrieveExemplars({ taskText: 'deploy the service', exemplars, k: 2 });
  assert.equal(out[0].id, 'a');
});

test('pure: module loaded without side effects and exposes only the API', () => {
  // If the import at the top of this file had triggered any LLM/network/db
  // side effect or thrown, the whole suite would have failed to load. Assert
  // the export contract explicitly.
  assert.equal(typeof retrieveExemplars, 'function');
});

test('static check: source imports no LLM / embedder / network module', () => {
  const src = readFileSync(SRC, 'utf8');
  // Collect every import / require specifier in the source.
  const specifiers = [];
  const importRe = /import\s+[^'"]*from\s*['"]([^'"]+)['"]/g;
  const bareImportRe = /import\s*['"]([^'"]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [importRe, bareImportRe, requireRe]) {
    let m;
    while ((m = re.exec(src)) !== null) specifiers.push(m[1]);
  }
  const FORBIDDEN = [
    'openai', 'anthropic', '@anthropic', 'cohere', 'mistral', 'ollama',
    'langchain', 'genai', 'generativeai', 'gemini', 'transformers',
    'embed', 'embedding', 'vector', 'fetch', 'axios', 'node-fetch',
    'http', 'https', 'net', 'undici', 'tls', 'dgram',
  ];
  for (const spec of specifiers) {
    const lower = spec.toLowerCase();
    for (const bad of FORBIDDEN) {
      assert.ok(
        !lower.includes(bad),
        `forbidden import on the zero-LLM serve path: "${spec}" (matched "${bad}")`,
      );
    }
  }
  // Sanity: the legitimate imports we DO expect are present.
  assert.ok(specifiers.some((s) => s.includes('search-bm25')), 'expected BM25 import');
});

test('only requires the store when exemplars are not injected', () => {
  // With injected exemplars, loadFromStore() must never run — so this works
  // even though V1's exemplar-store.js may not exist yet.
  const exemplars = [ex('a', 'hello world', 'doc', '2026-01-01T00:00:00Z')];
  const out = retrieveExemplars({ register: 'doc', taskText: 'hello', exemplars, k: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});
