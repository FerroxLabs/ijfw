#!/usr/bin/env node
// IJFW v1.3.0 -- D2 symbol-graph SPEC grader (hand-curated authority).
//
// Source authority: PRD-v2 section 9 Pillar D D2 + .planning/1.3.0/D-PILLAR-SPEC.md
// section 6 (Layer A -- spec grader) + GA real fix-wave finding F1.
//
// Layer A of the dual-gate strategy:
//   - Spec grader (Layer A, this file) runs against hand-curated fixtures
//     at test/fixtures/symbol-graph-spec/<kind>/<n>/. Ground truth is
//     human-authored, NOT derived from extractor or grader output.
//     Per-kind 80% precision + 80% recall gate (entities + edges).
//   - Consistency grader (Layer B) lives at grade-symbol-graph-consistency.js
//     and runs against auto-aligned fixtures at test/fixtures/symbol-graph/.
//
// Why 80%, not 90% or 100%? Real-world fuzzy-match across hand-curated
// bodies is harder than the auto-aligned curated set; the regex extractor
// is intentionally conservative. 80%/80% is the honest pass bar for spec
// conformance under the documented all-pairs + structural-drops contract.
//
// Walks every fixture under test/fixtures/symbol-graph-spec/<kind>/<n>/,
// runs extractEntities() against each entry's body, applies the same
// edge-generation rules as the consistency grader (so prediction logic
// is identical), and compares to the fixture's hand-authored expected.json.
//
// Exits 1 if any kind falls below 80% precision OR recall (entities OR edges).
//
// Run: node mcp-server/test/grade-symbol-graph-spec.js

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { extractEntities } from '../src/compute/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, '..', '..', 'test', 'fixtures', 'symbol-graph-spec');

const KINDS = ['file', 'function', 'identifier', 'error_code', 'decision'];
const PASS_GATE = 0.80; // per-kind precision AND recall (entities AND edges)

function entId(kind, name) { return `${kind}:${name}`; }

