/**
 * profile/egress.js — Cross-system profile bus, PHASE P4 (egress ledger).
 *
 * The exfiltration AUDIT TRAIL: every time the profile leaves this machine (a
 * brief rendered for a host, or a `profile.get`), exactly what left is appended
 * here so the user can answer "what has any agent ever seen about me?" and so
 * `forget` can expunge the record of a now-deleted inference (design-v2 §7
 * "exfiltration" + the right-to-be-forgotten contract from P0.7 audit.js).
 *
 * FORMAT — JSON-lines at `~/.ijfw/profile/egress.log`, one object per line:
 *   { ts, host, session, fields:[...] }
 * `fields[]` carries the leaked field ids: inference ids (e.g.
 * `preference::tests-pass-before-commit`) and style/expertise tags (e.g.
 * `style:formality`, `expertise:rust`). The inference ids are what `forget`
 * matches against on purge.
 *
 * PURGE — `purgeEgress(removedIds)` rewrites the log ATOMICALLY (temp file in
 * the same dir → fsync → rename, symlink-guarded — mirrors store.js discipline),
 * dropping every entry that referenced ANY removed inference id. Dropping the
 * whole entry (rather than scrubbing the one field) is the privacy-conservative
 * choice: if a brief leaked a now-forgotten inference, the record that the leak
 * happened is itself expunged so the audit trail can't resurrect the deleted id.
 * A missing log → 0 removed (keeps the P0.7 designed-in hook a clean no-op until
 * a brief has actually been served).
 *
 * Zero deps, Node built-ins only. NO LLM calls.
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
import { randomBytes } from 'node:crypto';

import { profileDir } from './store.js';

const EGRESS_FILE = 'egress.log';

/**
 * Max bytes we will read from the egress ledger (audit LOW: read-size cap).
 * Egress is append-only and purge-compacted, so a file beyond this is a
 * corrupt/hand-edited artifact; refuse to slurp it whole rather than OOM. 8 MiB
 * is far above any realistic ledger (one JSON line per brief/get served).
 */
const MAX_EGRESS_BYTES = 8 * 1024 * 1024;

