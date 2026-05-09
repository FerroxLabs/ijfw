#!/usr/bin/env node
// IJFW v1.3.0 -- LongMemEval-S baseline harness (V2-M8 / D-PILLAR-SPEC §9).
//
// Establishes the pre-D-pillar retrieval bar so D1+D2 must beat it. We
// run the regex-linear memory layer (mcp-server/src/memory/search.js
// pre-FTS5) over the LongMemEval-S benchmark (ICLR 2025, 500 questions,
// ~40-53 haystack sessions per question, with ground-truth
// `answer_session_ids` per question).
//
// Method:
//   For each question:
//     1. Write each haystack session to a per-question tmp file (markdown
//        body = concatenated turns; title = session_id).
//     2. Build the {path, relpath, title, preview} array the way
//        listMemoryFiles() shapes for the searchMemory() consumer.
//     3. Call searchMemory(question.question, files, limit=10).
//     4. Map top-K result paths -> session_ids. Compute per-question:
//          - hit@5 (any answer_session_id in top 5 results)
//          - hit@10 (any answer_session_id in top 10 results)
//          - reciprocal rank (1/r where r is the rank of the FIRST
//            answer_session_id; 0 if none)
//     5. Aggregate: Recall@5, Recall@10, MRR over all 500 questions.
//
// IMPORTANT for D-pillar baselining: this harness MUST be run on the
// pre-D0 memory layer (commit 42f7aaf or a git worktree of it). The
// alpha-bundle .planning/1.3.0/D-PILLAR-SPEC.md §9 row records the
// resulting numbers as the bar D1+D2 must beat by ≥10% Recall@10.
//
// Fixture provenance: see fixtures/longmemeval-s/README.md (URL +
// download instructions). Data file is gitignored; harness is committed.
//
// Run:
//   node mcp-server/test/longmemeval-baseline.js
//
// Output (stdout):
//   JSON envelope { recall_at_5, recall_at_10, mrr, count, layer, source }
//   plus a human-readable summary line. Exit 0 on success, 1 on any
//   harness error (missing data, search throw, etc). Failed-question
//   counts are reported but do not fail the harness.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURE_PATH = join(__dirname, 'fixtures', 'longmemeval-s', 'longmemeval_s_cleaned.json');

// Resolve both memory-layer search paths used in 1.2.10 / 1.3.0-alpha.2:
//
//  (a) regex-linear (`memory/search.js`) -- the dashboard-server search
//      path. Performs literal substring + regex over markdown body.
//      Used by the IJFW dashboard. Floor measurement.
//
//  (b) BM25 (`search-bm25.js::searchCorpus`) -- the MCP-tool search path
//      used by `ijfw_memory_search`. Tokenized BM25 with stopwords. This
//      is what AI agents hit at runtime.
//
// Both are pre-D0 retrieval. The harness reports them separately so the
// D-pillar spec gets a clear bar to beat (BM25 is the meaningful
// comparison; regex-linear is the floor showing how literal-substring
// fails on natural-language questions).
const { searchMemory } = await import(pathToFileURL(join(REPO_ROOT, 'mcp-server', 'src', 'memory', 'search.js')).href);
const { searchCorpus } = await import(pathToFileURL(join(REPO_ROOT, 'mcp-server', 'src', 'search-bm25.js')).href);

// --- Fixture discovery -----------------------------------------------------

if (!existsSync(FIXTURE_PATH)) {
  console.error(
    `[longmemeval-baseline] fixture missing: ${FIXTURE_PATH}\n` +
    `Download via:\n` +
    `  mkdir -p ${dirname(FIXTURE_PATH)}\n` +
    `  curl -L -o ${FIXTURE_PATH} \\\n` +
    `    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json`
  );
  process.exit(1);
}

const dataset = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
if (!Array.isArray(dataset) || dataset.length === 0) {
  console.error('[longmemeval-baseline] fixture parse error: expected non-empty array');
  process.exit(1);
}
console.log(`# longmemeval-baseline: ${dataset.length} questions loaded`);

// --- Helpers ---------------------------------------------------------------

