/**
 * profile/capture.js — Cross-system profile bus, PHASE P1 (the INPUT side).
 *
 * Turns REAL sessions into the per-session METADATA the P2 heuristic derivation
 * (./derive-heuristic.js `deriveStyle`) consumes. This is capture-hardening +
 * anti-poison + anti-drift: the gate that decides what evidence is allowed to
 * reach the one global profile, and in what shape.
 *
 * ── DATA MINIMIZATION (the load-bearing invariant) ──────────────────────────
 * METADATA ONLY. We NEVER persist raw transcript text. `extractMessageMetadata`
 * reduces a message to COUNTS (chars / emoji / code-block presence / formality
 * marker hits) and discards the string immediately. The per-session accumulator
 * and the wire record carry only numbers + booleans + an opaque salted identity.
 * Storing message content anywhere is a P1 failure (see profile-capture.test).
 *
 * ── WIRING CONTRACT (other agents read this — match exactly) ────────────────
 * OUTPUT FILE: <REPO_ROOT>/.ijfw/.session-style.jsonl — one JSON line per
 * session, appended at SessionEnd:
 *   { ts, session_id, host, avg_msg_chars, emoji_rate, code_block_ratio,
 *     formality_markers, turn_cadence_s, msg_count,
 *     profile_influenced, global_eligible, quarantine_reason, identity,
 *     trust_weight, delta_cap }
 *
 * The five style fields line up with what `deriveStyle` consumes; `toDeriveMeta`
 * renames the two that differ in unit (emoji_rate -> emoji_per_msg,
 * turn_cadence_s -> turn_cadence_per_min) so the P2 input shape is exact.
 * `formality_markers` and `code_block_ratio` are already in [0,1] as deriveStyle
 * expects, so they pass through unchanged.
 *
 * ── LIFECYCLE WIRING ────────────────────────────────────────────────────────
 *  - Per message (UserPromptSubmit hook): `captureMessage({sessionId,text,...})`
 *    extracts metadata and folds it into the accumulator state file
 *    `.ijfw/.session-style-acc.json` (counts only). The hook ALREADY imports a
 *    module from mcp-server/src and ALREADY has the {session_id,prompt} payload
 *    — capture rides that same call site (see pre-prompt.sh wiring note in the
 *    P1 report). `profileInjected:true` is passed when a profile brief was
 *    injected into the turn, so the session can be excluded from re-derivation.
 *  - Session end (Stop hook): `flushSession({sessionId,...})` reads the
 *    accumulator, applies the hardening gates, appends ONE contract record, and
 *    clears the accumulator.
 *
 * Zero deps, Node ESM, no network, no child_process, no LLM.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Paths. All capture state is PROJECT-LOCAL under <repo>/.ijfw/ — unlike the
// global profile (homedir-rooted), the per-session capture stream is scoped to
// the project it was observed in. The dream/derive stage decides what, if
// anything, is promoted to the global profile (and the gates below decide what
// is even ELIGIBLE for that promotion).
// ---------------------------------------------------------------------------

const IJFW_DIR = '.ijfw';
const STYLE_FILE = '.session-style.jsonl';
const ACC_FILE = '.session-style-acc.json';

function ijfwDir(cwd) {
  return join(cwd || process.cwd(), IJFW_DIR);
}

/** The append-only per-session style stream (the WIRING CONTRACT output). */
export function styleFilePath(cwd) {
  return join(ijfwDir(cwd), STYLE_FILE);
}