/** The egress ledger path — sibling of the profile, under the same dir. */
export function egressLogPath() {
  return join(profileDir(), EGRESS_FILE);
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

/**
 * appendEgress(entry) -> { ok, code?, message? }. Appends ONE JSON line:
 *   { ts, host, session, fields:[...] }
 * `ts` defaults to now (ISO). Never throws — egress logging must never break
 * the serve path (a brief that can't be logged still returns; logging failure
 * is surfaced via the return shape, not an exception).
 *
 * @param {{ host?:string, session?:string, fields?:string[], ts?:string }} entry
 */
export function appendEgress(entry = {}) {
  const target = egressLogPath();
  // The lstat pre-check is advisory only (it is racy against a symlink swap);
  // the LOAD-BEARING guard is the O_NOFOLLOW open below. We keep the pre-check so
  // an already-planted symlink returns a clear EEGRESS_SYMLINK rather than the
  // ELOOP that O_NOFOLLOW raises.
  if (isSymlink(target)) {
    return { ok: false, code: 'EEGRESS_SYMLINK', message: `refusing symlinked egress log: ${target}` };
  }
  const rec = {
    ts: typeof entry.ts === 'string' && entry.ts ? entry.ts : new Date().toISOString(),
    host: typeof entry.host === 'string' ? entry.host : null,
    session: typeof entry.session === 'string' ? entry.session : null,
    fields: Array.isArray(entry.fields) ? entry.fields.map((f) => String(f)) : [],
  };
  // Optional `cloud` flag — set ONLY when the caller explicitly marks this
  // disclosure as bound for a CLOUD host (appendExemplarEgress). Back-compat:
  // omitted entirely for normal local disclosures so the historical
  // {ts,host,session,fields} line shape is unchanged when the flag is absent.
  if (entry.cloud === true) rec.cloud = true;
  // HIGH-1 (symlink-TOCTOU): the previous appendFileSync(target,…) FOLLOWED a
  // pre-planted `egress.log` symlink (and created+followed it if absent),
  // letting an attacker redirect this append to an arbitrary file. We now open
  // the fd ourselves with O_NOFOLLOW so a symlinked target is REFUSED by the
  // kernel (ELOOP) rather than followed, and write through that fd. O_APPEND
  // keeps the append atomicity; O_CREAT|0o600 preserves create-if-absent with
  // owner-only perms. O_NOFOLLOW is a no-op on Windows, where the isSymlink()
  // lstat above is the portable guard.
  //
  // Tamper-evidence: this ledger is ADVISORY (append-only, not hash-chained). A
  // local attacker with write access to the file can still rewrite prior lines;
  // the integrity guarantee here is only that WE never write THROUGH a symlink.
  let fd = null;
  try {
    ensureDir(profileDir());
    fd = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(rec)}\n`, { encoding: 'utf8' });
    fsyncSync(fd);
    return { ok: true, entry: rec };
  } catch (err) {
    // ELOOP => the target is (now) a symlink; surface our domain code.
    if (err && err.code === 'ELOOP') {
      return { ok: false, code: 'EEGRESS_SYMLINK', message: `refusing symlinked egress log: ${target}` };
    }
    return { ok: false, code: err.code || 'EEGRESS_WRITE', message: err.message };
  } finally {
    if (fd != null) { try { closeSync(fd); } catch {} }
  }
}

/**
 * readEgress() -> { ok, entries:[...] }. Reads + parses every JSON line. A
 * missing log -> empty list. Unparseable lines are skipped (the log is an
 * append-only audit surface; one bad line must not poison the whole read).
 */
export function readEgress() {
  const target = egressLogPath();
  if (isSymlink(target)) {
    return { ok: false, code: 'EEGRESS_SYMLINK', entries: [] };
  }
  if (!existsSync(target)) return { ok: true, entries: [] };
  // Read-size cap (audit LOW): refuse to slurp a pathologically large ledger.
  try {
    const st = lstatSync(target);
    if (st.isFile() && st.size > MAX_EGRESS_BYTES) {
      return { ok: false, code: 'EEGRESS_TOOBIG', message: `egress log exceeds ${MAX_EGRESS_BYTES} bytes`, entries: [] };
    }
  } catch {
    // stat failure falls through to the read, which surfaces its own error.
  }
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, code: err.code || 'EEGRESS_READ', message: err.message, entries: [] };
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      entries.push(JSON.parse(s));
    } catch {
      // skip a corrupt line — best-effort audit read.
    }
  }
  return { ok: true, entries };
}

/**
 * Atomic write of the full egress contents (used by purge). temp in same dir →
 * fsync → rename, symlink-guarded both sides. Returns { ok, code?, message? }.
 */
function atomicRewrite(target, contents) {
  if (isSymlink(target)) {
    return { ok: false, code: 'EEGRESS_SYMLINK', message: `refusing symlinked egress log: ${target}` };
  }
  try {
    ensureDir(profileDir());
  } catch (err) {
    return { ok: false, code: err.code || 'EMKDIR', message: err.message };
  }
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (isSymlink(target)) {
      try { unlinkSync(tmp); } catch {}
      return { ok: false, code: 'EEGRESS_SYMLINK', message: `target became a symlink: ${target}` };
    }
    renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    if (fd != null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return { ok: false, code: err.code || 'EEGRESS_WRITE', message: err.message };
  }
}

/**
 * purgeEgress(removedIds) -> number. Drops every egress entry whose `fields[]`
 * references ANY id in `removedIds`, rewriting the log atomically. Returns the
 * count of entries removed. A missing log, an empty removedIds, or zero matches
 * -> 0 (and no rewrite). Never throws — this is called from `forget`, which must
 * complete the inference removal even if the egress rewrite fails.
 *
 * @param {string[]|Set<string>} removedIds inference ids being forgotten
 */
export function purgeEgress(removedIds) {
  const ids = removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  if (ids.size === 0) return 0;

  const target = egressLogPath();
  if (!existsSync(target)) return 0; // nothing served yet -> nothing to purge.

  const r = readEgress();
  if (!r.ok) return 0;

  const kept = [];
  let removedCount = 0;
  for (const entry of r.entries) {
    const fields = Array.isArray(entry.fields) ? entry.fields : [];
    const leaked = fields.some((f) => ids.has(String(f)));
    if (leaked) {
      removedCount += 1;
    } else {
      kept.push(entry);
    }
  }

  if (removedCount === 0) return 0; // no entry referenced a removed id.

  const contents = kept.length
    ? `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`
    : '';
  const w = atomicRewrite(target, contents);
  if (!w.ok) return 0; // rewrite failed -> report nothing purged (forget still removed the inference).
  return removedCount;
}

// ---------------------------------------------------------------------------
// Voice-exemplar disclosure (V4). A voice exemplar is a short raw snippet of the
// user's OWN writing few-shot into a prompt so the agent can draft in their
// voice. CAPTURE IS NOT DISCLOSURE: storing an exemplar logs nothing here. This
// helper is called ONLY when an exemplar is actually INJECTED into a prompt
// (the injection wiring is a later slice; this slice builds + unit-tests the
// helper). Encoding it through the SAME `fields[]` channel the inference egress
// uses means the existing `purgeEgress` (which drops any entry whose fields
// reference a removed id) expunges these too — `forgetVoiceExemplars` passes the
// prefixed field strings, so no purge-side change is required.
// ---------------------------------------------------------------------------

/** Field-prefix that namespaces a disclosed exemplar id in the egress ledger. */
export const EXEMPLAR_FIELD_PREFIX = 'voice-exemplar::';

/** The exact `fields[]` token for a disclosed exemplar id. */
export function exemplarField(id) {
  return `${EXEMPLAR_FIELD_PREFIX}${String(id)}`;
}

/**
 * appendExemplarEgress({ ids, host, session, cloudHost }) -> { ok, code?, message?, entry? }.
 *
 * Logs ONE JSON line recording that the given voice-exemplar ids were disclosed
 * (injected) into a prompt. Reuses `appendEgress` (single source of the
 * symlink-guarded atomic-append discipline) — every exemplar id is encoded as a
 * `voice-exemplar::<id>` field so `purgeEgress` already matches it on forget.
 *
 * CLOUD-HOST FLAG: when `cloudHost` is true the entry is marked TWO ways for an
 * auditor — a structured `cloud:true` on the record (clean boolean) AND a
 * sentinel `voice-exemplar::cloud-host` field (so even a fields-only reader, or
 * a grep of the raw ledger, can see "these writing samples were sent to a CLOUD
 * host"). Never throws — disclosure logging must not break the serve path.
 *
 * An empty/absent `ids` is a no-op success (nothing to disclose, no line
 * written) — we never write a contentless egress record.
 *
 * @param {{ ids?:string[], host?:string, session?:string, cloudHost?:boolean }} arg
 */
export function appendExemplarEgress({ ids = [], host, session, cloudHost = false } = {}) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x)).filter((x) => x) : [];
  if (list.length === 0) return { ok: true, skipped: true };
  const fields = list.map((id) => exemplarField(id));
  if (cloudHost === true) fields.push(`${EXEMPLAR_FIELD_PREFIX}cloud-host`);
  return appendEgress({
    host: typeof host === 'string' ? host : undefined,
    session: typeof session === 'string' ? session : undefined,
    fields,
    cloud: cloudHost === true ? true : undefined,
  });
}
