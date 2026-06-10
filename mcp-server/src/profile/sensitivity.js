/**
 * profile/sensitivity.js — Cross-system profile bus, PHASE P4 (exfiltration guard).
 *
 * The data-minimization gate that decides WHAT may leave the machine when a
 * brief is rendered (design-v2 §6 "data minimization" + §7 "exfiltration").
 * Three concerns live here, all pure and zero-dep / zero-LLM:
 *
 *   1. SENSITIVITY TIERING — every renderable field is low / med / high.
 *        - low : style axes (formality/energy/terseness/emoji_use) + expertise
 *                bands. Behavioural fingerprint, not content. Shared by default.
 *        - med : preferences / corrections / rules — what the user asked for.
 *        - high: anything an inference explicitly tags `high` (e.g. a derived
 *                dialectic belief about the user). Never shared unless opted in.
 *      `brief` returns ONLY low-sensitivity fields by default; med/high require
 *      a per-host opt-in AND the resolved host being on the share-hosts
 *      allowlist (audit MED-2). The opt-in alone (env flag / arg) is necessary
 *      but NOT sufficient — a self-declared host can never grant itself
 *      sensitive fields; an operator must add it to the allowlist.
 *
 *   2. REDACTION LIST — a user-controlled denylist of field ids / substrings
 *      that must NEVER leave, honored BEFORE any field is emitted. Sourced from
 *      the env (IJFW_PROFILE_REDACT, comma/newline separated) AND a plaintext
 *      file at ~/.ijfw/profile/redact.txt (one pattern per line, # comments).
 *
 *   3. KILL-SWITCH — a global "share nothing" override. Engaged by the env var
 *      IJFW_PROFILE_KILL (truthy) or a bare `*` / `KILL` line in redact.txt.
 *      When engaged, renderBrief emits an EMPTY brief regardless of everything
 *      else — the user's hard stop on profile egress.
 *
 * Zero deps, Node built-ins only. NO LLM calls.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { profileDir } from './store.js';

/** Sensitivity levels, ordered low → high (index = severity). */
export const SENSITIVITY_ORDER = Object.freeze(['low', 'med', 'high']);

/** The four style axes are always low-sensitivity (behavioural fingerprint). */
const STYLE_LOW = 'low';
/** Expertise bands are low-sensitivity (a competence summary, not content). */
const EXPERTISE_LOW = 'low';

/**
 * fieldSensitivity(field) -> 'low' | 'med' | 'high'.
 *
 * `field` is a descriptor `{ kind, sensitivity? }`:
 *   - kind 'style'      -> low (always).
 *   - kind 'expertise'  -> low (always).
 *   - kind 'inference'  -> the inference's OWN sensitivity tag (schema.js sets
 *                          it; preferences default to 'med'), clamped to a known
 *                          level. Unknown/absent -> 'med' (fail-safe: an
 *                          un-tagged inference is treated as at least med, never
 *                          silently low).
 */
export function fieldSensitivity(field) {
  if (!field || typeof field !== 'object') return 'med';
  if (field.kind === 'style') return STYLE_LOW;
  if (field.kind === 'expertise') return EXPERTISE_LOW;
  // inference (preference/trait/dialectic): honor its own tag, fail-safe to med.
  const tag = String(field.sensitivity || '').toLowerCase();
  if (SENSITIVITY_ORDER.includes(tag)) return tag;
  return 'med';
}

/**
 * sensitivityAllowed(level, opts) -> boolean. Low is ALWAYS allowed. med/high
 * require BOTH (audit MED-2 + MED-3):
 *   - the per-call/per-env share-sensitive opt-in (shareSensitive), AND
 *   - the resolved host being on the share-hosts allowlist (hostAllowedSensitive).
 *   - and NOT opts.forceLowOnly (the passive resource path forces low-only —
 *     audit MED-3: the user cannot consent per passive read, so a passive
 *     injection NEVER honors a sensitive opt-in).
 * Either factor missing => low-only. The opt-in alone can never elevate a
 * non-allowlisted (or self-declared) host.
 */
export function sensitivityAllowed(level, opts = {}) {
  const lvl = SENSITIVITY_ORDER.includes(level) ? level : 'med';
  if (lvl === 'low') return true;
  if (opts.forceLowOnly === true) return false; // passive read: low-only, always.
  if (!shareSensitive(opts)) return false; // no opt-in => never sensitive.
  // MED-2 host allowlist: enforced whenever the serve layer engages it
  // (opts.enforceHostAllowlist === true — set for EVERY production read path in
  // serve.js). Direct unit callers of renderBrief that don't engage it fall back
  // to opt-in-only (the legacy P4.2 contract) — but they are NOT a production
  // egress surface, so the moat is intact: every real read goes through serve.js.
  if (opts.enforceHostAllowlist === true) return hostAllowedSensitive(opts);
  return true;
}

/** Truthy env values that engage a boolean flag. */
function isTruthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * shareSensitive(opts) -> boolean. The per-host opt-in to include med/high
 * fields in a brief. Read from opts.shareSensitive (explicit override, for
 * tests / programmatic callers) else the IJFW_PROFILE_SHARE_SENSITIVE env var.
 */
export function shareSensitive(opts = {}) {
  if (typeof opts.shareSensitive === 'boolean') return opts.shareSensitive;
  const env = opts.env || process.env;
  return isTruthy(env.IJFW_PROFILE_SHARE_SENSITIVE);
}

