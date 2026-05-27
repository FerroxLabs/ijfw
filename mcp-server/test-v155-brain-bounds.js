// Regression tests for v1.5.5 fix wave — agent G4b scope, brain bounds cluster.
// Covers:
//   V155-034 — exportPageBundle size caps (per-page + total bundle).
//   V155-035 — layout-migration symlink-source rejection.
//   V155-056 — findFreshFiles / walkMd depth + symlink-loop guard.
//
// Run: node --test test-v155-brain-bounds.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import { exportPageBundle } from './src/brain/export.js';

/**
 * Helper: create the visible-layer wiki dirs under `<repoRoot>/ijfw/wiki/`
 * and bump the layout-version sentinel to 2 so resolveBrainPaths returns
 * the visible-layer paths (matches v1.5.2+ production layout).
 */
function setupVisibleBrain(repoRoot) {
  mkdirSync(join(repoRoot, '.ijfw'), { recursive: true });
  writeFileSync(join(repoRoot, '.ijfw', '.layout-version'), '2\n');
  mkdirSync(join(repoRoot, 'ijfw', 'wiki', 'concepts'), { recursive: true });
}

describe('V155-034: exportPageBundle enforces per-page + bundle size caps', () => {
  it('truncates a >2MB root page and surfaces truncatedPages in the result', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-034-root-'));
    try {
      setupVisibleBrain(tmp);
      const bigPage = join(tmp, 'ijfw', 'wiki', 'concepts', 'big.md');
      writeFileSync(bigPage, 'X'.repeat(3 * 1024 * 1024)); // 3 MB
      const outFile = join(tmp, 'ijfw', 'wiki', 'exports', 'big.bundle.md');
      const r = exportPageBundle(tmp, 'big', outFile);
      // Either the export truncates or refuses; both are acceptable failure
      // modes for the cap. What's UNacceptable is an unflagged inline of 3 MB.
      if (r.error) {
        assert.match(String(r.error), /page|root-page-unreadable/i);
        return;
      }
      assert.ok(Array.isArray(r.truncatedPages),
        `expected truncatedPages array, got: ${JSON.stringify(r)}`);
      assert.ok(r.truncatedPages.includes('big'),
        `expected 'big' in truncatedPages: ${JSON.stringify(r.truncatedPages)}`);
      const body = readFileSync(outFile, 'utf8');
      assert.ok(/truncated/i.test(body), 'expected truncation marker in bundle');
      assert.ok(body.length < 3 * 1024 * 1024,
        'expected bundle to be smaller than the raw 3 MB page');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('successfully exports a small page without truncation', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-034-small-'));
    try {
      setupVisibleBrain(tmp);
      writeFileSync(join(tmp, 'ijfw', 'wiki', 'concepts', 'small.md'), '# Small\n\nhello\n');
      const outFile = join(tmp, 'ijfw', 'wiki', 'exports', 'small.bundle.md');
      const r = exportPageBundle(tmp, 'small', outFile);
      assert.equal(r.error, undefined,
        `expected no error: ${JSON.stringify(r)}`);
      assert.equal(r.truncatedPages, undefined,
        'expected no truncatedPages on a small page');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-035: layout migration refuses symlinks in source tree', () => {
  // Skip on Windows where the test runner may not have privilege to create
  // arbitrary symlinks.
  if (platform() === 'win32') {
    it('(skipped on win32)', () => {});
    return;
  }

  it('aborts the migration when source memory tree contains a symlink', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-035-sym-'));
    try {
      const memDir = join(tmp, '.ijfw', 'memory');
      mkdirSync(memDir, { recursive: true });
      // Plant a real file plus a symlink pointing outside the source tree.
      const real = join(memDir, 'a.md');
      writeFileSync(real, '# real\n');
      const evilTarget = join(tmp, 'outside.md');
      writeFileSync(evilTarget, '# outside\n');
      try { symlinkSync(evilTarget, join(memDir, 'evil.md')); }
      catch { return; /* host doesn't support symlink in test env */ }

      // Backdate the real file's mtime past the 30s freshness gate so the
      // migration moves on to the symlink check (the regression target).
      const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
      utimesSync(real, oneHourAgo, oneHourAgo);
      utimesSync(evilTarget, oneHourAgo, oneHourAgo);

      const mod = await import('./src/memory/layout-migrations/001-visible-layer.js');
      const r = await mod.up(tmp);
      assert.equal(r.skipped, true,
        `expected migration to be skipped: ${JSON.stringify(r)}`);
      assert.equal(r.reason, 'symlink-source-rejected',
        `expected symlink rejection, got reason: ${r.reason}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-056: walkMd / findFreshFiles bounded against symlink loops', () => {
  if (platform() === 'win32') {
    it('(skipped on win32)', () => {});
    return;
  }

  it('does not infinite-loop on a self-referential symlink in .ijfw/memory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-056-loop-'));
    try {
      const memDir = join(tmp, '.ijfw', 'memory');
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, 'real.md'), '# real\n');
      try { symlinkSync(memDir, join(memDir, 'loop')); }
      catch { return; /* skip if symlink unsupported */ }

      // Import the module and call its private up() — the freshness check
      // path exercises walkMd internally. Should resolve quickly without
      // hanging.
      const mod = await import('./src/memory/layout-migrations/001-visible-layer.js');
      const t0 = Date.now();
      const r = await mod.up(tmp);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 5000,
        `expected migration to complete <5s, took ${elapsed}ms`);
      // Symlink in source tree triggers V155-035 rejection — that's the
      // expected outcome for this fixture (loop is itself a symlink).
      if (r.skipped) {
        assert.match(String(r.reason), /symlink|fresh-writes|already/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
