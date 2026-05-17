/**
 * memory-feedback.js
 *
 * IJFW v1.4.0 W7/B3 -- Memory Feedback Auto-Routing
 *
 * Reads .ijfw/memory/gate-receipts/ under a project root, detects repeated
 * FAIL/FLAG patterns on the same affected_artifacts[].type, and returns
 * one-liner markdown suggestion strings for surface in ijfw_memory_prelude.
 *
 * All entry points are best-effort: any error returns empty output without
 * throwing. No PII leakage: suggestion text contains only artifact TYPE and
 * counts, never IDs or full receipt content.
 */

import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const RECEIPTS_SUBPATH = join('.ijfw', 'memory', 'gate-receipts');
const MAX_FILE_BYTES = 64 * 1024;
const FAIL_VERDICTS = new Set(['FAIL', 'FLAG']);

/**
 * readRecentReceipts(projectRoot, limit)
 *
 * Reads .ijfw/memory/gate-receipts/*.json under projectRoot.
 * Sorts by mtime descending, takes the first `limit` entries.
 * Parses each JSON safely; skips malformed or structurally invalid files.
 * Returns an array of parsed gate-result objects.
 *
 * @param {string} projectRoot
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 */
export async function readRecentReceipts(projectRoot, limit = 50) {
  const receiptsDir = join(projectRoot, RECEIPTS_SUBPATH);

  let entries;
  try {
    entries = await readdir(receiptsDir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter((e) => e.endsWith('.json'));
  if (jsonFiles.length === 0) return [];

  const withMtime = [];
  for (const name of jsonFiles) {
    const filePath = join(receiptsDir, name);
    try {
      // W7.1/B3-H-01 + B3-M-01: lstat (not stat) so symlinks are detected,
      // pre-check size BEFORE readFile so a multi-GB attacker file cannot
      // OOM the prelude on read.
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) continue; // reject symlinks
      if (!info.isFile()) continue; // only regular files
      if (info.size > MAX_FILE_BYTES) continue; // size cap pre-read
      withMtime.push({ filePath, mtime: info.mtimeMs });
    } catch {
      // unreadable entry -- skip
    }
  }

  withMtime.sort((a, b) => b.mtime - a.mtime);
  const candidates = withMtime.slice(0, limit);

  const results = [];
  for (const { filePath } of candidates) {
    try {
      const raw = await readFile(filePath, { encoding: 'utf8', flag: 'r' });
      // Already size-bounded by pre-check above; this is belt-and-braces.
      const bounded = raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw;
      const parsed = JSON.parse(bounded);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.verdict === 'string' &&
        Array.isArray(parsed.affected_artifacts)
      ) {
        results.push(parsed);
      }
    } catch {
      // malformed JSON or read error -- skip
    }
  }

  return results;
}

/**
 * detectRepeatedFail(receipts, opts)
 *
 * Examines the last `opts.window` (default 10) receipts for repeated FAIL/FLAG
 * on the same affected_artifacts[].type value.
 *
 * @param {object[]} receipts
 * @param {{ threshold?: number, window?: number }} [opts]
 * @returns {Array<{ kind: string, artifact_type: string, count: number, threshold: number, sample: string[] }>}
 */
function detectRepeatedFail(receipts, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 3;
  const window = typeof opts.window === 'number' ? opts.window : 10;

  if (!Array.isArray(receipts) || receipts.length === 0) return [];

  const windowReceipts = receipts.slice(0, window);

  const countsByType = new Map();
  const samplesByType = new Map();

  for (const receipt of windowReceipts) {
    if (!receipt || typeof receipt !== 'object') continue;
    if (!FAIL_VERDICTS.has(receipt.verdict)) continue;
    if (!Array.isArray(receipt.affected_artifacts)) continue;

    const seenTypes = new Set();
    for (const artifact of receipt.affected_artifacts) {
      if (!artifact || typeof artifact !== 'object') continue;
      if (typeof artifact.type !== 'string' || artifact.type.length === 0) continue;

      const t = artifact.type;
      if (seenTypes.has(t)) continue;
      seenTypes.add(t);

      countsByType.set(t, (countsByType.get(t) ?? 0) + 1);

      if (!samplesByType.has(t)) samplesByType.set(t, []);
      const gateId =
        typeof receipt.gate_id === 'string' ? receipt.gate_id : 'unknown';
      samplesByType.get(t).push(gateId);
    }
  }

  const patterns = [];
  for (const [artifact_type, count] of countsByType.entries()) {
    if (count >= threshold) {
      patterns.push({
        kind: 'repeated-fail-on-same-artifact',
        artifact_type,
        count,
        threshold,
        sample: samplesByType.get(artifact_type) ?? [],
      });
    }
  }

  return patterns;
}

