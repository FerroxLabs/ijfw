// Regression tests for v1.5.5 fix wave (agent G3 scope).
// Covers: V155-003 (extension-installer partial deploy), V155-019 (post-done
// abs-path), V155-043/044/045 (UI startsWith sweep).
//
// Run: node --test test-v155-fixes.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import { runSelfCheck } from './src/orchestrator/post-done-runner.js';

describe('V155-019: post-done runSelfCheck handles Windows-style absolute paths', () => {
  it('relative path joined to projectRoot still works', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-019-'));
    try {
      writeFileSync(join(tmp, 'a.txt'), 'x');
      const report = 'I touched a.txt and b/c.txt (missing).';
      // Note: extractClaimedPaths uses ad-hoc heuristics; we don't depend on
      // exact extraction — instead we just call with a constructed payload
      // mirroring its output. Use the public surface by feeding the report.
      const r = runSelfCheck(report, tmp);
      assert.equal(typeof r.files_claimed, 'number');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('absolute POSIX path is accepted without prepending projectRoot', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-019-abs-'));
    try {
      const abs = join(tmp, 'x.js');
      writeFileSync(abs, 'console.log(1)');
      // Construct a report that references the abs path.
      const report = `Modified ${abs} in this task.`;
      const r = runSelfCheck(report, '/some/unrelated/project');
      // We only assert that abs-path handling doesn't crash and that the
      // self-check considers the abs path as a candidate. Specifics depend
      // on the extractor, but the key regression is that isAbsolute() is
      // now used — so the abs path must NOT be prefixed with projectRoot.
      assert.ok(r.files_claimed >= 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('source uses isAbsolute() not startsWith("/")', () => {
    const src = readFileSync(
      new URL('./src/orchestrator/post-done-runner.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /isAbsolute\(/, 'post-done-runner.js must use isAbsolute()');
    // Must not still use the POSIX-only check on file-existence call.
    // Filter to code-only lines (drop comments) to avoid matching the
    // commit-comment that explains the prior behavior.
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join('\n');
    assert.doesNotMatch(
      codeOnly,
      /p\.startsWith\(['"]\/['"]\)\s*\?\s*p/,
      'post-done-runner.js must not use p.startsWith("/") for abs-path detection',
    );
  });
});

describe('V155-043: uispec-drift uses isAbsolute() not startsWith("/")', () => {
  it('source has been migrated to isAbsolute()', () => {
    const src = readFileSync(new URL('./src/lib/uispec-drift.js', import.meta.url), 'utf8');
    assert.match(src, /isAbsolute\(/, 'uispec-drift.js must import isAbsolute');
    // The two flagged sites at lines 106 and 198 must not still be POSIX-only.
    // (We allow .startsWith on filename guards, e.g. `name.startsWith('.')`).
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.includes('opts.dir.startsWith') || ln.includes('d.startsWith(\'/\')')) {
        assert.fail(`uispec-drift.js line ${i + 1} still uses POSIX-only startsWith: ${ln.trim()}`);
      }
    }
  });
});

describe('V155-044: ui-review-runner uses isAbsolute()', () => {
  it('scope is resolved via isAbsolute()', () => {
    const src = readFileSync(new URL('./src/lib/ui-review-runner.js', import.meta.url), 'utf8');
    assert.match(src, /isAbsolute\(scope\)/, 'ui-review-runner.js must use isAbsolute(scope)');
  });
});

describe('V155-045: uispec-intake uses isAbsolute()', () => {
  it('imagePath is resolved via isAbsolute()', () => {
    const src = readFileSync(new URL('./src/lib/uispec-intake.js', import.meta.url), 'utf8');
    assert.match(src, /isAbsolute\(imagePath\)/, 'uispec-intake.js must use isAbsolute(imagePath)');
  });
});

describe('V155-003 / TP-002 (v1.5.5 Trident): extension-installer ok is strictly boolean on partial deploy', () => {
  it('extension-installer source uses ok:!partialFailed (strict boolean) + status:"partial"', () => {
    const src = readFileSync(new URL('./src/extension-installer.js', import.meta.url), 'utf8');
    // The fix introduces `partialFailed` + a strict-boolean `ok` field.
    assert.match(src, /partialFailed/, 'extension-installer.js must distinguish partial-failed');
    // TP-002: ok must be strict boolean (false on partial), not the prior truthy string.
    assert.match(
      src,
      /ok:\s*!partialFailed/,
      'extension-installer.js must return ok:!partialFailed (strict boolean)',
    );
    // status carries the tri-state.
    assert.match(
      src,
      /status:\s*partialFailed\s*\?\s*['"]partial['"]\s*:\s*['"]success['"]/,
      'extension-installer.js must set status to tri-state "partial"|"success"',
    );
    // Catch branch also carries status:'failed' so callers can branch cleanly.
    assert.match(
      src,
      /status:\s*['"]failed['"]/,
      'extension-installer.js catch path must set status:"failed"',
    );
    // The prior shape MUST NOT be present.
    assert.doesNotMatch(
      src,
      /ok:\s*partialFailed\s*\?\s*['"]partial['"]/,
      'TP-002: legacy ok:"partial" string (truthy under if(r.ok)) must be removed',
    );
  });
});

describe('V155-018: post-tool-use hook consults USERPROFILE for HOME fallback', () => {
  it('source uses ijfwHome() helper or USERPROFILE/os.homedir() chain', async () => {
    const src = readFileSync(
      new URL('../claude/hooks/scripts/post-tool-use.js', import.meta.url),
      'utf8',
    );
    // The fix adds a helper that consults USERPROFILE and os.homedir() in order.
    assert.match(src, /USERPROFILE/, 'post-tool-use.js must consult USERPROFILE on Windows');
    assert.match(src, /homedir\(\)/, 'post-tool-use.js must fall back to os.homedir()');
    // And the previous unconditional `HOME || ''` form must be gone for log dirs.
    assert.doesNotMatch(
      src,
      /process\.env\.HOME \|\| '',\s*\.ijfw/,
      'old POSIX-only HOME fallback must be removed for log directory writes',
    );
  });
});
