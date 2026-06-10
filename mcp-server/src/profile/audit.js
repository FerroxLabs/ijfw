/**
 * profile/audit.js — Cross-system profile bus, P0.7 + S3 (human-in-the-loop).
 *
 * Inspectability + the right to be forgotten, for the user-global profile.
 * Extends the existing memory-audit / forget UX to the profile tier (design-v2
 * §7 Poisoning guard: "memory-audit + forget extended to the profile").
 *
 *   - listInferences(profile, registry?): every inference (global dialectic +
 *     per-overlay) surfaced with full provenance, scope, its CITATION (the
 *     source locator + any verbatim span the atom carries) and an
 *     `inject_eligible` flag — so a user can SEE what was inferred, from where,
 *     and whether it has been approved to inject.
 *   - approve/reject/inject-eligibility: the human-in-the-loop gate Cursor
 *     abandoned (design S3). A newly-derived atom is `pending` (NOT
 *     inject-eligible) until the user explicitly approves it. An atom with no
 *     citation locator at all can never be approved (cite-or-drop).
 *   - forget(profile, idOrPattern): purge matching inferences (pure). Returns
 *     the new profile + the removed entries. ALSO purges the matching entries
 *     from the egress log AND from the approval registry — right-to-be-forgotten
 *     completeness: a forgotten atom leaves no approval record behind.
 *   - forgetAndWrite(idOrPattern): read-forget-write under the global lock.
 *
 * APPROVAL REGISTRY: an out-of-band JSON store (`approvals.json`, sibling of the
 * profile) mapping inference id -> { state, ts }. It is deliberately SEPARATE
 * from the profile atom (which is slug-only and privacy-minimized, FIX 4) so the
 * approval decision is a user control surface, not derived data that the CRDT
 * fold could resurrect or a foreign session could forge into the global merge.
 * The registry is FAIL-CLOSED: absent/unknown/`pending`/`rejected` -> not
 * inject-eligible; only an explicit `approved` admits an atom for injection.
 * render-brief/serve (a later slice, S5) consult `injectEligibleIds()` BEFORE
 * surfacing any preference slug — this module owns the gate, not the renderer.
 *
 * Zero deps. NO LLM calls.
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

import { withProfileLock } from './lock.js';
import { readProfile, writeProfile, profileDir } from './store.js';
import { purgeEgress, exemplarField } from './egress.js';
import { listExemplars, forgetExemplars, clearExemplars } from './exemplar-store.js';
import { citedSpan } from './capture.js';

/**
 * Build the CITATION for an inference (design S3 "verbatim span + source
 * locator"). The durable atom is deliberately SLUG-ONLY — FIX 4 (CRITICAL-2)
 * does NOT persist the verbatim user text into the durable, travel-eligible tier
 * (privacy minimization). So a citation here is primarily the LOCATOR:
 *   { span, sessions[], hosts[], last_confirmed, value }
 * `span` is the verbatim quote ONLY when the atom actually carries one — we read
 * the first present of `inf.cite` / `inf.evidence_span` / `inf.evidence` (the
 * forward-compatible fields S4's edit-diff capture may attach in the transient
 * tier). We NEVER fabricate a span. `has_locator` is true iff at least one
 * source session or host is present: an atom with no locator at all has nothing
 * grounding it (cite-or-drop) and therefore can never be approved for injection.
 */
function citationFor(inf) {
  const sessions = Array.isArray(inf.source_sessions) ? [...inf.source_sessions] : [];
  const hosts = Array.isArray(inf.source_hosts) ? [...inf.source_hosts] : [];
  let span = null;
  for (const k of ['cite', 'evidence_span', 'evidence']) {
    if (typeof inf[k] === 'string' && inf[k]) { span = inf[k]; break; }
  }
  return {
    span,
    sessions,
    hosts,
    last_confirmed: inf.last_confirmed,
    value: inf.value === undefined ? null : inf.value,
    has_locator: sessions.length > 0 || hosts.length > 0,
  };
}

