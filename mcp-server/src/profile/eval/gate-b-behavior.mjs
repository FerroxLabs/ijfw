/**
 * profile/eval/gate-b-behavior.mjs — Cross-system profile bus, PHASE P5 (Gate B).
 *
 * GATE B — BEHAVIOR A/B (THE HEADLINE). Capture (Gate C) is necessary but NOT
 * sufficient: PrefEval [2502.09597] shows even an EXPLICIT in-context preference
 * is followed <10% of the time at ~10 turns. So the headline claim — "the profile
 * changes what the agent does" — must be proven by BEHAVIOR, not by grading an
 * internal artifact. Gate B runs the SAME agent task WITH vs WITHOUT the profile
 * brief injected and measures preference-adherence IN THE OUTPUT.
 *
 * THE REAL BRIEF. The injected text is produced by the REAL renderBrief() — the
 * exact string a host receives. We do not hand the agent a hand-tuned hint; we
 * hand it what the production serving path emits.
 *
 * THE FOUR ARMS (all mandatory per the audit):
 *   - baseline     : empty profile -> empty brief (the floor; what the agent does
 *                    with NO profile signal).
 *   - heuristic    : the brief from the heuristic-derived profile (Gate C's
 *                    profile) — the product as shipped.
 *   - dialectic    : the brief from a profile that also ran the dialectic tier
 *                    (heuristic-vs-dialectic ABLATION) — only differs when a
 *                    dialectic transport is injected.
 *   - oracle       : an in-prompt ORACLE brief stating the prefs verbatim (the
 *                    CEILING — best case if capture were perfect). PrefEval shows
 *                    even THIS is not 100%, which is why it's the ceiling, not 1.0.
 *
 * SCORING — preference-adherence is measured TWO ways:
 *   1. OBJECTIVE (bias-free): does the output exhibit the user's prefs? (uses
 *      the held-out objective style target + literal preference checks). No judge.
 *   2. JUDGED (bias-controlled): a pairwise, position-randomized, length-
 *      controlled, identity-masked judge picks the more on-profile output. We
 *      report κ between the judge and the objective rater so the judge's
 *      reliability is measured.
 *
 * STATS — paired McNemar + bootstrap CI, both from the REAL lab-study helpers
 * (imported via harness.mjs, NOT re-derived).
 *
 * LIVE RUNNER — the agent run is gated behind IJFW_PROFILE_EVAL_LIVE with an
 * INJECTABLE transport (resolveAgentTransport). Unit tests inject a deterministic
 * fake agent that genuinely CONSUMES the injected brief (it adheres iff the brief
 * tells it to) so the REAL scoring + REAL stat pipeline run end-to-end offline.
 * Live runs construct a real local HTTP transport — the runner is genuinely
 * runnable, not a stub.
 *
 * Zero deps. ESM. No stubs in the pipeline.
 *
 * Cites: PrefEval [2502.09597] · LLM-judge bias [2410.02736].
 */

import { renderBrief } from '../render-brief.js';
import { makeProfile } from '../schema.js';
import { deriveProfileFromSessions } from './gate-c-capture.mjs';
import {
  makeHeldOutFixture,
  resolveAgentTransport,
  objectiveStyle,
  styleDistance,
  biasControlledJudge,
  cohenKappa,
  bootstrapCI,
  mcnemar,
} from './harness.mjs';

/**
 * Build the in-prompt ORACLE brief (the ceiling arm). States the persona's
 * preferences verbatim, in the same descriptive voice renderBrief uses, so the
 * agent has the BEST-CASE signal. This is the upper bound on what perfect capture
 * could buy — not a guarantee of adherence (PrefEval: even explicit prefs are
 * often ignored), which is exactly why it is the ceiling.
 */
export function buildOracleBrief(probes = []) {
  const subjects = new Set();
  for (const p of probes) for (const g of (p.goldSubjects || [])) subjects.add(g);
  if (subjects.size === 0) return '';
  const lines = [...subjects].map((s) => `- Observed preference: ${s}`);
  return `User profile (observed patterns — informative, not directive):\n${lines.join('\n')}`;
}

/**
 * Detect whether a keyword appears in a NEGATED / contrastive context in the
 * line, so we never credit "I won't use tabs" or "unlike TypeScript" as
 * adherence. Scans a small window of words BEFORE the match for a negation
 * cue. Lightweight + deterministic (no NLP dep) — the goal is to stop the
 * obvious false positives a live model would produce, not perfect parsing.
 */
