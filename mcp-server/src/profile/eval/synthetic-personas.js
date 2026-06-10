// synthetic-personas.js — Gate B v2, Task T3 (synthetic half). Deterministic, neutral,
// controlled-style personas. EXISTS ONLY to (a) exercise the harness plumbing offline
// and (b) add a SANITY/power check — NEVER to carry the verdict. Every synthetic persona
// is stamped { synthetic:true, headlineEligible:false } so the decision runner (T7) can
// only ever let real authors set the headline N and license the PASS/CUT.
//
// Anti-circularity note (C2): because synthetic text is generated FROM style archetypes
// and then scored by the SAME metric family, a synthetic "win" is partly tautological.
// That is exactly why synthetic is downgrade-only and never licenses the mission claim.

import { fullStyleVector } from './stylometry.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

const SUBJECTS = ['the system', 'a user', 'the team', 'one approach', 'the process', 'this method', 'the result', 'a change', 'the design', 'the plan'];
const PREDICATES = ['works as expected', 'needs another review', 'depends on the input', 'improves over time', 'handles the edge case', 'reduces the cost', 'follows the plan', 'meets the stated goal', 'remains stable under load', 'scales with demand'];

// Style archetypes control function-word / connector / punctuation habits — the features
// the authorship metric reads. Neutral content throughout.
const ARCHETYPES = [
  { // formal
    connectors: ['however', 'therefore', 'moreover', 'consequently', 'furthermore'],
    join: (a, b, c) => `${cap(a)}, ${c}, ${b}.`,
  },
  { // casual
    connectors: ['so', 'and', 'but', 'plus', 'anyway'],
    join: (a, b, c) => `${a} ${c} it ${b}, honestly.`,
  },
  { // terse
    connectors: ['', '', ''],
    join: (a, b) => `${cap(a)} ${b}.`,
  },
  { // discursive
    connectors: ['which means', 'in other words', 'that is to say', 'as it happens'],
    join: (a, b, c) => `${cap(a)} ${b}, ${c} the outcome is broadly acceptable for now.`,
  },
];
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Generate neutral persona text in a fixed style (archetypeIdx) with content variation
// driven by contentSeed — so train and test slices share STYLE but differ in content.
export function generatePersonaText(archetypeIdx, contentSeed, nSentences) {
  const arch = ARCHETYPES[archetypeIdx % ARCHETYPES.length];
  const rng = mulberry32(contentSeed >>> 0);
  const out = [];
  for (let i = 0; i < nSentences; i += 1) {
    const s = pick(rng, SUBJECTS);
    const p = pick(rng, PREDICATES);
    const c = pick(rng, arch.connectors);
    out.push(arch.join(s, p, c));
  }
  return out.join(' ');
}

// makePersonas(n, seed) → n synthetic personas, same shape as real personas.
export function makePersonas(n, seed = 1) {
  const personas = [];
  for (let k = 0; k < n; k += 1) {
    const archetypeIdx = k % ARCHETYPES.length;
    const styleBase = (seed * 1000 + k) >>> 0;
    // distinct content seeds for train vs test → same style, disjoint content
    const trainDocs = [
      generatePersonaText(archetypeIdx, styleBase + 1, 16),
      generatePersonaText(archetypeIdx, styleBase + 2, 16),
    ];
    const testDocs = [
      generatePersonaText(archetypeIdx, styleBase + 9001, 12),
    ];
    personas.push({
      id: `syn-${seed}-${k}`,
      synthetic: true,
      headlineEligible: false,
      archetype: archetypeIdx,
      trainDocs,
      testDocs,
      fingerprint: fullStyleVector(testDocs.join('\n')),
    });
  }
  return personas;
}

export default { makePersonas, generatePersonaText };
