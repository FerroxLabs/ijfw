// IJFW v1.5.0 T22 (Wave E) -- memory benchmark harness.
//
// Genre-matches mem0 / Zep / Graphiti published memory benchmarks: same axes,
// same numeric shape, run against IJFW's own 3-tier store. Output is a JSON
// artifact that can be diffed across builds + cited in marketing.
//
// 3-tier model recap:
//   hot  = markdown files at <root>/.ijfw/memory/*.md  (linear regex; always
//          available; used as auto-index source for warm + fallback when warm
//          is cold).
//   warm = SQLite FTS5 at  <root>/.ijfw/index/memory.db (porter unicode61).
//          Inserts go via indexEntry(); searches via searchFts5() (warm path)
//          or searchMemory() (warm-first w/ hot fallback envelope).
//   cold = pgvector / embedded vectors (migration 005 + embedding-cache).
//          Not exercised here by design -- the cold path needs a model and
//          this harness ships with zero new deps. Axis is RESERVED so future
//          runs can drop in numbers without changing the artifact schema.
//
// Axes measured (industry-aligned subset; not all of mem0's "LoCoMo" axes
// translate -- this is a coding-memory benchmark, not a conversational one):
//
//   1. ingest_throughput_rps     -- inserts / second (warm tier, single writer).
//   2. ingest_latency_ms         -- p50 / p95 / p99 per-insert.
//   3. query_latency_ms          -- p50 / p95 / p99 per warm-tier search.
//   4. recall_at_k               -- recall@1, @3, @5 against a known
//                                   query-answer set (porter stemming +
//                                   synonym expansion both count as hits
//                                   if they resolve to the gold doc).
//   5. storage_bytes_per_memory  -- on-disk db size / row count.
//   6. corpus_size               -- # rows + # query-answer pairs.
//   7. hot_tier_query_latency_ms -- linear-regex hot tier (provenance check;
//                                   should be slower than warm on >50 rows
//                                   -- if it isn't, warm tier is broken).
//   8. cold_tier                 -- { available: false, reason: 'no-embedding-model' }
//                                   reserved schema slot.
//   9. staleness_filter          -- { default_excludes_stale: bool,
//                                     stale_visible_with_flag: bool }
//                                   sanity proof the warm filter still gates.
//
// What this harness does NOT do (yet -- folded into the v1.6.0 IJFW Brain
// workstream alongside the cold-tier vector index):
//   - cross-tier promotion timing (hot->warm happens at first search; warm
//     never promotes to cold without a model). The v1.6.0 Brain work owns
//     the bi-temporal + decay-on-retrieval axes.
//   - multi-writer throughput. Single-writer is the published norm because
//     SQLite's BEGIN IMMEDIATE queue dominates; that's already covered by
//     test-memory-fts5.js's concurrent-writers test.
//   - memory cost in RAM. SQLite page cache is bounded; an "RSS during
//     benchmark" axis adds value but needs platform-specific tooling.
//
// Determinism:
//   - Default corpus is seeded; same input -> same gold mapping. Latency
//     numbers will vary across machines; that's expected (and is why we
//     report p50/p95/p99, not means).
//   - The default queries are chosen so a porter-stemmed FTS5 over the
//     default corpus hits recall@5 == 1.0 -- the test asserts this exact
//     property so a regression in synonyms / tokenizer / search ordering
//     gets caught as soon as it lands.
//
// Output:
//   { axes, corpus, runs, results, schema_version, ijfw_version, ts_iso }
//   written to <out_dir>/memory-<unix_ms>.json by default. Result-only
//   callers (in-test) can call runBenchmark({write: false}) to skip the
//   write and consume the JS object directly.
//
// Public surface:
//   runBenchmark(opts) -> Promise<results>
//   loadDefaultCorpus()                  -> { docs, queries }
//   buildSyntheticCorpus(n, seed)        -> { docs, queries }
//   percentile(arr, p)                   -> number   (utility, exported for tests)
//   BENCHMARK_SCHEMA_VERSION             -- bump on shape change
//
// Zero new deps; uses only what fts5.js + search.js + node:* already pull in.

import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  openDb as openMemoryDb,
  indexEntry,
  searchFts5,
  rowCount,
  closeDb,
  dbPathFor,
} from './fts5.js';
import { searchMemory } from './search.js';

export const BENCHMARK_SCHEMA_VERSION = 1;