const NEGATION_CUES = new Set([
  'no', 'not', "n't", 'never', 'without', 'avoid', 'unlike', 'instead',
  'rather', 'except', 'wont', 'dont', 'cant', 'stop', 'skip', 'drop',
]);
function isNegatedNear(text, keywordRe) {
  const lower = String(text).toLowerCase();
  const m = lower.match(keywordRe);
  if (!m) return false;
  const idx = lower.indexOf(m[0]);
  const before = lower.slice(Math.max(0, idx - 40), idx);
  // contraction forms ("won't", "don't") survive as "won t" after tokenization,
  // so check both the raw slice and a normalized one.
  const words = before.replace(/['']/g, '').split(/[^a-z]+/).filter(Boolean);
  const tail = words.slice(-5);
  for (const w of tail) {
    if (NEGATION_CUES.has(w)) return true;
    if (w.endsWith('nt') && w.length > 2) return true; // wont, dont, cant, isnt
  }
  return false;
}

/**
 * Literal preference adherence: does the output text honor the probe's gold
 * preferences? OBJECTIVE, no judge. H3 FIX — this is adherence-SENSITIVE, not
 * mention-sensitive: indentation prefs are checked against the ACTUAL leading
 * whitespace of code lines (not the word "tabs"), and every check is
 * NEGATION-AWARE so a live model saying "I won't use tabs" or "unlike
 * TypeScript…" does NOT score adherent. Returns a 0/1 adherence score for this
 * (output, probe) pair.
 */
export function objectiveAdherence(output, probe) {
  const text = String(output || '');
  const gold = (probe.goldSubjects || []).map((s) => String(s).toLowerCase());
  let checks = 0; let hits = 0;

  // terseness: if the persona wants terse, short output adheres.
  if (gold.some((g) => g.includes('terse'))) {
    checks += 1;
    const target = probe.goldStyle ? probe.goldStyle.terseness : 0.5;
    const got = objectiveStyle(text).terseness;
    if (Math.abs(got - target) <= 0.25) hits += 1;
  }
  // tabs vs spaces: ACTUAL indentation behavior, not a mention of the word.
  // Adherent iff some line is indented with a leading TAB (the real, checkable
  // signal). A bare prose mention ("I use tabs") is NOT adherence; a negated
  // mention is explicitly disqualified.
  if (gold.some((g) => g.includes('tab'))) {
    checks += 1;
    const lines = text.split('\n');
    const tabIndented = lines.some((ln) => /^\t/.test(ln) || /^[^\S\t]*\t/.test(ln));
    const negatedTabs = isNegatedNear(text, /\btabs?\b/);
    if (tabIndented && !negatedTabs) hits += 1;
  }
  // typescript: genuine usage (a type annotation or .ts), negation-aware. A
  // contrastive mention ("unlike TypeScript") does not count.
  if (gold.some((g) => g.includes('typescript'))) {
    checks += 1;
    const usesTs = /:\s*\w+\s*[),=]/.test(text) || /\.ts\b/.test(text)
      || /\binterface\b|\btype\s+\w+\s*=/.test(text);
    const mentionsTs = /typescript/i.test(text);
    const negatedTs = isNegatedNear(text, /typescript/);
    // adheres if it genuinely USES TS syntax, OR affirmatively names TS (not negated).
    if ((usesTs || (mentionsTs && !negatedTs)) && !(negatedTs && !usesTs)) hits += 1;
  }
  if (checks === 0) {
    // No checkable facet for this probe -> fall back to a style-distance match
    // against the probe's held-out style target (still objective).
    const target = probe.goldStyle || objectiveStyle('');
    const got = objectiveStyle(text);
    return styleDistance(got, target) <= 0.5 ? 1 : 0;
  }
  return hits / checks >= 0.5 ? 1 : 0;
}

/**
 * Run ONE arm over the probe set: for each probe, ask the agent transport to
 * answer the probe prompt WITH the arm's brief prepended (the brief is the ONLY
 * difference between arms). Returns the per-probe outputs + per-probe objective
 * adherence 0/1 vector.
 *
 * @param {Function} transport  ({prompt, system, ...}) -> Promise<{text}>
 * @param {string}   brief      the injected brief (may be '')
 * @param {Array}    probes
 * @returns {Promise<{ outputs:string[], adherence:number[] }>}
 */
