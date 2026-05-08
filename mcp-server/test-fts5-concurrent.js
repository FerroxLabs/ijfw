#!/usr/bin/env node
/**
 * test-fts5-concurrent.js -- H2 concurrent-write race regression.
 *
 * Spawns N child processes that each call openDb + safeWrite against the
 * SAME db path in parallel. With BEGIN IMMEDIATE + busy_timeout=5000 the
 * writers should serialise without surfacing SQLITE_BUSY to the caller.
 *
 * Asserts:
 *   - All children exit 0
 *   - No "SQLITE_BUSY" in stdout/stderr
 *   - All N rows are present afterwards (final count check)
 *
 * Zero external deps; ESM.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const N_WRITERS = 4;
const ROWS_PER_WRITER = 6;

async function main() {
  console.log('=== fts5 concurrent-write regression ===');

  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-concurrent-'));
  // Worker script: each child runs this against the same projectRoot.
  const worker = `
    import { openDb, safeWrite, closeDb } from '${join(__dirname, 'src', 'compute', 'index.js')}';
    const projectRoot = process.argv[2];
    const writerId = process.argv[3];
    const n = ${ROWS_PER_WRITER};
    let db;
    try {
      db = await openDb(projectRoot);
      for (let i = 0; i < n; i++) {
        safeWrite(db, 'raw', {
          source_kind: 'tool_result',
          session_id: 'concurrent-' + writerId,
          project_root: projectRoot,
          event_type: 'output',
          body: 'writer=' + writerId + ' i=' + i,
          ts: Date.now(),
        });
      }
      console.log('WRITER_OK ' + writerId);
    } catch (e) {
      console.error('WRITER_FAIL ' + writerId + ' ' + (e && e.code) + ' ' + (e && e.message));
      process.exit(1);
    } finally {
      try { closeDb(db); } catch {}
    }
  `;
  const workerPath = join(projectRoot, 'worker.mjs');
  writeFileSync(workerPath, worker);

  const children = [];
  for (let i = 0; i < N_WRITERS; i++) {
    children.push(new Promise((resolve) => {
      const c = spawn(process.execPath, [workerPath, projectRoot, String(i)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => { out += d.toString('utf8'); });
      c.stderr.on('data', (d) => { err += d.toString('utf8'); });
      c.on('close', (code) => resolve({ code, out, err, id: i }));
    }));
  }

  const results = await Promise.all(children);
  let pass = 0;
  let fail = 0;

  for (const r of results) {
    const busy = /SQLITE_BUSY/i.test(r.out) || /SQLITE_BUSY/i.test(r.err);
    if (r.code === 0 && !busy) {
      console.log(`  [PASS] writer ${r.id} exit=0 no SQLITE_BUSY`);
      pass++;
    } else {
      console.log(`  [FAIL] writer ${r.id} exit=${r.code} busy=${busy}`);
      console.log(`         stdout=${r.out.slice(0, 200)}`);
      console.log(`         stderr=${r.err.slice(0, 200)}`);
      fail++;
    }
  }

  // Verify total rows.
  try {
    const { openDb, closeDb } = await import('./src/compute/index.js');
    const db = await openDb(projectRoot);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM raw").get();
      const expected = N_WRITERS * ROWS_PER_WRITER;
      if (row && Number(row.n) === expected) {
        console.log(`  [PASS] total rows == ${expected} (got ${row.n})`);
        pass++;
      } else {
        console.log(`  [FAIL] total rows mismatch: expected=${expected} got=${row && row.n}`);
        fail++;
      }
    } finally {
      closeDb(db);
    }
  } catch (e) {
    console.log(`  [FAIL] could not verify final row count: ${e && e.message}`);
    fail++;
  }

  rmSync(projectRoot, { recursive: true, force: true });
  console.log(`\nconcurrent: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('test-fts5-concurrent crashed:', e && e.stack || e);
  process.exit(2);
});