/**
 * Surface every inference with provenance, its CITATION, and an inject-
 * eligibility flag. Each row:
 * { scope, id, kind, subject, value, confidence, evidence_count,
 *   last_confirmed, source_sessions, source_hosts, sensitivity,
 *   citation, approval_state, inject_eligible }.
 * scope is 'global' or 'overlay:<key>'.
 *
 * `registry` is the approval map (id -> { state }). When omitted, every atom is
 * treated as `pending` / NOT inject-eligible — the safe, fail-closed default
 * (an atom is never inject-eligible until a human approves it). An atom whose
 * citation has no locator is FORCED ineligible regardless of registry state.
 */
export function listInferences(profile, registry = null) {
  const reg = registry && typeof registry === 'object' ? registry : {};
  const rows = [];
  const push = (scope, inf) => {
    const citation = citationFor(inf);
    const entry = reg[inf.id];
    const state = entry && typeof entry.state === 'string' ? entry.state : 'pending';
    // Fail-closed: ONLY an explicit `approved` state AND a real citation locator
    // make an atom inject-eligible. Everything else (pending/rejected/unknown,
    // or a citation-less atom) is held back.
    const inject_eligible = state === 'approved' && citation.has_locator === true;
    rows.push({
      scope,
      id: inf.id,
      kind: inf.kind,
      subject: inf.subject,
      value: inf.value,
      confidence: inf.confidence,
      evidence_count: inf.evidence_count,
      last_confirmed: inf.last_confirmed,
      source_sessions: [...(inf.source_sessions || [])],
      source_hosts: [...(inf.source_hosts || [])],
      sensitivity: inf.sensitivity,
      citation,
      approval_state: state,
      inject_eligible,
    });
  };

  if (profile && profile.global && Array.isArray(profile.global.dialectic)) {
    for (const inf of profile.global.dialectic) push('global', inf);
  }
  if (profile && profile.overlays && typeof profile.overlays === 'object') {
    for (const [key, ov] of Object.entries(profile.overlays)) {
      if (ov && Array.isArray(ov.dialectic)) {
        for (const inf of ov.dialectic) push(`overlay:${key}`, inf);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Approval registry — the human-in-the-loop gate (design S3). A small JSON store
// `approvals.json` (sibling of the profile) mapping inference id -> { state, ts,
// note? }. SEPARATE from the profile atom on purpose: the approval decision is a
// user control surface, never derived data that the CRDT fold could resurrect or
// a foreign session could forge into the global merge. FAIL-CLOSED: a missing
// file / unknown id reads as `pending` (NOT inject-eligible).
// ---------------------------------------------------------------------------

const APPROVALS_FILE = 'approvals.json';
const APPROVAL_STATES = Object.freeze(['pending', 'approved', 'rejected']);
/** Read-size cap: the registry is one tiny record per atom; a file past this is corrupt. */
const MAX_APPROVALS_BYTES = 4 * 1024 * 1024;

export function approvalsPath() {
  return join(profileDir(), APPROVALS_FILE);
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
 * readApprovals() -> { ok, registry }. Missing file -> empty registry (the
 * fail-closed default). A symlinked / oversized / unparseable file -> empty
 * registry too: we never trust a tampered approval store to grant eligibility,
 * so a corrupt store degrades to "nothing approved" (safe), not "everything".
 */
export function readApprovals() {
  const target = approvalsPath();
  if (isSymlink(target)) return { ok: false, code: 'EAPPROVALS_SYMLINK', registry: {} };
  if (!existsSync(target)) return { ok: true, registry: {} };
  try {
    const st = lstatSync(target);
    if (st.isFile() && st.size > MAX_APPROVALS_BYTES) {
      return { ok: false, code: 'EAPPROVALS_TOOBIG', registry: {} };
    }
  } catch {
    // fall through to read
  }
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, code: err.code || 'EAPPROVALS_READ', registry: {} };
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: true, registry: {} };
    return { ok: true, registry: obj };
  } catch {
    // Corrupt store -> fail closed (empty = nothing approved), never throw.
    return { ok: false, code: 'EAPPROVALS_PARSE', registry: {} };
  }
}

/**
 * Atomic write of the approval registry (temp in same dir -> fsync -> rename,
 * symlink-guarded both sides — mirrors store.js / egress.js discipline).
 */
function writeApprovals(registry) {
  const target = approvalsPath();
  if (isSymlink(target)) return { ok: false, code: 'EAPPROVALS_SYMLINK', message: `refusing symlinked target: ${target}` };
  try {
    ensureDir(profileDir());
  } catch (err) {
    return { ok: false, code: err.code || 'EMKDIR', message: err.message };
  }
  const contents = `${JSON.stringify(registry, null, 2)}\n`;
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
      return { ok: false, code: 'EAPPROVALS_SYMLINK', message: `target became a symlink: ${target}` };
    }
    renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    if (fd != null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return { ok: false, code: err.code || 'EAPPROVALS_WRITE', message: err.message };
  }
}

/**
 * setApprovalState(registry, id, state, opts?) -> new registry (PURE; does not
 * mutate the input). `state` must be one of pending|approved|rejected. Stamps a
 * timestamp and an optional `note`. Throws TypeError on an unknown state or a
 * blank id — an invalid approval must never silently no-op.
 */
export function setApprovalState(registry, id, state, opts = {}) {
  const key = String(id || '');
  if (!key) throw new TypeError('setApprovalState: id must be a non-empty string');
  if (!APPROVAL_STATES.includes(state)) {
    throw new TypeError(`setApprovalState: state must be one of ${APPROVAL_STATES.join('|')} (got ${JSON.stringify(state)})`);
  }
  const next = { ...(registry && typeof registry === 'object' ? registry : {}) };
  const entry = { state, ts: typeof opts.ts === 'string' && opts.ts ? opts.ts : new Date().toISOString() };
  if (typeof opts.note === 'string' && opts.note) entry.note = opts.note;
  next[key] = entry;
  return next;
}

/**
 * injectEligibleIds(profile, registry) -> Set<string>. The single source of
 * truth for "which atoms may inject" — render-brief/serve (S5) call THIS rather
 * than re-deriving the gate. An id is eligible iff its registry state is
 * `approved` AND the atom carries a real citation locator. Fail-closed.
 */
export function injectEligibleIds(profile, registry = null) {
  const ids = new Set();
  for (const row of listInferences(profile, registry)) {
    if (row.inject_eligible) ids.add(row.id);
  }
  return ids;
}

/**
 * setApprovalAndWrite(id, state, opts?) — read -> set -> write the approval
 * registry under the GLOBAL profile lock (the registry shares the profile dir;
 * one lock serializes both). Returns { ok, id, state, code?, message? }.
 *
 * GUARD: a state can only be set for an atom that ACTUALLY EXISTS in the current
 * profile (prevents approving a forged id that no derivation ever produced) AND,
 * for `approved`, the atom must carry a citation locator (cite-or-drop — you
 * cannot approve something with nothing grounding it).
 */
export function setApprovalAndWrite(id, state, opts = {}) {
  const { lockPath, ...rest } = opts;
  return withProfileLock(async () => {
    const pr = readProfile();
    if (!pr.ok) return { ok: false, code: pr.code || 'EREAD', message: pr.message };
    const rows = listInferences(pr.profile);
    const row = rows.find((r) => r.id === String(id));
    if (!row) return { ok: false, code: 'ENOATOM', message: `no inference with id ${JSON.stringify(String(id))}` };
    if (state === 'approved' && !row.citation.has_locator) {
      return { ok: false, code: 'ENOCITATION', message: 'cannot approve a citation-less atom (cite-or-drop)' };
    }
    const ar = readApprovals();
    let next;
    try {
      next = setApprovalState(ar.registry, id, state, rest);
    } catch (err) {
      return { ok: false, code: 'EBADSTATE', message: err.message };
    }
    const w = writeApprovals(next);
    if (!w.ok) return { ok: false, code: w.code, message: w.message };
    return { ok: true, id: String(id), state };
  }, { lockPath, ...rest });
}

/** Convenience wrappers for the two human actions. */
export function approveAndWrite(id, opts = {}) { return setApprovalAndWrite(id, 'approved', opts); }
export function rejectAndWrite(id, opts = {}) { return setApprovalAndWrite(id, 'rejected', opts); }

/**
 * Purge approval-registry entries for the given removed ids (PURE on the passed
 * registry). Returns { registry, removed }.
 */
function purgeApprovals(registry, removedIds) {
  const ids = removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  const next = {};
  let removed = 0;
  for (const [k, v] of Object.entries(registry && typeof registry === 'object' ? registry : {})) {
    if (ids.has(k)) { removed += 1; continue; }
    next[k] = v;
  }
  return { registry: next, removed };
}

/** Hard cap on a user-supplied RegExp source (HIGH-2 ReDoS bound). */
const MAX_PATTERN_SOURCE = 200;

/**
 * Reject a RegExp whose SOURCE is structurally prone to catastrophic
 * backtracking. Inference ids are short slugs, but a pathological source like
 * `/(a+)+$/` can still hang the event loop — and `forget` runs under the GLOBAL
 * profile lock, so a hang there stalls the whole fleet's profile writes. We
 * bound the source length and reject the classic nested-quantifier shapes
 * (a quantifier applied to a group that itself ends in a quantifier). This is a
 * conservative denylist: it does not catch every ReDoS, but combined with the
 * bounded-length id corpus (we only ever .test() against short ids) it removes
 * the practical hang vector without a regex-engine dependency.
 *
 * Returns { ok:true, re } or { ok:false, code, message }.
 */
function sanitizeRegExp(re) {
  const src = re.source || '';
  if (src.length > MAX_PATTERN_SOURCE) {
    return { ok: false, code: 'EPATTERN_TOO_LONG', message: `regex source exceeds ${MAX_PATTERN_SOURCE} chars` };
  }
  // Nested quantifier: a group whose body ends in a quantifier, immediately
  // followed by another quantifier — e.g. (a+)+, (a*)*, (a+)*, (.{1,9})+ .
  const NESTED_QUANTIFIER = /\([^)]*[+*}][)?]*\)\s*[+*{]/;
  if (NESTED_QUANTIFIER.test(src)) {
    return { ok: false, code: 'EPATTERN_UNSAFE', message: 'regex has a nested quantifier (ReDoS-prone)' };
  }
  return { ok: true, re };
}

