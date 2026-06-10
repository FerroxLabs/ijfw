/**
 * profile/telemetry.js — Cross-system profile bus, S3 (repeat-correction proof).
 *
 * The NO-JUDGE behavioral metric (design spec §"The honest bar", claim 2):
 * "Repeat-correction-rate drop — how often you re-issue the SAME correction,
 * bucketed by session age. A working system bends the curve down (3× in week 1
 * -> 0× by week 4). The most honest single number."
 *
 * This module records, per preference SLUG, every time the user RE-ISSUES a
 * correction that the profile should already have learned, and computes the drop
 * curve across session-age buckets. If injecting a learned preference works, the
 * user stops repeating themselves and the curve bends toward zero.
 *
 * STORE: an append-only JSON-lines ledger `recorrections.log` (sibling of the
 * profile, under the same dir). One object per line:
 *   { ts, slug, session, host, age_days? }
 * `ts` is the event time; `age_days` (optional) is the age of the slug at the
 * time of the re-correction — i.e. days since the slug was first learned — and
 * is what we bucket on. When absent, callers can supply a `learnedAt` map to
 * `dropCurve`/`bucketByAge` to derive it from `ts`.
 *
 * The COMPUTE is pure and IO-free (bucketByAge / dropCurve operate on plain
 * arrays) so the metric is unit-testable without touching disk; the append/read
 * helpers mirror egress.js discipline (O_NOFOLLOW, symlink-guarded, size-capped).
 *
 * Zero deps, Node built-ins only. NO LLM calls.
 */

import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';

import { profileDir } from './store.js';

const RECORRECTIONS_FILE = 'recorrections.log';

/**
 * Read-size cap (mirrors egress.js): the ledger is one tiny JSON line per
 * re-correction; a file past this is a corrupt/hand-edited artifact — refuse to
 * slurp it whole rather than OOM. 8 MiB is far above any realistic ledger.
 */
const MAX_RECORRECTIONS_BYTES = 8 * 1024 * 1024;

