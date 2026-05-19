/**
 * gate-result.js
 *
 * IJFW v1.4.0 Wave 1 / t5 — Gate-Result Emitter
 *
 * Consumer surface every quality gate calls to emit a canonical gate-result.
 * Composes the W0 schema (validation) + formatter modules, fills in defaults,
 * detects project_type when omitted, and writes a fire-and-forget JSON
 * receipt under .ijfw/memory/gate-receipts/.
 *
 * Discipline:
 *   - ESM only; built-in Node.js modules only (no new prod deps).
 *   - ASCII only in strings.
 *   - Receipt writes MUST NOT throw — the gate's hot path is the priority.
 */

import { mkdir, writeFile, readdir, stat, unlink, appendFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  GATE_NAME_PATTERN,
  SCHEMA_VERSION,
  VALID_STATUSES,
  formatGateResult,
  makeGateId,
  validateGateResult,
} from './gate-result-schema.js';
import { detect as detectProjectType } from './project-type-detector.js';

// Re-exports so consumers can import everything they need from this module.
export {
  GATE_NAME_PATTERN,
  SCHEMA_VERSION,
  VALID_STATUSES,
  formatGateResult,
  makeGateId,
  validateGateResult,
};

/**
 * emitGateResult(gateOpts, context) — build, validate, and format a gate
 * result. Returns the fenced ```gate-result\n<json>\n``` block.
 *
 * @param {{
 *   gate: string,
 *   status: string,
 *   lenses?: Array,
 *   affected_artifacts?: Array,
 *   accounting: {duration_ms: number, lenses_invoked: number, cost_usd: number|null},
 *   remediation?: Array,
 *   receipts_ref?: string|null,
 *   supersedes?: string|null,
 * }} gateOpts
 * @param {{projectRoot?: string, project_type?: string}} [context]
 * @returns {Promise<string>}
 */
export async function emitGateResult(gateOpts, context = {}) {
  if (gateOpts === null || typeof gateOpts !== 'object') {
    throw new TypeError('emitGateResult: gateOpts must be an object');
  }

  const projectType =
    typeof context.project_type === 'string' && context.project_type.length > 0
      ? context.project_type
      : await resolveProjectType(context.projectRoot);

  const result = {
    schema_version: SCHEMA_VERSION,
    gate_id: makeGateId(gateOpts.gate),
    gate: gateOpts.gate,
    status: gateOpts.status,
    project_type: projectType,
    lenses: Array.isArray(gateOpts.lenses) ? gateOpts.lenses : [],
    affected_artifacts: Array.isArray(gateOpts.affected_artifacts)
      ? gateOpts.affected_artifacts
      : [],
    accounting: gateOpts.accounting,
    remediation: Array.isArray(gateOpts.remediation) ? gateOpts.remediation : [],
    receipts_ref: gateOpts.receipts_ref === undefined ? null : gateOpts.receipts_ref,
    supersedes: gateOpts.supersedes === undefined ? null : gateOpts.supersedes,
    emitted_at: new Date().toISOString(),
  };

  const { valid, errors } = validateGateResult(result);
  if (!valid) {
    throw new Error(
      `emitGateResult: invalid gate-result — ${errors.join('; ')}`,
    );
  }

  // Fire-and-forget receipt write. The gate's hot path must NOT block on
  // disk I/O — makeReceipt swallows its own errors and resolves undefined
  // on failure. The trailing .catch is belt-and-braces in case a future
  // refactor lets something escape makeReceipt's try/catch.
  makeReceipt(result, {
    projectRoot:
      typeof context.projectRoot === 'string' && context.projectRoot.length > 0
        ? context.projectRoot
        : process.cwd(),
  }).catch(() => {});

  return formatGateResult(result);
}

/**
 * makeReceipt(gateResult) — fire-and-forget JSON receipt write.
 *
 * Writes `.ijfw/memory/gate-receipts/<gate_id>.json` (creating parent dirs
 * as needed). Disk errors are swallowed and logged to stderr; this never
 * throws so the gate's hot path is never blocked by receipt issues.
 *
 * @param {object} gateResult — validated gate-result object (NOT the
 *   fenced block string). Caller is responsible for passing the object;
 *   if you only have the block string, JSON.parse the body first.
 * @param {{projectRoot?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function makeReceipt(gateResult, opts = {}) {
  try {
    if (!gateResult || typeof gateResult !== 'object') return;
    const gateId = typeof gateResult.gate_id === 'string' ? gateResult.gate_id : null;
    if (!gateId) return;

    // Defence-in-depth against path traversal via a poisoned gate_id.
    // makeGateId() produces ids matching `<gate>-<ts>-<rand4>` where <gate>
    // has colons collapsed to hyphens — i.e. lowercase alphanumerics + hyphen
    // only, starting with a letter. Anything else (e.g. "../" segments,
    // absolute paths, alternate separators) is rejected outright.
    if (!RECEIPT_GATE_ID_PATTERN.test(gateId)) {
      try {
        process.stderr.write(
          `ijfw: makeReceipt rejected unsafe gate_id "${gateId}"\n`,
        );
      } catch {
        /* even stderr write can fail in odd environments; nothing to do */
      }
      return;
    }
    // Belt-and-braces: strip any directory component that slipped past the
    // regex (e.g. odd Unicode tricks, alternate path separators on Windows).
    const safeId = basename(gateId);

    const root = typeof opts.projectRoot === 'string' && opts.projectRoot.length > 0
      ? opts.projectRoot
      : process.cwd();

    const receiptPath = join(
      root,
      '.ijfw',
      'memory',
      'gate-receipts',
      `${safeId}.json`,
    );

    await mkdir(dirname(receiptPath), { recursive: true });
    const body = JSON.stringify(gateResult, null, 2) + '\n';
    await writeFile(receiptPath, body, 'utf8');

    // v1.5.0 audit MED #9 (memory-engine.md F-PRF-2): bounded LRU on the
    // gate-receipts dir. Without eviction this directory grew unbounded
    // (one file per gate run forever); on long-lived projects this hit
    // hundreds of MB and slowed the memory-feedback scan in
    // ijfw_memory_prelude. We keep the newest N=1000 *.json files and
    // append the rest to .archive.jsonl (one JSON line per old receipt),
    // then unlink the originals. Atomic-ish: we write the archive line
    // before unlinking so a crash mid-eviction leaves the data preserved
    // in the archive *and* the receipt -- worst case is a single dup
    // entry in .archive.jsonl, never data loss.
    await evictOldReceipts(dirname(receiptPath));
  } catch (err) {
    // Fire-and-forget: log and move on. The gate hot path must not fail.
    const msg = err && err.message ? err.message : String(err);
    try {
      process.stderr.write(`ijfw: gate-result receipt write failed: ${msg}\n`);
    } catch {
      /* even stderr write can fail in odd environments; nothing to do */
    }
  }
}