/**
 * Build a predicate from an id/pattern (HIGH-2 hardened):
 *
 *   - RegExp: sanitized first (length-bounded + nested-quantifier rejected). An
 *     unsafe source yields a predicate that throws an Error carrying the code,
 *     so `forgetAndWrite` can reject it BEFORE taking the global lock.
 *   - string: EXACT-id OR explicit-segment match — `id === needle`,
 *     `id.startsWith(needle + '::')` (kind prefix), or `id.endsWith('::' +
 *     needle)` (subject segment). NOT a bare `includes` substring: bare
 *     substring is an over-deletion foot-gun (`forget('e')` would nuke every
 *     inference whose id contains an "e"). The `::` segment boundary keeps the
 *     `forget('tests') -> preference::tests` UX while making mid-token matches
 *     impossible.
 *
 * Returns a predicate `(id) => boolean`. For an unsafe RegExp it returns a
 * predicate that throws on first call (callers gate before the lock).
 */
function matcherFor(idOrPattern) {
  if (idOrPattern instanceof RegExp) {
    const s = sanitizeRegExp(idOrPattern);
    if (!s.ok) {
      const err = new Error(s.message);
      err.code = s.code;
      return () => { throw err; };
    }
    return (id) => s.re.test(String(id));
  }
  const needle = String(idOrPattern);
  if (!needle) return () => false;
  return (id) => {
    const s = String(id);
    return s === needle || s.startsWith(`${needle}::`) || s.endsWith(`::${needle}`);
  };
}

