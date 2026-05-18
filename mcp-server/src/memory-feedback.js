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

import { readdir, readFile, lstat, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const RECEIPTS_SUBPATH = join('.ijfw', 'memory', 'gate-receipts');
const DEVIATIONS_SUBPATH = join('.ijfw', 'memory', 'deviations.jsonl');
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DEVIATIONS_FILE_BYTES = 4 * 1024 * 1024; // 4MB JSONL cap
const FAIL_VERDICTS = new Set(['FAIL', 'FLAG']);

// W12-C N04 — deviation pattern derivation heuristics (ordered: most specific first).
const DEVIATION_PATTERN_RULES = [
  { label: 'test-fixture-drift',    rx: /test.*fail|expected.*got/i },
  { label: 'flaky-infra',           rx: /timeout|EBUSY|ECONNRESET/i },
  { label: 'missing-dep',           rx: /Cannot find module|MODULE_NOT_FOUND/i },
  { label: 'fs-permissions',        rx: /permission denied|EACCES/i },
  { label: 'git-cache-corruption',  rx: /cache-tree|fatal: unable to read/i },
  { label: 'branch-collision',      rx: /branch.*already exists|cannot create branch/i },
];

const VALID_DEVIATION_EVENTS = new Set([
  '3-attempt-cap-hit',
  'BLOCKED',
  'cross-ai-divergence',
]);

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

// ---------------------------------------------------------------------------
// W12-C N04 — memory-backed deviation patterns (lock-in #48: memory feeds forward)
// ---------------------------------------------------------------------------

/**
 * derivePattern(errorText) -> string
 *
 * Maps free-form error / failure text to one of seven labels (or 'unclassified').
 * Rules are tried in order; first match wins so e.g. an "EACCES timeout" string
 * resolves to 'flaky-infra' only when the test-fixture and timeout patterns
 * don't match earlier — the rule order encodes priority.
 *
 * Pure. Safe to call with any input (null, undefined, non-strings → 'unclassified').
 *
 * @param {string} errorText
 * @returns {string}
 */
export function derivePattern(errorText) {
  if (typeof errorText !== 'string' || errorText.length === 0) return 'unclassified';
  for (const rule of DEVIATION_PATTERN_RULES) {
    if (rule.rx.test(errorText)) return rule.label;
  }
  return 'unclassified';
}

/**
 * Build a short, stable hash of a payload for idempotency keys.
 * SHA-256 over a sorted-key JSON of {event, payload}, truncated to 12 hex chars.
 */
function payloadHash(event, payload) {
  const stable = stableStringify({ event, payload });
  return createHash('sha256').update(stable).digest('hex').slice(0, 12);
}

/** Deterministic JSON: object keys sorted recursively. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Extract a short task summary from a payload object (best-effort, never throws). */
function summarizeTask(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown task';
  const s = payload.task || payload.task_summary || payload.title || payload.name;
  if (typeof s === 'string' && s.length > 0) return s.slice(0, 120);
  return 'unknown task';
}

/** Extract last_error text from a payload object (best-effort, never throws). */
function extractError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const e = payload.last_error || payload.error || payload.message || '';
  if (typeof e === 'string') return e;
  return '';
}

/** Build the canonical key for an event. ts is required so repeated calls
 * with the SAME ts produce the same key (idempotency); different ts ⇒ new key
 * (but the payload hash guards against duplicate writes regardless of ts).
 */
function buildKey(event, payload, ts) {
  const hash = payloadHash(event, payload);
  switch (event) {
    case '3-attempt-cap-hit':
      return `deviation_${hash}_3attempt_${ts}`;
    case 'BLOCKED':
      return `deviation_${hash}_blocked_${ts}`;
    case 'cross-ai-divergence': {
      const commit =
        payload && typeof payload.commit === 'string' && payload.commit.length > 0
          ? payload.commit.slice(0, 12)
          : 'nocommit';
      return `deviation_consensus_${commit}_${ts}`;
    }
    default:
      return `deviation_${hash}_${event}_${ts}`;
  }
}