/** The in-flight per-session accumulator (counts only; cleared on flush). */
export function accumulatorPath(cwd) {
  return join(ijfwDir(cwd), ACC_FILE);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// P1.5 — PII / special-category deny-gate.
//
// We store interaction STYLE, never personal attributes. The deny-gate is a
// REAL check applied BEFORE persist: if any key in a candidate record names a
// special-category attribute (GDPR Art. 9 categories + obvious direct PII), the
// record is refused outright rather than redacted — we never want this class of
// data in the profile pipeline at all.
// ---------------------------------------------------------------------------

/** Special-category / direct-PII attribute keys that must never be persisted. */
export const SPECIAL_CATEGORY_KEYS = Object.freeze([
  'race',
  'ethnicity',
  'religion',
  'religious_belief',
  'political_opinion',
  'political_affiliation',
  'sexual_orientation',
  'sex_life',
  'health',
  'health_condition',
  'medical',
  'disability',
  'genetic',
  'biometric',
  'trade_union',
  'criminal_record',
  // direct identifiers that are not interaction style
  'ssn',
  'national_id',
  'passport',
  'credit_card',
  'email',
  'phone',
  'address',
  'full_name',
  'date_of_birth',
  'dob',
]);

const SPECIAL_CATEGORY_SET = new Set(SPECIAL_CATEGORY_KEYS);

/**
 * assertNoSpecialCategory(attrs) -> { ok, refused? }.
 *
 * Refuses if ANY key is a special-category / direct-PII attribute. Interaction-
 * style metadata (avg_msg_chars, emoji_rate, formality_markers, …) is allowed —
 * that is exactly what we DO store. Case-insensitive on the key name.
 */
export function assertNoSpecialCategory(attrs) {
  if (!attrs || typeof attrs !== 'object') return { ok: true };
  for (const key of Object.keys(attrs)) {
    if (SPECIAL_CATEGORY_SET.has(String(key).toLowerCase())) {
      return { ok: false, refused: key };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// P1.6 — identity partitioning + shared-machine stance.
//
// The global profile contribution is bound to the OS user (+ a stable salt) so
// two OS users on one machine never blend into one profile. On an AMBIGUOUS
// shared machine (no resolvable user, or an explicit shared-machine signal) we
// REFUSE the global contribution — session-local capture still proceeds (we do
// not throw away the data), but `global_eligible` is false so the dream/derive
// stage will not promote it cross-machine.
// ---------------------------------------------------------------------------

/** Per-install identity salt path — stable, homedir-independent of project. */
const IDENTITY_SALT_ENV = 'IJFW_IDENTITY_SALT';
const DEFAULT_SALT = 'ijfw-profile-identity-v1';

function resolveOsUser(env) {
  const e = env || {};
  const u = e.USER || e.USERNAME || e.LOGNAME || '';
  return String(u || '').trim();
}

/**
 * computeIdentity({env}) -> { identity, user, ambiguous }.
 *
 * `identity` is a SALTED hash of the OS user — never the raw username — so two
 * users get two distinct, opaque identities. `ambiguous` is true when no OS user
 * is resolvable OR a shared-machine signal is present; an ambiguous identity is
 * not eligible to contribute to the cross-machine global profile.
 */
export function computeIdentity({ env } = {}) {
  const e = env || {};
  const user = resolveOsUser(e);
  const sharedSignal = e.IJFW_SHARED_MACHINE === '1' || e.IJFW_SHARED_MACHINE === 'true';
  const salt = (e[IDENTITY_SALT_ENV] && String(e[IDENTITY_SALT_ENV]).trim()) || DEFAULT_SALT;
  const ambiguous = !user || sharedSignal;
  // Bind to user + machine so the same username on two machines is still two
  // identities (a shared username like "ubuntu" on CI boxes must not collide).
  const basis = `${salt}::${user || 'UNKNOWN'}::${hostname()}`;
  const identity = createHash('sha256').update(basis).digest('hex').slice(0, 24);
  return { identity, user: user || null, ambiguous };
}

// ---------------------------------------------------------------------------
// P1.3 — context quarantine (anti-poison).
//
// CI / shared-runner / multi-tenant contexts must not poison the GLOBAL profile:
// a build agent's terse machine output is not the user's authorship style. We
// detect the common CI env vars + shared/multi-tenant path shapes and mark the
// session global-ineligible (session-local capture still records, for project
// scope, but it never reaches the cross-machine profile).
// ---------------------------------------------------------------------------

/** CI / automation environment variables (presence of any => CI context). */
const CI_ENV_VARS = Object.freeze([
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER',
  'DRONE',
  'APPVEYOR',
  'CODEBUILD_BUILD_ID',
]);

/** Path fragments that signal a shared runner / multi-tenant workspace. */
const SHARED_PATH_PATTERNS = [
  /\/runner\/work\//i, // GitHub Actions runner
  /\/var\/lib\/jenkins\//i, // Jenkins
  /\/jenkins\/workspace\//i,
  /\/home\/circleci\//i,
  /\/builds\//i, // GitLab CI default
  /\/buildkite\//i,
  /\/codebuild\//i,
];

/**
 * detectQuarantine({env, cwd}) -> { quarantined, reason }.
 *
 * Pure. `reason` is a short stable string (e.g. "ci:GITHUB_ACTIONS",
 * "shared-path") suitable for the wire record. A clean local dev path with no CI
 * vars is NOT quarantined.
 */
export function detectQuarantine({ env, cwd } = {}) {
  const e = env || {};
  for (const v of CI_ENV_VARS) {
    const val = e[v];
    if (val !== undefined && val !== null && String(val) !== '' && String(val) !== '0' && String(val).toLowerCase() !== 'false') {
      return { quarantined: true, reason: `ci:${v}` };
    }
  }
  const p = String(cwd || '');
  for (const re of SHARED_PATH_PATTERNS) {
    if (re.test(p)) return { quarantined: true, reason: 'shared-path' };
  }
  return { quarantined: false, reason: null };
}

// ---------------------------------------------------------------------------
// P1.4 — per-host trust weighting + single-session influence cap + asymmetric
// decay.
//
// trustWeightForHost: first-party hosts (where we control the capture quality)
// are trusted more than unknown ones. Bounded (0,1].
//
// cappedDelta: a SINGLE session can never move an axis past STYLE_DELTA_CAP from
// its prior, no matter how extreme the sample or how high the weight/trust. This
// is the structural anti-drift guarantee the merge relies on.
//
// asymmetricStep: a CONTRADICTING signal (opposite side of the 0.5 midpoint from
// the current belief) adapts FASTER than a confirming one — so a real change in
// the user's behavior is reflected within a few sessions, while noise that
// merely re-confirms the current belief barely moves it. This is the classic
// "trust slowly, distrust quickly" asymmetry that keeps a stale profile from
// lagging a genuine shift.
// ---------------------------------------------------------------------------

/** Max distance a single session may move a style axis from its prior. */
export const STYLE_DELTA_CAP = 0.25;

/** Confirming-signal learning rate (slow). */
export const CONFIRM_ALPHA = 0.15;
/** Contradicting-signal learning rate (fast — distrust quickly). */
export const CONTRADICT_ALPHA = 0.35;

/** Known first-party hosts and their trust weights. Unknown -> conservative. */
const HOST_TRUST = Object.freeze({
  'claude-code': 1.0,
  'claude': 1.0,
  'codex': 0.9,
  'gemini': 0.9,
  'cursor': 0.85,
  'windsurf': 0.85,
  'copilot': 0.8,
  'hermes': 0.8,
  'wayland': 0.8,
  'aider': 0.75,
});
const UNKNOWN_HOST_TRUST = 0.5;

/**
 * trustWeightForHost(host) -> (0,1]. Deterministic. Known first-party hosts are
 * trusted at least as much as an unknown host.
 */
export function trustWeightForHost(host) {
  const key = String(host || '').toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(HOST_TRUST, key)) return HOST_TRUST[key];
  return UNKNOWN_HOST_TRUST;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * cappedDelta(prior, sample, {weight, trust}) -> new value in [0,1].
 *
 * Moves `prior` toward `sample` by a weight*trust-scaled EMA step, then HARD
 * clamps the net move to ±STYLE_DELTA_CAP. The clamp is the guarantee: one
 * session cannot move an axis past the cap regardless of weight/trust/extremity.
 */
export function cappedDelta(prior, sample, { weight = 1, trust = 1 } = {}) {
  const p = clamp01(prior);
  const s = clamp01(sample);
  const w = clamp01(weight) * clamp01(trust);
  const step = (s - p) * CONFIRM_ALPHA * w;
  const capped = Math.max(-STYLE_DELTA_CAP, Math.min(STYLE_DELTA_CAP, step));
  return clamp01(p + capped);
}

/**
 * asymmetricStep(current, sample) -> new value in [0,1].
 *
 * Contradiction (sample on the opposite side of the 0.5 midpoint from current)
 * uses CONTRADICT_ALPHA (fast); confirmation uses CONFIRM_ALPHA (slow). The move
 * is still bounded by STYLE_DELTA_CAP per step so a single contradicting session
 * cannot overshoot.
 */
export function asymmetricStep(current, sample) {
  const c = clamp01(current);
  const s = clamp01(sample);
  const currentSide = c >= 0.5 ? 1 : -1;
  const sampleSide = s >= 0.5 ? 1 : -1;
  const contradicting = sampleSide !== currentSide;
  const alpha = contradicting ? CONTRADICT_ALPHA : CONFIRM_ALPHA;
  const step = (s - c) * alpha;
  const capped = Math.max(-STYLE_DELTA_CAP, Math.min(STYLE_DELTA_CAP, step));
  return clamp01(c + capped);
}

// ---------------------------------------------------------------------------
// P1.1 — metadata-only message extraction.
//
// Reduce ONE message to counts and throw the text away. Emoji counting uses a
// Unicode property escape; formality markers are a small deterministic lexicon
// of polite/formal cues (mirrors feedback-detector's high-precision posture);
// code-block presence is a fenced-block check. NOTHING here returns the string.
// ---------------------------------------------------------------------------

// Emoji: pictographic + emoji-component ranges. Property escapes are supported
// in modern Node; the `u` flag is required. We count matches, never store them.
const EMOJI_RE = /(\p{Extended_Pictographic})/gu;
const CODE_FENCE_RE = /```|~~~|(?:^|\n) {4,}\S/; // fenced block or 4-space indent code
const FORMALITY_MARKERS = [
  /\bplease\b/i,
  /\bthank you\b/i,
  /\bthanks\b/i,
  /\bkindly\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bI would appreciate\b/i,
  /\bregards\b/i,
  /\bsincerely\b/i,
  /\bcertainly\b/i,
  /\bfurthermore\b/i,
  /\bhowever\b/i,
];

/**
 * extractMessageMetadata(text) -> { chars, emojis, hasCode, formalityHits, words }.
 *
 * METADATA ONLY. Returns counts; never returns or embeds the message text.
 */
export function extractMessageMetadata(text) {
  const s = typeof text === 'string' ? text : '';
  const chars = s.length;
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  let emojis = 0;
  if (s) {
    const m = s.match(EMOJI_RE);
    emojis = m ? m.length : 0;
  }
  const hasCode = CODE_FENCE_RE.test(s);
  let formalityHits = 0;
  for (const re of FORMALITY_MARKERS) {
    if (re.test(s)) formalityHits += 1;
  }
  return { chars, emojis, hasCode, formalityHits, words };
}

// ---------------------------------------------------------------------------
// Accumulator — per-session running totals (counts only). Read/modify/write of
// a small JSON file. Robust to a missing/corrupt accumulator (starts fresh).
// ---------------------------------------------------------------------------

function freshAccumulator(sessionId, ts) {
  return {
    v: 1,
    session_id: sessionId || null,
    first_ts: Number.isFinite(ts) ? ts : null,
    last_ts: Number.isFinite(ts) ? ts : null,
    msg_count: 0,
    total_chars: 0,
    total_emojis: 0,
    code_msgs: 0,
    formality_msgs: 0, // messages that contained >=1 formality marker
    formality_hits: 0, // total marker hits (for density)
    profile_influenced: false,
  };
}

function readAccumulator(cwd) {
  const p = accumulatorPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const acc = JSON.parse(readFileSync(p, 'utf8'));
    if (acc && typeof acc === 'object') return acc;
  } catch {
    // corrupt -> treat as absent (start fresh)
  }
  return null;
}

function writeAccumulator(cwd, acc) {
  ensureDir(ijfwDir(cwd));
  writeFileSync(accumulatorPath(cwd), JSON.stringify(acc), 'utf8');
}

function clearAccumulator(cwd) {
  const p = accumulatorPath(cwd);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best-effort
  }
}

/**
 * captureMessage({sessionId, text, ts, profileInjected, cwd, env}) -> {ok}.
 *
 * Per-message entrypoint (UserPromptSubmit hook). Extracts METADATA from `text`,
 * folds it into the per-session accumulator, and discards the text. Idempotent
 * w.r.t. shape: a new accumulator is created on the first message of a session
 * (or when the session_id changes — a stale accumulator from a previous session
 * is replaced rather than blended).
 *
 * `profileInjected:true` marks that a profile brief was injected into this turn
 * (P1.2) — the whole session is then flagged profile_influenced at flush.
 */
export function captureMessage({ sessionId, text, ts, profileInjected, cwd } = {}) {
  const root = cwd || process.cwd();
  const numTs = Number(ts);
  let acc = readAccumulator(root);
  if (!acc || acc.session_id !== (sessionId || null)) {
    acc = freshAccumulator(sessionId || null, numTs);
  }

  const meta = extractMessageMetadata(text);
  acc.msg_count += 1;
  acc.total_chars += meta.chars;
  acc.total_emojis += meta.emojis;
  if (meta.hasCode) acc.code_msgs += 1;
  if (meta.formalityHits > 0) acc.formality_msgs += 1;
  acc.formality_hits += meta.formalityHits;
  if (Number.isFinite(numTs)) {
    if (acc.first_ts === null) acc.first_ts = numTs;
    acc.last_ts = numTs;
  }
  // P1.2: any brief-injected message taints the whole session for re-derivation.
  if (profileInjected === true) acc.profile_influenced = true;

  try {
    writeAccumulator(root, acc);
  } catch (err) {
    return { ok: false, code: 'EACC_WRITE', error: err.message };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resolve the capture host from env (which platform produced the session).
// ---------------------------------------------------------------------------
function resolveHost(env) {
  const e = env || {};
  const h = e.IJFW_HOST || e.IJFW_PLATFORM || '';
  return String(h || 'claude-code').trim() || 'claude-code';
}

/**
 * flushSession({sessionId, ts, cwd, env, extraAttributes}) -> {ok}/{ok:false,...}.
 *
 * SessionEnd entrypoint. Reads the accumulator, computes the per-session contract
 * record, applies ALL hardening gates, appends ONE JSON line to
 * .ijfw/.session-style.jsonl, and clears the accumulator.
 *
 * Gate order (fail-closed BEFORE any write):
 *   1. P1.5 PII deny-gate over `extraAttributes` and the derived record — refuse
 *      to persist anything carrying a special-category attribute.
 *   2. P1.6 identity binding + shared-machine stance (sets identity; ambiguous
 *      machine => global ineligible).
 *   3. P1.3 context quarantine (CI / shared path => global ineligible).
 *   4. P1.2 profile_influenced flag carried through from the accumulator.
 *   5. P1.4 per-host trust weight + delta cap stamped onto the record.
 */
export function flushSession({ sessionId, ts, cwd, env, extraAttributes } = {}) {
  const root = cwd || process.cwd();
  const e = env || {};

  // P1.5 — deny-gate on any caller-supplied attributes BEFORE we do anything.
  if (extraAttributes !== undefined) {
    const gate = assertNoSpecialCategory(extraAttributes);
    if (!gate.ok) {
      return { ok: false, code: 'ESPECIAL_CATEGORY_DENIED', refused: gate.refused,
        error: `special-category attribute refused before persist: ${gate.refused}` };
    }
  }

  const acc = readAccumulator(root);
  if (!acc || acc.msg_count <= 0) {
    // Nothing captured this session — clean no-op, no empty record.
    clearAccumulator(root);
    return { ok: true, skipped: 'no-messages' };
  }

  const msgCount = acc.msg_count;
  const avgChars = acc.total_chars / msgCount;
  const emojiRate = acc.total_emojis / msgCount; // emoji per message
  const codeRatio = clamp01(acc.code_msgs / msgCount); // fraction of msgs w/ code, [0,1]
  // formality_markers as a [0,1] density: fraction of messages that carried a
  // formal marker. This is exactly what deriveStyle expects (0..1 marker density).
  const formality = clamp01(acc.formality_msgs / msgCount);
  // Turn cadence in SECONDS between messages (the contract unit). With one
  // message there is no inter-turn gap; report 0 (deriveStyle treats it as a
  // present-but-zero cadence). With N messages over a span, mean gap = span/(N-1).
  let cadenceS = 0;
  if (msgCount > 1 && Number.isFinite(acc.first_ts) && Number.isFinite(acc.last_ts) && acc.last_ts > acc.first_ts) {
    cadenceS = ((acc.last_ts - acc.first_ts) / 1000) / (msgCount - 1);
  }

  const host = resolveHost(e);

  // P1.6 — identity binding + shared-machine stance.
  const id = computeIdentity({ env: e });

  // P1.3 — context quarantine.
  const quar = detectQuarantine({ env: e, cwd: root });

  // global eligibility: a session may contribute to the cross-machine GLOBAL
  // profile only if it is NOT quarantined AND the identity is NOT ambiguous.
  const globalEligible = !quar.quarantined && !id.ambiguous;
  const quarantineReason = quar.quarantined
    ? quar.reason
    : (id.ambiguous ? 'ambiguous-identity' : null);

  // P1.4 — per-host trust + the single-session influence cap, stamped so the
  // dream/derive + merge stages apply them.
  const trustWeight = trustWeightForHost(host);

  const record = {
    ts: Number.isFinite(Number(ts)) ? Number(ts) : (Number.isFinite(acc.last_ts) ? acc.last_ts : Date.now()),
    session_id: acc.session_id || sessionId || null,
    host,
    // ── style metadata (lines up with deriveStyle via toDeriveMeta) ──
    avg_msg_chars: Math.round(avgChars * 100) / 100,
    emoji_rate: Math.round(emojiRate * 1000) / 1000,
    code_block_ratio: Math.round(codeRatio * 1000) / 1000,
    formality_markers: Math.round(formality * 1000) / 1000,
    turn_cadence_s: Math.round(cadenceS * 100) / 100,
    msg_count: msgCount,
    // ── hardening metadata ──
    profile_influenced: acc.profile_influenced === true, // P1.2
    global_eligible: globalEligible, // P1.3 + P1.6
    quarantine_reason: quarantineReason,
    identity: id.identity, // P1.6
    trust_weight: trustWeight, // P1.4
    delta_cap: STYLE_DELTA_CAP, // P1.4
  };

  // P1.5 — final deny-gate over the assembled record itself (defense in depth:
  // no special-category key may have crept in via any path).
  const recGate = assertNoSpecialCategory(record);
  if (!recGate.ok) {
    return { ok: false, code: 'ESPECIAL_CATEGORY_DENIED', refused: recGate.refused,
      error: `special-category attribute refused before persist: ${recGate.refused}` };
  }

  // Merge caller-supplied NON-special attributes (already gated) — additive,
  // never overwriting the contract fields.
  if (extraAttributes && typeof extraAttributes === 'object') {
    for (const [k, v] of Object.entries(extraAttributes)) {
      if (!Object.prototype.hasOwnProperty.call(record, k)) record[k] = v;
    }
  }

  try {
    ensureDir(ijfwDir(root));
    appendFileSync(styleFilePath(root), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: err.message };
  }

  clearAccumulator(root);
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Adapter: wire record -> exact deriveStyle input shape.
//
// deriveStyle reads: avg_msg_chars, emoji_per_msg, code_block_ratio,
// formality_markers, turn_cadence_per_min. Two of our contract fields differ in
// unit/name: emoji_rate (per msg) -> emoji_per_msg; turn_cadence_s (seconds
// between turns) -> turn_cadence_per_min (turns per minute). We convert here so
// P2 never has to know the wire format.
// ---------------------------------------------------------------------------

/**
 * toDeriveMeta(record) -> the object `deriveStyle` consumes.
 *
 * Pure. Only emits a field when its source is present, so a partial record
 * yields a partial meta (deriveStyle falls back to its neutral prior for absent
 * axes). turn_cadence_s of 0 maps to 0 turns/min (present-but-zero cadence).
 */
export function toDeriveMeta(record) {
  const r = record && typeof record === 'object' ? record : {};
  const meta = {};
  if (r.avg_msg_chars !== undefined && r.avg_msg_chars !== null) meta.avg_msg_chars = r.avg_msg_chars;
  if (r.emoji_rate !== undefined && r.emoji_rate !== null) meta.emoji_per_msg = r.emoji_rate;
  if (r.code_block_ratio !== undefined && r.code_block_ratio !== null) meta.code_block_ratio = r.code_block_ratio;
  if (r.formality_markers !== undefined && r.formality_markers !== null) meta.formality_markers = r.formality_markers;
  if (r.turn_cadence_s !== undefined && r.turn_cadence_s !== null) {
    // seconds-between-turns -> turns-per-minute. 0s gap => 0 turns/min (present).
    const s = Number(r.turn_cadence_s);
    meta.turn_cadence_per_min = Number.isFinite(s) && s > 0 ? 60 / s : 0;
  }
  // FIX 2 (CRITICAL-1 / M1 / H4): carry the per-host trust weight through so the
  // merge fold can apply trust scaling. Before this, toDeriveMeta DROPPED
  // trust_weight and the documented per-host trust weighting was inert. We
  // resolve trust from the recorded `trust_weight` when present, falling back to
  // the host's known trust (so a record that pre-dates the stamp is still
  // trust-scaled) — never silently full-trust an unknown host.
  if (r.trust_weight !== undefined && r.trust_weight !== null && Number.isFinite(Number(r.trust_weight))) {
    meta.trust_weight = Number(r.trust_weight);
  } else if (r.host !== undefined && r.host !== null) {
    meta.trust_weight = trustWeightForHost(r.host);
  }
  return meta;
}

// ===========================================================================
// S4 — EDIT-DELTA CAPTURE: the CORRECTION LOOP (the HEART of the product).
//
// The strongest, currently-missing personalization signal is NOT a regex
// trigger in a prompt — it is the clean ground-truth DIFF between what the
// AGENT PROPOSED and what the USER COMMITTED it to. Per the cross-audit: that
// diff IS the citation. An X->Y correction ("agent wrote `var`, user changed it
// to `const`") is direct evidence of a preference, grounded in an actual edit.
//
// We observe this at the PostToolUse boundary for Edit/Write tools:
//   - Edit  tool_input: { file_path, old_string (PROPOSED prior), new_string (COMMITTED) }
//   - Write tool_input: { file_path, content (COMMITTED), } (+ prior file content = PROPOSED)
// A first edit landing is the agent's proposal; a LATER edit to the SAME span/
// file is the user's correction of it. We record EVERY edit-delta as an
// evidence row carring (a) a real CITED SPAN (PII-scrubbed excerpt + content
// hashes for dedupe), (b) SCOPE (file-pattern / language / repo-relative path),
// and (c) an authorship OUTCOME (accept vs edit-after) for the expertise tier.
//
// DATA MINIMIZATION (same invariant as the style stream): we DO NOT persist the
// full file. The cited span is a BOUNDED, PII-scrubbed excerpt of the changed
// region only; the proposed/committed bodies are reduced to salted content
// HASHES so two identical edits dedupe without ever storing raw secrets.
//
// WIRING CONTRACT (the dream runner consumes this exactly like the feedback
// stream): OUTPUT FILE <REPO_ROOT>/.ijfw/.session-edits.jsonl — one JSON line
// per observed edit-delta:
//   { ts, session_id, host, scope:{file_pattern,language,repo_rel},
//     outcome:'accept'|'edit-after', proposed_hash, committed_hash,
//     cited_span, direction, identity, trust_weight }
// ===========================================================================

const EDIT_FILE = '.session-edits.jsonl';

/** The append-only per-session edit-delta evidence stream (S4 contract). */
export function editFilePath(cwd) {
  return join(ijfwDir(cwd), EDIT_FILE);
}

/** Max characters of a changed region we keep as the human-glanceable cited span. */
export const CITED_SPAN_MAX = 160;

// Extension -> coarse language label. Scope is "where this preference applies"
// (a file-pattern / language / repo-relative path) — NOT the raw absolute path,
// which could leak a username via /Users/<name>/ or /home/<name>/.
const EXT_LANGUAGE = Object.freeze({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', scala: 'scala', sh: 'shell', bash: 'shell',
  zsh: 'shell', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', html: 'html', css: 'css', scss: 'css', sql: 'sql',
});

/**
 * scopeForPath(filePath, {cwd}) -> { file_pattern, language, repo_rel }.
 *
 * Pure. Derives the SCOPE a preference grounded in an edit applies to, WITHOUT
 * persisting an absolute path (which can carry the OS username — a direct
 * identifier we never store). `file_pattern` is a glob over the extension
 * (`*.js`), `language` is the coarse label, `repo_rel` is the path relative to
 * the repo root (when it sits inside it) — never an absolute path.
 */
export function scopeForPath(filePath, { cwd } = {}) {
  const raw = String(filePath || '').trim();
  // Basename + extension, robust to either path separator.
  const base = raw.split(/[/\\]/).filter(Boolean).pop() || '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const file_pattern = ext ? `*.${ext}` : (base || '*');
  const language = (ext && EXT_LANGUAGE[ext]) || (ext || 'unknown');

  // repo-relative path ONLY when the file is inside the project root; otherwise
  // fall back to the basename so we never persist a homedir-rooted absolute path.
  let repo_rel = base;
  const root = String(cwd || '');
  if (root && raw) {
    const norm = raw.replace(/\\/g, '/');
    const nroot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === nroot) repo_rel = base;
    else if (norm.startsWith(`${nroot}/`)) repo_rel = norm.slice(nroot.length + 1);
  }
  return { file_pattern, language, repo_rel };
}

/** Salted content hash of an edit body — dedupe key, never the raw body. */
function contentHash(s) {
  const salt = process.env[IDENTITY_SALT_ENV] && String(process.env[IDENTITY_SALT_ENV]).trim()
    ? String(process.env[IDENTITY_SALT_ENV]).trim()
    : DEFAULT_SALT;
  return createHash('sha256').update(`${salt}::edit::${String(s == null ? '' : s)}`).digest('hex').slice(0, 16);
}

// Direct-identifier patterns scrubbed from a cited span before persist. Mirrors
// derive-heuristic.js PII_PATTERNS in spirit (kept local — capture.js must not
// import the derive module, to keep the zero-LLM/zero-network import graph of
// the derive side clean). Keep in sync deliberately if either list grows.
const EDIT_PII_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,        // email
  // eslint-disable-next-line security/detect-unsafe-regex -- linear-time PII redactor: each repetition consumes a mandatory digit, no ambiguous/overlapping quantifier; not ReDoS-exploitable.
  /(?:\+?\d[\s().-]?){7,}\d/g,                        // phone-ish run of digits
  /\b\d{3}-\d{2}-\d{4}\b/g,                           // US SSN shape
  // eslint-disable-next-line security/detect-unsafe-regex -- linear-time PII redactor: each repetition consumes a mandatory digit, no ambiguous/overlapping quantifier; not ReDoS-exploitable.
  /\b(?:\d[ -]?){13,19}\b/g,                          // card-ish long digit run
  /\b[A-Za-z0-9_-]*(?:secret|token|api[_-]?key|password|passwd|bearer)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi, // assigned secret
];

/**
 * citedSpan(committed, proposed) -> a bounded, PII-scrubbed excerpt of the
 * CHANGED region. This is the human-glanceable citation ("you changed it TO
 * this"). We take the committed side (the user's final), scrub direct
 * identifiers / assigned secrets, collapse whitespace, and cap the length. Pure.
 */
export function citedSpan(committed) {
  let s = String(committed == null ? '' : committed);
  for (const re of EDIT_PII_PATTERNS) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, CITED_SPAN_MAX);
}

/**
 * extractEditDelta({ proposed, committed, filePath, cwd }) ->
 *   { changed, outcome, scope, proposed_hash, committed_hash, cited_span, direction }
 *   | null.
 *
 * METADATA-MINIMIZED. The ground-truth correction signal. Returns null for a
 * no-op (no usable file path, or proposed === committed AND both empty). When
 * the committed body DIFFERS from what the agent proposed, this is an
 * `edit-after` correction (outcome) and `changed:true`; when they are identical
 * (a Write that landed exactly / an accepted Edit) it is an `accept`. The
 * `direction` is the bounded cited excerpt of the committed side — the citation.
 */
export function extractEditDelta({ proposed, committed, filePath, cwd } = {}) {
  const fp = String(filePath || '').trim();
  if (!fp) return null;
  const prop = proposed == null ? '' : String(proposed);
  const comm = committed == null ? '' : String(committed);
  if (prop === '' && comm === '') return null; // nothing observed

  const changed = prop !== comm;
  return {
    changed,
    outcome: changed ? 'edit-after' : 'accept',
    scope: scopeForPath(fp, { cwd }),
    proposed_hash: contentHash(prop),
    committed_hash: contentHash(comm),
    cited_span: citedSpan(comm),
    direction: citedSpan(comm), // alias kept explicit: the cited committed span
  };
}

/**
 * captureEditDelta({ sessionId, filePath, proposed, committed, ts, cwd, env,
 *   profileInjected }) -> { ok, skipped? } | { ok:false, code, error }.
 *
 * PostToolUse(Edit|Write) entrypoint. Computes the metadata-minimized edit-delta
 * and APPENDS one evidence row to .ijfw/.session-edits.jsonl. Best-effort and
 * fail-soft: a malformed payload or a write error never throws (the hook must
 * never block a tool). The row is identity-bound + trust-weighted exactly like
 * the style stream so the global merge can apply the same eligibility gates.
 *
 * `profileInjected:true` marks the session as profile-influenced so the dream
 * runner can exclude self-reinforcing edits the same way it does style rows.
 */
export function captureEditDelta({
  sessionId, filePath, proposed, committed, ts, cwd, env, profileInjected,
} = {}) {
  const root = cwd || process.cwd();
  const e = env || {};

  let delta;
  try {
    delta = extractEditDelta({ proposed, committed, filePath, cwd: root });
  } catch (err) {
    return { ok: false, code: 'EEXTRACT', error: err.message };
  }
  if (!delta) return { ok: true, skipped: 'no-delta' };

  const host = resolveHost(e);
  const id = computeIdentity({ env: e });
  const quar = detectQuarantine({ env: e, cwd: root });
  const globalEligible = !quar.quarantined && !id.ambiguous;

  const record = {
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    session_id: sessionId || null,
    host,
    scope: delta.scope,
    outcome: delta.outcome, // 'accept' | 'edit-after'
    changed: delta.changed,
    proposed_hash: delta.proposed_hash,
    committed_hash: delta.committed_hash,
    cited_span: delta.cited_span, // bounded, PII-scrubbed citation
    direction: delta.direction,
    profile_influenced: profileInjected === true,
    global_eligible: globalEligible,
    quarantine_reason: quar.quarantined ? quar.reason : (id.ambiguous ? 'ambiguous-identity' : null),
    identity: id.identity,
    trust_weight: trustWeightForHost(host),
  };

  // Defense in depth: the cited span must never carry a special-category KEY
  // (it is a value, but the assembled record is gated the same way the style
  // record is — a special-category attribute on any path is refused).
  const recGate = assertNoSpecialCategory(record);
  if (!recGate.ok) {
    return { ok: false, code: 'ESPECIAL_CATEGORY_DENIED', refused: recGate.refused,
      error: `special-category attribute refused before persist: ${recGate.refused}` };
  }

  try {
    ensureDir(ijfwDir(root));
    appendFileSync(editFilePath(root), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: err.message };
  }
  return { ok: true, record };
}