/**
 * Pre-validate an id/pattern WITHOUT running it against any data — used to
 * reject an unsafe RegExp BEFORE the global lock is acquired (HIGH-2: never hang
 * the event loop while holding the fleet-wide profile lock). Returns
 * { ok:true } or { ok:false, code, message }.
 */
export function validatePattern(idOrPattern) {
  if (idOrPattern instanceof RegExp) {
    const s = sanitizeRegExp(idOrPattern);
    return s.ok ? { ok: true } : { ok: false, code: s.code, message: s.message };
  }
  return { ok: true };
}

/**
 * Purge the matching entries from the egress log — P4 WIRED. `forget` is now a
 * single, complete "right to be forgotten" operation: removing an inference also
 * expunges every egress-ledger record that leaked it. Delegates to
 * `egress.purgeEgress`, which reads ~/.ijfw/profile/egress.log, drops every
 * entry whose `fields[]` references a removed inference id, and rewrites the log
 * ATOMICALLY (temp → fsync → rename, symlink-guarded).
 *
 * When no egress log exists yet (nothing has been served), `purgeEgress` returns
 * 0 — so the historical P0 contract ("no log -> egressRemoved 0") still holds.
 * Never throws: a failed egress rewrite must not abort the inference removal.
 */
function purgeEgressEntries(removedIds) {
  try {
    return purgeEgress(removedIds);
  } catch {
    // Egress purge is best-effort; the inference removal is the primary contract.
    return 0;
  }
}

