/**
 * profile/schema.js — Cross-system profile bus, P0.1.
 *
 * The portable user-profile atom + container schema, plus a lossless
 * markdown+YAML-frontmatter (de)serialization. ZERO dependencies, Node
 * built-ins only. NO LLM calls (a later CI guard enforces this module never
 * reaches the LLM tier).
 *
 * Storage format (human-readable + hand-editable, per design-v2 §4):
 *   ---
 *   schema_version: N
 *   <scalar summary frontmatter>
 *   ---
 *
 *   # IJFW User Profile
 *   ...prose...
 *
 *   ```json
 *   { ...the full structured UserProfile... }
 *   ```
 *
 * The fenced JSON block is the canonical, lossless record (round-trip
 * identity). The frontmatter carries human-glanceable scalars + the
 * schema_version. We hand-roll a *minimal* flat-scalar frontmatter
 * parse/serialize (no YAML dep); nested structure lives in the JSON block so
 * round-trip fidelity never depends on a hand-rolled recursive YAML parser.
 */

export const SCHEMA_VERSION = 1;

/** The four EMA+Beta style axes (design-v2 §4). */
export const STYLE_AXES = Object.freeze(['formality', 'energy', 'terseness', 'emoji_use']);

const SENSITIVITIES = Object.freeze(['low', 'med', 'high']);

/**
 * Deterministic, stable id for an inference so two sessions deriving the "same"
 * trait dedupe to one atom on merge. Keyed on kind+subject (NOT value — a
 * changed value for the same subject is an *update*, not a new atom).
 */
export function inferenceId(kind, subject) {
  return `${String(kind)}::${String(subject)}`;
}

/**
 * makeInference — the best-in-field atom (Honcho + Copilot + BEP):
 * { id, kind, subject, value, confidence, evidence_count, last_confirmed,
 *   source_sessions[], source_hosts[], sensitivity }.
 */
export function makeInference(fields = {}) {
  const {
    kind,
    subject,
    value,
    confidence = 0.0,
    evidence_count = 0,
    last_confirmed = new Date(0).toISOString(),
    source_sessions = [],
    source_hosts = [],
    sensitivity = 'low',
  } = fields;

  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('makeInference: kind must be a non-empty string');
  }
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new TypeError('makeInference: subject must be a non-empty string');
  }
  if (!SENSITIVITIES.includes(sensitivity)) {
    throw new TypeError(
      `makeInference: sensitivity must be one of ${SENSITIVITIES.join('|')} (got ${JSON.stringify(sensitivity)})`,
    );
  }
  const c = Number(confidence);
  if (!Number.isFinite(c) || c < 0 || c > 1) {
    throw new TypeError(`makeInference: confidence must be in [0,1] (got ${JSON.stringify(confidence)})`);
  }

  return {
    id: inferenceId(kind, subject),
    kind,
    subject,
    value: value === undefined ? null : value,
    confidence: c,
    evidence_count: Number(evidence_count) || 0,
    last_confirmed,
    source_sessions: [...source_sessions],
    source_hosts: [...source_hosts],
    sensitivity,
  };
}

/** One style axis: EMA point estimate + Beta(α,β) uncertainty (graceful cold start). */
function makeStyleAxis() {
  // Uniform Beta(1,1) prior = "unconfirmed" until evidence accrues.
  return { ema: 0.5, alpha: 1, beta: 1, evidence_count: 0 };
}

/**
 * makeProfile — the partitioned UserProfile container (design-v2 §4):
 * global.style (4 EMA+Beta axes) + global.dialectic[] + overlays + expertise +
 * provenance + egress_log_ref + schema_version.
 */
export function makeProfile() {
  const style = {};
  for (const axis of STYLE_AXES) style[axis] = makeStyleAxis();
  return {
    schema_version: SCHEMA_VERSION,
    global: {
      style,
      dialectic: [],
    },
    overlays: {},
    expertise: {},
    provenance: {
      created: new Date(0).toISOString(),
      updated: new Date(0).toISOString(),
    },
    egress_log_ref: null,
  };
}

// ---------------------------------------------------------------------------
// Minimal flat-scalar YAML frontmatter (no dependency).
// Only string/number/boolean/null scalars are supported — nested data lives in
// the canonical JSON block, so we never need a recursive YAML parser.
// ---------------------------------------------------------------------------

function serializeFrontmatterValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  // Quote strings to keep them unambiguous (colons, leading spaces, etc.).
  return JSON.stringify(String(v));
}

function parseFrontmatterValue(raw) {
  const s = raw.trim();
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

function parseFrontmatter(block) {
  const out = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    out[key] = parseFrontmatterValue(line.slice(idx + 1));
  }
  return out;
}

/** Human-glanceable summary scalars surfaced in the frontmatter. */
function summaryScalars(profile) {
  const fm = {
    schema_version:
      typeof profile.schema_version === 'number' ? profile.schema_version : SCHEMA_VERSION,
  };
  if (profile.provenance && typeof profile.provenance === 'object') {
    if (profile.provenance.updated) fm.updated = profile.provenance.updated;
    if (profile.provenance.created) fm.created = profile.provenance.created;
  }
  const dialectic = profile.global && Array.isArray(profile.global.dialectic)
    ? profile.global.dialectic.length : 0;
  fm.dialectic_count = dialectic;
  fm.expertise_domains = profile.expertise ? Object.keys(profile.expertise).length : 0;
  return fm;
}

/**
 * serializeProfile(profile) -> markdown text. Lossless via the canonical JSON
 * block; the frontmatter is a convenience surface only.
 */
export function serializeProfile(profile) {
  const fm = summaryScalars(profile);
  const fmLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${serializeFrontmatterValue(v)}`)
    .join('\n');
  const json = JSON.stringify(profile, null, 2);
  return (
    `---\n${fmLines}\n---\n\n`
    + '# IJFW User Profile\n\n'
    + 'Portable, user-global interaction profile. Inspect or hand-edit the\n'
    + 'canonical record in the JSON block below. Re-derived at SessionEnd.\n\n'
    + '```json\n'
    + `${json}\n`
    + '```\n'
  );
}

/**
 * parseProfile(text) -> profile object. Tolerant of unknown fields and of a
 * hand-edited file missing schema_version (stamped on parse). Throws only when
 * the canonical JSON block is absent/unparseable (structurally unrecoverable).
 */
export function parseProfile(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseProfile: text must be a string');
  }

  // Frontmatter (optional, advisory).
  let frontmatter = {};
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fmMatch) frontmatter = parseFrontmatter(fmMatch[1]);

  // Canonical JSON block (required).
  const jsonMatch = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!jsonMatch) {
    throw new Error('parseProfile: no canonical ```json``` profile block found');
  }
  let obj;
  try {
    obj = JSON.parse(jsonMatch[1]);
  } catch (err) {
    throw new Error(`parseProfile: canonical JSON block is unparseable: ${err.message}`);
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('parseProfile: canonical JSON block did not yield an object');
  }

  // schema_version invariant: never undefined. Prefer the block, fall back to
  // frontmatter, then the current SCHEMA_VERSION.
  if (typeof obj.schema_version !== 'number') {
    obj.schema_version =
      typeof frontmatter.schema_version === 'number'
        ? frontmatter.schema_version
        : SCHEMA_VERSION;
  }
  return obj;
}
