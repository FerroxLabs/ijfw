#!/usr/bin/env node
// IJFW v1.3.0 -- D4 cascading staleness grader.
//
// Source authority: PRD-v2 section 9 Pillar D D4 + .planning/1.3.0/D-PILLAR-SPEC.md section 7.
//
// Walks every fixture under test/fixtures/cascading-staleness/<n>/, seeds a
// fresh compute db with that fixture's pre-supersession graph state, runs
// propagateStale() with the calibrated weight_threshold + depth_cap, and
// compares the BFS-reached node set to the fixture's expected_stale_candidates
// + expected_unaffected.
//
// Per-fixture gate (D-PILLAR-SPEC section 7):
//   - precision >= 0.85
//   - recall    >= 0.70
// Aggregate gate:
//   - >= 90% of fixtures pass
//
// Exits 1 if the aggregate gate fails. Prints per-fixture P/R + a
// summary table. Calibration: if the baseline (depth=2, weight>=0.5)
// fails, this grader can be re-run with env overrides to tune:
//   IJFW_D4_WEIGHT=0.6 IJFW_D4_DEPTH=2 node mcp-server/test/grade-cascading-staleness.js
//
// Calibration data is recorded in D-PILLAR-SPEC.md section 2 once locked.

import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { openDb, closeDb } from '../src/compute/fts5.js';
import { propagateStale } from '../src/compute/staleness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, '..', '..', 'test', 'fixtures', 'cascading-staleness');

const PER_FIXTURE_PRECISION = 0.85;
const PER_FIXTURE_RECALL = 0.70;
const AGGREGATE_PASS_RATE = 0.90;

const WEIGHT_THRESHOLD = process.env.IJFW_D4_WEIGHT
  ? Number(process.env.IJFW_D4_WEIGHT)
  : 0.5;
const DEPTH_CAP = process.env.IJFW_D4_DEPTH
  ? parseInt(process.env.IJFW_D4_DEPTH, 10)
  : 2;

function listFixtures() {
  if (!existsSync(FIXTURES_ROOT)) return [];
  return readdirSync(FIXTURES_ROOT)
    .filter(name => !name.startsWith('_'))
    .filter(name => /^\d+$/.test(name))
    .filter(name => statSync(join(FIXTURES_ROOT, name)).isDirectory())
    .sort((a, b) => Number(a) - Number(b));
}

// Seed a fresh compute db with the fixture's graph_state.json and return
// the (kind, name) -> id map plus the superseded node's id. Each fixture
// runs in its own temp project root so dbs don't interfere.
async function seedFixture(fixtureDir) {
  const graph = JSON.parse(readFileSync(join(fixtureDir, 'graph_state.json'), 'utf8'));
  const event = JSON.parse(readFileSync(join(fixtureDir, 'supersession_event.json'), 'utf8'));

  const root = mkdtempSync(join(tmpdir(), 'd4-grade-'));
  const db = await openDb(root);
  const ts = Date.now();

  const idByName = new Map();
  const insertNode = db.prepare(
    `INSERT INTO kg_nodes (kind, name, first_seen, last_seen, redacted) VALUES (?, ?, ?, ?, ?)`
  );
  for (const node of graph.kg_nodes) {
    const info = insertNode.run(node.kind, node.name, ts, ts, node.redacted ? 1 : 0);
    idByName.set(node.name, Number(info.lastInsertRowid));
  }

  const insertEdge = db.prepare(
    `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const edge of graph.kg_edges) {
    const srcId = idByName.get(edge.src);
    const dstId = idByName.get(edge.dst);
    if (!srcId || !dstId) {
      throw new Error(`fixture references unknown node in edge: ${edge.src} -> ${edge.dst}`);
    }
    const lo = Math.min(srcId, dstId);
    const hi = Math.max(srcId, dstId);
    insertEdge.run(lo, hi, edge.kind || 'co_occurs', edge.weight, edge.co_occurrence_count || 1, ts);
  }

  const supersededId = idByName.get(event.superseded);
  if (!supersededId) {
    throw new Error(`fixture's superseded node "${event.superseded}" missing from graph_state`);
  }

  return { root, db, supersededId, idByName, graph, event };
}