/**
 * forget(profile, idOrPattern) -> { profile, removed, egressRemoved }. PURE:
 * does not mutate `profile`. Removes matching inferences from the global
 * dialectic AND every overlay, and (when present) their egress entries.
 */
export function forget(profile, idOrPattern) {
  const match = matcherFor(idOrPattern);
  const removed = [];
  const next = JSON.parse(JSON.stringify(profile || {}));

  if (next.global && Array.isArray(next.global.dialectic)) {
    next.global.dialectic = next.global.dialectic.filter((inf) => {
      if (match(inf.id)) { removed.push(inf); return false; }
      return true;
    });
  }
  if (next.overlays && typeof next.overlays === 'object') {
    for (const key of Object.keys(next.overlays)) {
      const ov = next.overlays[key];
      if (ov && Array.isArray(ov.dialectic)) {
        ov.dialectic = ov.dialectic.filter((inf) => {
          if (match(inf.id)) { removed.push(inf); return false; }
          return true;
        });
      }
    }
  }

  const egressRemoved = purgeEgressEntries(removed.map((r) => r.id));
  return { profile: next, removed, egressRemoved };
}

/**
 * forgetAndWrite(idOrPattern, opts?) — read → forget → write under the global
 * lock. Returns { ok, removed, egressRemoved, code?, message? }.
 */
export function forgetAndWrite(idOrPattern, opts = {}) {
  const { lockPath, ...lockOpts } = opts;
  // HIGH-2: validate the pattern BEFORE acquiring the global lock. An unsafe
  // RegExp must be rejected without ever running a `.test()` while the
  // fleet-wide profile lock is held — a hang there would stall every host's
  // profile write. matcherFor's predicate also throws on an unsafe source, but
  // by then we'd already hold the lock; gating here keeps the lock hold trivial.
  const v = validatePattern(idOrPattern);
  if (!v.ok) {
    return Promise.resolve({ ok: false, code: v.code, message: v.message, removed: [] });
  }
  return withProfileLock(async () => {
    const r = readProfile();
    if (!r.ok) return { ok: false, code: r.code || 'EREAD', message: r.message, removed: [] };
    const { profile: next, removed, egressRemoved } = forget(r.profile, idOrPattern);
    const w = writeProfile(next);
    if (!w.ok) return { ok: false, code: w.code, message: w.message, removed: [] };
    // Right-to-be-forgotten completeness: a forgotten atom must leave NO approval
    // record behind (otherwise a re-derived id could silently inherit a stale
    // `approved`). Best-effort: a failed registry rewrite must not abort the
    // already-committed inference removal.
    let approvalsRemoved = 0;
    try {
      const ar = readApprovals();
      const { registry: prunedReg, removed: aRemoved } = purgeApprovals(ar.registry, removed.map((x) => x.id));
      if (aRemoved > 0) {
        const aw = writeApprovals(prunedReg);
        if (aw.ok) approvalsRemoved = aRemoved;
      }
    } catch {
      // best-effort — inference removal is the primary contract.
    }
    return { ok: true, removed, egressRemoved, approvalsRemoved };
  }, { lockPath, ...lockOpts });
}

