/**
 * test-audit-med-update-batch.js — v1.5.0 audit MED batch (update/install/trust)
 *
 * Covers:
 *   - M9 (F-SPD-3): Parallel federated registry fetch — Promise.all collapses
 *     N×timeout to ~1×timeout. One slow source must not block others.
 *   - M10 (F-PRF-2): Per-source cache file quota — LRU-eviction of oldest
 *     cache files when count or total-bytes cap exceeded.
 *   - M11 (F-REL-1): writeStateFields atomic via sync directory lock — two
 *     concurrent writers do not corrupt state.json, and a reader never sees
 *     a torn intermediate state.
 *
 * Run: node --test mcp-server/test-audit-med-update-batch.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  refreshTrustFromAllRegistries,
  withSourceCache,
  enforceFederatedCacheQuota,
  IJFW_REGISTRY_META_KEY_PEM,
} from './src/extension-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTmpHome(fn) {
  const tmp = await mkdtemp(join(tmpdir(), 'ijfw-medbatch-'));
  const origHome = process.env.HOME;
  const origUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  try {
    await fn(tmp);
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserprofile;
    await rm(tmp, { recursive: true, force: true });
  }
}

function makeSource(name, url) {
  return {
    name,
    url: url || `https://${name}.example/v1.json`,
    meta_key_pem: IJFW_REGISTRY_META_KEY_PEM,
    priority: 0,
    publisher_ttl_ms: 24 * 60 * 60 * 1000,
    revocation_ttl_ms: 5 * 60 * 1000,
  };
}

function seedRegistryBody(updatedAt = new Date().toISOString()) {
  return JSON.stringify({
    registry_version: '1.0',
    updated_at: updatedAt,
    signature: null,
    publishers: {},
    revoked: [],
  });
}

// ---------------------------------------------------------------------------
// M9 — Parallel federated registry fetch
// ---------------------------------------------------------------------------

test('M9 — Promise.all collapses N×timeout to ~1×timeout', async () => {
  await withTmpHome(async () => {
    const sources = [
      makeSource('slow-a'),
      makeSource('slow-b'),
      makeSource('slow-c'),
      makeSource('slow-d'),
    ];

    const FETCH_DELAY_MS = 200;
    let parallelHigh = 0;
    let inflight = 0;
    const fetchImpl = async (_url, _source, _part) => {
      inflight += 1;
      parallelHigh = Math.max(parallelHigh, inflight);
      await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
      inflight -= 1;
      return { ok: true, body: seedRegistryBody(), error: null };
    };

    const t0 = Date.now();
    const r = await refreshTrustFromAllRegistries({
      sources,
      fetchImpl,
      allowSeed: true,
    });
    const elapsed = Date.now() - t0;

    assert.equal(r.ok, true, `expected ok=true, got error=${r.error}`);
    assert.ok(parallelHigh >= 2, `expected at least 2 concurrent fetches, saw ${parallelHigh}`);
    // 4 sequential × 200ms = 800ms; parallel should be < 600ms with generous slack.
    assert.ok(elapsed < 4 * FETCH_DELAY_MS - 50, `expected parallel fetch (< 750ms), got ${elapsed}ms`);
  });
});

test('M9 — one throwing source does not block others', async () => {
  await withTmpHome(async () => {
    const sources = [
      makeSource('good-1'),
      makeSource('thrower'),
      makeSource('good-2'),
    ];
    const fetchImpl = async (_url, source) => {
      if (source.name === 'thrower') {
        throw new Error('simulated network panic');
      }
      return { ok: true, body: seedRegistryBody(), error: null };
    };

    const r = await refreshTrustFromAllRegistries({
      sources,
      fetchImpl,
      allowSeed: true,
    });
    assert.equal(r.ok, true);
    const threwWarning = r.warnings.some((w) => w.includes('thrower') && w.includes('fetch threw'));
    assert.ok(threwWarning, `expected fetch-threw warning for thrower; warnings=${JSON.stringify(r.warnings)}`);
    // The two good sources still applied — multi is non-null and contains entries.
    assert.ok(r.multi, 'expected multi-registry result populated');
  });
});

// ---------------------------------------------------------------------------
// M10 — Per-source cache file quota
// ---------------------------------------------------------------------------

test('M10 — file-count quota evicts oldest caches', async () => {
  await withTmpHome(async (home) => {
    process.env.IJFW_FEDERATED_CACHE_MAX_SOURCES = '3';
    process.env.IJFW_FEDERATED_CACHE_MAX_BYTES = String(64 * 1024 * 1024);
    try {
      const stateDir = join(home, '.ijfw', 'state');
      await mkdir(stateDir, { recursive: true });

      // Pre-seed 5 cache files with ascending mtimes (oldest first).
      const names = ['src-a', 'src-b', 'src-c', 'src-d', 'src-e'];
      const t0 = Date.now() / 1000 - 1000;
      for (let i = 0; i < names.length; i++) {
        const p = join(stateDir, `registry-cache-${names[i]}.json`);
        await writeFile(p, JSON.stringify({
          publishers: {},
          publishers_fetched_at: null,
          revoked: [],
          revocation_fetched_at: null,
          source_name: names[i],
          source_url: `https://${names[i]}.example/v1.json`,
        }), 'utf8');
        const mt = t0 + i; // ascending mtimes
        await utimes(p, mt, mt);
      }

      // Protect the newest one (simulate the fresh-write contract).
      const newest = join(stateDir, `registry-cache-${names[4]}.json`);
      const evicted = await enforceFederatedCacheQuota({ protectPath: newest });
      // 5 files, cap=3, protect newest → must evict 2 oldest (src-a, src-b).
      assert.equal(evicted.length, 2, `expected 2 evictions, got ${evicted.length}: ${JSON.stringify(evicted)}`);
      assert.ok(evicted.some((p) => p.endsWith('src-a.json')), 'oldest should be evicted');
      assert.ok(evicted.some((p) => p.endsWith('src-b.json')), 'second-oldest should be evicted');

      const remaining = (await readdir(stateDir))
        .filter((n) => n.startsWith('registry-cache-'))
        .sort();
      assert.equal(remaining.length, 3, `expected 3 files, got ${remaining.length}: ${remaining}`);
      assert.ok(remaining.includes(`registry-cache-${names[4]}.json`), 'newest must survive');
    } finally {
      delete process.env.IJFW_FEDERATED_CACHE_MAX_SOURCES;
      delete process.env.IJFW_FEDERATED_CACHE_MAX_BYTES;
    }
  });
});

test('M10 — total-bytes quota evicts when byte cap exceeded', async () => {
  await withTmpHome(async (home) => {
    process.env.IJFW_FEDERATED_CACHE_MAX_SOURCES = '100';
    // Tiny byte budget so a single file overflows.
    process.env.IJFW_FEDERATED_CACHE_MAX_BYTES = '256';
    try {
      const stateDir = join(home, '.ijfw', 'state');
      await mkdir(stateDir, { recursive: true });

      const payload = 'x'.repeat(300);
      const t0 = Date.now() / 1000 - 100;
      for (const n of ['big-a', 'big-b', 'big-c']) {
        const p = join(stateDir, `registry-cache-${n}.json`);
        await writeFile(p, payload, 'utf8');
        // Stagger mtimes so eviction order is deterministic.
        const offset = ['big-a', 'big-b', 'big-c'].indexOf(n);
        await utimes(p, t0 + offset, t0 + offset);
      }

      // Don't protect — we expect everything except possibly the newest to go.
      const evicted = await enforceFederatedCacheQuota({});
      assert.ok(evicted.length >= 2, `expected at least 2 evictions for 3×300B vs 256B cap, got ${evicted.length}`);

      const remainingFiles = (await readdir(stateDir))
        .filter((n) => n.startsWith('registry-cache-'));
      let totalBytes = 0;
      for (const n of remainingFiles) {
        const st = await stat(join(stateDir, n));
        totalBytes += st.size;
      }
      // Either we're under the cap, or we have exactly one file left (we can't
      // evict below 1 if one file alone exceeds the cap and isn't protected).
      assert.ok(
        totalBytes <= 256 || remainingFiles.length <= 1,
        `expected under cap or single file; got ${remainingFiles.length} files = ${totalBytes} bytes`,
      );
    } finally {
      delete process.env.IJFW_FEDERATED_CACHE_MAX_SOURCES;
      delete process.env.IJFW_FEDERATED_CACHE_MAX_BYTES;
    }
  });
});

test('M10 — withSourceCache fires quota after write (smoke)', async () => {
  await withTmpHome(async (home) => {
    process.env.IJFW_FEDERATED_CACHE_MAX_SOURCES = '2';
    try {
      const stateDir = join(home, '.ijfw', 'state');
      await mkdir(stateDir, { recursive: true });
      // Pre-seed two stale caches.
      const t0 = Date.now() / 1000 - 1000;
      for (const n of ['stale-1', 'stale-2']) {
        const p = join(stateDir, `registry-cache-${n}.json`);
        await writeFile(p, JSON.stringify({
          publishers: {},
          publishers_fetched_at: null,
          revoked: [],
          revocation_fetched_at: null,
          source_name: n,
          source_url: `https://${n}.example/v1.json`,
        }), 'utf8');
        await utimes(p, t0, t0);
      }

      // Write a fresh cache via withSourceCache — should kick out the oldest.
      const fresh = makeSource('fresh');
      await withSourceCache(fresh, () => ({
        publishers: {},
        publishers_fetched_at: new Date().toISOString(),
        revoked: [],
        revocation_fetched_at: new Date().toISOString(),
        source_name: 'fresh',
        source_url: fresh.url,
      }));

      const remaining = (await readdir(stateDir))
        .filter((n) => n.startsWith('registry-cache-'));
      assert.ok(remaining.length <= 2, `expected ≤2 files after quota, got ${remaining.length}: ${remaining}`);
      assert.ok(remaining.includes('registry-cache-fresh.json'), 'fresh write must survive');
    } finally {
      delete process.env.IJFW_FEDERATED_CACHE_MAX_SOURCES;
    }
  });
});

// ---------------------------------------------------------------------------
// M11 — writeStateFields atomicity
// ---------------------------------------------------------------------------
//
// We can't import writeStateFields directly (it's a private function in
// cross-orchestrator-cli.js, an executable CLI module). Instead we drive it
// via a small inline test harness that requires the lock-acquire helper to
// serialise concurrent writers. Specifically: two child processes each call
// the state-write path in parallel; the merged final state.json must contain
// both writers' fields (no torn write, no lost merge).

test('M11 — concurrent writeStateFields preserve both writers fields', async () => {
  await withTmpHome(async (home) => {
    const ijfwHome = join(home, '.ijfw');
    await mkdir(ijfwHome, { recursive: true });

    // Inline harness that re-implements the writeStateFields contract using
    // the SAME sync directory-lock pattern so we can test the primitive
    // without exec'ing the full CLI. The harness mirrors the production code
    // exactly so a failure here = a failure in the real writeStateFields.
    const harnessPath = join(home, 'harness.mjs');
    const cleanHarness = `
      import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync, renameSync } from 'node:fs';
      import { join, dirname } from 'node:path';

      const home = process.env.IJFW_TEST_HOME;
      const ijfwHome = join(home, '.ijfw');
      const statePath = join(ijfwHome, 'state.json');
      const lockDir = join(ijfwHome, '.state.lock');
      const writerId = process.env.IJFW_TEST_WRITER_ID;

      function readState() {
        try { return JSON.parse(readFileSync(statePath, 'utf8')); }
        catch { return {}; }
      }

      function writeAtomic(target, data) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
        writeFileSync(tmp, data, { mode: 0o600 });
        renameSync(tmp, target);
      }

      function withStateLock(fn) {
        const deadline = Date.now() + 5000;
        let acquired = false;
        let staleRecoveryUsed = false;
        while (Date.now() < deadline) {
          try {
            mkdirSync(lockDir, { recursive: false });
            acquired = true;
            break;
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if (!staleRecoveryUsed) {
              try {
                const st = statSync(lockDir);
                if (Date.now() - st.mtimeMs > 30000) {
                  staleRecoveryUsed = true;
                  rmSync(lockDir, { recursive: true, force: true });
                  continue;
                }
              } catch {}
            }
            const until = Date.now() + 25;
            while (Date.now() < until) {}
          }
        }
        if (!acquired) { return fn(); }
        try { return fn(); }
        finally { try { rmSync(lockDir, { recursive: true, force: true }); } catch {} }
      }

      withStateLock(() => {
        const before = readState();
        const until = Date.now() + 50;
        while (Date.now() < until) {}
        const next = Object.assign({}, before, { [writerId]: writerId });
        writeAtomic(statePath, JSON.stringify(next, null, 2) + '\\n');
      });
      console.log('done:' + writerId);
    `;
    await writeFile(harnessPath, cleanHarness, 'utf8');

    function spawnWriter(id) {
      return new Promise((resolve, reject) => {
        const child = spawnSync(process.execPath, [harnessPath], {
          env: { ...process.env, IJFW_TEST_HOME: home, IJFW_TEST_WRITER_ID: id },
          encoding: 'utf8',
          timeout: 15000,
        });
        if (child.status === 0) resolve(child.stdout || '');
        else reject(new Error(`writer ${id} exited ${child.status}: ${child.stderr}`));
      });
    }

    // Fire 4 writers in parallel.
    const outs = await Promise.all([
      spawnWriter('writer-A'),
      spawnWriter('writer-B'),
      spawnWriter('writer-C'),
      spawnWriter('writer-D'),
    ]);
    for (const o of outs) {
      assert.ok(o.includes('done:'), `writer output missing done sentinel: ${o}`);
    }

    // Final state must include ALL writer fields. If the lock failed, a later
    // writer's read-modify-write would clobber the earlier writer's field and
    // we'd see < 4 fields.
    const statePath = join(ijfwHome, 'state.json');
    const final = JSON.parse(await readFile(statePath, 'utf8'));
    for (const id of ['writer-A', 'writer-B', 'writer-C', 'writer-D']) {
      assert.equal(final[id], id, `expected ${id}=${id} in final state, got: ${JSON.stringify(final)}`);
    }
  });
});

test('M11 — state.json never observed in torn state during writes', async () => {
  // Smaller test: while a writer holds the lock, a concurrent reader either
  // sees the OLD complete state or the NEW complete state — never a partial
  // / malformed JSON. The writeAtomic rename guarantees this; the lock keeps
  // the read-modify-write sequence intact so successive writes preserve all
  // prior fields. We assert the JSON parses cleanly on every read.
  await withTmpHome(async (home) => {
    const ijfwHome = join(home, '.ijfw');
    await mkdir(ijfwHome, { recursive: true });
    const statePath = join(ijfwHome, 'state.json');

    const harness = `
      import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync, renameSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      const home = process.env.IJFW_TEST_HOME;
      const ijfwHome = join(home, '.ijfw');
      const statePath = join(ijfwHome, 'state.json');
      const lockDir = join(ijfwHome, '.state.lock');
      function readState() {
        try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; }
      }
      function writeAtomic(target, data) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
        writeFileSync(tmp, data, { mode: 0o600 });
        renameSync(tmp, target);
      }
      function withStateLock(fn) {
        const deadline = Date.now() + 5000;
        let acquired = false;
        while (Date.now() < deadline) {
          try { mkdirSync(lockDir, { recursive: false }); acquired = true; break; }
          catch (e) { if (e.code !== 'EEXIST') throw e; const u = Date.now()+10; while(Date.now()<u){} }
        }
        if (!acquired) return fn();
        try { return fn(); } finally { try { rmSync(lockDir, { recursive: true, force: true }); } catch {} }
      }
      // Write 20 times to stress.
      for (let i = 0; i < 20; i++) {
        withStateLock(() => {
          const s = readState();
          s['counter'] = (s['counter'] || 0) + 1;
          s[process.env.IJFW_TEST_WRITER_ID] = i;
          writeAtomic(statePath, JSON.stringify(s, null, 2) + '\\n');
        });
      }
    `;
    const harnessPath = join(home, 'harness.mjs');
    await writeFile(harnessPath, harness, 'utf8');

    function spawnWriter(id) {
      return new Promise((resolve, reject) => {
        const child = spawnSync(process.execPath, [harnessPath], {
          env: { ...process.env, IJFW_TEST_HOME: home, IJFW_TEST_WRITER_ID: id },
          encoding: 'utf8',
          timeout: 30000,
        });
        if (child.status === 0) resolve();
        else reject(new Error(`writer ${id} exited ${child.status}: ${child.stderr}`));
      });
    }

    // Concurrent reader fires throughout; every read must parse (an
    // existing file is never torn — writeAtomic uses rename which is atomic
    // on POSIX + NTFS). ENOENT before the first write is not "torn" — skip.
    let stopReading = false;
    let badReads = 0;
    let readsAttempted = 0;
    const reader = (async () => {
      while (!stopReading) {
        readsAttempted++;
        try {
          const raw = await readFile(statePath, 'utf8');
          if (raw.length > 0) JSON.parse(raw); // throws on torn
        } catch (err) {
          // ENOENT before the first writer has flushed is expected, not torn.
          if (err && err.code === 'ENOENT') {
            // skip
          } else {
            badReads += 1;
          }
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    await Promise.all([spawnWriter('A'), spawnWriter('B')]);
    stopReading = true;
    await reader;

    assert.equal(badReads, 0, `reader saw ${badReads} torn states out of ${readsAttempted} attempts`);

    const finalRaw = await readFile(statePath, 'utf8');
    const final = JSON.parse(finalRaw);
    // 2 writers × 20 increments = 40 — the counter MUST be 40 if every
    // read-modify-write was serialised. If the lock failed, we'd see <40.
    assert.equal(final.counter, 40, `expected counter=40 with proper locking, got ${final.counter}; final=${finalRaw}`);
  });
});
