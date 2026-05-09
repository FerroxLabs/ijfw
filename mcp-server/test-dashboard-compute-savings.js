#!/usr/bin/env node
// IJFW v1.3.0 alpha -- W1C dashboard populator test.
//
// Verifies scripts/dashboard/server.js exposes a working getComputeSavings()
// that:
//   1. Returns the empty-state shape when the per-project compute db is
//      absent (so the dashboard renders the positive "0 / start using
//      compute:" tile rather than an error).
//   2. Returns the correct totalRuns + byKind grouping when the db has
//      indexed rows.
//
// The fixture writes rows via the canonical compute-module writer
// (mcp-server/src/compute) -- the same path real ijfw_run dispatch uses --
// then asserts the dashboard's reader sees them grouped by source_kind.
//
// Run: node --test mcp-server/test-dashboard-compute-savings.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb, safeWrite, closeDb, dbPathFor } from './src/compute/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_PATH = join(REPO_ROOT, 'scripts', 'dashboard', 'server.js');

// Importing server.js touches HOME state (PID/port files, config). Isolate
// it before import so the test never collides with a running dashboard.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'ijfw-dash-cs-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getComputeSavings } = await import(pathToFileURL(SERVER_PATH).href);

test('getComputeSavings: empty state when compute.db absent', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-cs-empty-'));
  try {
    const result = await getComputeSavings(projectRoot);
    assert.equal(result.totalRuns, 0, 'totalRuns must be 0');
    assert.deepEqual(result.byKind, {}, 'byKind must be empty');
    assert.equal(result.project, projectRoot, 'project label must echo input');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('getComputeSavings: counts and groups raw rows by source_kind', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-cs-pop-'));
  let db;
  try {
    db = await openDb(projectRoot);
    assert.ok(existsSync(dbPathFor(projectRoot)), 'compute.db file created');

    const NOW = Date.now();
    // 5 compute_output, 3 memory_dump, 2 audit_finding -> total 10
    const fixtures = [
      ['compute_output', 5],
      ['memory_dump', 3],
      ['audit_finding', 2],
    ];
    let cursor = 0;
    for (const [kind, n] of fixtures) {
      for (let i = 0; i < n; i++) {
        safeWrite(db, 'raw', {
          source_kind: kind,
          session_id: 'cs-test',
          project_root: projectRoot,
          event_type: 'output',
          body: `${kind} fixture row ${i}`,
          ts: NOW + cursor++,
        });
      }
    }
    // Close before the reader opens it to avoid WAL contention warnings.
    closeDb(db);
    db = null;

    const result = await getComputeSavings(projectRoot);
    assert.equal(result.totalRuns, 10, `totalRuns must be 10, got ${result.totalRuns}`);
    assert.equal(result.byKind.compute_output, 5, 'compute_output count');
    assert.equal(result.byKind.memory_dump, 3, 'memory_dump count');
    assert.equal(result.byKind.audit_finding, 2, 'audit_finding count');
    assert.equal(result.project, projectRoot, 'project label echoes input');
  } finally {
    if (db) closeDb(db);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('getComputeSavings: missing projectRoot returns safe empty shape', async () => {
  const result = await getComputeSavings(undefined);
  assert.equal(result.totalRuns, 0);
  assert.deepEqual(result.byKind, {});
});