function edgeKey(src, dst, kind) {
  const a = String(src);
  const b = String(dst);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}|${hi}|${kind}`;
}

function runFixture(inputPath) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
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

  const entSet = new Set(masterSet);
  const corpusHasFile = entitiesByEntry.some(list => list.some(e => e.kind === 'file'));

  const edgeSet = new Set();
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

        edgeSet.add(edgeKey(entId(a.kind, a.name), entId(b.kind, b.name), 'co_occurs'));
      }
    }
  }
  return { entities: entSet, edges: edgeSet };
}

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

function loadExpected(expectedPath) {
  const j = JSON.parse(readFileSync(expectedPath, 'utf8'));
  const entSet = new Set();
  for (const e of (j.entities || [])) entSet.add(entId(e.kind, e.name));
  const edgeSet = new Set();
  for (const e of (j.edges || [])) edgeSet.add(edgeKey(e.src, e.dst, e.kind || 'co_occurs'));
  return { entities: entSet, edges: edgeSet };
}

function listFixtures(kind) {
  const dir = join(FIXTURES_ROOT, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => statSync(join(dir, name)).isDirectory())
    .sort();
}

function gradeKind(kind) {
  const fixtures = listFixtures(kind);
  let entTP = 0, entFP = 0, entFN = 0;
  let edgeTP = 0, edgeFP = 0, edgeFN = 0;
  const failures = [];

  for (const fix of fixtures) {
    const fixDir = join(FIXTURES_ROOT, kind, fix);
    const inputPath = join(fixDir, 'input.json');
    const expectedPath = join(fixDir, 'expected.json');
    if (!existsSync(inputPath) || !existsSync(expectedPath)) {
      failures.push(`${kind}/${fix}: missing input or expected json`);
      continue;
    }

    let predicted, expected;
    try {
      predicted = runFixture(inputPath);
      expected = loadExpected(expectedPath);
    } catch (err) {
      failures.push(`${kind}/${fix}: extractor threw -- ${err && err.message ? err.message : String(err)}`);
      continue;
    }

    const predOfKind = new Set([...predicted.entities].filter(e => e.startsWith(`${kind}:`)));
    const expOfKind = new Set([...expected.entities].filter(e => e.startsWith(`${kind}:`)));

    for (const e of predOfKind) {
      if (expOfKind.has(e)) entTP++;
      else { entFP++; failures.push(`${kind}/${fix}: false positive entity ${e}`); }
    }
    for (const e of expOfKind) {
      if (!predOfKind.has(e)) { entFN++; failures.push(`${kind}/${fix}: false negative entity ${e}`); }
    }

    const edgeOfKind = () => (key) => {
      const [a, b] = key.split('|');
      return a.startsWith(`${kind}:`) || b.startsWith(`${kind}:`);
    };
    const predEdgesOfKind = new Set([...predicted.edges].filter(edgeOfKind()));
    const expEdgesOfKind  = new Set([...expected.edges].filter(edgeOfKind()));

    for (const e of predEdgesOfKind) {
      if (expEdgesOfKind.has(e)) edgeTP++;
      else { edgeFP++; failures.push(`${kind}/${fix}: false positive edge ${e}`); }
    }
    for (const e of expEdgesOfKind) {
      if (!predEdgesOfKind.has(e)) { edgeFN++; failures.push(`${kind}/${fix}: false negative edge ${e}`); }
    }
  }

  const entP = (entTP + entFP) ? entTP / (entTP + entFP) : 1.0;
  const entR = (entTP + entFN) ? entTP / (entTP + entFN) : 1.0;
  const edgeP = (edgeTP + edgeFP) ? edgeTP / (edgeTP + edgeFP) : 1.0;
  const edgeR = (edgeTP + edgeFN) ? edgeTP / (edgeTP + edgeFN) : 1.0;

  const pass = entP >= PASS_GATE && entR >= PASS_GATE && edgeP >= PASS_GATE && edgeR >= PASS_GATE;

  return {
    kind,
    fixtures: fixtures.length,
    entP, entR, edgeP, edgeR,
    counters: { entTP, entFP, entFN, edgeTP, edgeFP, edgeFN },
    pass,
    failures,
  };
}

function main() {
  if (!existsSync(FIXTURES_ROOT)) {
    console.error(`fixtures root not present: ${FIXTURES_ROOT}`);
    process.exit(1);
  }

  console.log('IJFW D2 -- symbol graph SPEC grader (hand-curated authority)');
  console.log('=============================================================');
  console.log('');

  let allPass = true;
  const results = [];
  for (const kind of KINDS) {
    const r = gradeKind(kind);
    results.push(r);
    if (!r.pass) allPass = false;
  }

  for (const r of results) {
    const verdict = r.pass ? 'PASS' : 'FAIL';
    console.log(`[${verdict}] ${r.kind} (${r.fixtures} fixtures)`);
    console.log(
      `        entity   P=${(r.entP * 100).toFixed(1)}% R=${(r.entR * 100).toFixed(1)}%` +
      `  (TP=${r.counters.entTP} FP=${r.counters.entFP} FN=${r.counters.entFN})`
    );
    console.log(
      `        edges    P=${(r.edgeP * 100).toFixed(1)}% R=${(r.edgeR * 100).toFixed(1)}%` +
      `  (TP=${r.counters.edgeTP} FP=${r.counters.edgeFP} FN=${r.counters.edgeFN})`
    );
  }

  if (!allPass) {
    console.log('');
    console.log('Failures (first 60):');
    let count = 0;
    for (const r of results) {
      for (const f of r.failures) {
        console.log('  ' + f);
        if (++count >= 60) break;
      }
      if (count >= 60) break;
    }
    console.log('');
    console.log(`Gate: per-kind precision AND recall >= ${PASS_GATE * 100}% (entities + edges)`);
    console.log('RESULT: FAIL');
    process.exit(1);
  }

  console.log('');
  console.log(`Gate: per-kind precision AND recall >= ${PASS_GATE * 100}% (entities + edges)`);
  console.log('RESULT: PASS');
}

main();
