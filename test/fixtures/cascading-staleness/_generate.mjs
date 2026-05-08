#!/usr/bin/env node
// IJFW v1.3.0 -- D4 cascading-staleness fixture generator.
//
// Authors 50 synthetic supersession-event fixtures for
// mcp-server/test/grade-cascading-staleness.js per D-PILLAR-SPEC section 7.
//
// Each fixture lives at test/fixtures/cascading-staleness/<n>/ with:
//   graph_state.json       -- kg_nodes + kg_edges (pre-supersession)
//   supersession_event.json -- which node is superseded (the BFS root)
//   expected.json          -- { expected_stale_candidates, expected_unaffected }
//
// Topology coverage (per fixture index 1..50):
//   1-10  star      -- one hub, N spokes (depth=1 only)
//   11-20 chain     -- A-B-C-D-E with varied weights at each link
//   21-30 hybrid    -- chain + side spurs at depth 2
//   31-40 weighted  -- topology with some edges below threshold (must
//                       NOT propagate)
//   41-50 redacted  -- topology with redacted nodes that terminate
//                       traversal at their boundary
//
// Names use a deterministic naming scheme so collision across fixtures is
// impossible (each fixture lives in its own db at grade time anyway, but
// stable names make debugging readable).
//
// Run: node test/fixtures/cascading-staleness/_generate.mjs

import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const PROPAGATION_THRESHOLD = 0.5; // D-PILLAR-SPEC section 2 baseline
const PROPAGATION_DEPTH = 2;

// ---------- builders ----------

function n(kind, name, redacted = 0) {
  return { kind, name, redacted };
}
function e(srcName, dstName, weight, kind = 'co_occurs') {
  return { src: srcName, dst: dstName, kind, weight, co_occurrence_count: 3 };
}

// Star topology: one hub, N spokes. Superseded = hub.
// Expected: every spoke (depth 1) flagged when weight >= 0.5.
function buildStar(idx) {
  const slug = `star_${idx}`;
  const hub = `${slug}_hub`;
  const spokes = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].slice(0, 3 + (idx % 3));
  const nodes = [n('function', hub)];
  const edges = [];
  const expectedStale = [];
  const expectedUnaffected = [];
  // Mix of weights: at least one above threshold, optionally one below.
  spokes.forEach((s, i) => {
    const fullName = `${slug}_${s}`;
    nodes.push(n('function', fullName));
    // Weight pattern: alternate above/below threshold based on idx
    const w = (idx + i) % 4 === 0 ? 0.4 : (0.55 + (i * 0.05) % 0.3);
    edges.push(e(hub, fullName, w));
    if (w >= PROPAGATION_THRESHOLD) expectedStale.push(fullName);
    else expectedUnaffected.push(fullName);
  });
  return {
    name: `star-${idx}`,
    description: `Star topology hub=${hub}, ${spokes.length} spokes (depth=1 only)`,
    superseded: hub,
    nodes, edges, expectedStale, expectedUnaffected,
  };
}

// Chain topology: A-B-C-D-E with varied weights. Superseded = A.
// Expected: B (depth 1) + C (depth 2) flagged when both edges >= 0.5.
function buildChain(idx) {
  const slug = `chain_${idx}`;
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const fullNames = labels.map(l => `${slug}_${l}`);
  const nodes = fullNames.map(name => n('identifier', name));
  // Weights pattern shifts per fixture so each chain has a distinct
  // shape. Pattern picks (w_AB, w_BC, w_CD, w_DE) from a rotating set
  // that includes some sub-threshold edges to test depth termination.
  const patterns = [
    [0.7, 0.7, 0.7, 0.7],
    [0.7, 0.6, 0.4, 0.7], // C-D below; D, E unaffected
    [0.7, 0.4, 0.7, 0.7], // B-C below; C..E unaffected
    [0.55, 0.55, 0.55, 0.55],
    [0.9, 0.9, 0.4, 0.4],
    [0.4, 0.7, 0.7, 0.7], // A-B below; whole chain unaffected
    [0.7, 0.7, 0.6, 0.5],
    [0.8, 0.5, 0.7, 0.7],
    [0.9, 0.45, 0.7, 0.7], // B-C below threshold by 0.05
    [0.7, 0.55, 0.45, 0.7],
  ];
  const w = patterns[(idx - 1) % patterns.length];
  const edges = [
    e(fullNames[0], fullNames[1], w[0]),
    e(fullNames[1], fullNames[2], w[1]),
    e(fullNames[2], fullNames[3], w[2]),
    e(fullNames[3], fullNames[4], w[3]),
  ];

  // Compute expected propagation by simulation.
  const expectedStale = [];
  const expectedUnaffected = [];
  // Depth 1: B reached if w_AB >= threshold
  if (w[0] >= PROPAGATION_THRESHOLD) {
    expectedStale.push(fullNames[1]);
    // Depth 2 from A: C if w_BC also >= threshold
    if (w[1] >= PROPAGATION_THRESHOLD) {
      expectedStale.push(fullNames[2]);
    } else {
      expectedUnaffected.push(fullNames[2]);
    }
  } else {
    expectedUnaffected.push(fullNames[1], fullNames[2]);
  }
  // D + E always beyond depth 2 from A.
  expectedUnaffected.push(fullNames[3], fullNames[4]);

  return {
    name: `chain-${idx}`,
    description: `Chain A-E, weights [${w.join(',')}]; superseded=A`,
    superseded: fullNames[0],
    nodes, edges, expectedStale, expectedUnaffected,
  };
}

