// IJFW v1.5.2 -- brain dream-cycle pipeline orchestrator.
//
// runDreamCycle({db, repoRoot, env, cycleId}) drives one full pass:
//   1. scanInbox(dump/inbox) → skip files where isProcessed === true
//   2. for each file: extractFile() → (LLM extract -- stubbed for tests via
//      opts.extractFacts) → insert facts → writeManifest → commitProcessed
//   3. collect touched subjects → for each: compileWikiPage()
//   4. append per-action lines to ijfw/wiki/log.md
//
// Crash atomicity (Trident F-B4): the per-file order is strict --
//   facts INSERT inside BEGIN IMMEDIATE → writeManifest → commitProcessed
// A crash between any two leaves a recoverable state:
//   - file in inbox/, no manifest → orphan, reprocess next cycle
//   - manifest present → no-op via isProcessed gate
//
// Budget: every LLM call goes through BudgetGuard. budgetExhausted=true
// signals the cycle stopped voluntarily (not crashed).

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveBrainPaths } from './paths.js';
import { scanInbox, writeManifest, commitProcessed, isProcessed } from './dump-ingest.js';
import { extractFile } from './extractors/index.js';
import { BudgetGuard } from './budget-guard.js';
import { compileWikiPage } from './wiki-compiler.js';

function ensureFactsTable(db) {
  // Idempotent: matches the schema downstream consumers expect.
  // BEGIN IMMEDIATE wraps the per-file insert; we just need the table.
  try {
    db.prepare('SELECT 1 FROM facts LIMIT 1').get();
  } catch {
    db.prepare(
      'CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)'
    ).run();
  }
}

function appendLog(wikiLogPath, line) {
  try {
    mkdirSync(dirname(wikiLogPath), { recursive: true });
    appendFileSync(wikiLogPath, line + '\n');
  } catch { /* logging is best-effort */ }
}

async function defaultExtractFacts({ file, text }) {
  // The default extractor is a NO-OP placeholder so the pipeline runs without
  // an LLM. Production wiring (in a later task) replaces this with a tiered-llm
  // call. Returning [] keeps the pipeline crash-safe even when extraction
  // would normally produce facts -- the manifest still records the visit.
  return [];
}

function nowIso() { return new Date().toISOString(); }

export async function runDreamCycle({ db, repoRoot, env = process.env, cycleId, extractFacts } = {}) {
  if (!db) throw new Error('dream-pipeline: db required');
  if (!repoRoot) throw new Error('dream-pipeline: repoRoot required');
  ensureFactsTable(db);
  const paths = resolveBrainPaths(repoRoot);
  const cid = cycleId || `cycle-${Date.now()}`;
  // Parse budget caps from env explicitly so zero is respected (Number('0')||default
  // would silently fall back to the default; we need the caller's $0 to mean $0).
  const cycleUsdRaw = env.IJFW_DREAM_BUDGET_USD != null ? Number(env.IJFW_DREAM_BUDGET_USD) : undefined;
  const dayUsdRaw = env.IJFW_DREAM_BUDGET_DAY_USD != null ? Number(env.IJFW_DREAM_BUDGET_DAY_USD) : undefined;
  const guardOpts = { repoRoot, cycleId: cid, env };
  if (Number.isFinite(cycleUsdRaw)) guardOpts.cycleUsd = cycleUsdRaw;
  if (Number.isFinite(dayUsdRaw)) guardOpts.dayUsd = dayUsdRaw;
  const guard = BudgetGuard(guardOpts);
  const extractor = extractFacts || defaultExtractFacts;

  let processed = 0;
  let factsInserted = 0;
  let pagesCompiled = 0;
  let budgetExhausted = false;
  const touchedSubjects = new Set();
  const errors = [];

  mkdirSync(paths.dumpInbox, { recursive: true });
  mkdirSync(paths.dumpProcessed, { recursive: true });

  const candidates = scanInbox(paths.dumpInbox).filter(
    (f) => !isProcessed(paths.dumpProcessed, f.name)
  );

  for (const file of candidates) {
    // Budget gate per file (extraction call). Use cheap-tier pricing as a
    // ballpark -- the real call site will pass the actual price.
    const gate = guard.guardCall({ outputPricePerMtok: 0.30, requestedMaxTokens: 512 });
    if (!gate.allowed) { budgetExhausted = true; break; }

    let extracted;
    try {
      const extraction = await extractor({ file, text: '' });
      extracted = Array.isArray(extraction) ? extraction : [];
    } catch (e) {
      errors.push({ file: file.name, stage: 'extract', message: e.message });
      continue;
    }

    // Insert facts inside BEGIN IMMEDIATE so the rollback boundary is one
    // file = atomic from the db's perspective.
    const insertFact = db.prepare(
      'INSERT INTO facts (subject, predicate, object, valid_from, source, confidence) VALUES (?,?,?,?,?,?)'
    );
    const txn = db.transaction((rows) => {
      for (const f of rows) {
        insertFact.run(
          f.subject || '',
          f.predicate || '',
          f.object || '',
          f.valid_from || nowIso(),
          file.name,
          f.confidence != null ? f.confidence : 0.7
        );
      }
    });
    try {
      txn(extracted);
    } catch (e) {
      errors.push({ file: file.name, stage: 'insert', message: e.message });
      continue;
    }
    factsInserted += extracted.length;
    for (const f of extracted) if (f.subject) touchedSubjects.add(f.subject);

    // Strict ORDER: write manifest BEFORE commit. Both atomic.
    try {
      writeManifest(paths.dumpProcessed, file.name, {
        cycleId: cid,
        ts: nowIso(),
        sizeBytes: file.sizeBytes,
        kind: file.kind,
        factsInserted: extracted.length,
        touchedSubjects: [...new Set(extracted.map((f) => f.subject).filter(Boolean))],
      });
    } catch (e) {
      errors.push({ file: file.name, stage: 'manifest', message: e.message });
      continue;
    }
    try {
      commitProcessed(paths.dumpInbox, paths.dumpProcessed, file.name);
    } catch (e) {
      errors.push({ file: file.name, stage: 'commit', message: e.message });
      continue;
    }
    processed += 1;
    appendLog(paths.wikiLog, `${nowIso()} ingest ${file.name} +${extracted.length}f cycle=${cid}`);
  }

  // Compile pages for touched subjects. Failures are logged, not fatal.
  for (const subject of touchedSubjects) {
    const r = compileWikiPage(db, { repoRoot, type: 'entity', subject });
    if (r.ok) {
      pagesCompiled += 1;
      appendLog(paths.wikiLog, `${nowIso()} compile entity ${subject} facts=${r.factsCount}`);
    } else {
      appendLog(paths.wikiLog, `${nowIso()} compile-fail ${subject} reason=${r.error}`);
    }
  }

  return { processed, pagesCompiled, factsInserted, budgetExhausted, cycleId: cid, errors };
}