// --- Internals -------------------------------------------------------------

// Strict gate_id shape: lowercase alphanumerics + hyphen, must start with a
// letter. Matches what makeGateId() produces after colon-collapse + ts/rand4
// suffix. Used by makeReceipt() to refuse poisoned gate_id values before any
// filesystem call.
const RECEIPT_GATE_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

// v1.5.0 audit MED #9 -- bounded LRU constants. Pulled out so tests can
// dial the cap down to keep the test fixtures cheap.
export const RECEIPTS_KEEP = 1000;
export const RECEIPTS_ARCHIVE = '.archive.jsonl';

/**
 * evictOldReceipts(dir, opts) -- bounded LRU on the gate-receipts directory.
 *
 * Keeps the newest `keep` *.json files; older files are appended to
 * `.archive.jsonl` as JSONL and then unlinked. Never throws -- the gate's
 * hot path is the priority and a logging-channel directory should not
 * propagate I/O errors into the gate result.
 *
 * @param {string} dir
 * @param {{keep?: number}} [opts]
 * @returns {Promise<{evicted: number}>}
 */
export async function evictOldReceipts(dir, opts = {}) {
  const keep = Number.isFinite(opts.keep) && opts.keep > 0 ? opts.keep | 0 : RECEIPTS_KEEP;
  try {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return { evicted: 0 };
    }
    const jsonFiles = entries.filter((f) => f.endsWith('.json'));
    if (jsonFiles.length <= keep) return { evicted: 0 };

    // Stat each candidate; sort by mtime descending (newest first).
    const stamped = [];
    for (const f of jsonFiles) {
      const full = join(dir, f);
      try {
        const s = await stat(full);
        stamped.push({ full, name: f, mtimeMs: s.mtimeMs });
      } catch {
        // Cannot stat -- treat as oldest so it gets evicted/cleaned up.
        stamped.push({ full, name: f, mtimeMs: 0 });
      }
    }
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toEvict = stamped.slice(keep);
    if (toEvict.length === 0) return { evicted: 0 };

    const archivePath = join(dir, RECEIPTS_ARCHIVE);
    let evicted = 0;
    for (const victim of toEvict) {
      try {
        // Read + append to archive *before* unlinking so a mid-eviction crash
        // leaves the receipt either intact OR in the archive (never lost).
        let body;
        try {
          const { readFile } = await import('node:fs/promises');
          body = await readFile(victim.full, 'utf8');
        } catch {
          // Already gone -- skip without inflating the evicted counter.
          continue;
        }
        // Normalize: archive entries are one JSON object per line. The
        // receipt body is pretty-printed JSON -- collapse via parse/stringify.
        let archiveLine;
        try {
          archiveLine = JSON.stringify(JSON.parse(body)) + '\n';
        } catch {
          // Malformed body -- preserve raw bytes inside a wrapper line so
          // operators can still inspect what was there.
          archiveLine = JSON.stringify({ raw: body, evicted_from: victim.name }) + '\n';
        }
        await appendFile(archivePath, archiveLine, 'utf8');
        await unlink(victim.full);
        evicted++;
      } catch {
        // Per-file failures don't abort the eviction -- next call retries.
      }
    }
    return { evicted };
  } catch {
    return { evicted: 0 };
  }
}

async function resolveProjectType(projectRoot) {
  try {
    const root = typeof projectRoot === 'string' && projectRoot.length > 0
      ? projectRoot
      : process.cwd();
    // detect() is synchronous; we call it inside an async function so any
    // throw is captured by the catch below and falls back to 'unknown'.
    const detected = detectProjectType(root);
    if (detected && typeof detected.primary_type === 'string' && detected.primary_type.length > 0) {
      return detected.primary_type;
    }
    if (detected && typeof detected.type === 'string' && detected.type.length > 0) {
      return detected.type;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