export async function runArm(transport, brief, probes) {
  const outputs = [];
  const adherence = [];
  for (const probe of probes) {
    // The brief is injected as the SYSTEM context — exactly how a host would
    // passively inject the profile ahead of the user's turn.
    // eslint-disable-next-line no-await-in-loop
    const res = await transport({
      prompt: probe.prompt || '',
      system: brief || '',
      maxTokens: 256,
      probe, // passed through so a fake transport can be brief-faithful in tests
    });
    const text = res && typeof res.text === 'string' ? res.text : '';
    outputs.push(text);
    adherence.push(objectiveAdherence(text, probe));
  }
  return { outputs, adherence };
}

/**
 * runGateB(corpus, opts) -> Gate B report.
 *
 * @param {object} [corpus]  { sessions, probes, negativeControl } (defaults to fixture)
 * @param {object} [opts]
 *   @param {Function} [opts.agent]          injected agent transport (tests/live)
 *   @param {Function} [opts.judge]          injected pairwise judge ({first,second})->0|1
 *   @param {Function} [opts._localTransport] dialectic derivation arm (ablation)
 *   @param {object}   [opts.env]
 *   @param {number}   [opts.seed]           position-randomization + bootstrap seed
 *
 * @returns {Promise<object>} arms (incl. the redacted `default` arm), paired
 *   McNemar (heuristic vs baseline), the redaction McNemar (default vs heuristic),
 *   bootstrap CIs per arm, oracle ceiling, ablation delta, STRUCTURED κ (judge vs
 *   objective; null+reason when degenerate), and the new-signal SURFACING latency
 *   probe (NOT adaptation/retraction).
 *
 * THROWS in live mode (IJFW_PROFILE_EVAL_LIVE) when no transport can be resolved
 * — a live behavioral gate must NOT silently fake a result.
 */
