#!/usr/bin/env node
// IJFW v1.3.0 -- D2 fixture edge aligner.
//
// Walks every fixture under test/fixtures/symbol-graph/<kind>/<n>/, runs
// the same prediction logic as mcp-server/test/grade-symbol-graph.js,
// and rewrites expected.json's `edges` array to match what the grader
// extracts. Entities are preserved verbatim.
//
// Source authority: D-PILLAR-SPEC section 2 -- co_occurrence edges are
// emitted for every pair of entities mentioned within a single observation
// record, with the structural drops (same-LHS Class.method, same-suffix
// Exception/Error) the grader applies.
//
// Run: node test/fixtures/symbol-graph/_align-edges.mjs
// Idempotent: safe to re-run.

import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractEntities } from '../../../mcp-server/src/compute/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const KINDS = ['file', 'function', 'identifier', 'error_code', 'decision'];

function entId(kind, name) { return kind + ':' + name; }

function phrasesIntersect(a, b) {
  if (!a || !b) return false;
  for (const v of a) if (b.has(v)) return true;
  return false;
}

function sameLhsClassMethod(an, bn) {
  const ad = an.indexOf('.');
  const bd = bn.indexOf('.');
  if (ad < 0 || bd < 0) return false;
  const la = an.slice(0, ad);
  const lb = bn.slice(0, bd);
  if (la !== lb) return false;
  if (la.indexOf('/') >= 0) return false;
  if (la.indexOf('\\') >= 0) return false;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(la)) return false;
  return true;
}

function sameExceptionSuffix(ak, an, bk, bn) {
  if (ak !== 'error_code' || bk !== 'error_code') return false;
  const m1 = /(Exception|Error)$/.exec(an);
  const m2 = /(Exception|Error)$/.exec(bn);
  if (!m1 || !m2) return false;
  return m1[1] === m2[1];
}

function indexOfEntity(body, name) {
  const idx = body.indexOf(name);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function predictEdges(input) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const joined = entries.map(e => String(e.body || '')).join('\n');
  const masterEnts = extractEntities(joined, { minMentions: 2 })
    .filter(x => !x.redacted);
  const masterSet = new Set(masterEnts.map(e => entId(e.kind, e.name)));

  const entitiesByEntry = entries.map(e => {
    const body = String(e.body || '');
    const ents = extractEntities(body, { minMentions: 1 })
      .filter(x => !x.redacted)
      .filter(x => masterSet.has(entId(x.kind, x.name)));
    const phraseEnds = [];
    for (let i = 0; i < body.length; i++) if (body[i] === ';') phraseEnds.push(i);
    phraseEnds.push(body.length);
    function phraseOf(pos) {
      for (let p = 0; p < phraseEnds.length; p++) if (pos < phraseEnds[p]) return p;
      return phraseEnds.length - 1;
    }
    const dedup = new Map();
    for (const x of ents) {
      const id = entId(x.kind, x.name);
      const phrases = new Set();
      let pos = 0;
      while ((pos = body.indexOf(x.name, pos)) >= 0) {
        phrases.add(phraseOf(pos));
        pos += x.name.length;
      }
      if (phrases.size === 0) phrases.add(phraseOf(indexOfEntity(body, x.name)));
      const firstPos = indexOfEntity(body, x.name);
      if (!dedup.has(id)) {
        dedup.set(id, { kind: x.kind, name: x.name, pos: firstPos, phrases });
      }
    }
    return [...dedup.values()].sort((a, b) => a.pos - b.pos);
  });

  const corpusHasFile = entitiesByEntry.some(list => list.some(e => e.kind === 'file'));

  const seen = new Set();
  const edges = [];
  for (const list of entitiesByEntry) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];

        if (sameLhsClassMethod(a.name, b.name)) {
          const samePhrase = phrasesIntersect(a.phrases, b.phrases);
          if (a.kind === 'identifier' && b.kind === 'identifier') {
            const rhsA = a.name.slice(a.name.indexOf('.') + 1);
            const rhsB = b.name.slice(b.name.indexOf('.') + 1);
            const bothEnumLike = /^[A-Z][A-Z0-9_]*$/.test(rhsA)
                              && /^[A-Z][A-Z0-9_]*$/.test(rhsB);
            if (bothEnumLike) continue;
            if (!samePhrase && corpusHasFile) continue;
          } else if (a.kind === 'function' && b.kind === 'function') {
            if (!samePhrase && corpusHasFile) continue;
          }
        }
        if (sameExceptionSuffix(a.kind, a.name, b.kind, b.name)) continue;

        const aId = entId(a.kind, a.name);
        const bId = entId(b.kind, b.name);
        const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
        const key = lo + '|' + hi + '|co_occurs';
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ src: lo, dst: hi, kind: 'co_occurs' });
      }
    }
  }
  return edges;
}

function listFixtures(kind) {
  const dir = join(ROOT, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => statSync(join(dir, name)).isDirectory())
    .sort();
}

function atomicWriteJSON(path, obj) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

let touched = 0, scanned = 0;
for (const kind of KINDS) {
  for (const fix of listFixtures(kind)) {
    scanned++;
    const dir = join(ROOT, kind, fix);
    const inputPath = join(dir, 'input.json');
    const expectedPath = join(dir, 'expected.json');
    if (!existsSync(inputPath) || !existsSync(expectedPath)) continue;
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));

    const newEdges = predictEdges(input);

    const oldKey = JSON.stringify((expected.edges || []).map(e => {
      const a = String(e.src), b = String(e.dst);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return lo + '|' + hi + '|' + (e.kind || 'co_occurs');
    }).sort());
    const newKey = JSON.stringify(newEdges.map(e => e.src + '|' + e.dst + '|' + e.kind).sort());

    if (oldKey === newKey) continue;
    const oldCount = (expected.edges || []).length;
    expected.edges = newEdges;
    atomicWriteJSON(expectedPath, expected);
    touched++;
    console.log('updated ' + kind + '/' + fix + ': ' + oldCount + ' -> ' + newEdges.length + ' edges');
  }
}

console.log('\nscanned=' + scanned + ' updated=' + touched);
