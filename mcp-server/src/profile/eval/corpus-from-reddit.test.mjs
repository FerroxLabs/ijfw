// Gate B v2 — corpus-from-reddit ingest loader. Pure transform from a RAW local
// single-subreddit dump to the {id,docs} corpus loadRealPersonas wants + a disjoint
// same-register foreigner pool. The guards: fail-closed on too-few-authors / too-short
// (never silently underpower), author grouping is deterministic, the foreigner pool is
// disjoint from the persona corpus, and NO network is ever touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  groupByAuthor, ingestRedditCorpus, REDDIT_DEFAULTS,
} from './corpus-from-reddit.mjs';

// ---- fixtures: synthetic Reddit-shaped rows (no network) ----
// One long post per row; many rows per author so each author clears the doc-count + token floors.
function row(author, body, id) {
  return {
    author, body, id: id || `${author}-${Math.random().toString(36).slice(2)}`, subreddit: 'testsub',
  };
}
const LONG = 'This is a reasonably long body of text written by a real person on a forum. '
  + 'It contains several sentences so that the token floor is comfortably cleared by each document. '
  + 'People tend to ramble a bit when they post, which is convenient for stylometry. '
  + 'The quick brown fox jumped over the lazy dog while the cat watched from a distance, unimpressed.';

function makeAuthorRows(author, nDocs) {
  return Array.from({ length: nDocs }, (_, i) => row(author, `${LONG} (post ${i} by ${author})`, `${author}-${i}`));
}

function writeJsonl(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-fix-'));
  const p = path.join(dir, 'dump.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n'));
  return p;
}
function writeJson(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-fix-'));
  const p = path.join(dir, 'dump.json');
  fs.writeFileSync(p, JSON.stringify(rows));
  return p;
}

// 10 authors x 6 long docs each — comfortably over the floors.
function tenAuthors() {
  const rows = [];
  for (let a = 0; a < 10; a += 1) rows.push(...makeAuthorRows(`u${a}`, 6));
  return rows;
}
// Fixtures use small docs; pass a fixture-scaled token floor (production default = 1800).
const FIX = { minTokensPerAuthor: 200 };

test('groupByAuthor: groups rows into {id,docs}, drops deleted/bot/empty authors', () => {
  const rows = [
    row('alice', 'hello world one'), row('alice', 'hello world two'),
    row('[deleted]', 'should be dropped'), row('AutoModerator', 'bot post'),
    row('', 'empty author'), row('bob', 'a post by bob'),
  ];
  // minTokensPerAuthor:0 + minDocsPerAuthor:1 isolates the AUTHOR-dropping behavior under test.
  const grouped = groupByAuthor(rows, { minTokensPerAuthor: 0, minDocsPerAuthor: 1, minBodyChars: 1 });
  const ids = grouped.map((g) => g.id).sort();
  assert.deepEqual(ids, ['alice', 'bob']);
  assert.equal(grouped.find((g) => g.id === 'alice').docs.length, 2);
});

test('ingest emits the {id,docs} corpus shape loadRealPersonas consumes', () => {
  const p = writeJsonl(tenAuthors());
  const { corpus } = ingestRedditCorpus(p, { nPersonaAuthors: 4, nForeignAuthors: 4, ...FIX });
  assert.ok(Array.isArray(corpus) && corpus.length === 4);
  for (const author of corpus) {
    assert.ok(typeof author.id === 'string' && author.id.length > 0);
    assert.ok(Array.isArray(author.docs) && author.docs.length >= REDDIT_DEFAULTS.minDocsPerAuthor);
    assert.ok(author.docs.every((d) => typeof d === 'string'));
  }
});

test('foreigner pool is DISJOINT from the persona corpus', () => {
  const p = writeJsonl(tenAuthors());
  const { corpus, foreigners } = ingestRedditCorpus(p, { nPersonaAuthors: 4, nForeignAuthors: 4, ...FIX });
  const cIds = new Set(corpus.map((a) => a.id));
  const fIds = new Set(foreigners.map((a) => a.id));
  for (const id of fIds) assert.ok(!cIds.has(id), `foreigner ${id} must not be a persona`);
  assert.equal(foreigners.length, 4);
});

test('accepts a JSON-array dump as well as JSONL', () => {
  const p = writeJson(tenAuthors());
  const { corpus } = ingestRedditCorpus(p, { nPersonaAuthors: 3, nForeignAuthors: 3, ...FIX });
  assert.equal(corpus.length, 3);
});

test('FAIL-CLOSED: too few qualifying authors THROWS (never silently underpowers)', () => {
  const rows = [...makeAuthorRows('only1', 6), ...makeAuthorRows('only2', 6)];
  const p = writeJsonl(rows);
  assert.throws(
    () => ingestRedditCorpus(p, { nPersonaAuthors: 4, nForeignAuthors: 4, ...FIX }),
    /qualifying authors|too few/i,
  );
});

test('FAIL-CLOSED: authors below the doc-count floor are dropped, not padded', () => {
  // u_short has only 1 doc (< minDocsPerAuthor) → must not appear
  const rows = [...tenAuthors(), row('u_short', LONG)];
  const p = writeJsonl(rows);
  const { corpus, foreigners } = ingestRedditCorpus(p, { nPersonaAuthors: 5, nForeignAuthors: 5, ...FIX });
  const all = new Set([...corpus, ...foreigners].map((a) => a.id));
  assert.ok(!all.has('u_short'), 'under-floor author excluded');
});

test('FAIL-CLOSED: a missing dump file THROWS', () => {
  assert.throws(() => ingestRedditCorpus('/no/such/dump.jsonl', {}), /ENOENT|not found|read/i);
});

test('selection is deterministic for a fixed seed (same authors, same order)', () => {
  const p = writeJsonl(tenAuthors());
  const a = ingestRedditCorpus(p, { nPersonaAuthors: 4, nForeignAuthors: 3, seed: 7, ...FIX });
  const b = ingestRedditCorpus(p, { nPersonaAuthors: 4, nForeignAuthors: 3, seed: 7, ...FIX });
  assert.deepEqual(a.corpus.map((x) => x.id), b.corpus.map((x) => x.id));
  assert.deepEqual(a.foreigners.map((x) => x.id), b.foreigners.map((x) => x.id));
});