export async function runGateB(corpus, opts = {}) {
  const data = corpus || makeHeldOutFixture();
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const seed = Number.isFinite(opts.seed) ? opts.seed : 7;

  const { transport, live } = resolveAgentTransport({ agent: opts.agent, env: opts.env });
  if (!transport) {
    if (opts.env && opts.env.IJFW_PROFILE_EVAL_LIVE) {
      throw new Error(
        'Gate B live mode requested (IJFW_PROFILE_EVAL_LIVE) but no agent transport '
        + 'could be resolved (no injected agent and no local URL). Refusing to fake a '
        + 'behavioral result.',
      );
    }
    throw new Error('Gate B requires an agent transport (inject opts.agent for offline runs).');
  }

  // BRIEFS — all from the REAL renderBrief except the oracle ceiling.
  //
  // `shareSensitive: true` reflects the per-host OPT-IN serving scenario: Gate B
  // measures behavior WHEN THE PROFILE IS SHARED with a host the user trusts
  // (the only scenario in which behavioral adherence is even at stake). Without
  // the opt-in, renderBrief redacts med/high prefs by design (sensitivity.js) —
  // and the preference levers that drive behavior are exactly those med-tier
  // corrections. Measuring the no-share path would test the redactor, not the
  // behavioral effect. The opt-in is set here EXPLICITLY (not silently) so the
  // arm semantics stay honest. `redactFile` is left at default so the kill-switch
  // + denylist still apply.
  const renderOpts = { env: opts.env, shareSensitive: true };
  //  baseline : empty profile -> empty brief.
  const baselineBrief = renderBrief(makeProfile(), renderOpts).text; // '' by construction
  //  heuristic: the shipped product brief (heuristic-derived profile).
  const heuristicProfile = await deriveProfileFromSessions(data.sessions, { env: opts.env });
  const heuristicBrief = renderBrief(heuristicProfile, renderOpts).text;
  //  default  : the SAME heuristic profile rendered with NO opt-in (shareSensitive
  //             omitted -> low-only). This exercises the redactor in the SCORED
  //             path (M1 FIX): the med-tier preference levers (corrections like
  //             tabs/typescript) are gated, only the always-shareable low-tier
  //             style axes survive. Adherence should drop toward baseline —
  //             simultaneously proving the redactor works AND that the behavioral
  //             effect is opt-in-gated, not unconditional.
  const defaultBrief = renderBrief(heuristicProfile, { env: opts.env }).text;
  //  dialectic: heuristic + dialectic ABLATION (differs only if a transport injected).
  const dialecticProfile = await deriveProfileFromSessions(data.sessions, {
    env: opts.env,
    _localTransport: opts._localTransport,
  });
  const dialecticBrief = renderBrief(dialecticProfile, renderOpts).text;
  //  oracle   : in-prompt ceiling.
  const oracleBrief = buildOracleBrief(probes);

  // RUN every arm through the SAME transport — the brief is the only difference.
  const baseline = await runArm(transport, baselineBrief, probes);
  const defaultArm = await runArm(transport, defaultBrief, probes);
  const heuristic = await runArm(transport, heuristicBrief, probes);
  const dialectic = await runArm(transport, dialecticBrief, probes);
  const oracle = await runArm(transport, oracleBrief, probes);

  // PAIRED McNEMAR — heuristic (with profile) vs baseline (without). The headline
  // contrast: does injecting the profile flip non-adherent outputs to adherent?
  // REAL mcnemar helper.
  const headline = mcnemar(baseline.adherence, heuristic.adherence);

  // Bootstrap CIs per arm on the per-probe adherence vectors. REAL helper.
  const ci = (v, s) => bootstrapCI(v, { seed: s });
  const arms = {
    baseline: { adherence: baseline.adherence, outputs: baseline.outputs, ci: ci(baseline.adherence, seed) },
    default: { adherence: defaultArm.adherence, outputs: defaultArm.outputs, ci: ci(defaultArm.adherence, seed + 4) },
    heuristic: { adherence: heuristic.adherence, outputs: heuristic.outputs, ci: ci(heuristic.adherence, seed + 1) },
    dialectic: { adherence: dialectic.adherence, outputs: dialectic.outputs, ci: ci(dialectic.adherence, seed + 2) },
    oracle: { adherence: oracle.adherence, outputs: oracle.outputs, ci: ci(oracle.adherence, seed + 3) },
  };

  // REDACTOR CONTROL (M1): paired McNemar default (redacted) vs heuristic
  // (shared). A non-trivial drop here is the redactor demonstrably gating the
  // behavioral levers — the behavioral effect is OPT-IN, not unconditional.
  const redaction = mcnemar(defaultArm.adherence, heuristic.adherence);

  // ABLATION — dialectic vs heuristic (does the LLM tier buy anything?).
  const ablation = mcnemar(heuristic.adherence, dialectic.adherence);

  // BIAS-CONTROLLED JUDGE (optional second rater). Pairwise heuristic-vs-baseline
  // outputs through the position-randomized / length-controlled / identity-masked
  // wrapper, then κ between the judge and the OBJECTIVE rater (the bias check).
  let judgeReport = null;
  if (typeof opts.judge === 'function') {
    const items = probes.map((_, i) => ({ a: heuristic.outputs[i], b: baseline.outputs[i] }));
    const { preferA } = biasControlledJudge(items, opts.judge, { seed });
    // Objective second rater: 1 iff heuristic objectively adhered AND baseline did
    // not (i.e. the objective signal also prefers the heuristic arm).
    const objectivePrefersA = probes.map((_, i) => (
      heuristic.adherence[i] === 1 && baseline.adherence[i] === 0 ? 1 : 0
    ));
    // κ is STRUCTURED ({kappa, degenerate, reason}). On a tiny/low-variance
    // fixture κ is DEGENERATE and reported as such (null + reason) — never as a
    // spurious 1.0 (H1 FIX). The caller surfaces `degenerate`/`reason`.
    judgeReport = {
      preferA,
      objectivePrefersA,
      kappa: cohenKappa(preferA, objectivePrefersA),
    };
  }

  // NEW-SIGNAL SURFACING LATENCY probe (H4: NOT "adaptation"). Feed a
  // CONTRADICTING preference one session at a time and measure how many sessions
  // it takes the NEW signal to clear the evidence floor and SURFACE in the brief.
  // It does NOT measure retraction — the superseded belief is still asserted
  // afterwards (no asymmetric-decay yet; that is P1.4). Uses the REAL pipeline.
  const surfacing = await newSignalSurfacingLatency(data, opts);

  return {
    arms,
    headline,            // McNemar: heuristic vs baseline (the proof contrast)
    ablation,            // McNemar: dialectic vs heuristic
    redaction,           // McNemar: default (redacted) vs heuristic (the opt-in gate)
    oracleCeiling: arms.oracle.ci.point,
    judge: judgeReport,  // null unless a judge was injected
    surfacing,           // new-signal surfacing latency (NOT adaptation/retraction)
    live,                // whether this was a live LLM run
    briefs: {
      baseline: baselineBrief,
      default: defaultBrief,
      heuristic: heuristicBrief,
      dialectic: dialecticBrief,
      oracle: oracleBrief,
    },
  };
}

