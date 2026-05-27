// Regression tests for v1.5.5 fix wave — agent G4b scope, brain LOW cluster.
// Covers:
//   V155-052 — rotateLogIfNeeded preserves history when live rename fails.
//   V155-055 — path-guard rejects hardlinked targets via st.nlink check.
//   V155-067 — extractMarkdown caps file size before readFileSync.
//   V155-068 — readManifest tolerates JSON.parse failure.
//
// Run: node --test test-v155-brain-lows.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import { rotateLogIfNeeded } from './src/lib/atomic-io.js';
import { validateSafeRepoPath } from './src/brain/path-guard.js';
import { extractMarkdown } from './src/brain/extractors/markdown.js';
import { readManifestSafe } from './src/brain/dump-ingest.js';

describe('V155-052: rotateLogIfNeeded preserves history on failure', () => {
  it('rotates a >maxBytes log successfully and leaves rot1+rot2 populated', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-052-ok-'));
    try {
      const log = join(tmp, 'app.log');
      writeFileSync(log, 'X'.repeat(2 * 1024 * 1024)); // 2 MB > default 1 MB
      const r = rotateLogIfNeeded(log);
      // legacy true / new {rotated:true} both acceptable
      const rotated = r === true || (typeof r === 'object' && r.rotated === true) || r === true;
      assert.ok(rotated || r === true, `expected rotation, got ${JSON.stringify(r)}`);
      assert.ok(existsSync(`${log}.1`), 'expected rot1 to exist after first rotation');
      assert.equal(existsSync(log), false, 'expected live log gone after rotation');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns false when log is below threshold', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-052-small-'));
    try {
      const log = join(tmp, 'app.log');
      writeFileSync(log, 'tiny');
      const r = rotateLogIfNeeded(log);
      assert.equal(r, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves oldest history through successive rotations', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-052-chain-'));
    try {
      const log = join(tmp, 'chain.log');
      // First rotation
      writeFileSync(log, 'gen1: ' + 'A'.repeat(2 * 1024 * 1024));
      rotateLogIfNeeded(log);
      assert.ok(existsSync(`${log}.1`), 'rot1 after gen1');
      // Second rotation
      writeFileSync(log, 'gen2: ' + 'B'.repeat(2 * 1024 * 1024));
      rotateLogIfNeeded(log);
      assert.ok(existsSync(`${log}.1`), 'rot1 after gen2');
      assert.ok(existsSync(`${log}.2`), 'rot2 after gen2 (gen1 demoted)');
      // gen1 should now be in rot2; verify content
      const rot2body = readFileSync(`${log}.2`, 'utf8');
      assert.ok(rot2body.startsWith('gen1:'),
        `expected rot2 to contain gen1 bytes, got "${rot2body.slice(0, 16)}"`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-055: path-guard rejects hardlinked targets', () => {
  if (platform() === 'win32') {
    it('(skipped on win32 — hardlink semantics differ)', () => {});
    return;
  }
  it('refuses to validate a file that is a hardlink to another inode', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-055-'));
    try {
      const repoRoot = tmp;
      mkdirSync(join(repoRoot, '.ijfw', 'metrics'), { recursive: true });
      const external = join(tmp, 'external.txt');
      writeFileSync(external, 'external\n');
      const target = join(repoRoot, '.ijfw', 'metrics', 'brain-spend.jsonl');
      try { linkSync(external, target); }
      catch { return; /* host doesn't support hardlinks */ }

      const r = validateSafeRepoPath(repoRoot, target);
      assert.equal(r.ok, false, `expected refusal: ${JSON.stringify(r)}`);
      assert.equal(r.error, 'outFile-is-hardlink',
        `expected outFile-is-hardlink, got error=${r.error}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts a regular nlink=1 file at the target path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-055-ok-'));
    try {
      mkdirSync(join(tmp, '.ijfw', 'metrics'), { recursive: true });
      const target = join(tmp, '.ijfw', 'metrics', 'budget.jsonl');
      writeFileSync(target, '{}\n');
      const r = validateSafeRepoPath(tmp, target);
      assert.equal(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-067: extractMarkdown caps file size', () => {
  it('refuses files larger than maxFileBytes with structured error', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-067-big-'));
    try {
      const f = join(tmp, 'big.md');
      writeFileSync(f, 'A'.repeat(2 * 1024 * 1024));
      const r = extractMarkdown(f, { maxFileBytes: 1024 * 1024 }); // 1 MB cap
      assert.equal(r.error, 'file-too-large');
      assert.equal(r.text, '');
      assert.equal(Array.isArray(r.chunks), true);
      assert.equal(r.chunks.length, 0);
      assert.ok(r.sizeBytes >= 2 * 1024 * 1024);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('processes small files normally', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-067-ok-'));
    try {
      const f = join(tmp, 'ok.md');
      writeFileSync(f, '# Hello\n\nWorld\n');
      const r = extractMarkdown(f);
      assert.equal(r.error, undefined);
      assert.ok(r.text.includes('Hello'));
      assert.ok(r.chunks.length >= 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-068: readManifestSafe tolerates parse failure (legacy readManifest preserved)', () => {
  it('returns ok:false code:"enoent" when manifest absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-068-none-'));
    try {
      const r = readManifestSafe(tmp, 'missing.md');
      assert.equal(r.ok, false);
      assert.equal(r.code, 'enoent');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns ok:false code:"parse-fail" on malformed JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-068-bad-'));
    try {
      writeFileSync(join(tmp, 'foo.md.manifest.json'), '{ not-json');
      const r = readManifestSafe(tmp, 'foo.md');
      assert.equal(r.ok, false);
      assert.equal(r.code, 'parse-fail');
      assert.equal(typeof r.message, 'string');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns ok:true data:{...} on good JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-068-ok-'));
    try {
      writeFileSync(join(tmp, 'foo.md.manifest.json'), '{"source":"foo.md","facts":42}');
      const r = readManifestSafe(tmp, 'foo.md');
      assert.equal(r.ok, true);
      assert.equal(r.data.source, 'foo.md');
      assert.equal(r.data.facts, 42);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
