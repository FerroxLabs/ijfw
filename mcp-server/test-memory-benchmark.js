#!/usr/bin/env node
/**
 * test-memory-benchmark.js -- IJFW v1.5.0 T22 Wave E.
 *
 * Verifies the memory benchmark harness:
 *   1. Runs against a small canned corpus and emits a well-formed artifact.
 *   2. All required axes are present in the result.
 *   3. recall@1 > 0 (sanity: the warm tier actually returns the gold doc).
 *   4. recall@5 == 1.0 on the curated corpus (porter stemming is doing work).
 *   5. p95 query latency under a defensible ceiling (100 ms for <=50 rows).
 *   6. Storage cost reported with bytes_per_memory > 0.
 *   7. Staleness filter still gates by default + opens on the include_stale flag
 *      (proves the bench didn't accidentally break the warm-tier filter).
 *   8. percentile() helper monotonic + boundary-correct (unit-level coverage).
 *   9. Synthetic corpus generator deterministic on a fixed seed.
 *
 * Real memory ops only -- no mocks. Uses a temp project root each test.
 *
 * Run: node --test mcp-server/test-memory-benchmark.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runBenchmark,
  loadDefaultCorpus,
  buildSyntheticCorpus,
  percentile,
  BENCHMARK_SCHEMA_VERSION,
} from './src/memory/benchmark.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

// --- Unit-level: percentile helper --------------------------------------

test('benchmark/percentile -- boundaries + monotonic', () => {
  assert.equal(percentile([], 50), 0, 'empty -> 0');
  assert.equal(percentile([5], 50), 5, 'singleton -> the one value');

  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // p0 = min, p100 = max
  assert.equal(percentile(arr, 0), 1);
  assert.equal(percentile(arr, 100), 10);
  // p50 = midpoint of 1..10 = 5.5 with linear interp
  assert.equal(percentile(arr, 50), 5.5);
  // p95 between 9.55 and ~10
  assert.ok(percentile(arr, 95) >= 9.5 && percentile(arr, 95) <= 10);

  // Monotonic in p
  let prev = -Infinity;
  for (const p of [0, 10, 25, 50, 75, 90, 95, 99, 100]) {
    const v = percentile(arr, p);
    assert.ok(v >= prev, `monotonic at p=${p}: ${v} >= ${prev}`);
    prev = v;
  }

  assert.throws(() => percentile([1, 2, 3], 101), /RangeError|range/);
});

// --- Synthetic corpus determinism ---------------------------------------

test('benchmark/buildSyntheticCorpus -- deterministic on fixed seed', () => {
  const a = buildSyntheticCorpus(20, 42);
  const b = buildSyntheticCorpus(20, 42);
  assert.equal(a.docs.length, 20);
  assert.equal(a.queries.length, 20);
  assert.deepEqual(a.docs, b.docs, 'same seed -> same docs');
  assert.deepEqual(a.queries, b.queries, 'same seed -> same queries');
  // Different seed -> different docs (very high probability; check filler swap)
  const c = buildSyntheticCorpus(20, 43);
  assert.notDeepEqual(a.docs, c.docs);
  // Each query anchor must be unique so recall scoring is unambiguous.
  const anchors = new Set(a.queries.map(q => q.q));
  assert.equal(anchors.size, a.queries.length, 'all query anchors unique');
});

// --- Default corpus shape -----------------------------------------------

test('benchmark/loadDefaultCorpus -- 30 docs, 30 queries, gold ids all valid', () => {
  const c = loadDefaultCorpus();
  assert.ok(c.docs.length >= 20, `>=20 docs (got ${c.docs.length})`);
  assert.equal(c.docs.length, c.queries.length, '1:1 docs:queries');
  const ids = new Set(c.docs.map(d => d.id));
  for (const q of c.queries) {
    assert.ok(ids.has(q.gold), `gold ${q.gold} resolves to a doc id`);
  }
});

// --- End-to-end: small canned corpus run --------------------------------

test('benchmark/runBenchmark -- emits well-formed artifact with all axes', async () => {
  const root = tmpRoot('bench-e2e');
  try {
    const r = await runBenchmark({ root, write: true, query_runs: 2 });

    // Shape: schema + ijfw_version + ts_iso + duration_ms.
    assert.equal(r.schema_version, BENCHMARK_SCHEMA_VERSION);
    assert.ok(typeof r.ijfw_version === 'string' && r.ijfw_version.length > 0);
    assert.match(r.ts_iso, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(r.duration_ms > 0);

    // Corpus block.
    assert.ok(r.corpus.docs > 0);
    assert.ok(r.corpus.queries > 0);
    assert.equal(r.corpus.query_runs, 2);
    assert.equal(r.corpus.total_query_samples, r.corpus.queries * 2);

    // All required axes present.
    const axes = r.axes;
    assert.ok(axes.ingest, 'ingest axis');
    assert.ok(axes.query_warm_fts5, 'query_warm_fts5 axis');
    assert.ok(axes.query_hot_linear, 'query_hot_linear axis');
    assert.ok(axes.query_cold_vector, 'query_cold_vector axis');
    assert.ok(axes.storage, 'storage axis');
    assert.ok(axes.staleness_filter, 'staleness_filter axis');

    // Ingest axis -- throughput + latency percentiles.
    assert.ok(axes.ingest.throughput_rps > 0, `throughput_rps>0 got ${axes.ingest.throughput_rps}`);
    assert.ok(axes.ingest.latency_ms.p50 >= 0);
    assert.ok(axes.ingest.latency_ms.p95 >= axes.ingest.latency_ms.p50, 'p95 >= p50');
    assert.ok(axes.ingest.latency_ms.p99 >= axes.ingest.latency_ms.p95, 'p99 >= p95');

    // Warm-tier query latency + recall.
    assert.ok(axes.query_warm_fts5.latency_ms.p50 >= 0);
    assert.ok(axes.query_warm_fts5.latency_ms.p95 >= 0);
    assert.ok(typeof axes.query_warm_fts5.recall['recall@1'] === 'number');
    assert.ok(typeof axes.query_warm_fts5.recall['recall@3'] === 'number');
    assert.ok(typeof axes.query_warm_fts5.recall['recall@5'] === 'number');

    // recall@1 > 0 (sanity -- memory really returns relevant results).
    assert.ok(
      axes.query_warm_fts5.recall['recall@1'] > 0,
      `recall@1>0 got ${axes.query_warm_fts5.recall['recall@1']}`,
    );
    // Monotonic in k.
    assert.ok(
      axes.query_warm_fts5.recall['recall@5'] >= axes.query_warm_fts5.recall['recall@3'],
      'recall@5 >= recall@3',
    );
    assert.ok(
      axes.query_warm_fts5.recall['recall@3'] >= axes.query_warm_fts5.recall['recall@1'],
      'recall@3 >= recall@1',
    );

    // Curated corpus is hand-tuned: porter stemming should hit recall@5==1.0.
    // If this regresses, the synonym table or tokenizer changed unsafely.
    assert.equal(
      axes.query_warm_fts5.recall['recall@5'], 1.0,
      'curated corpus must hit recall@5 = 1.0 (porter stemming sanity)',
    );

    // Defensible p95 ceiling for a 30-row corpus on hot tier.
    assert.ok(
      axes.query_warm_fts5.latency_ms.p95 < 100,
      `p95 query latency < 100ms (got ${axes.query_warm_fts5.latency_ms.p95}ms)`,
    );

    // Storage axis.
    assert.ok(axes.storage.rows_indexed >= r.corpus.docs);
    assert.ok(axes.storage.db_bytes > 0, `db_bytes>0 got ${axes.storage.db_bytes}`);
    assert.ok(axes.storage.bytes_per_memory > 0);

    // Cold tier is reserved (not measured by this build).
    assert.equal(axes.query_cold_vector.available, false);
    assert.ok(typeof axes.query_cold_vector.reason === 'string');

    // Staleness filter sanity -- proves the warm filter still works after
    // ingest. Either both nulls (pre-v3 schema -- not our case) or both
    // honestly-set booleans.
    if (axes.staleness_filter.default_excludes_stale !== null) {
      assert.equal(axes.staleness_filter.default_excludes_stale, true,
        'default warm-tier search excludes stale_candidate=1 rows');
      assert.equal(axes.staleness_filter.stale_visible_with_flag, true,
        'include_stale=true surfaces stale rows');
    }

    // Artifact written to .ijfw/benchmarks/memory-<ts>.json under root.
    assert.ok(typeof r.artifact_path === 'string');
    assert.ok(existsSync(r.artifact_path), `artifact at ${r.artifact_path}`);
    assert.ok(r.artifact_path.endsWith('.json'));
    assert.ok(r.artifact_path.includes('.ijfw/benchmarks'));

    // Artifact contents round-trip.
    const onDisk = JSON.parse(readFileSync(r.artifact_path, 'utf8'));
    assert.equal(onDisk.schema_version, BENCHMARK_SCHEMA_VERSION);
    assert.equal(onDisk.corpus.docs, r.corpus.docs);
    assert.equal(onDisk.axes.ingest.throughput_rps, r.axes.ingest.throughput_rps);

    // Non-zero file size.
    assert.ok(statSync(r.artifact_path).size > 100);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// --- write:false path (in-memory consumer) ------------------------------

test('benchmark/runBenchmark -- write:false yields results without artifact', async () => {
  // Use a tiny synthetic corpus so the test is fast.
  const corpus = buildSyntheticCorpus(10, 7);
  const r = await runBenchmark({ corpus, write: false, query_runs: 1, warmup: 1 });

  assert.equal(r.artifact_path, undefined, 'no artifact_path when write=false');
  // Synthetic anchors are unique substrings -> recall@1 must be 1.0.
  assert.equal(r.axes.query_warm_fts5.recall['recall@1'], 1.0,
    'unique-anchor synthetic corpus -> recall@1 = 1.0');
  assert.equal(r.corpus.docs, 10);
});

// --- Custom k_set ------------------------------------------------------

test('benchmark/runBenchmark -- honours custom k_set', async () => {
  const corpus = buildSyntheticCorpus(5, 11);
  const r = await runBenchmark({
    corpus,
    write: false,
    query_runs: 1,
    warmup: 0,
    k_set: [1, 10],
  });
  const recall = r.axes.query_warm_fts5.recall;
  assert.ok('recall@1' in recall);
  assert.ok('recall@10' in recall);
  assert.ok(!('recall@3' in recall), 'k=3 not requested -> not present');
  assert.ok(!('recall@5' in recall), 'k=5 not requested -> not present');
});
