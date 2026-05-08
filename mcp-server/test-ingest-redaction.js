#!/usr/bin/env node
/**
 * test-ingest-redaction.js -- D-PILLAR-SPEC §12 ingest scrub gate (real
 * fix-wave C3).
 *
 * Verifies that secrets are stripped at the observation-ingest boundary
 * by `redactSecrets()` BEFORE storage, not after. The ingest scrub is the
 * security gate; downstream `kg_nodes.redacted=1` is a residual safety
 * belt for entity-name-coincidentally-matches-secret-shape cases only.
 *
 * Tests:
 *   1. compute safeWrite scrubs sk_live_* in body before storage
 *   2. compute safeWrite scrubs sk-proj-* OpenAI keys in body
 *   3. memory indexEntry scrubs body before storage
 *   4. FTS5 search for the original secret string returns no rows
 *   5. IJFW_INGEST_SCRUB=0 disables scrubbing (returns raw)
 *   6. extractEntities + auto-index see the SCRUBBED body, not the
 *      original -- so kg_nodes never persists secret-shaped values
 *      that came in as ingest body content
 *   7. Non-secret content passes through unchanged
 *
 * Run: node --test mcp-server/test-ingest-redaction.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb as openComputeDb,
  closeDb as closeComputeDb,
  safeWrite,
  search as computeSearch,
} from './src/compute/fts5.js';
import {
  openDb as openMemoryDb,
  closeDb as closeMemoryDb,
  indexEntry,
  searchFts5,
  __getLastAutoIndexPromise,
} from './src/memory/fts5.js';
import { extractEntities } from './src/compute/extract.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

// Test secrets -- shaped like real keys but obviously synthetic. Each is
// long enough to trip the redactor's minimum-length floors.
const STRIPE_LIVE = 'sk_live_TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ';
const OPENAI_PROJ = 'sk-proj-TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// --- Test 1: compute safeWrite scrubs Stripe sk_live_ before storage ---
test('safeWrite scrubs sk_live_* body before INSERT', async () => {
  delete process.env.IJFW_INGEST_SCRUB; // ensure default-on
  const root = tmpRoot('ingest-scrub-stripe');
  let db;
  try {
    db = await openComputeDb(root);
    const body = `payment failed; ${STRIPE_LIVE} should be redacted; rest of message`;
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's-stripe',
      project_root: root,
      body,
      ts: Date.now(),
    });

    // The persisted body must not contain the original secret.
    const row = db.prepare('SELECT body FROM raw WHERE session_id = ?').get('s-stripe');
    assert.ok(row, 'row inserted');
    assert.doesNotMatch(row.body, /TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ/,
      'original secret string must not appear in stored body');
    assert.match(row.body, /\[REDACTED:stripe\]/,
      'stored body carries [REDACTED:stripe] placeholder');
    assert.match(row.body, /payment failed/, 'non-secret prefix survives');
    assert.match(row.body, /rest of message/, 'non-secret suffix survives');
  } finally {
    closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Test 2: compute safeWrite scrubs OpenAI sk-proj- ----------------
test('safeWrite scrubs sk-proj-* OpenAI body before INSERT', async () => {
  delete process.env.IJFW_INGEST_SCRUB;
  const root = tmpRoot('ingest-scrub-openai');
  let db;
  try {
    db = await openComputeDb(root);
    const body = `gpt-4 call: key=${OPENAI_PROJ} returned 200`;
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's-openai',
      project_root: root,
      body,
      ts: Date.now(),
    });

    const row = db.prepare('SELECT body FROM raw WHERE session_id = ?').get('s-openai');
    assert.ok(row);
    assert.doesNotMatch(row.body, /TESTABC123DEFGHIJKLMN/,
      'original OpenAI key body must not survive ingest');
    assert.match(row.body, /\[REDACTED:openai\]/,
      'stored body carries [REDACTED:openai] placeholder');
  } finally {
    closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Test 3: memory indexEntry scrubs body --------------------------
test('memory indexEntry scrubs body before INSERT', async () => {
  delete process.env.IJFW_INGEST_SCRUB;
  const root = tmpRoot('ingest-scrub-memory');
  let db;
  try {
    db = await openMemoryDb(root);
    const body = `lessons learned: ${STRIPE_LIVE} leaked once; do not repeat`;
    indexEntry(db, { body, source: 'lessons.md' });

    const row = db.prepare('SELECT body, source FROM memory_entries').get();
    assert.ok(row);
    assert.doesNotMatch(row.body, /TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ/,
      'original secret must not appear in memory_entries body');
    assert.match(row.body, /\[REDACTED:stripe\]/,
      'memory body carries [REDACTED:stripe] placeholder');
    assert.equal(row.source, 'lessons.md', 'clean file-path source untouched');
  } finally {
    closeMemoryDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Test 4: FTS5 search for the original secret returns nothing ----
test('FTS5 search for original secret returns zero rows after scrub', async () => {
  delete process.env.IJFW_INGEST_SCRUB;
  const root = tmpRoot('ingest-scrub-search');
  let db;
  try {
    db = await openComputeDb(root);
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's-search',
      project_root: root,
      body: `secret was ${STRIPE_LIVE} oops`,
      ts: Date.now(),
    });

    // Quote the secret as an FTS5 phrase so internal underscores don't
    // confuse the tokenizer; underscores are word chars so MATCH 'sk_live_*'
    // would tokenize anyway, but the phrase form is the cleanest assertion.
    const hits = computeSearch(db, 'raw', `"${STRIPE_LIVE}"`, 10);
    assert.equal(hits.length, 0,
      `search for original secret must return zero rows (got ${hits.length})`);

    // Sanity check: the row exists, it's just been scrubbed.
    const total = db.prepare('SELECT COUNT(*) AS n FROM raw').get();
    assert.equal(Number(total.n), 1, 'row was inserted (just with scrubbed body)');

    // And we can find it by the non-secret content.
    const oops = computeSearch(db, 'raw', 'oops', 10);
    assert.equal(oops.length, 1, 'non-secret content still searchable');
  } finally {
    closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Test 5: IJFW_INGEST_SCRUB=0 disables scrubbing -----------------
test('IJFW_INGEST_SCRUB=0 disables ingest-time scrubbing', async () => {
  const root = tmpRoot('ingest-scrub-off');
  let computeDb, memoryDb;
  const prev = process.env.IJFW_INGEST_SCRUB;
  process.env.IJFW_INGEST_SCRUB = '0';
  try {
    computeDb = await openComputeDb(root);
    safeWrite(computeDb, 'raw', {
      source_kind: 'tool_result',
      session_id: 's-off',
      project_root: root,
      body: `raw secret ${STRIPE_LIVE} preserved`,
      ts: Date.now(),
    });
    const row = computeDb.prepare('SELECT body FROM raw WHERE session_id = ?').get('s-off');
    assert.ok(row);
    assert.match(row.body, new RegExp(STRIPE_LIVE),
      'opt-out: secret survives in compute body when scrub is disabled');

    memoryDb = await openMemoryDb(root);
    indexEntry(memoryDb, { body: `also raw ${STRIPE_LIVE} here`, source: 'x' });
    const memRow = memoryDb.prepare('SELECT body FROM memory_entries').get();
    assert.ok(memRow);
    assert.match(memRow.body, new RegExp(STRIPE_LIVE),
      'opt-out: secret survives in memory body when scrub is disabled');
  } finally {
    if (prev === undefined) delete process.env.IJFW_INGEST_SCRUB;
    else process.env.IJFW_INGEST_SCRUB = prev;
    closeComputeDb(computeDb);
    closeMemoryDb(memoryDb);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Test 6: extractEntities + auto-index see scrubbed body ---------
test('extractEntities + auto-index never see original secret value', async () => {
  delete process.env.IJFW_INGEST_SCRUB;
  const root = tmpRoot('ingest-scrub-graph');
  let db;
  try {
    db = await openComputeDb(root);
    // Body contains a real file path entity AND a secret. After ingest
    // scrub, the file path remains; the secret is replaced with the
    // [REDACTED:stripe] placeholder. The auto-index should extract the
    // file path entity but never the secret value.
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's-graph',
      project_root: root,
      body: `src/auth/login.js loaded ${STRIPE_LIVE} during boot`,
      ts: Date.now(),
    });

    // Confirm the scrubbed body is what extractEntities would see.
    const row = db.prepare('SELECT body FROM raw WHERE session_id = ?').get('s-graph');
    const ents = extractEntities(row.body, { minMentions: 1 });

    // No entity carries the original secret string as its name.
    for (const e of ents) {
      assert.doesNotMatch(String(e.name), /TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ/,
        `entity name ${e.kind}=${e.name} must not contain raw secret`);
    }

    // kg_nodes (populated by safeWrite's auto-index helper, which fires
    // synchronously on the compute side) must not contain the secret.
    const nodes = db.prepare('SELECT name FROM kg_nodes').all();
    for (const n of nodes) {
      assert.doesNotMatch(String(n.name), /TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ/,
        `kg_nodes row ${n.name} must not contain raw secret`);
    }
  } finally {
    closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Test 7: Non-secret content passes through unchanged ------------
test('non-secret content passes through ingest unchanged', async () => {
  delete process.env.IJFW_INGEST_SCRUB;
  const root = tmpRoot('ingest-scrub-clean');
  let computeDb, memoryDb;
  try {
    const cleanBody =
      'authLogin called validateToken at src/auth/login.js; ' +
      'returned 200 with user_id=42; MAX_RETRY_COUNT held at 3';

    computeDb = await openComputeDb(root);
    safeWrite(computeDb, 'raw', {
      source_kind: 'tool_result',
      session_id: 's-clean',
      project_root: root,
      body: cleanBody,
      ts: Date.now(),
    });
    const row = computeDb.prepare('SELECT body FROM raw WHERE session_id = ?').get('s-clean');
    assert.equal(row.body, cleanBody, 'clean compute body unchanged byte-for-byte');

    memoryDb = await openMemoryDb(root);
    indexEntry(memoryDb, { body: cleanBody, source: 'src/auth/login.js' });
    const memRow = memoryDb.prepare('SELECT body, source FROM memory_entries').get();
    assert.equal(memRow.body, cleanBody, 'clean memory body unchanged byte-for-byte');
    assert.equal(memRow.source, 'src/auth/login.js', 'clean source unchanged');
  } finally {
    closeComputeDb(computeDb);
    closeMemoryDb(memoryDb);
    rmSync(root, { recursive: true, force: true });
  }
});