/**
 * newSignalSurfacingLatency(corpus, opts) -> {
 *   surfaced, surfacingLatencySessions, contradicting, oldSubject,
 *   bothBeliefsPresent, retractionImplemented }.
 *
 * H4 FIX — this measures ACCRUAL/SURFACING, NOT adaptation. We feed a
 * CONTRADICTING preference one session at a time and find the FIRST session index
 * at which the NEW signal clears the evidence floor (>=3) and SURFACES in the
 * rendered brief. It does NOT measure retraction: the heuristic floor keys prefs
 * by EXACT phrase, so a contradicting phrase is a NEW atom — it never overwrites
 * the old one. After surfacing, BOTH the old belief ("use tabs not spaces") AND
 * the new contradicting belief ("use spaces not tabs") are present in the brief.
 * Calling that "the profile adapts" would invert the finding (falsifiable by one
 * grep). RETRACTION of the superseded belief is not yet implemented —
 * asymmetric-decay is P1.4's job, and this probe will report it as
 * `retractionImplemented:true` when it lands. Uses the REAL pipeline; no judge.
 */
export async function newSignalSurfacingLatency(corpus, opts = {}) {
  const data = corpus || makeHeldOutFixture();
  // Start from the established heuristic profile (old pref asserted).
  let profile = await deriveProfileFromSessions(data.sessions, { env: opts.env });
  const oldSubject = 'use tabs not spaces';
  const contradicting = 'use spaces not tabs'; // a DIFFERENT subject (heuristic adds it)

  const { applyDelta } = await import('../merge.js');
  const { deriveProfile } = await import('../derive.js');

  let surfaced = false;
  let surfacingLatencySessions = Infinity;
  let bothBeliefsPresent = false;
  const MAX = 6;
  for (let i = 1; i <= MAX; i++) {
    const sid = `surfacing-${i}`;
    const ts = new Date(Date.UTC(2026, 6, i)).toISOString();
    const feedback = [{ session_id: sid, ts, kind: 'correction', phrase: contradicting, context: '' }];
    // eslint-disable-next-line no-await-in-loop
    const delta = await deriveProfile(
      { feedback, sessionId: sid, host: 'claude' },
      { env: opts.env },
    );
    profile = applyDelta(profile, delta);
    // shareSensitive: true — same opt-in serving scenario as runGateB, so the
    // med-tier contradicting preference can surface and the latency is real.
    // eslint-disable-next-line no-await-in-loop
    const brief = renderBrief(profile, { env: opts.env, shareSensitive: true }).text.toLowerCase();
    if (brief.includes(contradicting) && i >= 3) {
      // New signal has accrued enough evidence (>=3) to clear the floor + surface.
      surfaced = true;
      surfacingLatencySessions = i;
      // HONEST FINDING: the OLD belief is STILL asserted (no retraction). Both
      // contradicting beliefs coexist in the brief — this is surfacing, not
      // adaptation.
      bothBeliefsPresent = brief.includes(oldSubject) && brief.includes(contradicting);
      break;
    }
  }
  return {
    surfaced,
    surfacingLatencySessions,
    contradicting,
    oldSubject,
    bothBeliefsPresent,
    retractionImplemented: false, // asymmetric-decay (P1.4) not yet wired
  };
}

/**
 * adaptationLatency — DEPRECATED back-compat alias. The metric was renamed (H4):
 * it measures new-signal SURFACING, not adaptation/retraction. New callers should
 * use newSignalSurfacingLatency. This alias maps the new fields to the old names
 * (`flipped`/`latencySessions`) AND carries the new ones so nothing breaks.
 */
export async function adaptationLatency(corpus, opts = {}) {
  const r = await newSignalSurfacingLatency(corpus, opts);
  return { ...r, flipped: r.surfaced, latencySessions: r.surfacingLatencySessions };
}

export default {
  runGateB, runArm, buildOracleBrief, objectiveAdherence,
  newSignalSurfacingLatency, adaptationLatency,
};
