/**
 * profile/exemplar-store.js — Voice exemplars (V1: capture + transient store).
 *
 * An "exemplar" is a short raw snippet of the USER's OWN natural-language
 * writing — their prompt text, or a git commit message subject+body. Holding a
 * handful of these lets a downstream drafter few-shot the user's real voice
 * (NOT a stylometry/authorship ruler — this is a FEATURE, not a research proof).
 *
 * TIER (deliberately narrow): this is a LOCAL-ONLY, TRANSIENT tier. It is
 *   - bounded (MAX_EXEMPLARS records; oldest-by-ts evicted when over cap),
 *   - dedup-by-id,
 *   - one-shot wipeable (clearExemplars),
 * and it is NEVER promoted to the durable/global/cross-project user profile.
 * It lives beside the profile in the SAME directory so it inherits the profile
 * path policy for free — including the test-context auto-tmpdir guarantee
 * (path-policy.js homedirProfileDefault), so a forgetful test can NEVER write
 * into the user's real ~/.ijfw/profile.
 *
 * Storage: a single JSONL file under profileDir(). One Exemplar record per line.
 * Reads are symlink-guarded and size-capped; writes are atomic (temp in the same
 * dir → fsync → rename), mirroring store.js. Zero deps, Node built-ins only.
 * NO LLM calls.
 *
 * Exemplar record (the SHARED contract — V2/V4 code against this):
 *   {
 *     id: string,        // stable: `exemplar::${sha8(text)}`
 *     text: string,      // raw snippet, bounded (~600 chars), PII-scrubbed
 *     register: string,  // 'terse' | 'casual' | 'formal' | 'commit' | 'doc'
 *     source: string,    // 'prompt' | 'commit-msg'
 *     ts: string         // ISO-8601
 *   }
 */

import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { resolveOverrideDir, homedirProfileDefault } from './path-policy.js';

const EXEMPLAR_FILE = 'exemplars.jsonl';

/** Max exemplars retained. Over cap → evict oldest by `ts` (transient tier). */
export const MAX_EXEMPLARS = 200;

/** Hard cap on a single exemplar's text length (chars). Mirrors the capture bound. */
export const EXEMPLAR_TEXT_MAX = 600;

/**
 * Max bytes we will read from the on-disk JSONL. The store is bounded by
 * MAX_EXEMPLARS short records, so a file larger than this is a corrupt/hand-
 * edited artifact; refusing to slurp it whole avoids an OOM. ~2 MiB is orders
 * of magnitude above any legitimate exemplar set (200 x 600 chars ≈ 120 KiB).
 */
const MAX_STORE_BYTES = 2 * 1024 * 1024;

/** Short stable content hash → the dedupe key inside the exemplar id. */
export function sha8(text) {
  return createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 8);
}

/** The stable exemplar id for a given (already-final) text. */
export function exemplarId(text) {
  return `exemplar::${sha8(text)}`;
}

/**
 * The JSONL store path. Routed through profileDir() so it inherits the profile
 * path policy — in a test context profileDir() resolves under os.tmpdir(), so
 * this path is NEVER under the real ~/.ijfw. See store.js / path-policy.js.
 */