function gradeFixture(fixtureDir) {
  return seedFixture(fixtureDir).then(({ root, db, supersededId, graph, event }) => {
    try {
      const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8'));
      const expStaleSet = new Set(expected.expected_stale_candidates || []);
      const expUnaffectedSet = new Set(expected.expected_unaffected || []);

      const env = propagateStale(db, supersededId, {
        weight_threshold: WEIGHT_THRESHOLD,
        depth_cap: DEPTH_CAP,
      });

      // Predicted set = reached_nodes excluding depth=0 (superseded) and
      // excluding redacted nodes (redacted nodes are reached but never
      // flagged for staleness per D-PILLAR-SPEC section 3 ordering).
      const predicted = new Set(
        env.reached_nodes
          .filter(n => n.depth > 0 && !n.redacted)
          .map(n => n.name)
      );

      // Universe of names we score on = expected_stale + expected_unaffected.
      // Anything outside (e.g. unrelated graph nodes the fixture doesn't
      // call out) is not part of the score.
      const universe = new Set([...expStaleSet, ...expUnaffectedSet]);

      let tp = 0, fp = 0, fn = 0;
      for (const name of universe) {
        if (predicted.has(name)) {
          if (expStaleSet.has(name)) tp++;
          else fp++;
        } else {
          if (expStaleSet.has(name)) fn++;
          // expUnaffected and not predicted -> true negative; not counted
        }
      }

      // Predicted-but-outside-universe nodes count as false positives too:
      // the grader penalises spurious propagation hits aggressively.
      for (const name of predicted) {
        if (!universe.has(name)) fp++;
      }

      const precision = (tp + fp) === 0 ? 1.0 : tp / (tp + fp);
      const recall = (tp + fn) === 0 ? 1.0 : tp / (tp + fn);
      const pass = precision >= PER_FIXTURE_PRECISION && recall >= PER_FIXTURE_RECALL;

      return {
        fixture: fixtureDir.split('/').pop(),
        name: expected.name,
        description: expected.description,
        precision, recall, pass,
        counters: { tp, fp, fn },
        predicted: [...predicted].sort(),
        expectedStale: [...expStaleSet].sort(),
      };
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function main() {
  if (!existsSync(FIXTURES_ROOT)) {
    console.error(`fixtures root not present: ${FIXTURES_ROOT}`);
    process.exit(1);
  }

  console.log('IJFW D4 -- cascading staleness grader');
  console.log('======================================');
  console.log(`Calibration: weight_threshold=${WEIGHT_THRESHOLD}, depth_cap=${DEPTH_CAP}`);
  console.log(`Per-fixture gate: precision>=${PER_FIXTURE_PRECISION}, recall>=${PER_FIXTURE_RECALL}`);
  console.log(`Aggregate gate:   >=${(AGGREGATE_PASS_RATE * 100).toFixed(0)}% of fixtures pass\n`);

  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    console.error(`no fixtures found at ${FIXTURES_ROOT}`);
    process.exit(1);
  }

  let passed = 0;
  const results = [];
  for (const fix of fixtures) {
    const dir = join(FIXTURES_ROOT, fix);
    const r = await gradeFixture(dir);
    results.push(r);
    if (r.pass) passed++;
  }

  // Per-fixture summary (compressed: failures listed in detail).
  const passRate = passed / fixtures.length;
  const failures = results.filter(r => !r.pass);

  console.log(`PASS: ${passed}/${fixtures.length} (${(passRate * 100).toFixed(1)}%)`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(
        `  [FAIL] ${f.fixture} (${f.name}): P=${(f.precision * 100).toFixed(1)}% ` +
        `R=${(f.recall * 100).toFixed(1)}% TP=${f.counters.tp} FP=${f.counters.fp} FN=${f.counters.fn}`
      );
      console.log(`         predicted: [${f.predicted.join(', ')}]`);
      console.log(`         expected:  [${f.expectedStale.join(', ')}]`);
    }
  }

  if (passRate < AGGREGATE_PASS_RATE) {
    console.log(`\nGate: aggregate pass rate ${(passRate * 100).toFixed(1)}% < ${(AGGREGATE_PASS_RATE * 100).toFixed(0)}%`);
    console.log('RESULT: FAIL');
    process.exit(1);
  }

  console.log(`\nGate: aggregate pass rate >=${(AGGREGATE_PASS_RATE * 100).toFixed(0)}% (got ${(passRate * 100).toFixed(1)}%)`);
  console.log('RESULT: PASS');
}

main().catch(err => {
  console.error('grader error:', err);
  process.exit(1);
});
