/**
 * profile/derive-dialectic.js — Cross-system profile bus, PHASE P3.3.
 *
 * The BOUNDED, CORROBORATED local-LLM dialectic tier. It sits ABOVE the zero-LLM
 * heuristic floor (derive-heuristic.js) and ADDS inferences the heuristic cannot
 * reach — but only under three HARD, code-enforced guards. The model PROPOSES;
 * this module DISPOSES. We never trust the model's own confidence or its claim
 * of evidence; the corroboration and the confidence cap are computed in code.
 *
 *   GUARD 1 — bounded input (NUMERIC cap). The digest fed to the model is a
 *     sampled/windowed slice under a hard CHARACTER cap (DIALECTIC_MAX_DIGEST_CHARS)
 *     plus a bounded output token cap. Corpus size (1k vs 100k sessions) must NOT
 *     scale per-cycle spend — the digest is the MOST-RECENT window, truncated.
 *
 *   GUARD 2 — ≥K cross-session corroboration. A dialectic inference is admitted
 *     ONLY when the digest window spans ≥ DIALECTIC_MIN_CORROBORATION (K=2)
 *     DISTINCT sessions. A single-session corpus can therefore NEVER mint a
 *     trait — the honest unit of corroboration is the session, computed here,
 *     not asserted by the model. Each admitted inference is stamped with the
 *     corroborating session ids and evidence_count = the corroboration count.
 *
 *   GUARD 3 — LOW confidence floor. Whatever confidence the model emits, the
 *     admitted inference is capped at DIALECTIC_MAX_CONFIDENCE (well under the
 *     0.7 heuristic-correction default). The dialectic must never mint a
 *     high-confidence trait — it is a corroboration signal, not an authority.
 *
 * SELF-CONTAINED MOAT CONTRACT: this module imports ONLY ./schema.js. It takes
 * its LLM access as an injected `transport` (a function), never importing the
 * cloud path (tiered-llm's Anthropic caller) and never reaching the serving
 * path. The serve/render modules must never import this file — the import-graph
 * moat guard (P4.5) depends on it. On ANY transport error or unparseable output
 * the module degrades to an EMPTY additive delta ({ inferences: [] }).
 *
 * Zero deps. ESM. Node built-ins only (none needed).
 */

import { makeInference } from './schema.js';

/** Hard character cap on the digest handed to the model (GUARD 1). */
export const DIALECTIC_MAX_DIGEST_CHARS = 4000;

/** Bounded output token cap for the model call (GUARD 1). */
export const DIALECTIC_MAX_TOKENS = 512;

/**
 * Maximum number of MOST-RECENT sessions sampled into the digest. A small,
 * fixed window means corpus size cannot scale spend (GUARD 1). 40 rows of
 * compact metadata sit comfortably under DIALECTIC_MAX_DIGEST_CHARS; the char
 * cap is the belt, this is the suspenders.
 */
export const DIALECTIC_DIGEST_WINDOW = 40;

/** ≥K cross-session corroboration before ANY trait is minted (GUARD 2). */
export const DIALECTIC_MIN_CORROBORATION = 2;

/** LOW confidence cap — strictly under the 0.7 heuristic default (GUARD 3). */
export const DIALECTIC_MAX_CONFIDENCE = 0.5;

/** Coerce a signals bundle into the per-session style row array. */
function styleRows(signals) {
  if (!signals || typeof signals !== 'object') return [];
  if (Array.isArray(signals.style)) return signals.style;
  return [];
}

/** Distinct, ordered session ids present in a row list. */
function distinctSessions(rows) {
  const seen = [];
  const set = new Set();
  for (const r of rows) {
    const id = r && (r.session_id || r.sessionId);
    if (typeof id === 'string' && id && !set.has(id)) {
      set.add(id);
      seen.push(id);
    }
  }
  return seen;
}

/**
 * buildDigest(signals) -> string. A compact, MOST-RECENT-window, char-capped
 * textual digest of the per-session metadata. Deterministic. The window keeps
 * spend constant across corpus sizes; the slice() is a hard final truncation so
 * the cap holds even if a single row is pathologically large.
 */
export function buildDigest(signals) {
  const rows = styleRows(signals);
  if (rows.length === 0) return '';
  // Take the MOST-RECENT window (the tail of the chronological list). We do not
  // sort (rows arrive chronological by capture); a tail-slice is the recency
  // window and is O(window), not O(corpus).
  const window = rows.slice(-DIALECTIC_DIGEST_WINDOW);
  const lines = [];
  for (const r of window) {
    if (!r || typeof r !== 'object') continue;
    // Compact, fixed-field rendering — never the raw object (keeps each line
    // bounded and the digest predictable).
    const f = (v) => (v === undefined || v === null ? '' : v);
    lines.push(
      `sid=${f(r.session_id || r.sessionId)} host=${f(r.host)} `
      + `len=${f(r.avg_msg_chars)} emoji=${f(r.emoji_per_msg)} `
      + `code=${f(r.code_block_ratio)} formal=${f(r.formality_markers)} `
      + `cadence=${f(r.turn_cadence_per_min)} msgs=${f(r.msg_count)}`,
    );
  }
  const text = lines.join('\n');
  // Hard final cap (GUARD 1) — truncate, never exceed.
  return text.length > DIALECTIC_MAX_DIGEST_CHARS
    ? text.slice(0, DIALECTIC_MAX_DIGEST_CHARS)
    : text;
}