/**
 * detectRisingFailRate(receipts, opts)
 *
 * Compares the fail rate in the most recent `window` receipts to the `window`
 * receipts before that. If the rate rose by >= minRise (absolute), emits a
 * rising-fail-rate pattern.
 *
 * @param {object[]} receipts
 * @param {{ window?: number, minRise?: number }} [opts]
 * @returns {Array<{ kind: string, from_rate: number, to_rate: number, window: number, suggestion: string }>}
 */
export function detectRisingFailRate(receipts, opts = {}) {
  try {
    const window = typeof opts.window === 'number' && opts.window > 0 ? opts.window : 20;
    const minRise = typeof opts.minRise === 'number' ? opts.minRise : 0.2;

    if (!Array.isArray(receipts) || receipts.length < 2) return [];

    const recent = receipts.slice(0, window);
    const prior = receipts.slice(window, window * 2);

    if (prior.length === 0) return [];

    const failRate = (arr) => {
      const valid = arr.filter((r) => r && typeof r === 'object' && typeof r.verdict === 'string');
      if (valid.length === 0) return 0;
      return valid.filter((r) => FAIL_VERDICTS.has(r.verdict)).length / valid.length;
    };

    const fromRate = failRate(prior);
    const toRate = failRate(recent);

    if (toRate - fromRate < minRise) return [];

    const fromPct = Math.round(fromRate * 100);
    const toPct = Math.round(toRate * 100);

    return [{
      kind: 'rising-fail-rate',
      from_rate: fromRate,
      to_rate: toRate,
      window,
      suggestion: `gate fail rate rose from ${fromPct}% to ${toPct}% in the last ${window} receipts — consider rolling back the most recent changes`,
    }];
  } catch {
    return [];
  }
}

/**
 * detectCrossSkillCorrelation(receipts, opts)
 *
 * Looks at the last `window` receipts. If >= minDistinctGates distinct gate_id
 * prefixes (split on first `-` or `:`) have a FAIL/FLAG verdict, emits a
 * cross-skill-correlation pattern.
 *
 * @param {object[]} receipts
 * @param {{ window?: number, minDistinctGates?: number }} [opts]
 * @returns {Array<{ kind: string, distinct_gates: number, window: number, suggestion: string }>}
 */
export function detectCrossSkillCorrelation(receipts, opts = {}) {
  try {
    const window = typeof opts.window === 'number' && opts.window > 0 ? opts.window : 10;
    const minDistinctGates = typeof opts.minDistinctGates === 'number' ? opts.minDistinctGates : 3;

    if (!Array.isArray(receipts) || receipts.length === 0) return [];

    const windowReceipts = receipts.slice(0, window);
    const prefixes = new Set();

    for (const receipt of windowReceipts) {
      if (!receipt || typeof receipt !== 'object') continue;
      if (!FAIL_VERDICTS.has(receipt.verdict)) continue;
      if (typeof receipt.gate_id !== 'string' || receipt.gate_id.length === 0) continue;

      // Take the prefix before the first `-` or `:`
      const prefix = receipt.gate_id.split(/[-:]/)[0];
      if (prefix) prefixes.add(prefix);
    }

    if (prefixes.size < minDistinctGates) return [];

    return [{
      kind: 'cross-skill-correlation',
      distinct_gates: prefixes.size,
      window,
      suggestion: `${prefixes.size} different gates flagged in the last ${window} receipts — review project state, not individual artifacts`,
    }];
  } catch {
    return [];
  }
}

/**
 * detectRegression(receipts, opts)
 *
 * For each unique (gate_id, artifact_type) key in receipts: if the most recent
 * `failWindow` receipts were all FAIL/FLAG but the `passWindow` receipts before
 * that were all PASS, emits a regression pattern.
 *
 * artifact_type is the TYPE field (e.g. 'chapter'), never the ID.
 *
 * @param {object[]} receipts
 * @param {{ passWindow?: number, failWindow?: number }} [opts]
 * @returns {Array<{ kind: string, gate_id: string, artifact_type: string, suggestion: string }>}
 */