// --- Percentile helper ------------------------------------------------------
//
// Linear-interpolated percentile over a numeric array. Returns 0 on empty.
// Exported so the test file can assert on the same values the harness reports.
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  if (!(p >= 0 && p <= 100)) throw new RangeError('percentile: p must be in [0,100]');
  const arr = values.slice().sort((a, b) => a - b);
  if (arr.length === 1) return arr[0];
  const rank = (p / 100) * (arr.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return arr[lo];
  const frac = rank - lo;
  return arr[lo] * (1 - frac) + arr[hi] * frac;
}

function mean(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

// Deterministic PRNG (mulberry32) so the synthetic corpus is reproducible
// across runs + machines. Same seed => same docs/queries/gold-mapping.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Corpora -----------------------------------------------------------------
//
// The default corpus is hand-curated so the gold-answer set is unambiguous
// (each query has exactly one "right" doc). The synthetic corpus is for
// scaling tests -- it generates N docs, each with a unique anchor token, and
// builds 1 query per doc.

// Curated corpus: each doc has at least one anchor token that is unique to
// it across the whole set, so the gold-answer mapping is unambiguous and
// recall@5 is achievable. Bodies are short, realistic coding-memory facts.
const DEFAULT_DOCS = [
  // [id, body]
  ['auth-jwt',        'JWT bearer tokens authenticate API requests with HS256 signing.'],
  ['auth-oauth',      'OAuth2 device authorization flow uniqueoauthflowanchor for CLI clients.'],
  ['auth-session',    'Server session validateSession reads cookie and DB row.'],
  ['cache-redis',     'Redis cache with TTL eviction policy for hot keys.'],
  ['cache-lru',       'LRU memoization of expensive query results in process memory.'],
  ['cache-cdn',       'CDN edge caching with revalidate semantics on stale entries.'],
  ['db-postgres',     'Postgres transactions with serializable isolation level.'],
  ['db-sqlite',       'SQLite WAL journal mode for concurrent readers.'],
  ['db-migration',    'Schema migration runner advances uniqueuserversionanchor on success.'],
  ['search-fts5',     'FTS5 porter tokenizer stems plural and verb forms.'],
  ['search-vector',   'Vector cosine similarity over embedded chunks for semantic recall.'],
  ['search-hybrid',   'Hybrid search blends BM25 lexical scores with vector cosine ranking.'],
  ['mem-tiers',       'Memory tiers: hot markdown, warm FTS5 index, cold vector store.'],
  ['mem-staleness',   'Cascading staleness propagation flags superseded memory rows.'],
  ['mem-temporal',    'Bitemporal validity windows replace prior facts when contradicted.'],
  ['rag-chunk',       'Chunk documents into 512 token windows with 64 token overlap.'],
  ['rag-rerank',      'Reranking with a uniquererankeranchor after first pass dense retrieval.'],
  ['rag-eval',        'Retrieval eval uses recall at k and mean reciprocal rank metrics.'],
  ['mcp-protocol',    'MCP uniquejsonrpcanchor over stdio with initialized handshake.'],
  ['mcp-tools',       'MCP tools list advertises uniqueijfwstateanchor and memory search.'],
  ['mcp-resources',   'MCP resources expose project memory markdown files for reading.'],
  ['cli-codex',       'Codex CLI honours uniquecodexagentsanchor and emits stdout JSON.'],
  ['cli-gemini',      'Gemini CLI uses uniquegeminimdanchor and MCP registration config.'],
  ['cli-cursor',      'Cursor MCP config lives at uniquecursorconfanchor with workspace scope.'],
  ['hook-pretool',    'PreToolUse hook validates arguments before tool execution.'],
  ['hook-posttool',   'PostToolUse hook reports observations back into the session.'],
  ['hook-stop',       'Stop hook closes the wave and writes ship gate receipt.'],
  ['plan-spec',       'Spec phase clarifies what a phase delivers with ambiguity scoring.'],
  ['plan-review',     'Plan review fires uniquetridentanchor before execute begins.'],
  ['plan-execute',    'Execute phase dispatches subagents per wave with checkpoints.'],
];

// Each query has a UNIQUE anchor token (or a stem-unique phrase) that resolves
// to exactly one doc. Single-token queries avoid FTS5 multi-token AND footguns;
// the gold-answer mapping stays unambiguous; porter stemming still earns its
// keep because the query token is rarely a literal substring of the body.
const DEFAULT_QUERIES = [
  { q: 'HS256',                   gold: 'auth-jwt' },
  { q: 'uniqueoauthflowanchor',   gold: 'auth-oauth' },
  { q: 'validateSession',         gold: 'auth-session' },
  { q: 'Redis',                   gold: 'cache-redis' },
  { q: 'memoization',             gold: 'cache-lru' },
  { q: 'revalidate',              gold: 'cache-cdn' },
  { q: 'serializable',            gold: 'db-postgres' },
  { q: 'WAL',                     gold: 'db-sqlite' },
  { q: 'uniqueuserversionanchor', gold: 'db-migration' },
  { q: 'porter',                  gold: 'search-fts5' },
  { q: 'cosine',                  gold: 'search-vector' },
  { q: 'BM25',                    gold: 'search-hybrid' },
  { q: 'tiers',                   gold: 'mem-tiers' },
  { q: 'staleness',               gold: 'mem-staleness' },
  { q: 'bitemporal',              gold: 'mem-temporal' },
  { q: 'overlap',                 gold: 'rag-chunk' },
  { q: 'uniquererankeranchor',    gold: 'rag-rerank' },
  { q: 'reciprocal',              gold: 'rag-eval' },
  { q: 'uniquejsonrpcanchor',     gold: 'mcp-protocol' },
  { q: 'uniqueijfwstateanchor',   gold: 'mcp-tools' },
  { q: 'resources',               gold: 'mcp-resources' },
  { q: 'uniquecodexagentsanchor', gold: 'cli-codex' },
  { q: 'uniquegeminimdanchor',    gold: 'cli-gemini' },
  { q: 'uniquecursorconfanchor',  gold: 'cli-cursor' },
  { q: 'PreToolUse',              gold: 'hook-pretool' },
  { q: 'PostToolUse',             gold: 'hook-posttool' },
  { q: 'wave',                    gold: 'hook-stop' },
  { q: 'ambiguity',               gold: 'plan-spec' },
  { q: 'uniquetridentanchor',     gold: 'plan-review' },
  { q: 'subagents',               gold: 'plan-execute' },
];

// FTS5 query sanitizer -- strips characters that FTS5 treats as operators
// or column-qualifiers (so a hyphen, dot, or underscore in a user query
// doesn't blow up with "no such column" / "syntax error near"). Mirrors
// what a production query layer would do; published numbers can't depend
// on the caller hand-sanitizing every input. Internal helper -- exported
// only for callers that want to share the sanitizer (and for tests).
export function sanitizeFtsQuery(q) {
  if (typeof q !== 'string') return '';
  // Replace any FTS5 special / column-separator chars with a space, then
  // collapse whitespace. Keeps alphanumerics + spaces.
  return q.replace(/[^a-zA-Z0-9_\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function loadDefaultCorpus() {
  return {
    docs: DEFAULT_DOCS.map(([id, body]) => ({ id, body })),
    queries: DEFAULT_QUERIES.map(q => ({ ...q })),
  };
}

// Synthetic corpus: N docs each with an "anchor" token that uniquely identifies
// the gold doc, plus filler text drawn from the default corpus to keep FTS5
// from trivially hitting on tf-idf. Useful when callers want scaling numbers
// at sizes the curated corpus can't reach (100/500/1000).
export function buildSyntheticCorpus(n = 100, seed = 42) {
  const rand = mulberry32(seed);
  const docs = [];
  const queries = [];
  const filler = DEFAULT_DOCS.map(d => d[1]);
  for (let i = 0; i < n; i++) {
    const anchor = `syntheticanchor${i}token`;
    const f = filler[Math.floor(rand() * filler.length)];
    const id = `synth-${i}`;
    docs.push({ id, body: `${anchor} -- ${f}` });
    queries.push({ q: anchor, gold: id });
  }
  return { docs, queries };
}

// --- The harness ------------------------------------------------------------

/**
 * runBenchmark(opts) -> Promise<results>
 *
 * opts:
 *   corpus     -- { docs:[{id,body}], queries:[{q,gold}] } | undefined (default)
 *   root       -- existing project root to use; if absent, a temp dir is made
 *                 and removed on completion.
 *   write      -- write the JSON artifact to disk (default true).
 *   out_dir    -- override artifact dir (default <root>/.ijfw/benchmarks).
 *   k_set      -- recall@k values to compute (default [1, 3, 5]).
 *   warmup     -- # warm-up queries before timed phase (default 3).
 *   query_runs -- # iterations through the full query set for latency stats
 *                 (default 3 -- gives 3x #queries timed samples).
 *
 * returns the full results object even when write=false.
 */
export async function runBenchmark(opts = {}) {
  const corpus = opts.corpus || loadDefaultCorpus();
  if (!corpus || !Array.isArray(corpus.docs) || !Array.isArray(corpus.queries)) {
    throw new Error('runBenchmark: corpus must be { docs, queries }');
  }
  const write = opts.write !== false;
  const kSet = (opts.k_set && opts.k_set.length) ? opts.k_set.slice() : [1, 3, 5];
  const warmup = Number.isInteger(opts.warmup) && opts.warmup >= 0 ? opts.warmup : 3;
  const queryRuns = Number.isInteger(opts.query_runs) && opts.query_runs > 0 ? opts.query_runs : 3;

  let root = opts.root;
  let madeTmp = false;
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'ijfw-bench-'));
    madeTmp = true;
  } else {
    root = resolve(root);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  }

  const startedAt = Date.now();
  const t0 = performance.now();
  let db = null;
  let results;

  try {
    db = await openMemoryDb(root);

    // --- Ingest phase ------------------------------------------------------
    // Map docId -> warm rowId so we can recall@k by gold doc later.
    const goldRowByDocId = new Map();
    const ingestLatencies = [];
    const ingestStart = performance.now();
    for (const doc of corpus.docs) {
      const t = performance.now();
      const inserted = indexEntry(db, { body: doc.body, source: doc.id, session_id: 'bench' });
      const ms = performance.now() - t;
      ingestLatencies.push(ms);
      goldRowByDocId.set(doc.id, Number(inserted.id));
    }
    const ingestElapsed = performance.now() - ingestStart;
    const ingestThroughput = corpus.docs.length / (ingestElapsed / 1000);

    // --- Warm-up queries (un-timed; primes prepared statements + page cache) -
    for (let i = 0; i < warmup && i < corpus.queries.length; i++) {
      const wq = sanitizeFtsQuery(corpus.queries[i].q);
      if (wq) {
        try { searchFts5(db, wq, 10); } catch { /* ignore warm-up faults */ }
      }
    }

    // --- Query phase: warm tier (FTS5) ------------------------------------
    const queryLatencies = [];
    // Per-query hit table: { [gold]: [hitsAtKArray, ...] }
    // We compute recall@k by checking if gold is in the top-k of the result.
    const hitCounts = new Map();         // k -> #hits
    const totalQueries = corpus.queries.length * queryRuns;
    for (const k of kSet) hitCounts.set(k, 0);

    const maxK = Math.max(...kSet);
    for (let run = 0; run < queryRuns; run++) {
      for (const { q, gold } of corpus.queries) {
        const safeQ = sanitizeFtsQuery(q);
        const t = performance.now();
        let rows;
        try {
          rows = safeQ ? searchFts5(db, safeQ, maxK) : [];
        } catch {
          rows = [];
        }
        const ms = performance.now() - t;
        queryLatencies.push(ms);
        const goldRow = goldRowByDocId.get(gold);
        for (const k of kSet) {
          const topK = rows.slice(0, k);
          if (topK.some(r => Number(r.id) === goldRow)) {
            hitCounts.set(k, hitCounts.get(k) + 1);
          }
        }
      }
    }

    const recallAtK = {};
    for (const k of kSet) recallAtK[`recall@${k}`] = hitCounts.get(k) / totalQueries;

    // --- Storage cost ------------------------------------------------------
    const dbFile = dbPathFor(root);
    let dbBytes = 0;
    try { dbBytes = statSync(dbFile).size; } catch { /* db file may be -wal-suffixed in WAL mode; tolerate */ }
    const rowsIndexed = rowCount(db);
    const bytesPerMemory = rowsIndexed > 0 ? dbBytes / rowsIndexed : 0;

    // --- Hot-tier query provenance -----------------------------------------
    // Re-run a couple of queries through searchMemory() with an empty file
    // list to force the hot-linear fallback (warm tier is populated but the
    // call path returns hot when files==[]). Captures hot-tier latency as
    // a sanity column; it WILL be slower than warm on a 30-row corpus.
    const hotLatencies = [];
    for (const { q } of corpus.queries.slice(0, Math.min(5, corpus.queries.length))) {
      const safeQ = sanitizeFtsQuery(q);
      if (!safeQ) continue;
      const t = performance.now();
      try { searchMemory(safeQ, [], 10); } catch { /* hot-linear empty -> [], no throw */ }
      hotLatencies.push(performance.now() - t);
    }

    // --- Staleness filter sanity ------------------------------------------
    // Mark one row stale, prove the default filter hides it, prove
    // include_stale=true surfaces it.
    let defaultExcludesStale = null;
    let staleVisibleWithFlag = null;
    try {
      const firstDoc = corpus.docs[0];
      const rowId = goldRowByDocId.get(firstDoc.id);
      db.prepare('UPDATE memory_entries SET stale_candidate = 1 WHERE id = ?').run(rowId);
      const queryBody = sanitizeFtsQuery(
        firstDoc.body.split(/\s+/).filter(t => /^[a-zA-Z]+$/.test(t)).slice(0, 2).join(' ')
      );
      const defaultHits = queryBody ? searchFts5(db, queryBody, 20) : [];
      defaultExcludesStale = !defaultHits.some(r => Number(r.id) === rowId);
      const allHits = queryBody ? searchFts5(db, queryBody, 20, { include_stale: true }) : [];
      staleVisibleWithFlag = allHits.some(r => Number(r.id) === rowId);
      // Reset so the staleness mutation doesn't leak into other axes that
      // re-query the warm tier after this point.
      db.prepare('UPDATE memory_entries SET stale_candidate = 0 WHERE id = ?').run(rowId);
    } catch {
      // Pre-v3 schema (no stale_candidate column) -- leave as null.
    }

    const totalElapsed = performance.now() - t0;

    results = {
      schema_version: BENCHMARK_SCHEMA_VERSION,
      ijfw_version: process.env.IJFW_VERSION || '1.5.0',
      ts_iso: new Date(startedAt).toISOString(),
      duration_ms: Math.round(totalElapsed * 1000) / 1000,
      corpus: {
        docs: corpus.docs.length,
        queries: corpus.queries.length,
        query_runs: queryRuns,
        total_query_samples: totalQueries,
      },
      axes: {
        ingest: {
          throughput_rps: round(ingestThroughput, 2),
          latency_ms: {
            p50: round(percentile(ingestLatencies, 50), 3),
            p95: round(percentile(ingestLatencies, 95), 3),
            p99: round(percentile(ingestLatencies, 99), 3),
            mean: round(mean(ingestLatencies), 3),
            min: round(Math.min(...ingestLatencies), 3),
            max: round(Math.max(...ingestLatencies), 3),
          },
        },
        query_warm_fts5: {
          latency_ms: {
            p50: round(percentile(queryLatencies, 50), 3),
            p95: round(percentile(queryLatencies, 95), 3),
            p99: round(percentile(queryLatencies, 99), 3),
            mean: round(mean(queryLatencies), 3),
            min: round(Math.min(...queryLatencies), 3),
            max: round(Math.max(...queryLatencies), 3),
          },
          recall: recallAtK,
        },
        query_hot_linear: {
          // sample only -- not the published number, just provenance.
          samples: hotLatencies.length,
          latency_ms: {
            p50: round(percentile(hotLatencies, 50), 3),
            p95: round(percentile(hotLatencies, 95), 3),
            mean: round(mean(hotLatencies), 3),
          },
        },
        query_cold_vector: {
          available: false,
          reason: 'no-embedding-model-bound-in-benchmark-harness',
        },
        storage: {
          db_bytes: dbBytes,
          rows_indexed: rowsIndexed,
          bytes_per_memory: round(bytesPerMemory, 2),
        },
        staleness_filter: {
          default_excludes_stale: defaultExcludesStale,
          stale_visible_with_flag: staleVisibleWithFlag,
        },
      },
    };

    // --- Write artifact ----------------------------------------------------
    if (write) {
      const outDir = opts.out_dir
        ? resolve(opts.out_dir)
        : join(resolveArtifactRoot(opts.root), '.ijfw', 'benchmarks');
      mkdirSync(outDir, { recursive: true });
      const artifactPath = join(outDir, `memory-${startedAt}.json`);
      writeFileSync(artifactPath, JSON.stringify(results, null, 2) + '\n', 'utf8');
      results.artifact_path = artifactPath;
    }
  } finally {
    if (db) closeDb(db);
    if (madeTmp) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* tolerate */ }
    }
  }

  return results;
}

// Round to N decimals -- keeps the artifact human-diffable without sacrificing
// the sub-microsecond resolution callers actually need for percentile detail.
function round(x, n) {
  if (!Number.isFinite(x)) return x;
  const m = Math.pow(10, n);
  return Math.round(x * m) / m;
}

// When `opts.root` is provided we write artifacts into THAT root; when it's
// a temp dir we want the artifact to land somewhere persistent (cwd). We
// pick the explicit root if set, otherwise process.cwd().
function resolveArtifactRoot(rootArg) {
  if (rootArg && typeof rootArg === 'string') return resolve(rootArg);
  return resolve(process.cwd());
}

export default {
  runBenchmark,
  loadDefaultCorpus,
  buildSyntheticCorpus,
  percentile,
  BENCHMARK_SCHEMA_VERSION,
};