function sessionToMarkdown(session_id, turns, session_date) {
  // Each session is a list of {role, content, [has_answer]} turns.
  // Concatenate role-prefixed turns into a markdown doc. The first line
  // is the title; downstream search uses that as the relpath title.
  const lines = [`# ${session_id}`, '', `_${session_date}_`, ''];
  for (const t of turns || []) {
    const role = t.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`**${role}:** ${String(t.content || '').replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildFilesForQuestion(qDir, q) {
  // Materialise sessions to disk and return the {path,relpath,title,preview}
  // shape that searchMemory() consumes.
  const files = [];
  const haystack = q.haystack_sessions || [];
  const sessionIds = q.haystack_session_ids || [];
  const dates = q.haystack_dates || [];
  const n = Math.min(haystack.length, sessionIds.length);
  for (let i = 0; i < n; i++) {
    const sid = sessionIds[i];
    const sess = haystack[i];
    const date = dates[i] || '';
    const md = sessionToMarkdown(sid, sess, date);
    const fname = `${String(sid).replace(/[^A-Za-z0-9_.-]/g, '_')}.md`;
    const fpath = join(qDir, fname);
    writeFileSync(fpath, md, 'utf8');
    files.push({
      path: fpath,
      relpath: fname,
      title: String(sid),
      preview: md.slice(0, 300),
    });
  }
  return files;
}

function hitRanksByTitle(results, answerSessionIds) {
  // results: ordered hits with .title === session_id (we set title=sid above)
  // answerSessionIds: array of ground-truth session_ids
  const truth = new Set(answerSessionIds.map(String));
  const ranks = [];
  for (let i = 0; i < results.length; i++) {
    if (truth.has(String(results[i].title))) ranks.push(i + 1);
  }
  return ranks;
}

function hitRanksById(results, answerSessionIds) {
  // For BM25 results, doc.id encodes the session_id (we built it that way).
  const truth = new Set(answerSessionIds.map(String));
  const ranks = [];
  for (let i = 0; i < results.length; i++) {
    if (truth.has(String(results[i].id))) ranks.push(i + 1);
  }
  return ranks;
}

// --- Main run --------------------------------------------------------------

const TOP_K = 10;
const layers = {
  'regex-linear': { recall5: 0, recall10: 0, mrrSum: 0 },
  'bm25': { recall5: 0, recall10: 0, mrrSum: 0 },
};
let countWithTruth = 0;
let countSkippedNoTruth = 0;
let harnessErrors = 0;
const tStart = Date.now();

// One enclosing tmp dir so a single rm cleans the lot.
const root = mkdtempSync(join(tmpdir(), 'longmemeval-baseline-'));

try {
  for (let qi = 0; qi < dataset.length; qi++) {
    const q = dataset[qi];
    const truth = q.answer_session_ids || [];
    if (truth.length === 0) {
      // Abstention questions etc. -- LongMemEval includes some questions
      // marked with empty answer_session_ids (the model is meant to
      // refuse). Retrieval recall is undefined for these; we skip them
      // from the recall denominator and report the skip count.
      countSkippedNoTruth++;
      continue;
    }

    const qDir = join(root, `q${qi}`);
    mkdirSync(qDir, { recursive: true });

    let files;
    try {
      files = buildFilesForQuestion(qDir, q);
    } catch (e) {
      harnessErrors++;
      rmSync(qDir, { recursive: true, force: true });
      continue;
    }

    // (a) Regex-linear path -- mirrors dashboard-server search.
    let regexResults;
    try {
      regexResults = searchMemory(q.question, files, TOP_K);
    } catch (e) {
      harnessErrors++;
      rmSync(qDir, { recursive: true, force: true });
      continue;
    }

    // (b) BM25 path -- mirrors MCP `ijfw_memory_search`. Build the docs
    //     array shape that searchCorpus consumes (id + text), reading
    //     the markdown body we already wrote to disk for path (a).
    const bm25Docs = files.map(f => ({
      id: f.title, // session_id
      text: readFileSync(f.path, 'utf8'),
    }));
    let bm25Results;
    try {
      bm25Results = searchCorpus(q.question, bm25Docs, { limit: TOP_K });
    } catch (e) {
      harnessErrors++;
      rmSync(qDir, { recursive: true, force: true });
      continue;
    }

    // Score both layers.
    const regexRanks = hitRanksByTitle(regexResults, truth);
    const bm25Ranks = hitRanksById(bm25Results, truth);

    if (regexRanks.some(r => r <= 5))  layers['regex-linear'].recall5++;
    if (regexRanks.some(r => r <= 10)) layers['regex-linear'].recall10++;
    if (regexRanks.length > 0) layers['regex-linear'].mrrSum += 1 / Math.min(...regexRanks);

    if (bm25Ranks.some(r => r <= 5))  layers['bm25'].recall5++;
    if (bm25Ranks.some(r => r <= 10)) layers['bm25'].recall10++;
    if (bm25Ranks.length > 0) layers['bm25'].mrrSum += 1 / Math.min(...bm25Ranks);

    countWithTruth++;

    // Per-question cleanup -- we don't want 26k stale files at the end.
    rmSync(qDir, { recursive: true, force: true });

    if ((qi + 1) % 50 === 0) {
      const r10 = layers['regex-linear'].recall10;
      const b10 = layers['bm25'].recall10;
      console.log(
        `  progress ${qi + 1}/${dataset.length}: ` +
        `regex r@10=${(r10 / countWithTruth * 100).toFixed(1)}% ` +
        `bm25 r@10=${(b10 / countWithTruth * 100).toFixed(1)}%`
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);

function summarise(s) {
  return {
    recall_at_5: countWithTruth > 0 ? Number((s.recall5 / countWithTruth).toFixed(4)) : 0,
    recall_at_10: countWithTruth > 0 ? Number((s.recall10 / countWithTruth).toFixed(4)) : 0,
    mrr: countWithTruth > 0 ? Number((s.mrrSum / countWithTruth).toFixed(4)) : 0,
  };
}
const regexSummary = summarise(layers['regex-linear']);
const bm25Summary = summarise(layers['bm25']);
// Back-compat single-number convenience: brief asks for "Recall@5/10 + MRR"
// rows in D-PILLAR-SPEC §9 -- pick BM25 (the MCP-tool path users actually
// hit) as the headline; keep regex-linear as a labelled secondary row.
const recallAt5 = bm25Summary.recall_at_5;
const recallAt10 = bm25Summary.recall_at_10;
const mrr = bm25Summary.mrr;

const envelope = {
  fixture: 'longmemeval-s (cleaned, 2025-09)',
  fixture_url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned',
  count_total: dataset.length,
  count_evaluated: countWithTruth,
  count_skipped_abstention: countSkippedNoTruth,
  count_harness_errors: harnessErrors,
  layers: {
    regex_linear: {
      search_module: 'mcp-server/src/memory/search.js',
      role: 'dashboard-server search path (literal-substring floor)',
      ...regexSummary,
    },
    bm25: {
      search_module: 'mcp-server/src/search-bm25.js',
      role: 'MCP `ijfw_memory_search` tool path (tokenised BM25)',
      ...bm25Summary,
    },
  },
  // Headline (BM25 -- the MCP-tool path users actually hit).
  recall_at_5: recallAt5,
  recall_at_10: recallAt10,
  mrr: mrr,
  elapsed_sec: Number(elapsedSec),
};

console.log(JSON.stringify(envelope, null, 2));
console.log(
  `# longmemeval-baseline (regex-linear): ` +
  `R@5=${(regexSummary.recall_at_5 * 100).toFixed(1)}% ` +
  `R@10=${(regexSummary.recall_at_10 * 100).toFixed(1)}% ` +
  `MRR=${(regexSummary.mrr * 100).toFixed(1)}% ` +
  `over ${countWithTruth}/${dataset.length} q (${elapsedSec}s)`
);
console.log(
  `# longmemeval-baseline (bm25):         ` +
  `R@5=${(recallAt5 * 100).toFixed(1)}% ` +
  `R@10=${(recallAt10 * 100).toFixed(1)}% ` +
  `MRR=${(mrr * 100).toFixed(1)}% ` +
  `over ${countWithTruth}/${dataset.length} q (${elapsedSec}s)`
);

if (harnessErrors > 0) {
  console.error(`# WARNING: ${harnessErrors} questions hit harness errors`);
  process.exit(1);
}
process.exit(0);