// Hybrid: small chain with side spurs at depth 1 + 2.
// Superseded = root R. Spurs S1 off R (depth 1), S2 off depth-1 node.
function buildHybrid(idx) {
  const slug = `hybrid_${idx}`;
  const R = `${slug}_root`;
  const N1 = `${slug}_n1`;
  const N2 = `${slug}_n2`;
  const S1 = `${slug}_spur1`;
  const S2 = `${slug}_spur2`;
  const F = `${slug}_far`;
  const nodes = [
    n('file', R),
    n('function', N1),
    n('function', N2),
    n('identifier', S1),
    n('identifier', S2),
    n('function', F),
  ];
  // Edge weights vary per fixture for diversity.
  const wMain1 = 0.6 + ((idx % 5) * 0.06);
  const wMain2 = (idx % 3 === 0) ? 0.45 : 0.6;
  const wSpur1 = (idx % 4 === 0) ? 0.4 : 0.7;
  const wSpur2 = 0.55;
  const wFar = 0.7;
  const edges = [
    e(R, N1, wMain1),
    e(N1, N2, wMain2),
    e(R, S1, wSpur1),
    e(N1, S2, wSpur2),
    e(N2, F, wFar), // depth 3 from R, must NOT propagate
  ];

  const expectedStale = [];
  const expectedUnaffected = [];
  // Depth 1 reachable.
  if (wMain1 >= PROPAGATION_THRESHOLD) expectedStale.push(N1);
  else expectedUnaffected.push(N1);
  if (wSpur1 >= PROPAGATION_THRESHOLD) expectedStale.push(S1);
  else expectedUnaffected.push(S1);
  // Depth 2 reachable via N1 (if depth-1 hop happened).
  if (wMain1 >= PROPAGATION_THRESHOLD) {
    if (wMain2 >= PROPAGATION_THRESHOLD) expectedStale.push(N2);
    else expectedUnaffected.push(N2);
    if (wSpur2 >= PROPAGATION_THRESHOLD) expectedStale.push(S2);
    else expectedUnaffected.push(S2);
  } else {
    expectedUnaffected.push(N2, S2);
  }
  // F is always at depth 3 from R; never propagated under depth_cap=2.
  expectedUnaffected.push(F);

  return {
    name: `hybrid-${idx}`,
    description: `Hybrid root + chain + spurs; superseded=root`,
    superseded: R,
    nodes, edges, expectedStale, expectedUnaffected,
  };
}

// Weighted: heavy mix of sub-threshold edges. Tests precision.
function buildWeighted(idx) {
  const slug = `wt_${idx}`;
  const R = `${slug}_root`;
  const A = `${slug}_a`;
  const B = `${slug}_b`;
  const C = `${slug}_c`;
  const D = `${slug}_d`;
  const E = `${slug}_e`;
  const nodes = [
    n('decision', R),
    n('function', A),
    n('function', B),
    n('function', C),
    n('function', D),
    n('function', E),
  ];
  // Patterns target the calibration zone: weights 0.4-0.6 around the
  // 0.5 threshold so the grader catches edge-case propagation behaviour.
  const patterns = [
    [0.55, 0.55, 0.45, 0.55, 0.45],
    [0.6,  0.4,  0.7,  0.6,  0.4],
    [0.7,  0.7,  0.4,  0.7,  0.7],
    [0.45, 0.7,  0.7,  0.7,  0.7], // R-A below; A's spurs unaffected
    [0.5,  0.5,  0.5,  0.5,  0.5], // exactly at threshold
    [0.51, 0.49, 0.51, 0.49, 0.51],
    [0.65, 0.45, 0.65, 0.45, 0.65],
    [0.8,  0.4,  0.4,  0.4,  0.8], // most edges sub-threshold
    [0.55, 0.55, 0.55, 0.55, 0.55],
    [0.7,  0.7,  0.5,  0.5,  0.5],
  ];
  const w = patterns[(idx - 1) % patterns.length];
  const edges = [
    e(R, A, w[0]),
    e(R, B, w[1]),
    e(A, C, w[2]),
    e(B, D, w[3]),
    e(B, E, w[4]),
  ];

  const expectedStale = [];
  const expectedUnaffected = [];
  // Depth 1.
  const aReached = w[0] >= PROPAGATION_THRESHOLD;
  const bReached = w[1] >= PROPAGATION_THRESHOLD;
  if (aReached) expectedStale.push(A); else expectedUnaffected.push(A);
  if (bReached) expectedStale.push(B); else expectedUnaffected.push(B);
  // Depth 2: from A reach C; from B reach D + E.
  if (aReached && w[2] >= PROPAGATION_THRESHOLD) expectedStale.push(C);
  else expectedUnaffected.push(C);
  if (bReached && w[3] >= PROPAGATION_THRESHOLD) expectedStale.push(D);
  else expectedUnaffected.push(D);
  if (bReached && w[4] >= PROPAGATION_THRESHOLD) expectedStale.push(E);
  else expectedUnaffected.push(E);

  return {
    name: `weighted-${idx}`,
    description: `Weighted topology near threshold zone`,
    superseded: R,
    nodes, edges, expectedStale, expectedUnaffected,
  };
}

