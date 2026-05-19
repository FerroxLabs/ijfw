#!/usr/bin/env node
/**
 * test-design-med-batch.js -- v1.5.0 audit-MED-design #6..#12.
 *
 * Single test file covering all seven MED-batch design libs because they
 * share a contract surface (UI-SPEC.md) and tests are small and pure.
 *
 *   #6 playwright-baseline   -- baseline write + compare
 *   #7 lighthouse-pillar     -- LCP/CLS thresholds
 *   #8 uispec-drift (budget) -- bundle_kb_budget enforcement
 *   #9 sketches-gc           -- >30d archive policy
 *  #10 uispec-drift (palette)-- declared-vs-used token drift
 *  #11 a11y-contract         -- axe violations budget
 *  #12 uispec-intake         -- --from-image / --from-figma flag parsing
 *
 * ESM, zero external deps.  No CLI spawn, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSketchesGc, formatGcResult } from './src/lib/sketches-gc.js';
import { evaluateLighthouse, LIGHTHOUSE_THRESHOLDS, lighthousePromptFor } from './src/lib/lighthouse-pillar.js';
import {
  parseUISpec,
  measureBundleSize,
  evaluateBundleBudget,
  scanCodeForTailwind,
  diffPaletteDrift,
  loadUISpec,
} from './src/lib/uispec-drift.js';
import {
  evaluateA11y,
  DEFAULT_A11Y_TARGET,
  DEFAULT_MAX_VIOLATIONS,
  axePromptFor,
} from './src/lib/a11y-contract.js';
import {
  baselinePath,
  createBaseline,
  compareToBaseline,
  playwrightCapturePromptFor,
} from './src/lib/playwright-baseline.js';
import {
  fromImage,
  fromFigma,
  parseIntakeFlags,
} from './src/lib/uispec-intake.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-design-med-${prefix}-`));
}

// ===========================================================================
// #9 sketches-gc
// ===========================================================================

test('#9: sketches-gc archives directories older than 30 days', () => {
  const root = tmpRoot('gc');
  try {
    const sketchRoot = join(root, '.planning', 'sketches');
    mkdirSync(sketchRoot, { recursive: true });
    const oldDir = join(sketchRoot, 'old-sketch');
    const newDir = join(sketchRoot, 'fresh-sketch');
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, 'index.html'), '<html></html>');
    writeFileSync(join(newDir, 'index.html'), '<html></html>');

    // Backdate the old sketch by 60 days.
    const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(oldDir, oldTime, oldTime);

    const result = runSketchesGc({ root: sketchRoot, maxAgeDays: 30 });
    assert.equal(result.archived.length, 1, 'one sketch archived');
    assert.equal(result.archived[0].from, oldDir);
    assert.equal(result.skipped.length, 1, 'fresh sketch skipped');
    assert.ok(existsSync(join(sketchRoot, '.archive', 'old-sketch')));
    assert.ok(!existsSync(oldDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#9: sketches-gc idempotent on second run', () => {
  const root = tmpRoot('gc-idem');
  try {
    const sketchRoot = join(root, 'sk');
    mkdirSync(sketchRoot, { recursive: true });
    const dir = join(sketchRoot, 'a');
    mkdirSync(dir);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(dir, old, old);

    const r1 = runSketchesGc({ root: sketchRoot, maxAgeDays: 30 });
    assert.equal(r1.archived.length, 1);
    const r2 = runSketchesGc({ root: sketchRoot, maxAgeDays: 30 });
    assert.equal(r2.archived.length, 0, 'second pass finds nothing to archive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#9: sketches-gc dry-run does not move anything', () => {
  const root = tmpRoot('gc-dry');
  try {
    const sketchRoot = join(root, 'sk');
    mkdirSync(sketchRoot, { recursive: true });
    const dir = join(sketchRoot, 'a');
    mkdirSync(dir);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(dir, old, old);

    const r = runSketchesGc({ root: sketchRoot, maxAgeDays: 30, dryRun: true });
    assert.equal(r.archived.length, 1);
    assert.ok(existsSync(dir), 'original still on disk');
    assert.ok(!existsSync(join(sketchRoot, '.archive', 'a')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#9: sketches-gc returns empty for missing root', () => {
  const r = runSketchesGc({ root: '/nonexistent/path/to/sketches' });
  assert.deepEqual(r.archived, []);
  assert.deepEqual(r.skipped, []);
});

test('#9: formatGcResult renders human-readable text', () => {
  const r = { archived: [{ from: '/a/b', to: '/a/.archive/b', ageDays: 45 }], skipped: [], scannedAt: 'x', root: '/a', archiveDir: '/a/.archive' };
  const txt = formatGcResult(r);
  assert.ok(txt.includes('archived: 1'));
  assert.ok(txt.includes('45d'));
});

// ===========================================================================
// #7 lighthouse-pillar
// ===========================================================================

test('#7: evaluateLighthouse PASS for LCP within budget', () => {
  const r = evaluateLighthouse({ lcpMs: 1800, clsScore: 0.05 });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'within-budget');
});

test('#7: evaluateLighthouse FAIL for LCP over budget', () => {
  const r = evaluateLighthouse({ lcpMs: 3200, clsScore: 0.05 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /LCP 3200ms > 2500ms/);
});

test('#7: evaluateLighthouse FAIL for CLS over budget', () => {
  const r = evaluateLighthouse({ lcpMs: 1000, clsScore: 0.25 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /CLS 0\.250 > 0\.1/);
});

test('#7: evaluateLighthouse handles raw Lighthouse JSON shape', () => {
  const raw = {
    audits: {
      'largest-contentful-paint': { numericValue: 2000 },
      'cumulative-layout-shift': { numericValue: 0.08 },
    },
  };
  const r = evaluateLighthouse(raw);
  assert.equal(r.pass, true);
  assert.equal(r.lcpMs, 2000);
  assert.equal(r.clsScore, 0.08);
});

test('#7: evaluateLighthouse null report -> pass:null', () => {
  const r = evaluateLighthouse(null);
  assert.equal(r.pass, null);
  assert.equal(r.reason, 'lighthouse-unavailable');
});

test('#7: evaluateLighthouse honours threshold overrides', () => {
  const r = evaluateLighthouse({ lcpMs: 1800 }, { lcpMs: 1500 });
  assert.equal(r.pass, false);
});

test('#7: lighthousePromptFor includes url + tool name', () => {
  const p = lighthousePromptFor('http://localhost:3000');
  assert.match(p, /chrome-devtools-mcp:lighthouse_audit/);
  assert.match(p, /localhost:3000/);
});

test('#7: LIGHTHOUSE_THRESHOLDS sets cwv defaults', () => {
  assert.equal(LIGHTHOUSE_THRESHOLDS.lcpMs, 2500);
  assert.equal(LIGHTHOUSE_THRESHOLDS.clsScore, 0.1);
});

// ===========================================================================
// #8 uispec-drift (bundle budget)
// ===========================================================================

test('#8: parseUISpec extracts bundle_kb_budget', () => {
  const md = `# UI-SPEC

Some preamble.

- bundle_kb_budget: 200
- a11y_target: WCAG-2.2-AA
- max_violations: 0

## 3. Color & Contrast
- Tokens: bg-slate-900 text-slate-100 #ff8a00
`;
  const spec = parseUISpec(md);
  assert.equal(spec.bundleKbBudget, 200);
  assert.equal(spec.a11yTarget, 'WCAG-2.2-AA');
  assert.equal(spec.maxViolations, 0);
  assert.ok(spec.paletteHex.includes('#ff8a00'));
  assert.ok(spec.paletteTokens.includes('bg-slate-900'));
  assert.ok(spec.paletteTokens.includes('text-slate-100'));
});

test('#8: parseUISpec returns nulls when fields missing', () => {
  const spec = parseUISpec('# UI-SPEC\n\nNothing declared.\n');
  assert.equal(spec.bundleKbBudget, null);
  assert.equal(spec.a11yTarget, null);
  assert.equal(spec.maxViolations, null);
  assert.deepEqual(spec.paletteHex, []);
});

test('#8: measureBundleSize sums files under build dir', () => {
  const root = tmpRoot('bundle');
  try {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'a.js'), 'x'.repeat(1024)); // 1 KB
    writeFileSync(join(dist, 'b.css'), 'x'.repeat(2048)); // 2 KB
    writeFileSync(join(dist, 'ignored.txt'), 'x'.repeat(9999));
    const m = measureBundleSize({ projectRoot: root });
    assert.equal(m.totalKb, 3);
    assert.equal(m.files.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#8: measureBundleSize returns null when build dir missing', () => {
  const m = measureBundleSize({ projectRoot: '/nonexistent/abc' });
  assert.equal(m.totalKb, null);
  assert.equal(m.reason, 'build-dir-missing');
});

test('#8: evaluateBundleBudget pass when under budget', () => {
  const r = evaluateBundleBudget({ bundleKbBudget: 200 }, { totalKb: 150, dir: '/x' });
  assert.equal(r.pass, true);
});

test('#8: evaluateBundleBudget fail when over', () => {
  const r = evaluateBundleBudget({ bundleKbBudget: 100 }, { totalKb: 150, dir: '/x' });
  assert.equal(r.pass, false);
  assert.match(r.reason, /150 KB > budget 100 KB/);
});

test('#8: evaluateBundleBudget null when no budget declared', () => {
  const r = evaluateBundleBudget({ bundleKbBudget: null }, { totalKb: 100, dir: '/x' });
  assert.equal(r.pass, null);
});

// ===========================================================================
// #10 uispec-drift (palette)
// ===========================================================================

test('#10: scanCodeForTailwind extracts tokens + hex from source', () => {
  const root = tmpRoot('drift');
  try {
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'Button.tsx'),
      'export const Button = () => <button className="bg-rose-500 text-white">x</button>;'
    );
    writeFileSync(
      join(src, 'styles.css'),
      '.foo { color: #112233; background: bg-emerald-700; }'
    );
    const scan = scanCodeForTailwind('src', { projectRoot: root });
    assert.ok(scan.tokens.includes('bg-rose-500'));
    assert.ok(scan.tokens.includes('bg-emerald-700'));
    assert.ok(scan.hex.includes('#112233'));
    assert.ok(scan.files >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#10: diffPaletteDrift flags undeclared tokens as block', () => {
  const spec = { paletteTokens: ['bg-slate-900', 'text-slate-100'], paletteHex: ['#ffffff'] };
  const scan = { tokens: ['bg-slate-900', 'bg-rose-500'], hex: ['#ffffff', '#deadbe'], files: 1 };
  const findings = diffPaletteDrift(spec, scan);
  const tokenFinding = findings.find((f) => f.type === 'token' && f.value === 'bg-rose-500');
  const hexFinding = findings.find((f) => f.type === 'hex' && f.value === '#deadbe');
  assert.ok(tokenFinding);
  assert.equal(tokenFinding.severity, 'block');
  assert.ok(hexFinding);
  assert.equal(hexFinding.severity, 'block');
});

test('#10: diffPaletteDrift downgrades to flag when no spec tokens declared', () => {
  const findings = diffPaletteDrift(
    { paletteTokens: [], paletteHex: [] },
    { tokens: ['bg-rose-500'], hex: ['#000000'], files: 1 },
  );
  assert.ok(findings.every((f) => f.severity === 'flag'));
});

test('#10: loadUISpec returns ok=false for missing file', () => {
  const r = loadUISpec('/no/such/file.md');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ui-spec-missing');
});

test('#10: loadUISpec reads + parses real file', () => {
  const root = tmpRoot('loadspec');
  try {
    const p = join(root, 'UI-SPEC.md');
    writeFileSync(p, '- bundle_kb_budget: 50\n');
    const r = loadUISpec(p);
    assert.equal(r.ok, true);
    assert.equal(r.spec.bundleKbBudget, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// #11 a11y-contract
// ===========================================================================

test('#11: evaluateA11y PASS when no critical/serious violations', () => {
  const axe = {
    violations: [
      { id: 'minor-thing', impact: 'minor' },
      { id: 'moderate-thing', impact: 'moderate' },
    ],
  };
  const r = evaluateA11y(axe);
  assert.equal(r.pass, true);
  assert.equal(r.count, 0, 'default filter excludes minor/moderate');
});

test('#11: evaluateA11y FAIL when one critical violation exceeds budget=0', () => {
  const axe = { violations: [{ id: 'color-contrast', impact: 'critical' }] };
  const r = evaluateA11y(axe);
  assert.equal(r.pass, false);
  assert.equal(r.count, 1);
  assert.match(r.reason, /1 violation/);
});

test('#11: evaluateA11y honours maxViolations budget', () => {
  const axe = {
    violations: [
      { id: 'a', impact: 'serious' },
      { id: 'b', impact: 'serious' },
    ],
  };
  const r = evaluateA11y(axe, { maxViolations: 2 });
  assert.equal(r.pass, true);
});

test('#11: evaluateA11y accepts bare array', () => {
  const r = evaluateA11y([{ id: 'x', impact: 'critical' }]);
  assert.equal(r.pass, false);
});

test('#11: evaluateA11y null report -> pass:null', () => {
  const r = evaluateA11y(null);
  assert.equal(r.pass, null);
  assert.equal(r.reason, 'axe-unavailable');
});

test('#11: evaluateA11y * filter counts all severities', () => {
  const r = evaluateA11y(
    { violations: [{ id: 'a', impact: 'minor' }] },
    { severityFilter: ['*'] },
  );
  assert.equal(r.count, 1);
  assert.equal(r.pass, false);
});

test('#11: axePromptFor includes url + target', () => {
  const p = axePromptFor('http://localhost:3000');
  assert.match(p, /localhost:3000/);
  assert.match(p, /WCAG-2\.2-AA/);
});

test('#11: defaults are WCAG-2.2-AA and zero', () => {
  assert.equal(DEFAULT_A11Y_TARGET, 'WCAG-2.2-AA');
  assert.equal(DEFAULT_MAX_VIOLATIONS, 0);
});

// ===========================================================================
// #6 playwright-baseline
// ===========================================================================

test('#6: baselinePath sanitises phase+surface', () => {
  const root = tmpRoot('bp');
  try {
    const p = baselinePath({
      phase: '1.5.0/n4-design',
      surface: 'home page',
      projectRoot: root,
    });
    assert.match(p, /visual-baseline/);
    assert.match(p, /1\.5\.0-n4-design/);
    assert.match(p, /home-page\.png$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#6: createBaseline writes the file', () => {
  const root = tmpRoot('cb');
  try {
    // Minimal PNG-ish bytes (we just need a Uint8Array).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const r = createBaseline({ phase: 'p1', surface: 's1', png, projectRoot: root });
    assert.equal(r.ok, true);
    assert.ok(existsSync(r.path));
    const written = readFileSync(r.path);
    assert.deepEqual(Array.from(written), Array.from(png));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#6: createBaseline graceful no-snapshot', () => {
  const r = createBaseline({ phase: 'p', surface: 's', png: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-snapshot');
});

test('#6: compareToBaseline byte-identical -> pass:true', () => {
  const root = tmpRoot('cmp');
  try {
    const bytes = Buffer.from('hello world');
    createBaseline({ phase: 'p', surface: 's', png: bytes, projectRoot: root });
    const r = compareToBaseline({ phase: 'p', surface: 's', png: bytes, projectRoot: root });
    assert.equal(r.pass, true);
    assert.equal(r.diffPercent, 0);
    assert.equal(r.reason, 'identical');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#6: compareToBaseline hash mismatch without differ -> pass:false', () => {
  const root = tmpRoot('cmp2');
  try {
    createBaseline({ phase: 'p', surface: 's', png: Buffer.from('hello'), projectRoot: root });
    const r = compareToBaseline({ phase: 'p', surface: 's', png: Buffer.from('world'), projectRoot: root });
    assert.equal(r.pass, false);
    assert.equal(r.diffPercent, 100);
    assert.match(r.reason, /hash-mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#6: compareToBaseline missing baseline -> pass:null', () => {
  const r = compareToBaseline({ phase: 'p', surface: 's', png: Buffer.from('x'), projectRoot: '/no/such/dir' });
  assert.equal(r.pass, null);
  assert.equal(r.reason, 'baseline-missing');
});

test('#6: compareToBaseline injected pixelmatch is used', () => {
  const root = tmpRoot('cmp3');
  try {
    createBaseline({ phase: 'p', surface: 's', png: Buffer.from('A'), projectRoot: root });
    let called = false;
    const fakePixelmatch = () => {
      called = true;
      return 0; // zero diff
    };
    const fakeParser = () => ({ width: 1, height: 1, data: new Uint8Array(4) });
    const r = compareToBaseline({
      phase: 'p',
      surface: 's',
      png: Buffer.from('B'),
      projectRoot: root,
      pixelmatch: fakePixelmatch,
      pngParser: fakeParser,
    });
    assert.equal(called, true);
    assert.equal(r.pass, true);
    assert.equal(r.diffPercent, 0);
    assert.equal(r.reason, 'within-threshold');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#6: playwrightCapturePromptFor includes the helpful command', () => {
  const p = playwrightCapturePromptFor('http://localhost:3000', 'p1', 'home');
  assert.match(p, /npx playwright screenshot/);
  assert.match(p, /home/);
});

// ===========================================================================
// #12 uispec-intake
// ===========================================================================

test('#12: parseIntakeFlags extracts --from-image and --from-figma', () => {
  const r = parseIntakeFlags(['ui-spec', '--from-image', '/tmp/x.png', '--from-figma', 'https://figma.com/file/abc/Foo']);
  assert.equal(r.fromImage, '/tmp/x.png');
  assert.equal(r.fromFigma, 'https://figma.com/file/abc/Foo');
  assert.deepEqual(r.rest, ['ui-spec']);
});

test('#12: parseIntakeFlags supports = form', () => {
  const r = parseIntakeFlags(['--from-image=/a/b.png']);
  assert.equal(r.fromImage, '/a/b.png');
});

test('#12: fromImage rejects missing file', () => {
  const r = fromImage('/no/such/img.png');
  assert.equal(r.ok, false);
  assert.match(r.error, /image-not-found/);
});

test('#12: fromImage rejects unsupported format', () => {
  const root = tmpRoot('intake');
  try {
    const bad = join(root, 'a.bmp');
    writeFileSync(bad, 'x');
    const r = fromImage(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /unsupported-format/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#12: fromImage parses PNG dimensions', () => {
  const root = tmpRoot('png');
  try {
    const p = join(root, 'a.png');
    // Minimal PNG header with IHDR width=100, height=50.
    const header = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0x00, 0x00, 0x00, 0x0d,                          // IHDR length
      0x49, 0x48, 0x44, 0x52,                          // "IHDR"
      0x00, 0x00, 0x00, 0x64,                          // width 100
      0x00, 0x00, 0x00, 0x32,                          // height 50
      0x08, 0x06, 0x00, 0x00, 0x00,                    // bit depth etc
    ]);
    writeFileSync(p, header);
    const r = fromImage(p);
    assert.equal(r.ok, true);
    assert.equal(r.stub.source.kind, 'image');
    assert.deepEqual(r.stub.source.dimensions, { width: 100, height: 50 });
    assert.match(r.stub.advisory, /v1\.6\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#12: fromFigma rejects non-https url', async () => {
  const r = await fromFigma('http://figma.com/file/abc/Foo');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'https-required');
});

test('#12: fromFigma rejects non-figma host', async () => {
  const r = await fromFigma('https://example.com/file/abc/Foo');
  assert.equal(r.ok, false);
  assert.match(r.error, /not-figma-host/);
});

test('#12: fromFigma without token returns degraded stub', async () => {
  const r = await fromFigma('https://figma.com/file/ABC123/Hello', { token: null });
  assert.equal(r.ok, true);
  assert.equal(r.stub.source.fileKey, 'ABC123');
  assert.match(r.stub.advisory, /FIGMA_TOKEN unset/);
});

test('#12: fromFigma with token + injected fetcher fills name/lastModified', async () => {
  const fakeFetcher = async () => ({
    ok: true,
    data: { name: 'My Design', lastModified: '2026-05-19T00:00:00Z' },
    error: null,
  });
  const r = await fromFigma('https://figma.com/design/XYZ/Foo', {
    token: 'fake',
    httpsGetJson: fakeFetcher,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stub.source.fileKey, 'XYZ');
  assert.equal(r.stub.source.name, 'My Design');
  assert.equal(r.stub.source.lastModified, '2026-05-19T00:00:00Z');
});

test('#12: fromFigma graceful on fetcher error', async () => {
  const failingFetcher = async () => {
    throw new Error('network down');
  };
  const r = await fromFigma('https://figma.com/file/abc/Foo', {
    token: 'fake',
    httpsGetJson: failingFetcher,
  });
  assert.equal(r.ok, true); // ok=true, but advisory carries the error
  assert.match(r.stub.advisory, /figma-api-error|figma-api-degraded/);
});