/** Build the human-readable value text for an event. */
function buildValue(event, payload, pattern) {
  if (event === 'cross-ai-divergence') {
    const v = (payload && payload.verdicts) || {};
    const codex = v.codex || 'n/a';
    const gemini = v.gemini || 'n/a';
    const claude = v.claude || 'n/a';
    return `codex: ${codex}, gemini: ${gemini}, claude: ${claude} — pattern: ${pattern}`;
  }
  const task = summarizeTask(payload);
  const err = extractError(payload);
  const attempts = (payload && typeof payload.attempts === 'number') ? payload.attempts : 3;
  if (event === '3-attempt-cap-hit') {
    return `${task} failed at attempt ${attempts} — last error: ${err}. Pattern: ${pattern}`;
  }
  if (event === 'BLOCKED') {
    return `${task} BLOCKED — last error: ${err}. Pattern: ${pattern}`;
  }
  return `${task} (${event}) — ${err}. Pattern: ${pattern}`;
}

/**
 * recordDeviation({ event, payload, projectRoot, ts? }) → { key, pattern, written }
 *
 * Writes one JSONL entry to <projectRoot>/.ijfw/memory/deviations.jsonl.
 * Idempotent: if an entry with the same payload_hash already exists in the
 * file, returns { written: false } without appending.
 *
 * @param {{event: string, payload: object, projectRoot: string, ts?: string}} opts
 * @returns {Promise<{ key: string, pattern: string, written: boolean, type: 'feedback' }>}
 */
export async function recordDeviation({ event, payload, projectRoot, ts } = {}) {
  if (typeof event !== 'string' || !VALID_DEVIATION_EVENTS.has(event)) {
    throw new Error(`recordDeviation: event must be one of ${Array.from(VALID_DEVIATION_EVENTS).join(', ')}`);
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('recordDeviation: projectRoot is required');
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  const timestamp = typeof ts === 'string' && ts.length > 0 ? ts : new Date().toISOString();

  const errorText =
    event === 'cross-ai-divergence'
      ? (payload && typeof payload.divergence_summary === 'string' ? payload.divergence_summary : '')
      : extractError(payload);
  const pattern = derivePattern(errorText);
  const hash = payloadHash(event, payload);
  const key = buildKey(event, payload, timestamp);
  const value = buildValue(event, payload, pattern);

  const entry = {
    key,
    value,
    ts: timestamp,
    pattern,
    event,
    type: 'feedback',
    payload_hash: hash,
  };

  const filePath = join(projectRoot, DEVIATIONS_SUBPATH);

  // Idempotency: scan existing entries for matching payload_hash.
  const existing = await readDeviationsFile(filePath);
  for (const e of existing) {
    if (e && e.payload_hash === hash) {
      return { key: e.key, pattern: e.pattern, written: false, type: 'feedback' };
    }
  }

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    throw new Error(`recordDeviation: failed to write ${filePath}: ${err.message}`);
  }

  return { key, pattern, written: true, type: 'feedback' };
}

/**
 * Read & parse the JSONL deviations file. Skips malformed lines. Never throws.
 */
async function readDeviationsFile(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    return [];
  }
  if (!info.isFile()) return [];
  if (info.size > MAX_DEVIATIONS_FILE_BYTES) return [];

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && typeof obj.key === 'string') {
        out.push(obj);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * readDeviationPatterns({ patternLabel?, sinceISO?, event?, projectRoot })
 *   -> Array<{key, value, ts, pattern, event, type, payload_hash}>
 *
 * Query function so the planner can ask "all `git-cache-corruption` events
 * from the last 30 days" and surface the warning in fresh dispatch briefs.
 *
 * Returns newest-first.
 *
 * @param {{patternLabel?: string, sinceISO?: string, event?: string, projectRoot: string}} opts
 * @returns {Promise<object[]>}
 */
export async function readDeviationPatterns(opts = {}) {
  const { patternLabel, sinceISO, event, projectRoot } = opts;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('readDeviationPatterns: projectRoot is required');
  }

  const filePath = join(projectRoot, DEVIATIONS_SUBPATH);
  const all = await readDeviationsFile(filePath);

  let sinceMs = null;
  if (typeof sinceISO === 'string' && sinceISO.length > 0) {
    const parsed = Date.parse(sinceISO);
    if (!Number.isNaN(parsed)) sinceMs = parsed;
  }

  const filtered = all.filter((e) => {
    if (patternLabel && e.pattern !== patternLabel) return false;
    if (event && e.event !== event) return false;
    if (sinceMs !== null) {
      const eMs = Date.parse(e.ts);
      if (Number.isNaN(eMs) || eMs < sinceMs) return false;
    }
    return true;
  });

  // Newest first by ts (string ISO compare works for valid ISO timestamps).
  filtered.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return filtered;
}