// Redacted: topology with redacted nodes that terminate traversal.
function buildRedacted(idx) {
  const slug = `rd_${idx}`;
  const R = `${slug}_root`;
  const X = `${slug}_redacted`;
  const Y = `${slug}_y`;
  const Z = `${slug}_z`;
  const Q = `${slug}_q`;
  const nodes = [
    n('function', R),
    // Mid-traversal redacted node: BFS reaches it but does NOT walk
    // past it. Grader still includes redacted node in reached set, but
    // we EXCLUDE it from name-flagging so its name doesn't pull in
    // unrelated rows. Per propagateStale's name-flag filter, redacted
    // nodes don't seed observation flags; they still count as "reached"
    // in the BFS envelope but not as flagged candidates.
    n('identifier', X, 1),
    n('function', Y),
    n('function', Z),
    n('function', Q),
  ];
  const edges = [
    // R -> X (redacted) at depth 1. X is reached but its name is not
    // used to flag. Per traversal semantics, BFS does NOT walk past X.
    e(R, X, 0.7),
    // R -> Y at depth 1 (clean). Y is flagged.
    e(R, Y, 0.7),
    // Y -> Z at depth 2 (clean). Z is flagged.
    e(Y, Z, 0.6),
    // X -> Q is suppressed by redaction at X (would be depth 2 via X
    // if not for the redacted boundary). Q must NOT be flagged.
    e(X, Q, 0.7),
  ];
  const expectedStale = [Y, Z];     // clean reachable nodes
  const expectedUnaffected = [Q];   // beyond redacted boundary
  // X (redacted) is reached by BFS but its name is not used to flag
  // observations -- it's neither "stale_candidate" nor "must not be
  // flagged" for ground truth purposes. We don't list it either way;
  // grader scoring ignores redacted nodes by convention (see
  // grade-cascading-staleness.js note).
  return {
    name: `redacted-${idx}`,
    description: `Redacted boundary terminates BFS at depth 1`,
    superseded: R,
    nodes, edges, expectedStale, expectedUnaffected,
  };
}

// ---------- emit ----------

function clearChildren() {
  if (!existsSync(ROOT)) return;
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('_')) continue;
    const full = join(ROOT, entry);
    if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
  }
}

function writeFixture(idx, payload) {
  const dir = join(ROOT, String(idx));
  mkdirSync(dir, { recursive: true });

  const graphState = {
    kg_nodes: payload.nodes,
    kg_edges: payload.edges,
  };
  writeFileSync(join(dir, 'graph_state.json'), JSON.stringify(graphState, null, 2) + '\n');

  const supersession = {
    superseded: payload.superseded,
    superseded_kind: payload.nodes.find(node => node.name === payload.superseded).kind,
    replacement: null, // alpha doesn't need a replacement node for D4 grading
    note: payload.description,
  };
  writeFileSync(join(dir, 'supersession_event.json'), JSON.stringify(supersession, null, 2) + '\n');

  const expected = {
    name: payload.name,
    description: payload.description,
    expected_stale_candidates: payload.expectedStale,
    expected_unaffected: payload.expectedUnaffected,
    propagation_threshold: PROPAGATION_THRESHOLD,
    depth_cap: PROPAGATION_DEPTH,
  };
  writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
}

function main() {
  clearChildren();
  for (let i = 1; i <= 10; i++)  writeFixture(i,        buildStar(i));
  for (let i = 1; i <= 10; i++)  writeFixture(10 + i,   buildChain(i));
  for (let i = 1; i <= 10; i++)  writeFixture(20 + i,   buildHybrid(i));
  for (let i = 1; i <= 10; i++)  writeFixture(30 + i,   buildWeighted(i));
  for (let i = 1; i <= 10; i++)  writeFixture(40 + i,   buildRedacted(i));
  console.log(`Wrote 50 fixtures into ${ROOT}`);
}

main();