export function exemplarStorePath(env = process.env) {
  // Mirror profileDir()'s resolution exactly, but thread `env` explicitly so a
  // caller-supplied env override is honored WITHOUT mutating the process-global
  // process.env (that round-trip was a concurrency footgun). When env === the
  // process default this is byte-identical to profileDir(). The policy's own
  // resolveOverrideDir() applies the safety gate (homedir-scoping, symlink
  // refusal); homedirProfileDefault() applies the test-context auto-tmpdir.
  const safe = resolveOverrideDir(env.IJFW_PROFILE_DIR, env);
  const dir = safe || homedirProfileDefault(['.ijfw', 'profile'], env);
  return join(dir, EXEMPLAR_FILE);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** True iff `p` exists AND is a symlink (refuse to read/write through it). */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Validate a record loosely against the contract; drop anything malformed. */
function isValidRecord(r) {
  return (
    r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    r.id &&
    typeof r.text === 'string' &&
    typeof r.register === 'string' &&
    typeof r.source === 'string' &&
    typeof r.ts === 'string'
  );
}

/**
 * Read the raw record set from disk (insertion order = file order). Best-effort:
 * a missing file → []; a symlinked/oversized/garbage file → [] (fail-soft, the
 * transient tier is reconstructable). Malformed lines are skipped individually.
 */
function readRaw(opts = {}) {
  const path = opts.path || exemplarStorePath(opts.env || process.env);
  if (isSymlink(path)) return [];
  if (!existsSync(path)) return [];
  try {
    const st = lstatSync(path);
    if (st.isFile() && st.size > MAX_STORE_BYTES) return [];
  } catch {
    return [];
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (isValidRecord(rec)) out.push(rec);
  }
  return out;
}

/**
 * Atomic full-file rewrite of the JSONL store (records in file order). Symlink-
 * guarded both before and right before rename (TOCTOU narrowing). Returns
 * { ok } | { ok:false, code, message }; never throws.
 */
function writeRaw(records, opts = {}) {
  const target = opts.path || exemplarStorePath(opts.env || process.env);
  if (isSymlink(target)) {
    return { ok: false, code: 'EEXEMPLAR_SYMLINK', message: `refusing symlinked target: ${target}` };
  }
  const dir = join(target, '..');
  try {
    ensureDir(dir);
  } catch (err) {
    return { ok: false, code: err.code || 'EMKDIR', message: err.message };
  }
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (isSymlink(target)) {
      try { unlinkSync(tmp); } catch {}
      return { ok: false, code: 'EEXEMPLAR_SYMLINK', message: `target became a symlink: ${target}` };
    }
    renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    if (fd != null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return { ok: false, code: err.code || 'EWRITE', message: err.message };
  }
}

/** Chronological sort key — ISO-8601 sorts lexicographically; fall back to id. */
function tsKey(r) {
  return `${r.ts || ''}::${r.id || ''}`;
}

/**
 * appendExemplar(rec, opts?) -> { ok, removed?, code?, message? }.
 *
 * Adds one Exemplar to the transient store. Behavior:
 *   - dedup by `id`: a record whose id already exists is treated as a refresh —
 *     the existing copy is replaced (kept once), no growth. removed counts any
 *     records evicted to honor the cap (NOT the dedup replacement).
 *   - bound: after insert, if over MAX_EXEMPLARS, evict the OLDEST by `ts`.
 *   - the file is rewritten atomically newest-by-insertion last.
 * Fail-soft: a bad record → { ok:false, code:'EINVALID' }; a write error →
 * { ok:false, code, message }. Never throws.
 */
export function appendExemplar(rec, opts = {}) {
  if (!isValidRecord(rec)) {
    return { ok: false, code: 'EINVALID', message: 'record does not satisfy the exemplar contract' };
  }
  const cap = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : MAX_EXEMPLARS;
  const existing = readRaw(opts);

  // Dedup by id: drop any prior copy, then append the fresh one at the end.
  const filtered = existing.filter((r) => r.id !== rec.id);
  filtered.push(rec);

  // Bound: evict oldest by ts until within cap. We sort a COPY by ts to find the
  // oldest, but preserve file order otherwise. Simplest correct approach: while
  // over cap, find the min-ts record and remove it.
  let removed = 0;
  while (filtered.length > cap) {
    let minIdx = 0;
    for (let i = 1; i < filtered.length; i += 1) {
      if (tsKey(filtered[i]) < tsKey(filtered[minIdx])) minIdx = i;
    }
    filtered.splice(minIdx, 1);
    removed += 1;
  }

  const w = writeRaw(filtered, opts);
  if (!w.ok) return w;
  return { ok: true, removed };
}

/**
 * listExemplars(opts?) -> Exemplar[], NEWEST-first (by ts, then id for ties).
 * A read-only view of the current set. Missing/corrupt store → [].
 */
export function listExemplars(opts = {}) {
  const recs = readRaw(opts);
  return recs.sort((a, b) => {
    const ka = tsKey(a);
    const kb = tsKey(b);
    if (ka < kb) return 1;
    if (ka > kb) return -1;
    return 0;
  });
}

/**
 * forgetExemplars(idOrPattern, opts?) -> { ok, removed }.
 *   - a string equal to an existing id → removes that one record;
 *   - any other string → treated as a case-insensitive substring/regex match
 *     against id + text (a "pattern"): every matching record is removed;
 *   - a RegExp → matched against id + text.
 * Removing nothing is still { ok:true, removed:0 }. Fail-soft on write error.
 */
export function forgetExemplars(idOrPattern, opts = {}) {
  const existing = readRaw(opts);
  if (!existing.length) return { ok: true, removed: 0 };

  let predicate;
  if (idOrPattern instanceof RegExp) {
    predicate = (r) => idOrPattern.test(r.id) || idOrPattern.test(r.text);
  } else {
    const s = String(idOrPattern == null ? '' : idOrPattern);
    if (!s) return { ok: true, removed: 0 };
    // Exact id match first (precise forget), else substring (case-insensitive).
    const lower = s.toLowerCase();
    predicate = (r) =>
      r.id === s ||
      r.id.toLowerCase().includes(lower) ||
      r.text.toLowerCase().includes(lower);
  }

  const kept = existing.filter((r) => !predicate(r));
  const removed = existing.length - kept.length;
  if (removed === 0) return { ok: true, removed: 0 };

  const w = writeRaw(kept, opts);
  if (!w.ok) return { ok: false, removed: 0, code: w.code, message: w.message };
  return { ok: true, removed };
}

/**
 * clearExemplars(opts?) -> { ok, removed }. One-shot wipe of the whole transient
 * store. Returns the count removed. Fail-soft.
 */
export function clearExemplars(opts = {}) {
  const existing = readRaw(opts);
  const removed = existing.length;
  if (removed === 0) {
    // Nothing to clear; ensure no stale file lingers but don't error if absent.
    const path = opts.path || exemplarStorePath(opts.env || process.env);
    if (existsSync(path) && !isSymlink(path)) {
      try { unlinkSync(path); } catch {}
    }
    return { ok: true, removed: 0 };
  }
  const w = writeRaw([], opts);
  if (!w.ok) return { ok: false, removed: 0, code: w.code, message: w.message };
  return { ok: true, removed };
}