// ---------------------------------------------------------------------------
// Voice exemplars (V4) — VISIBLE, FORGETTABLE, disclosure-logged.
//
// A voice exemplar is a short raw snippet of the USER's OWN writing, stored
// locally + transiently by the V1 store (`exemplar-store.js`) and few-shot into
// prompts so the agent can draft in the user's voice. This is a FEATURE, not a
// research proof: NO stylometry / AUC / Gate-B here. This slice extends the same
// audit + right-to-be-forgotten UX the inference tier already has (listVoice-
// Exemplars mirrors listInferences; forgetVoiceExemplars mirrors forgetAndWrite)
// to the exemplar tier so a user can SEE every writing sample being used and
// PURGE any of them. Zero-LLM, zero-network — same as the rest of this module.
// ---------------------------------------------------------------------------

/** Human-readable label so an auditor knows EXACTLY what these rows are. */
const EXEMPLAR_LABEL = 'writing sample used to match your voice';
/** Preview cap (~80 chars) — a glanceable excerpt, never the full snippet. */
const EXEMPLAR_PREVIEW_MAX = 80;

/**
 * scrubbedPreview(text) -> short, already-PII-scrubbed excerpt of an exemplar's
 * raw `text`, safe to render in an audit list. Reuses capture.js `citedSpan`
 * (direct-identifier + assigned-secret scrub + whitespace-collapse) — the SAME
 * scrub the edit-delta citation uses — then hard-caps to EXEMPLAR_PREVIEW_MAX so
 * the audit surface never echoes a full writing sample back at the user. Pure.
 */
function scrubbedPreview(text) {
  // citedSpan covers the edit-delta PII set; the stored exemplar text is also
  // homedir-path-scrubbed upstream (exemplar-capture PII_PATTERNS). We re-scrub
  // homedir paths HERE too — defense-in-depth at the boundary, so the preview
  // can never echo an OS username regardless of what upstream did (MED-2).
  const scrubbed = scrubHomedirPaths(citedSpan(text == null ? '' : text));
  if (scrubbed.length <= EXEMPLAR_PREVIEW_MAX) return scrubbed;
  return `${scrubbed.slice(0, EXEMPLAR_PREVIEW_MAX - 1).trimEnd()}…`;
}

/** Replace the username segment of a homedir path with a placeholder. Pure. */
function scrubHomedirPaths(s) {
  return String(s)
    .replace(/(\/(?:Users|home)\/)[^/\s]+/g, '$1<user>')
    .replace(/([A-Za-z]:\\Users\\)[^\\/\s]+/g, '$1<user>');
}

/**
 * listVoiceExemplars(opts?) -> Array<{ id, register, source, ts, preview, label }>.
 *
 * Surfaces the user's voice exemplars in human-glanceable form. Reads via V1's
 * `listExemplars(opts)` and shapes each record into an audit row whose `preview`
 * is a PII-scrubbed, length-capped excerpt of the raw `text` (the raw text
 * itself is NEVER returned by this audit surface). `label` states plainly what
 * the row is, so the control surface reads as "these are writing samples used to
 * match your voice" rather than opaque ids.
 *
 * Resilient: a missing/throwing store (V1 lands in parallel) degrades to an
 * empty list rather than throwing — an audit read must never crash the caller.
 */
export function listVoiceExemplars(opts = {}) {
  let records;
  try {
    records = listExemplars(opts);
  } catch {
    return [];
  }
  if (!Array.isArray(records)) return [];
  const rows = [];
  for (const ex of records) {
    if (!ex || typeof ex !== 'object') continue;
    rows.push({
      id: ex.id,
      register: ex.register,
      source: ex.source,
      ts: ex.ts,
      preview: scrubbedPreview(ex.text),
      label: EXEMPLAR_LABEL,
    });
  }
  return rows;
}

