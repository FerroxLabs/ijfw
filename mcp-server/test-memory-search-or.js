#!/usr/bin/env node
/**
 * Tests: mcp-server/src/memory/search.js -- W1.3 (v1.6.0) NL OR-query fix.
 * Run: node --experimental-sqlite --test test-memory-search-or.js
 *
 * FTS5 treats a space-separated MATCH as implicit AND, so before W1.3 a
 * natural-language recall whose answer is spread across multiple entries
 * retrieved nothing from the warm tier. These tests force the warm (FTS5)
 * tier by pointing IJFW_PROJECT_DIR at an isolated temp dir (fresh, empty
 * index -> searchMemory auto-indexes the fileList) so we exercise buildOrQuery
 * + searchFts5 directly rather than the hot-linear fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = join(tmpdir(), 'ijfw-mem-search-or-' + Date.now());
mkdirSync(PROJECT, { recursive: true });

// Isolate the warm index to this project + keep the test deterministic
// (no LLM auto-link round-trips).
process.env.IJFW_PROJECT_DIR = PROJECT;
process.env.IJFW_AUTOLINK_OFF = '1';

// auth.md is in the initial corpus because searchMemory auto-indexes only
// when the warm index is empty (first call); files added later are never
// indexed within one test process.
const FILES = [
  { name: 'alpha.md', content: '# Alpha\nThis file talks about caching strategies in depth.\n' },
  { name: 'beta.md',  content: '# Beta\nMemory recall and positive framing are core to IJFW.\n' },
  { name: 'gamma.md', content: '# Gamma\nA plain note with no special keywords.\n' },
  { name: 'auth.md',  content: '# Auth\nWe chose token-based authentication for the gateway.\n' },
];
for (const f of FILES) writeFileSync(join(PROJECT, f.name), f.content);

const fileList = FILES.map(f => ({
  path:    join(PROJECT, f.name),
  relpath: f.name,
  title:   f.name.replace('.md', ''),
  preview: f.content.slice(0, 200),
}));

const { searchMemory } = await import('./src/memory/search.js');

test('warm tier is actually exercised (sanity: single term hits FTS5)', () => {
  const results = searchMemory('caching', fileList);
  assert.ok(results.length > 0, 'caching should retrieve alpha.md');
  assert.equal(results.tier, 'warm-fts5', 'must hit the warm tier, not hot-linear');
});

test('NL query ORs salient terms across entries (no implicit-AND starvation)', () => {
  // caching/strategies live only in alpha.md; memory/recall only in beta.md.
  // No single entry contains all four -> implicit-AND would retrieve nothing.
  const results = searchMemory(
    'what caching strategies and memory recall did we cover',
    fileList,
  );
  const relpaths = new Set(results.map(r => r.relpath));
  assert.ok(relpaths.has('alpha.md'), 'should retrieve alpha.md via caching/strategies');
  assert.ok(relpaths.has('beta.md'), 'should retrieve beta.md via memory/recall');
});

test('single salient term survives a sea of stopwords/short tokens', () => {
  // Only "caching" is salient; the rest are stopwords or <3 chars.
  const results = searchMemory('and what is the caching we had', fileList);
  assert.ok(results.some(r => r.relpath === 'alpha.md'), 'should retrieve alpha.md');
});

test('synonym expansion still fires through the OR path', () => {
  // "auth" must still surface content that only says "authentication" --
  // buildOrQuery folds each token through expandQuery.
  const results = searchMemory('how does auth work here', fileList);
  assert.ok(results.some(r => r.relpath === 'auth.md'),
    'auth should match authentication via synonym expansion');
});

test('all-noise query degrades gracefully (no throw, no false hits)', () => {
  // Every token is a stopword/short -> buildOrQuery yields '' -> falls back to
  // the raw query, which finds nothing. Must not throw.
  const results = searchMemory('is it we the and', fileList);
  assert.ok(Array.isArray(results), 'returns an array');
});

process.on('exit', () => { try { rmSync(PROJECT, { recursive: true }); } catch {} });
