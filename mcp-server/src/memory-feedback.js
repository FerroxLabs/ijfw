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
 * detectPatterns(receipts, opts)
 *
 * Examines the last `opts.window` (default 10) receipts for repeated FAIL/FLAG
 * on the same affected_artifacts[].type value.
 *
 * If a single artifact_type appears in >= opts.threshold (default 3) receipts
 * within the window with a FAIL or FLAG verdict, one pattern object is emitted
 * for that artifact_type.
 *
 * @param {object[]} receipts
 * @param {{ threshold?: number, window?: number }} [opts]
 * @returns {Array<{ kind: string, artifact_type: string, count: number, threshold: number, sample: string[] }>}
 */
export function detectPatterns(receipts, opts = {}) {
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

    return patterns.map(
      (p) =>
        `Pattern detected: ${p.count}/${window} recent gates flagged on ${p.artifact_type} -- consider reviewing ${p.artifact_type} scope`,
    );
  } catch {
    return [];
  }
}
