// playwright-baseline.js -- v1.5.0 audit-MED-design-#6.
//
// Visual-regression baseline for the ijfw-ui-auditor pipeline.  Stores
// reference screenshots under `.planning/visual-baseline/<phase>/<surface>.png`
// and compares subsequent snapshots against them.
//
// Playwright is treated as an optional peer.  IJFW core stays zero-dep, so this
// file works in three modes:
//
//   1. capture(): caller passes a Buffer (PNG bytes).  We just write it to disk
//      with atomic rename.  No Playwright needed.
//
//   2. compare(): caller passes the new Buffer (or path).  We byte-diff against
//      baseline.  Returns {diffPercent: 0|100, status: 'identical'|'changed'|...}
//      when no perceptual diff peer is installed.  If `opts.pixelmatch` is
//      injected (callers can require pixelmatch + pngjs themselves), we use the
//      real per-pixel ratio.
//
//   3. createBaseline()/compareToBaseline(): high-level helpers used by the
//      auditor agent.  Auto-derive the baseline path from {phase, surface}.
//
// Graceful no-op without Playwright: createBaseline() simply records "no
// snapshot supplied -- baseline deferred"; compareToBaseline() returns
// {pass: null, reason: 'no-snapshot'} so the auditor can mark FLAG instead of
// hard-failing.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_BASELINE_ROOT = '.planning/visual-baseline';
const DEFAULT_DIFF_THRESHOLD = 1.0; // % of differing pixels above which fail

/**
 * Resolve the baseline path for a (phase, surface) pair.
 *
 * @param {object} opts
 * @param {string} opts.phase
 * @param {string} opts.surface
 * @param {string} [opts.root]          default .planning/visual-baseline
 * @param {string} [opts.projectRoot]   default cwd
 */
export function baselinePath(opts) {
  const phase = sanitizeSegment(opts.phase || 'unspecified');
  const surface = sanitizeSegment(opts.surface || 'default');
  const root = opts.root || DEFAULT_BASELINE_ROOT;
  const projectRoot = opts.projectRoot || process.cwd();
  return join(projectRoot, root, phase, `${surface}.png`);
}

/**
 * Write a baseline screenshot.  Caller is responsible for capturing the bytes
 * (e.g. via `await page.screenshot()` in Playwright).
 *
 * @param {object} opts
 * @param {Buffer|null} opts.png        PNG bytes; null = "Playwright unavailable, skip"
 * @param {string} opts.phase
 * @param {string} opts.surface
 * @param {string} [opts.root]
 * @param {string} [opts.projectRoot]
 * @returns {{ok: boolean, path: string|null, reason: string}}
 */
export function createBaseline(opts) {
  const target = baselinePath(opts);
  if (!opts.png || !(opts.png instanceof Uint8Array)) {
    return { ok: false, path: target, reason: 'no-snapshot' };
  }
  try {
    if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    // Binary-safe atomic write: tmp file + rename.  We can't use writeAtomic
    // from lib/atomic-io.js because it JSON-stringifies non-string payloads.
    const tmp = `${target}.tmp.${randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(tmp, opts.png, { mode: 0o644 });
      renameSync(tmp, target);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* */ }
      throw e;
    }
    return { ok: true, path: target, reason: 'baseline-written' };
  } catch (e) {
    return { ok: false, path: target, reason: `write-failed: ${e.code || e.message}` };
  }
}

/**
 * Compare a candidate PNG against the stored baseline.
 *
 * @param {object} opts
 * @param {Buffer|null} opts.png            Candidate bytes.
 * @param {string} opts.phase
 * @param {string} opts.surface
 * @param {string} [opts.root]
 * @param {string} [opts.projectRoot]
 * @param {number} [opts.threshold]         Allowed diff %; default 1.0.
 * @param {Function} [opts.pixelmatch]      Optional injected pixelmatch fn.
 * @param {Function} [opts.pngParser]       Optional injected PNG parser (e.g. require('pngjs').PNG.sync.read)
 * @returns {{pass: boolean|null, diffPercent: number|null, baselinePath: string, reason: string}}
 */
export function compareToBaseline(opts) {
  const baseline = baselinePath(opts);
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_DIFF_THRESHOLD;

  if (!opts.png || !(opts.png instanceof Uint8Array)) {
    return { pass: null, diffPercent: null, baselinePath: baseline, reason: 'no-snapshot' };
  }
  if (!existsSync(baseline)) {
    return { pass: null, diffPercent: null, baselinePath: baseline, reason: 'baseline-missing' };
  }

  let baselineBytes;
  try {
    baselineBytes = readFileSync(baseline);
  } catch (e) {
    return { pass: null, diffPercent: null, baselinePath: baseline, reason: `baseline-read-failed: ${e.code || e.message}` };
  }

  // Fast path: byte-identical.
  if (bytesEqual(baselineBytes, opts.png)) {
    return { pass: true, diffPercent: 0, baselinePath: baseline, reason: 'identical' };
  }

  // Hash path: hashes differ → at least 1 byte differs → 100% naive diff.
  // Unless a real per-pixel differ is injected.
  if (typeof opts.pixelmatch === 'function' && typeof opts.pngParser === 'function') {
    try {
      const baseImg = opts.pngParser(baselineBytes);
      const candImg = opts.pngParser(opts.png);
      if (baseImg.width !== candImg.width || baseImg.height !== candImg.height) {
        return {
          pass: false,
          diffPercent: 100,
          baselinePath: baseline,
          reason: `dimension-mismatch: ${baseImg.width}x${baseImg.height} vs ${candImg.width}x${candImg.height}`,
        };
      }
      const diffBuffer = new Uint8Array(baseImg.data.length);
      const diffPixels = opts.pixelmatch(
        baseImg.data,
        candImg.data,
        diffBuffer,
        baseImg.width,
        baseImg.height,
        { threshold: 0.1 },
      );
      const total = baseImg.width * baseImg.height;
      const diffPercent = total === 0 ? 0 : (diffPixels / total) * 100;
      const pass = diffPercent <= threshold;
      return {
        pass,
        diffPercent: Math.round(diffPercent * 100) / 100,
        baselinePath: baseline,
        reason: pass ? 'within-threshold' : `diff ${diffPercent.toFixed(2)}% > threshold ${threshold}%`,
      };
    } catch {
      // Fall through to hash-based fallback.
    }
  }

  // Hash fallback.
  const baseHash = createHash('sha256').update(baselineBytes).digest('hex');
  const candHash = createHash('sha256').update(opts.png).digest('hex');
  return {
    pass: false,
    diffPercent: 100,
    baselinePath: baseline,
    reason: `hash-mismatch (no per-pixel differ installed): ${baseHash.slice(0, 8)} vs ${candHash.slice(0, 8)}`,
  };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sanitizeSegment(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unspecified';
}

/**
 * Build the auditor prompt fragment for the snapshot capture step.
 */
export function playwrightCapturePromptFor(url, phase, surface) {
  return [
    'Playwright (optional peer): if installed, run',
    "  npx playwright screenshot " + JSON.stringify(url) + " /tmp/<surface>.png --full-page",
    `Then call createBaseline({ phase: '${phase}', surface: '${surface}', png: <bytes> })`,
    'from mcp-server/src/lib/playwright-baseline.js.',
    'If Playwright is missing, leave the baseline unset; the auditor will FLAG',
    'rather than BLOCK on missing-snapshot.',
  ].join('\n');
}
