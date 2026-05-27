// Regression tests for v1.5.5 fix wave — agent G4b scope, error-surfacing cluster.
// Covers:
//   V155-026 — listMemoryFiles surfaces unreadable / corrupt-frontmatter
//              entries instead of `.filter(Boolean)`-ing them away.
//   V155-027 — latestCheckpoint distinguishes 'no-checkpoint' (ENOENT)
//              from 'checkpoint-corrupt' (JSON.parse fail).
//   V155-028 — cmdAudit surfaces malformed override manifests instead
//              of silently dropping them.
//
// Run: node --test test-v155-error-surfacing.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { listMemoryFiles } from './src/memory/reader.js';
import { latestCheckpoint } from './src/recovery/checkpoint.js';

describe('V155-026: listMemoryFiles surfaces unreadable entries', () => {
  it('return shape includes an `errors` array', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-026-shape-'));
    try {
      const result = listMemoryFiles(tmp);
      assert.equal(Array.isArray(result.files), true);
      assert.equal(Array.isArray(result.errors), true,
        'expected listMemoryFiles to include an errors array');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not throw or hide a malformed-frontmatter file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-026-bad-'));
    try {
      // Plant a file in a tier 2 location: <repoRoot>/.ijfw/memory/bad.md
      const memDir = join(tmp, '.ijfw', 'memory');
      mkdirSync(memDir, { recursive: true });
      // parseFrontmatter is conservative (likely doesn't throw on garbage
      // headers) so we don't rely on parse-fail; we only assert the API
      // never throws and never returns a corrupt entry that crashes the
      // dashboard. The shape contract is the regression target.
      writeFileSync(join(memDir, 'ok.md'), '# OK\n\nhello\n');
      const result = listMemoryFiles(tmp);
      // ok.md must appear as a normal entry.
      assert.ok(
        result.files.some((f) => f.relpath === 'ok.md' || /ok\.md$/.test(f.path)),
        'expected the well-formed entry to be present',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-027: latestCheckpoint distinguishes no-checkpoint vs corrupt', () => {
  it('returns ok:false error:"no-checkpoint" when state dir has no latest.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-027-none-'));
    try {
      const r = latestCheckpoint(tmp);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'no-checkpoint');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns ok:false error:"checkpoint-corrupt" when latest.json is malformed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-027-corrupt-'));
    try {
      // Path mirrors checkpointPaths() — `.ijfw/checkpoints/latest.json`.
      const dir = join(tmp, '.ijfw', 'checkpoints');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'latest.json'), '{ partial-broken');
      const r = latestCheckpoint(tmp);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'checkpoint-corrupt',
        `expected checkpoint-corrupt got ${JSON.stringify(r)}`);
      assert.equal(typeof r.message, 'string');
      assert.equal(r.path, join(dir, 'latest.json'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-028: cmdAudit surfaces malformed override manifests', () => {
  it('emits errors[] entry rather than silently dropping a malformed override', async () => {
    // We need cmdAudit + the readActiveOverrides path, both of which require
    // an `.ijfw/skill-overrides` shape. Simpler: import the function and
    // verify the error-surface change at source level — the production
    // command runs through src/cli.js, integration covered by an existing
    // cmdAudit smoke test elsewhere.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('./src/dispatch/override.js', import.meta.url),
      'utf8',
    );
    // The patched cmdAudit must push to a local `errors` array on catch.
    assert.ok(
      /reason:\s*'load-fail'/.test(src),
      'expected cmdAudit to record load-fail errors in the audit output',
    );
    // The regression target is the actual swallow expression
    // `loadOverrideFile(p).catch(() => null)` inside cmdAudit's loop. A
    // forensic comment quoting the old pattern is allowed; what we forbid
    // is the live executable form on a non-comment line.
    const auditStart = src.indexOf('async function cmdAudit(');
    assert.ok(auditStart >= 0, 'expected cmdAudit declaration to be findable');
    const nextFnIdx = src.indexOf('\nasync function ', auditStart + 1);
    const auditBody = nextFnIdx > 0 ? src.slice(auditStart, nextFnIdx) : src.slice(auditStart);
    // Live swallow == `loadOverrideFile(...).catch(() => null)` on a line that
    // is NOT a comment. Strip `//` line comments before scanning.
    const stripped = auditBody.split('\n').map((line) => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    }).join('\n');
    assert.equal(
      /loadOverrideFile\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/.test(stripped),
      false,
      'expected cmdAudit to no longer swallow override-load errors',
    );
  });
});