/** Default bucket width in days (a "week" bucket). */
export const DEFAULT_BUCKET_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function recorrectionsLogPath() {
  return join(profileDir(), RECORRECTIONS_FILE);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** True iff `p` exists AND is a symlink (refuse to read/write through links). */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IO — append-only ledger (mirrors egress.js).
// ---------------------------------------------------------------------------

/**
 * recordRecorrection(entry) -> { ok, entry?, code?, message? }. Appends ONE JSON
 * line { ts, slug, session, host, age_days? }. `ts` defaults to now (ISO).
 * Never throws — telemetry must never break the host path; a logging failure is
 * surfaced via the return shape, not an exception. `slug` is required (a
 * re-correction with no slug is meaningless and is rejected with EBADSLUG).
 *
 * @param {{ slug?:string, session?:string, host?:string, ts?:string, age_days?:number }} entry
 */
export function recordRecorrection(entry = {}) {
  const slug = typeof entry.slug === 'string' ? entry.slug : '';
  if (!slug) return { ok: false, code: 'EBADSLUG', message: 'recordRecorrection: slug is required' };

  const target = recorrectionsLogPath();
  if (isSymlink(target)) {
    return { ok: false, code: 'ERECORR_SYMLINK', message: `refusing symlinked telemetry log: ${target}` };
  }
  const rec = {
    ts: typeof entry.ts === 'string' && entry.ts ? entry.ts : new Date().toISOString(),
    slug,
    session: typeof entry.session === 'string' ? entry.session : null,
    host: typeof entry.host === 'string' ? entry.host : null,
  };
  if (Number.isFinite(entry.age_days)) rec.age_days = Number(entry.age_days);

  let fd = null;
  try {
    ensureDir(profileDir());
    // O_NOFOLLOW refuses a symlinked target at the kernel (anti-TOCTOU); O_APPEND
    // keeps append atomicity; O_CREAT|0o600 creates owner-only if absent.
    fd = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(rec)}\n`, { encoding: 'utf8' });
    fsyncSync(fd);
    return { ok: true, entry: rec };
  } catch (err) {
    if (err && err.code === 'ELOOP') {
      return { ok: false, code: 'ERECORR_SYMLINK', message: `refusing symlinked telemetry log: ${target}` };
    }
    return { ok: false, code: err.code || 'ERECORR_WRITE', message: err.message };
  } finally {
    if (fd != null) { try { closeSync(fd); } catch {} }
  }
}

/**
 * readRecorrections() -> { ok, events:[...] }. Reads + parses every JSON line. A
 * missing log -> empty list. Unparseable lines are skipped (append-only audit
 * surface; one bad line must not poison the whole read).
 */
export function readRecorrections() {
  const target = recorrectionsLogPath();
  if (isSymlink(target)) return { ok: false, code: 'ERECORR_SYMLINK', events: [] };
  if (!existsSync(target)) return { ok: true, events: [] };
  try {
    const st = lstatSync(target);
    if (st.isFile() && st.size > MAX_RECORRECTIONS_BYTES) {
      return { ok: false, code: 'ERECORR_TOOBIG', message: `telemetry log exceeds ${MAX_RECORRECTIONS_BYTES} bytes`, events: [] };
    }
  } catch {
    // fall through to read
  }
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, code: err.code || 'ERECORR_READ', message: err.message, events: [] };
  }
  const events = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      // skip a corrupt line — best-effort audit read.
    }
  }
  return { ok: true, events };
}

// ---------------------------------------------------------------------------
// COMPUTE — pure, IO-free. Bucket re-corrections by session-age + drop curve.
// ---------------------------------------------------------------------------

/**
 * Resolve the AGE (in days) of a re-correction event:
 *   - prefer an explicit `event.age_days` (the recorder already knew the slug's
 *     age at re-correction time),
 *   - else derive it from `learnedAt[slug]` -> `event.ts` (days since the slug
 *     was first learned),
 *   - else null (cannot be bucketed).
 */
function ageDaysFor(event, learnedAt) {
  if (Number.isFinite(event.age_days)) return Math.max(0, Number(event.age_days));
  const learned = learnedAt && learnedAt[event.slug];
  if (learned && typeof event.ts === 'string') {
    const l = Date.parse(learned);
    const t = Date.parse(event.ts);
    if (Number.isFinite(l) && Number.isFinite(t)) {
      return Math.max(0, (t - l) / DAY_MS);
    }
  }
  return null;
}

/** The bucket INDEX an age falls into (0 = first window). */
function bucketIndex(ageDays, bucketDays) {
  return Math.floor(ageDays / bucketDays);
}

/**
 * bucketByAge(events, opts?) -> { perSlug, totals, bucketDays }.
 *
 * Buckets re-correction events by SESSION-AGE (how old the slug was when the user
 * re-issued the correction). Returns, per slug, an array of counts indexed by
 * age bucket, plus a `totals` array summed across all slugs. Events that can't
 * be aged (no age_days and no learnedAt entry) are tallied into `undated` and
 * excluded from the buckets — never silently dropped.
 *
 * @param {Array} events  re-correction events { slug, ts, age_days? }
 * @param {{ bucketDays?:number, learnedAt?:Record<string,string>, maxBuckets?:number }} opts
 */
export function bucketByAge(events = [], opts = {}) {
  const bucketDays = Number.isFinite(opts.bucketDays) && opts.bucketDays > 0 ? opts.bucketDays : DEFAULT_BUCKET_DAYS;
  const learnedAt = opts.learnedAt || null;
  const list = Array.isArray(events) ? events : [];

  const perSlug = {};
  let undated = 0;
  let maxIdx = -1;

  for (const ev of list) {
    if (!ev || typeof ev.slug !== 'string' || !ev.slug) continue;
    const age = ageDaysFor(ev, learnedAt);
    if (age === null) { undated += 1; continue; }
    const idx = bucketIndex(age, bucketDays);
    if (Number.isFinite(opts.maxBuckets) && opts.maxBuckets > 0 && idx >= opts.maxBuckets) continue;
    if (!perSlug[ev.slug]) perSlug[ev.slug] = [];
    perSlug[ev.slug][idx] = (perSlug[ev.slug][idx] || 0) + 1;
    if (idx > maxIdx) maxIdx = idx;
  }

  // Normalize ragged arrays to a common length (fill holes with 0) so the curve
  // is dense and comparable across slugs.
  const length = maxIdx + 1;
  const totals = Array.from({ length }, () => 0);
  for (const slug of Object.keys(perSlug)) {
    const arr = perSlug[slug];
    for (let i = 0; i < length; i += 1) {
      const v = Number(arr[i]) || 0;
      arr[i] = v;
      totals[i] += v;
    }
    perSlug[slug] = arr;
  }

  return { perSlug, totals, undated, bucketDays };
}

/**
 * dropCurve(events, opts?) -> { perSlug, overall, bucketDays }.
 *
 * The headline metric. For each slug (and overall), reports the bucketed counts
 * and a DROP RATIO comparing an early window to a late window:
 *   drop = (early - late) / early   in [0,1]   (1.0 = re-corrections vanished)
 * `early` defaults to bucket 0 (week 1); `late` defaults to the LAST non-empty
 * bucket. A slug with re-corrections in week 1 and none by week 4 yields
 * drop = 1.0 — the curve bent all the way down. When `early` is 0 the drop is
 * null (no baseline to improve on). `trend` is 'down' | 'flat' | 'up'.
 *
 * @param {Array} events
 * @param {{ bucketDays?:number, learnedAt?:Record<string,string>, earlyBucket?:number, lateBucket?:number, maxBuckets?:number }} opts
 */
export function dropCurve(events = [], opts = {}) {
  const { perSlug, totals, undated, bucketDays } = bucketByAge(events, opts);

  const summarize = (counts) => {
    const c = Array.isArray(counts) ? counts.map((x) => Number(x) || 0) : [];
    const earlyIdx = Number.isFinite(opts.earlyBucket) ? opts.earlyBucket : 0;
    let lateIdx;
    if (Number.isFinite(opts.lateBucket)) {
      lateIdx = opts.lateBucket;
    } else {
      // last non-empty bucket; if all-empty, fall back to the last index.
      lateIdx = c.length - 1;
      for (let i = c.length - 1; i >= 0; i -= 1) { if (c[i] > 0) { lateIdx = i; break; } }
    }
    const early = Number(c[earlyIdx]) || 0;
    const late = Number(c[lateIdx]) || 0;
    let drop = null;
    if (early > 0) drop = (early - late) / early;
    let trend = 'flat';
    if (late < early) trend = 'down';
    else if (late > early) trend = 'up';
    const total = c.reduce((a, b) => a + b, 0);
    return { counts: c, early, late, earlyBucket: earlyIdx, lateBucket: lateIdx, drop, trend, total };
  };

  const perSlugOut = {};
  for (const slug of Object.keys(perSlug)) perSlugOut[slug] = summarize(perSlug[slug]);

  return {
    perSlug: perSlugOut,
    overall: summarize(totals),
    undated,
    bucketDays,
  };
}