/**
 * forgetVoiceExemplars(idOrPattern, opts?) -> { ok, removed, egressRemoved, code?, message? }.
 *
 * The right-to-be-forgotten path for voice exemplars. Runs under the GLOBAL
 * profile lock (same discipline as forgetAndWrite — the exemplar store shares
 * the profile dir, and one lock serializes both) so a concurrent capture/serve
 * can't race the purge. Delegates the actual removal to V1's store:
 *   - a falsy / `'*'` / `'all'` pattern  -> clearExemplars(opts) (forget ALL)
 *   - any other id or pattern            -> forgetExemplars(idOrPattern, opts)
 *
 * Then expunges the egress trail: each forgotten exemplar was disclosed (if at
 * all) under a `voice-exemplar::<id>` field, so we hand `purgeEgress` those
 * exact field strings. `purgeEgress` already matches entries by exact field
 * value, so NO purge-side change is needed — forgetting an exemplar drops every
 * egress line that recorded it being injected. Best-effort egress purge: a
 * failed egress rewrite must not abort the already-committed exemplar removal.
 *
 * EGRESS-PURGE PRECISION: V1's forgetExemplars/clearExemplars report `removed` as
 * a COUNT, not the removed ids — so we cannot derive the disclosed-field strings
 * from the result. We therefore SNAPSHOT the exemplar ids that WILL match BEFORE
 * forgetting (under the same lock, applying V1's exact-id|substring|regex match
 * semantics over id+text, or ALL for a clear), and purge egress for exactly that
 * snapshot. The snapshot is taken under the global lock so it can't race a
 * concurrent capture.
 */
export function forgetVoiceExemplars(idOrPattern, opts = {}) {
  const { lockPath, ...rest } = opts;
  const forgetAll = idOrPattern == null || idOrPattern === '*' || idOrPattern === 'all';
  return withProfileLock(async () => {
    // Snapshot the ids that this forget WILL remove, BEFORE removing them — V1
    // reports a count, not ids, so this is the only way to know which egress
    // fields to expunge. Mirror V1's match semantics (exact id, else case-
    // insensitive substring over id+text; RegExp tested over id+text; ALL on
    // clear) so the snapshot is exactly the set forgetExemplars will drop.
    let snapshotIds = [];
    try {
      const current = listExemplars(rest);
      if (Array.isArray(current)) {
        const match = exemplarMatcher(idOrPattern, forgetAll);
        snapshotIds = current.filter((ex) => ex && match(ex)).map((ex) => ex.id);
      }
    } catch {
      snapshotIds = []; // snapshot is best-effort; the removal is primary.
    }

    let res;
    try {
      res = forgetAll ? clearExemplars(rest) : forgetExemplars(idOrPattern, rest);
    } catch (err) {
      return { ok: false, code: err.code || 'EEXEMPLAR_FORGET', message: err.message, removed: 0 };
    }
    if (!res || res.ok !== true) {
      return { ok: false, code: (res && res.code) || 'EEXEMPLAR_FORGET', message: res && res.message, removed: 0 };
    }

    let egressRemoved = 0;
    if (snapshotIds.length > 0) {
      try {
        egressRemoved = purgeEgress(snapshotIds.map((id) => exemplarField(id)));
      } catch {
        egressRemoved = 0; // best-effort — exemplar removal is the primary contract.
      }
    }
    // Echo V1's `removed` (a count) back unchanged; also surface the concrete ids
    // we expunged from the egress trail so a caller can report precisely.
    return { ok: true, removed: res.removed, removedIds: snapshotIds, egressRemoved };
  }, { lockPath, ...rest });
}

/**
 * Build a predicate `(exemplar) => boolean` mirroring V1 forgetExemplars match
 * semantics, used ONLY to snapshot the to-be-removed ids for the egress purge:
 *   - forgetAll        -> every record;
 *   - RegExp           -> tested against id OR text;
 *   - string           -> exact id, else case-insensitive substring over id+text.
 * Kept in lockstep with exemplar-store.js forgetExemplars deliberately.
 */
function exemplarMatcher(idOrPattern, forgetAll) {
  if (forgetAll) return () => true;
  if (idOrPattern instanceof RegExp) {
    return (r) => idOrPattern.test(String(r.id)) || idOrPattern.test(String(r.text));
  }
  const s = String(idOrPattern == null ? '' : idOrPattern);
  if (!s) return () => false;
  const lower = s.toLowerCase();
  return (r) =>
    r.id === s ||
    String(r.id).toLowerCase().includes(lower) ||
    String(r.text).toLowerCase().includes(lower);
}