export function detectRegression(receipts, opts = {}) {
  try {
    const passWindow = typeof opts.passWindow === 'number' && opts.passWindow > 0 ? opts.passWindow : 5;
    const failWindow = typeof opts.failWindow === 'number' && opts.failWindow > 0 ? opts.failWindow : 2;

    if (!Array.isArray(receipts) || receipts.length === 0) return [];

    // Build per-(gate_id, artifact_type) ordered lists (receipts[0] = most recent).
    // receipts are assumed newest-first (as returned by readRecentReceipts).
    const streams = new Map(); // key -> [receipt, ...]

    for (const receipt of receipts) {
      if (!receipt || typeof receipt !== 'object') continue;
      if (typeof receipt.gate_id !== 'string' || receipt.gate_id.length === 0) continue;
      if (!Array.isArray(receipt.affected_artifacts)) continue;

      const seenTypes = new Set();
      for (const artifact of receipt.affected_artifacts) {
        if (!artifact || typeof artifact !== 'object') continue;
        if (typeof artifact.type !== 'string' || artifact.type.length === 0) continue;

        const t = artifact.type;
        if (seenTypes.has(t)) continue;
        seenTypes.add(t);

        const key = `${receipt.gate_id}\x00${t}`;
        if (!streams.has(key)) streams.set(key, []);
        streams.get(key).push(receipt);
      }
    }

    const patterns = [];

    for (const [key, stream] of streams.entries()) {
      if (stream.length < failWindow + passWindow) continue;

      const recentSlice = stream.slice(0, failWindow);
      const priorSlice = stream.slice(failWindow, failWindow + passWindow);

      const allRecentFail = recentSlice.every((r) => FAIL_VERDICTS.has(r.verdict));
      const allPriorPass = priorSlice.every((r) => r.verdict === 'PASS');

      if (!allRecentFail || !allPriorPass) continue;

      const [gate_id, artifact_type] = key.split('\x00');
      patterns.push({
        kind: 'regression',
        gate_id,
        artifact_type,
        suggestion: `gate ${gate_id} on ${artifact_type} was passing last ${passWindow} runs; failing now — likely regression`,
      });
    }

    return patterns;
  } catch {
    return [];
  }
}

/**
 * detectPatterns(receipts, opts)
 *
 * Dispatcher: runs all four detectors and returns the union in deterministic
 * order: repeated-fail-on-same-artifact, rising-fail-rate, cross-skill-correlation,
 * regression.
 *
 * @param {object[]} receipts
 * @param {{ threshold?: number, window?: number }} [opts]
 * @returns {object[]}
 */
export function detectPatterns(receipts, opts = {}) {
  if (!Array.isArray(receipts)) return [];
  return [
    ...detectRepeatedFail(receipts, opts),
    ...detectRisingFailRate(receipts, opts),
    ...detectCrossSkillCorrelation(receipts, opts),
    ...detectRegression(receipts, opts),
  ];
}

/**
 * getFeedbackSuggestions(projectRoot, opts)
 *
 * Reads gate receipts, detects patterns, and returns an array of one-liner
 * markdown bullet bodies (caller prepends "- ").
 *
 * Text format: "Pattern detected: <count>/<window> recent gates flagged on
 *   <artifact_type> -- consider reviewing <artifact_type> scope"
 *
 * Never throws; returns [] on any error.
 *
 * @param {string} projectRoot
 * @param {{ threshold?: number, window?: number, limit?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function getFeedbackSuggestions(projectRoot, opts = {}) {
  try {
    // W7.1: bound caller-supplied opts to defensible minimums so misconfigured
    // callers cannot disable the feature or pass negative values.
    const limit = Math.max(1, typeof opts.limit === 'number' ? opts.limit : 50);
    const window = Math.max(1, typeof opts.window === 'number' ? opts.window : 10);
    const threshold = Math.max(1, typeof opts.threshold === 'number' ? opts.threshold : 3);

    const receipts = await readRecentReceipts(projectRoot, limit);
    const patterns = detectPatterns(receipts, { threshold, window });

    return patterns.map((p) => {
      if (p.kind === 'repeated-fail-on-same-artifact') {
        return `Pattern detected: ${p.count}/${window} recent gates flagged on ${p.artifact_type} -- consider reviewing ${p.artifact_type} scope`;
      }
      return `Pattern detected: ${p.suggestion}`;
    });
  } catch {
    return [];
  }
}
