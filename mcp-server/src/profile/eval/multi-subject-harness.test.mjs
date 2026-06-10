// Gate B v2 — Task T4: multi-subject harness. The load-bearing guards: briefs are
// TRAIN-only (dataflow + AST), the harness never imports styleTargetFromAxes, the leak
// guard catches OWN_test prose in a brief, scoring is per-subject aggregated, and a
// faithful agent makes the oracle beat baseline while a constant agent fabricates NO
// advantage (the harness can't manufacture an arm difference on its own).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBriefs, assertBriefNonLeaky, runHarness, ARMS,
} from './multi-subject-harness.mjs';
import { generatePersonaText } from './synthetic-personas.js';
import { fullStyleVector } from './stylometry.js';

// Formal personas (archetype 0), distinct content per persona.
function formalPersona(id, seed) {
  const trainDocs = [generatePersonaText(0, seed + 1, 18), generatePersonaText(0, seed + 2, 18)];
  const testDocs = [generatePersonaText(0, seed + 9001, 14)];
  return {
    id, synthetic: false, headlineEligible: true, trainDocs, testDocs,
    fingerprint: fullStyleVector(testDocs.join('\n')),
  };
}
const PERSONAS = [formalPersona('p1', 100), formalPersona('p2', 200), formalPersona('p3', 300)];
const RELAX = { cfg: { leakFloor: 0.001 } }; // templated synthetic train≈test; relax 2nd-tier floor

// Faithful agent: echoes injected exemplars (→ author style), else a fixed CASUAL default.
function faithfulAgent(prompt) {
  const ex = prompt.match(/"""([\s\S]*?)"""/g);
  if (ex) return ex.map((s) => s.replace(/"""/g, '')).join(' ');
  return 'yeah it just kinda works i think, pretty simple honestly, no big deal at all and you can just go with it.';
}
// Constant agent: same output for every prompt — no arm can differ.
function constantAgent() { return 'the result, however, meets the stated goal; therefore the process follows the plan.'; }

test('buildBriefs: baseline is empty, arms differ only by brief, TRAIN-derived', () => {
  const b = buildBriefs(PERSONAS[0]);
  assert.equal(b.baseline, '');
  assert.ok(b.derived.length > 0 && b.fewShotOracle.length > 0);
  // fewShotOracle contains a TRAIN doc, never a TEST doc
  assert.ok(PERSONAS[0].trainDocs.some((d) => b.fewShotOracle.includes(d)), 'oracle injects a train exemplar');
  assert.ok(!PERSONAS[0].testDocs.some((d) => b.fewShotOracle.includes(d)), 'oracle never injects a test doc');
});

test('AST GUARD: buildBriefs references trainDocs and never testDocs; no styleTargetFromAxes', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./multi-subject-harness.mjs', import.meta.url)), 'utf8');
  // strip comments so the guard checks CODE, not its own documentation
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/styleTargetFromAxes/.test(code), 'harness code must not import/use styleTargetFromAxes');
  // extract the buildBriefs body by stable markers (next top-level statement)
  const start = src.indexOf('export function buildBriefs');
  const end = src.indexOf('const FUNC_TRI_WEIGHTS', start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'located buildBriefs body');
  const body = src.slice(start, end);
  assert.ok(/trainDocs/.test(body), 'buildBriefs uses trainDocs');
  assert.ok(!/testDocs/.test(body), 'buildBriefs never touches testDocs');
});

test('LEAK GUARD: verbatim OWN_test prose in a brief throws; a generic brief passes', () => {
  const p = PERSONAS[0];
  // positive control: brief IS the test text → leaky
  assert.throws(() => assertBriefNonLeaky(p.testDocs[0], p), /leak|too close/i);
  // the derived band brief (generic English) is func/tri-far from the persona's test → ok
  const briefs = buildBriefs(p);
  assert.doesNotThrow(() => assertBriefNonLeaky(briefs.derived, p));
});

test('per-subject AGGREGATION: one authorship vector per (subject, arm)', async () => {
  const out = await runHarness(PERSONAS, { transport: faithfulAgent, ...RELAX });
  assert.deepEqual(out.arms, ARMS);
  for (const id of out.personaIds) {
    for (const arm of ARMS) {
      const r = out.results[id][arm];
      assert.equal(r.vector.__full, true, 'a single full vector per arm');
      assert.equal(r.outputs.length, 3, 'three probe outputs aggregated into the one vector');
      assert.ok(Number.isFinite(r.distOwn));
    }
  }
});

test('FAITHFUL agent: fewShotOracle beats baseline (mean distance to OWN test)', async () => {
  const out = await runHarness(PERSONAS, { transport: faithfulAgent, ...RELAX });
  const mean = (arm) => out.personaIds.reduce((s, id) => s + out.results[id][arm].distOwn, 0) / out.personaIds.length;
  assert.ok(mean('fewShotOracle') < mean('baseline'), `oracle ${mean('fewShotOracle').toFixed(3)} < baseline ${mean('baseline').toFixed(3)}`);
});

test('CONSTANT agent: harness fabricates NO arm advantage (all arms equal distance)', async () => {
  const out = await runHarness(PERSONAS, { transport: constantAgent, ...RELAX });
  for (const id of out.personaIds) {
    assert.equal(out.results[id].fewShotOracle.distOwn, out.results[id].baseline.distOwn);
    assert.equal(out.results[id].derived.distOwn, out.results[id].baseline.distOwn);
  }
});

test('runHarness requires a transport function', async () => {
  await assert.rejects(() => runHarness(PERSONAS, {}), /transport/);
});