/** The bounded instruction template wrapped around the digest. Fixed-size. */
function buildPrompt(digest) {
  return (
    'You are profiling a developer from per-session interaction METADATA '
    + '(statistics only, never transcripts). Propose DURABLE cross-session '
    + 'traits as JSON: {"inferences":[{"kind":"trait","subject":"<short '
    + 'phrase>","value":"<short>","confidence":<0..1>}]}. Only propose a trait '
    + 'visible across MULTIPLE sessions. Return ONLY JSON.\n\n'
    + 'SESSION METADATA DIGEST:\n'
    + digest
  );
}

/** Tolerant JSON extraction: parse the whole string, else the first {...} block. */
function parseInferences(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      if (obj && Array.isArray(obj.inferences)) return obj.inferences;
    } catch { /* fall through */ }
    return null;
  };
  let arr = tryParse(text.trim());
  if (!arr) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) arr = tryParse(m[0]);
  }
  return Array.isArray(arr) ? arr : [];
}

/**
 * deriveDialectic(signals, opts) -> { inferences: Inference[] }.
 *
 * @param {object} signals  { style: Row[], ... } — the same bundle deriveHeuristic reads
 * @param {object} opts
 *   @param {(args:{prompt,maxTokens,model?})=>Promise<{text:string}>} opts.transport
 *          the injected LLM transport (local Ollama caller, or — only on explicit
 *          cloud opt-in handled by the orchestrator — a cloud caller). REQUIRED;
 *          without it nothing networks.
 *   @param {string}   [opts.model]
 *   @param {string}   [opts.sessionId] provenance for the derived inferences
 *   @param {string}   [opts.host]
 *   @param {Function} [opts.log]       degrade reasons are LOGGED, not swallowed
 *
 * ALWAYS returns an additive delta. On no-signal, no-transport, transport error,
 * unparseable output, or sub-K corroboration -> { inferences: [] }. A degrade
 * caused by a transport error or unparseable output is LOGGED via opts.log (the
 * audit flagged a swallowed-error class; we surface it explicitly) while still
 * degrading gracefully to the heuristic floor.
 */
export async function deriveDialectic(signals, opts = {}) {
  const empty = { inferences: [] };
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const rows = styleRows(signals);
  if (rows.length === 0) return empty;                 // GUARD 2 (degenerate): no corpus
  if (typeof opts.transport !== 'function') return empty; // no transport => no network, ever

  // GUARD 2 — corroboration is computed in CODE from the digest WINDOW (the
  // slice the model actually saw), so a model can never claim evidence the
  // corpus does not contain.
  const window = rows.slice(-DIALECTIC_DIGEST_WINDOW);
  const sessions = distinctSessions(window);
  if (sessions.length < DIALECTIC_MIN_CORROBORATION) return empty;

  const digest = buildDigest(signals);
  if (!digest) return empty;
  const prompt = buildPrompt(digest);

  let text;
  try {
    const res = await opts.transport({
      prompt,
      maxTokens: DIALECTIC_MAX_TOKENS,
      model: opts.model,
    });
    text = res && typeof res.text === 'string' ? res.text : '';
  } catch (err) {
    // GUARD: transport error -> degrade to the heuristic floor (empty additive).
    // LOGGED, not swallowed.
    log(`profile dialectic transport error -> heuristic-only: ${err && err.message ? err.message : err}`);
    return empty;
  }

  const proposed = parseInferences(text);
  if (proposed.length === 0) {
    if (text && text.trim()) {
      log('profile dialectic: model output unparseable/empty -> heuristic-only');
    }
    return empty;
  }

  const host = typeof opts.host === 'string' ? opts.host : null;
  const corroboratingSessions = sessions.slice(0, Math.max(DIALECTIC_MIN_CORROBORATION, sessions.length));

  const out = [];
  for (const p of proposed) {
    if (!p || typeof p !== 'object') continue;
    const kind = typeof p.kind === 'string' && p.kind.trim() ? p.kind.trim() : 'trait';
    const subject = typeof p.subject === 'string' ? p.subject.trim() : '';
    if (!subject) continue;
    // GUARD 3 — confidence is CAPPED in code, never taken from the model.
    const rawConf = Number(p.confidence);
    const confidence = Math.min(
      DIALECTIC_MAX_CONFIDENCE,
      Number.isFinite(rawConf) && rawConf > 0 ? rawConf : DIALECTIC_MAX_CONFIDENCE,
    );
    try {
      out.push(makeInference({
        kind,
        subject,
        value: p.value === undefined ? null : p.value,
        confidence,
        // GUARD 2 — evidence + sources reflect the CODE-COMPUTED corroboration,
        // not the model's assertion.
        evidence_count: corroboratingSessions.length,
        source_sessions: corroboratingSessions,
        source_hosts: host ? [host] : [],
        // Dialectic traits are inferred (more revealing than a style stat) —
        // tag medium so the sensitivity gate (P4) can govern egress.
        sensitivity: 'med',
      }));
    } catch {
      // makeInference rejects malformed atoms — skip, never throw out of derive.
    }
  }
  return { inferences: out };
}

export default { deriveDialectic, buildDigest };