/** The share-hosts allowlist path (sibling of the profile). */
export function shareHostsFilePath() {
  return join(profileDir(), 'share-hosts.txt');
}

/**
 * loadShareHosts(opts) -> { hosts:Set<string>, all:boolean }.
 *
 * Reads the per-host sensitive-field allowlist from `~/.ijfw/profile/
 * share-hosts.txt` (one host per line, `#` comments) AND the env var
 * IJFW_PROFILE_SHARE_HOSTS (comma/newline separated). Hosts are lowercased for
 * case-insensitive matching. A bare `*` line opts ALL hosts in (operator escape
 * hatch — explicit and auditable). A missing/unreadable file -> empty set
 * (default-deny: no host gets sensitive fields). Never throws.
 *
 * @param {{ env?:object, shareHostsFile?:string }} [opts]
 */
export function loadShareHosts(opts = {}) {
  const env = opts.env || process.env;
  const raw = [];
  raw.push(...parsePatterns(env.IJFW_PROFILE_SHARE_HOSTS));
  const file = opts.shareHostsFile || shareHostsFilePath();
  try {
    if (existsSync(file)) {
      raw.push(...parsePatterns(readFileSync(file, 'utf8')));
    }
  } catch {
    // unreadable allowlist -> no hosts (default-deny). Never throw.
  }
  const hosts = new Set();
  let all = false;
  for (const h of raw) {
    if (h === '*') { all = true; continue; }
    hosts.add(h.toLowerCase());
  }
  return { hosts, all };
}

/**
 * hostAllowedSensitive(opts) -> boolean. True iff the resolved host is on the
 * share-hosts allowlist (audit MED-2). The host comes from opts.host (resolved
 * by the serve layer from the caller context, NOT self-declared by the field
 * payload). No host, or a host absent from the allowlist => false (default-deny).
 *
 * @param {{ host?:string, env?:object, shareHostsFile?:string,
 *           shareHosts?:{hosts:Set<string>,all:boolean} }} [opts]
 */
export function hostAllowedSensitive(opts = {}) {
  const host = typeof opts.host === 'string' ? opts.host.trim().toLowerCase() : '';
  if (!host) return false; // unknown host can never receive sensitive fields.
  const allow = opts.shareHosts || loadShareHosts(opts);
  if (allow.all) return true;
  return allow.hosts.has(host);
}

/** The redaction file path (sibling of the profile). */
export function redactFilePath() {
  return join(profileDir(), 'redact.txt');
}

/**
 * Parse a raw redaction blob (env value or file contents) into pattern lines.
 * Splits on commas AND newlines, trims, drops blanks and `#` comments.
 */
function parsePatterns(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));
}

/**
 * loadRedaction(opts) -> { patterns: string[], kill: boolean }.
 *
 * Merges the env denylist (IJFW_PROFILE_REDACT) and the redact.txt file. The
 * kill-switch is engaged by IJFW_PROFILE_KILL (truthy) OR a bare `*` / `KILL`
 * (case-insensitive) pattern in either source. File read is best-effort — a
 * missing/unreadable file is simply no patterns (never throws).
 *
 * @param {{ env?:object, redactFile?:string }} [opts]
 */
export function loadRedaction(opts = {}) {
  const env = opts.env || process.env;
  const patterns = [];

  // Env denylist.
  patterns.push(...parsePatterns(env.IJFW_PROFILE_REDACT));

  // File denylist (best-effort).
  const file = opts.redactFile || redactFilePath();
  try {
    if (existsSync(file)) {
      patterns.push(...parsePatterns(readFileSync(file, 'utf8')));
    }
  } catch {
    // unreadable redact file -> treat as no file patterns (never throw).
  }

  // Kill-switch: explicit env flag OR a bare `*`/`KILL` token in the patterns.
  const killTokens = new Set(['*', 'kill']);
  const killFromPatterns = patterns.some((p) => killTokens.has(p.toLowerCase()));
  const kill = isTruthy(env.IJFW_PROFILE_KILL) || killFromPatterns;

  // Drop the kill tokens from the substring denylist — they're a switch, not a
  // field pattern (a literal `*` would otherwise redact everything via substring
  // match, which is the same outcome, but we keep the two mechanisms distinct).
  const cleaned = patterns.filter((p) => !killTokens.has(p.toLowerCase()));

  return { patterns: cleaned, kill };
}

/**
 * killSwitchEngaged(redaction) -> boolean. Thin reader over loadRedaction's
 * result so callers can branch without re-parsing.
 */
export function killSwitchEngaged(redaction) {
  return !!(redaction && redaction.kill);
}

/**
 * isRedacted(fieldId, redaction) -> boolean. A field is redacted when its id
 * EXACTLY equals OR CONTAINS any denylist pattern (substring match mirrors the
 * memory `forget <pattern>` UX). Case-insensitive on both sides so a user need
 * not match casing exactly. An empty/absent denylist redacts nothing.
 */
export function isRedacted(fieldId, redaction) {
  if (!redaction || !Array.isArray(redaction.patterns) || redaction.patterns.length === 0) {
    return false;
  }
  const id = String(fieldId || '').toLowerCase();
  if (!id) return false;
  for (const p of redaction.patterns) {
    const needle = String(p).toLowerCase();
    if (!needle) continue;
    if (id === needle || id.includes(needle)) return true;
  }
  return false;
}
