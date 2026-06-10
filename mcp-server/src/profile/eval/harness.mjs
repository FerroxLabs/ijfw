/**
 * profile/eval/harness.mjs — Cross-system profile bus, PHASE P5 (shared eval infra).
 *
 * THE "PROVE IT" FRONT. This is the rigor stack the two gates (Gate C capture,
 * Gate B behavior) sit on top of. The brand position attacks competitors for the
 * "assert-not-prove" move (the Honcho move): grading an INTERNAL artifact and
 * calling it proof of learning. This harness ports the SAME fact-recall rigor our
 * published memory benchmark uses — held-out splits, paired baselines, bootstrap
 * CIs, paired McNemar, bias-controlled judging, ECE, κ — onto the profile bus.
 *
 * NO STUBS IN THE PIPELINE. Every gate wires the REAL profile modules:
 *   - deriveHeuristic / deriveProfile  (src/profile/derive*.js)   — derivation
 *   - applyDelta                       (src/profile/merge.js)     — fold to profile
 *   - renderBrief                      (src/profile/render-brief) — the injected brief
 * and the REAL statistics helpers, imported (NOT re-derived) from the lab-study
 * memory benchmark:
 *   - bootstrapCI / mcnemar            (src/memory/bench-metrics.js)
 * The ONLY env-gated stub-point is the LIVE-LLM agent run in Gate B, and even
 * there the injection point is real (exercised by a deterministic fake transport
 * in tests; a genuine local HTTP transport when run live).
 *
 * Zero deps. ESM. Node built-ins only.
 *
 * Cites (methodology): LaMP time-based split [2304.11406] · PrefEval behavior
 * [2502.09597] · LLM-judge bias [2410.02736] · persona caricature [2402.10811].
 */

// REUSE the real lab-study stat helpers — do NOT re-derive the math. These are
// the same functions the published memory benchmark uses (bench-metrics.js).
import { bootstrapCI, mcnemar } from '../../memory/bench-metrics.js';

// Re-export so the gates import the SAME implementations (single source of truth).
export { bootstrapCI, mcnemar };

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) — for position randomization + any sampling.
// Matches the seed discipline the bench harness uses so eval runs are
// reproducible (a non-deterministic eval cannot be a regression test).
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Held-out TIME-BASED split (LaMP-style). NEVER test on a session you trained
// on. The split is by timestamp: train = sessions strictly before `cutoff`,
// probe = sessions at/after `cutoff`. We also return the disjointness proof so a
// gate can ASSERT no session id leaks across the boundary before scoring.
// ---------------------------------------------------------------------------

/**
 * splitByTime(sessions, opts) -> { train, probe, trainIds, probeIds, disjoint }.
 *
 * @param {Array<{session_id?:string, sessionId?:string, ts?:string}>} sessions
 * @param {object} [opts]
 *   @param {string|number} [opts.cutoff]  ISO/epoch boundary. If omitted, splits
 *     chronologically at `trainFraction` of the (time-sorted) sessions.
 *   @param {number} [opts.trainFraction]  default 0.6 (sessions 1..k = first 60%).
 *   @param {boolean} [opts.allowUndated]  escape hatch: permit a majority-undated
 *     corpus (default false — a mostly-undated corpus throws, see below).
 *   @param {number} [opts.maxUndatedFraction]  default 0.5 — the fraction of
 *     undated sessions above which the split is rejected as degenerate.
 *
 * A session with no parseable ts sorts to the END (treated as most-recent, i.e.
 * probe-side) so an undated probe never silently lands in train.
 *
 * DEGENERATE-SPLIT GUARD (M3): on a malformed real corpus where most sessions are
 * undated, every undated session sorts to the probe side and a time-based split
 * becomes meaningless — yet it would still "pass" (disjoint, non-empty). We refuse
 * that silently-degenerate split: if more than `maxUndatedFraction` of sessions
 * are undated we THROW (unless `allowUndated` is set for a known-undated test
 * corpus). A held-out split you can't trust is worse than no split.
 */
export function splitByTime(sessions = [], opts = {}) {
  const list = Array.isArray(sessions) ? sessions.slice() : [];
  const tsOf = (s) => {
    const t = Date.parse(s && s.ts);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  // Guard against a silently-degenerate split on a mostly-undated corpus.
  if (list.length > 0 && !opts.allowUndated) {
    const maxUndated = Number.isFinite(opts.maxUndatedFraction) ? opts.maxUndatedFraction : 0.5;
    const undated = list.filter((s) => !Number.isFinite(Date.parse(s && s.ts))).length;
    if (undated / list.length > maxUndated) {
      throw new Error(
        `splitByTime: ${undated}/${list.length} sessions are undated (> ${maxUndated} of the corpus). `
        + 'A time-based held-out split on a mostly-undated corpus is degenerate (all undated sessions '
        + 'sort to probe). Refusing to produce a split that looks valid but is not. '
        + 'Pass { allowUndated: true } only for a known-undated test corpus.',
      );
    }
  }
  list.sort((a, b) => tsOf(a) - tsOf(b));

  let cutoffMs = null;
  if (opts.cutoff !== undefined && opts.cutoff !== null) {
    const t = typeof opts.cutoff === 'number' ? opts.cutoff : Date.parse(opts.cutoff);
    if (Number.isFinite(t)) cutoffMs = t;
  }

  let train; let probe;
  if (cutoffMs !== null) {
    train = list.filter((s) => tsOf(s) < cutoffMs);
    probe = list.filter((s) => tsOf(s) >= cutoffMs);
  } else {
    const frac = Number.isFinite(opts.trainFraction) ? opts.trainFraction : 0.6;
    const k = Math.max(1, Math.min(list.length - 1, Math.round(list.length * frac)));
    train = list.slice(0, k);
    probe = list.slice(k);
  }

  const idOf = (s) => String((s && (s.session_id ?? s.sessionId)) ?? '');
  const trainIds = new Set(train.map(idOf).filter(Boolean));
  const probeIds = new Set(probe.map(idOf).filter(Boolean));
  // Disjointness proof: no session id may appear on both sides of the split.
  let disjoint = true;
  for (const id of probeIds) {
    if (trainIds.has(id)) { disjoint = false; break; }
  }
  return { train, probe, trainIds, probeIds, disjoint };
}

// ---------------------------------------------------------------------------
// Precision / recall for a SET-recovery task (Gate C). gold = the set of
// held-out preference subjects the user actually expressed in the probe window;
// predicted = the subjects the derived profile asserts. Pure set arithmetic.
// ---------------------------------------------------------------------------

/**
 * precisionRecall(predicted, gold) -> { precision, recall, f1, tp, fp, fn,
 *   perGoldHit:number[], perPredCorrect:number[] }.
 *
 * `perGoldHit` is a 0/1 vector over the gold set (1 = recovered) and
 * `perPredCorrect` a 0/1 vector over predictions (1 = correct) — these feed the
 * REAL bootstrapCI helper so precision AND recall both get a CI.
 */
export function precisionRecall(predicted = [], gold = []) {
  const pred = new Set((predicted || []).map((x) => String(x)));
  const goldSet = new Set((gold || []).map((x) => String(x)));
  let tp = 0;
  const perPredCorrect = [];
  for (const p of pred) {
    const hit = goldSet.has(p) ? 1 : 0;
    perPredCorrect.push(hit);
    if (hit) tp += 1;
  }
  const perGoldHit = [];
  for (const g of goldSet) perGoldHit.push(pred.has(g) ? 1 : 0);
  const fp = pred.size - tp;
  const fn = goldSet.size - tp;
  const precision = pred.size > 0 ? tp / pred.size : 0;
  const recall = goldSet.size > 0 ? tp / goldSet.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn, perGoldHit, perPredCorrect };
}

// ---------------------------------------------------------------------------
// Cohen's κ — inter-rater agreement (two raters, binary or categorical labels).
// Reported wherever a judge is used, against a second (objective) rater, so the
// judge's reliability is measured, not assumed (LLM-judge-bias mitigation).
// ---------------------------------------------------------------------------

/**
 * cohenKappa(raterA, raterB) -> { kappa, degenerate, reason, n }.
 *
 * κ is the chance-corrected agreement in [-1,1]. CRITICAL HONESTY GUARD: κ is
 * UNDEFINED when either rater has no label variance — with a single label there
 * is no chance baseline to correct against, so the formula's `1 - pe` denominator
 * collapses and the naive result is a spurious 1.0. Reporting that 1.0 as
 * "agreement" is exactly the lenient-judge-looks-rigorous texture we attack: a
 * non-result dressed up as a strong one. So when EITHER rater is single-valued we
 * return `kappa: null, degenerate: true` with a reason string, NOT 1.0. The caller
 * MUST surface that reason instead of treating the judge as validated.
 *
 * A genuinely varied, fully-agreeing pair still returns kappa = 1 (real result).
 */
export function cohenKappa(raterA = [], raterB = []) {
  const n = Math.min(raterA.length, raterB.length);
  if (n === 0) return { kappa: null, degenerate: true, reason: 'degenerate: empty rater sequence (n=0)', n: 0 };
  const labels = new Set();
  const setA = new Set();
  const setB = new Set();
  for (let i = 0; i < n; i++) {
    labels.add(raterA[i]); labels.add(raterB[i]);
    setA.add(raterA[i]); setB.add(raterB[i]);
  }
  // DEGENERACY GUARD: a rater with a single distinct label has zero variance, so
  // κ is undefined (no chance baseline). Refuse to manufacture a 1.0.
  if (setA.size < 2 || setB.size < 2) {
    return {
      kappa: null,
      degenerate: true,
      reason: `degenerate: no label variance at n=${n}`,
      n,
    };
  }
  let agree = 0;
  const margA = new Map();
  const margB = new Map();
  for (let i = 0; i < n; i++) {
    if (raterA[i] === raterB[i]) agree += 1;
    margA.set(raterA[i], (margA.get(raterA[i]) || 0) + 1);
    margB.set(raterB[i], (margB.get(raterB[i]) || 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const l of labels) {
    pe += ((margA.get(l) || 0) / n) * ((margB.get(l) || 0) / n);
  }
  // pe === 1 can only happen if a rater is single-valued, already handled above;
  // keep a defensive guard so we never divide by zero.
  if (pe >= 1) {
    return { kappa: null, degenerate: true, reason: `degenerate: no chance baseline at n=${n}`, n };
  }
  return { kappa: (po - pe) / (1 - pe), degenerate: false, reason: null, n };
}

// ---------------------------------------------------------------------------
// ECE — Expected Calibration Error on the profile's `confidence` field. Bins
// (confidence, correctness) pairs and measures |avg-confidence − accuracy| per
// bin, weighted by bin mass. A well-calibrated profile that says "0.7 confident"
// is right ~70% of the time. This is what makes `confidence` an honest number
// instead of decoration.
// ---------------------------------------------------------------------------

/**
 * expectedCalibrationError(pairs, opts) -> { ece, bins }.
 *
 * @param {Array<{confidence:number, correct:0|1|boolean}>} pairs
 * @param {object} [opts]  @param {number} [opts.nBins] default 10
 */
export function expectedCalibrationError(pairs = [], opts = {}) {
  const nBins = Number.isFinite(opts.nBins) && opts.nBins > 0 ? Math.floor(opts.nBins) : 10;
  const rows = (pairs || [])
    .map((p) => ({ c: Number(p.confidence), y: p.correct ? 1 : 0 }))
    .filter((p) => Number.isFinite(p.c) && p.c >= 0 && p.c <= 1);
  const n = rows.length;
  const bins = Array.from({ length: nBins }, () => ({ count: 0, confSum: 0, correctSum: 0 }));
  for (const r of rows) {
    let idx = Math.floor(r.c * nBins);
    if (idx >= nBins) idx = nBins - 1; // c === 1 lands in the top bin
    const b = bins[idx];
    b.count += 1; b.confSum += r.c; b.correctSum += r.y;
  }
  let ece = 0;
  const binStats = [];
  for (let i = 0; i < nBins; i++) {
    const b = bins[i];
    if (b.count === 0) { binStats.push({ lo: i / nBins, hi: (i + 1) / nBins, count: 0, avgConf: 0, acc: 0, gap: 0 }); continue; }
    const avgConf = b.confSum / b.count;
    const acc = b.correctSum / b.count;
    const gap = Math.abs(avgConf - acc);
    ece += (b.count / n) * gap;
    binStats.push({ lo: i / nBins, hi: (i + 1) / nBins, count: b.count, avgConf, acc, gap });
  }
  return { ece: n > 0 ? ece : 0, bins: binStats };
}

// ---------------------------------------------------------------------------
// OBJECTIVE style metrics — computed against the user's OWN held-out samples.
// This is the bias-FREE rater: no LLM, no judge, just measurable properties of
// the text (length/terseness, emoji density, code-block presence, formality
// markers). Gate B compares an arm's output to these targets; a closer match =
// better adherence. This is the second rater κ is computed against.
// ---------------------------------------------------------------------------

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const FORMAL_MARKERS = [
  'therefore', 'however', 'furthermore', 'consequently', 'regards', 'kindly',
  'please', 'thank you', 'would you', 'could you', 'i would', 'shall',
];
const CASUAL_MARKERS = ["gonna", "wanna", "yeah", "yep", "nope", "lol", "btw", "ok", "cool", "hey"];

/**
 * objectiveStyle(text) -> { len, emojiPerChar, codeBlock, formalityMarkers,
 *   terseness }. All measurable, no judge. `terseness` is the inverse-length
 *   sample on the SAME 120-char crossover the heuristic derive uses, so the
 *   eval target and the derived axis are on one scale.
 */
export function objectiveStyle(text) {
  const s = String(text || '');
  const len = s.length;
  const emojis = (s.match(EMOJI_RE) || []).length;
  const codeBlock = /```|\n {4}\S|`[^`]+`/.test(s) ? 1 : 0;
  const lower = s.toLowerCase();
  let formalHits = 0;
  for (const m of FORMAL_MARKERS) if (lower.includes(m)) formalHits += 1;
  let casualHits = 0;
  for (const m of CASUAL_MARKERS) if (lower.includes(m)) casualHits += 1;
  const markerTotal = formalHits + casualHits;
  const formalityMarkers = markerTotal > 0 ? formalHits / markerTotal : 0.5;
  // Inverse-length terseness on the heuristic's 120-char crossover.
  const avgLen = len; // single-sample text; the caller may average across samples
  const terseness = 1 - avgLen / (avgLen + 120);
  return {
    len,
    emojiPerChar: len > 0 ? emojis / len : 0,
    codeBlock,
    formalityMarkers,
    terseness,
  };
}

/**
 * styleDistance(a, b) -> number >= 0. L1 distance over the comparable, scale-free
 * style dimensions (terseness, formalityMarkers, emoji presence, code presence).
 * Lower = closer to target. Used to turn "did the arm adhere to the user's style"
 * into an OBJECTIVE 0/1 (closer-than-the-other-arm) for the paired McNemar.
 */
export function styleDistance(a, b) {
  const dims = ['terseness', 'formalityMarkers'];
  let d = 0;
  for (const k of dims) d += Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0));
  // emoji + code as presence bits (clamped) so a single emoji doesn't dominate.
  d += Math.abs((a.emojiPerChar > 0 ? 1 : 0) - (b.emojiPerChar > 0 ? 1 : 0)) * 0.5;
  d += Math.abs((a.codeBlock ? 1 : 0) - (b.codeBlock ? 1 : 0)) * 0.5;
  return d;
}

// ---------------------------------------------------------------------------
// BIAS-CONTROLLED PAIRWISE JUDGE wrapper. Where a judge is needed it must be:
//   - PAIRWISE        (A vs B, not absolute scores — absolute scores drift)
//   - POSITION-RANDOMIZED (seeded coin flip on presentation order — kills the
//                          first-position bias documented in 2410.02736)
//   - LENGTH-CONTROLLED   (both candidates normalized to ~equal length before
//                          judging — kills the verbosity bias)
//   - IDENTITY-MASKED     (arm labels stripped; the judge sees "Candidate 1/2",
//                          never "with-profile"/"baseline" — kills label bias)
// The judge itself is an injected function so unit tests can drive it
// deterministically; live runs inject an LLM-backed judge. We then report κ
// between the judge and the OBJECTIVE style rater.
// ---------------------------------------------------------------------------

function lengthControl(text, targetLen) {
  const s = String(text || '');
  if (s.length <= targetLen) return s;
  // Truncate at a word boundary near the target so neither candidate is
  // advantaged by raw verbosity.
  const cut = s.slice(0, targetLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > targetLen * 0.6 ? cut.slice(0, lastSpace) : cut;
}

/**
 * biasControlledJudge(items, judgeFn, opts) -> { preferA:number[], details[] }.
 *
 * @param {Array<{ a:string, b:string }>} items   candidate pairs (A = arm-under-test, B = comparator)
 * @param {Function} judgeFn  ({ first, second, meta }) -> 0 | 1
 *   returns which POSITION (0=first shown, 1=second shown) the judge prefers.
 *   The judge NEVER sees which position is A vs B (identity-masked).
 * @param {object} [opts]  @param {number} [opts.seed]  position-randomization seed.
 *
 * Returns `preferA` as a 0/1 vector (1 = judge preferred arm A) with the
 * position flip UNDONE, so downstream paired tests see a clean A-vs-B signal.
 */
export function biasControlledJudge(items = [], judgeFn, opts = {}) {
  const rng = mulberry32(Number.isFinite(opts.seed) ? opts.seed : 1234);
  const preferA = [];
  const details = [];
  for (const it of items) {
    const aFirst = rng() < 0.5; // POSITION RANDOMIZATION
    const rawA = String(it.a || '');
    const rawB = String(it.b || '');
    const target = Math.min(rawA.length, rawB.length) || Math.max(rawA.length, rawB.length);
    const ctlA = lengthControl(rawA, target); // LENGTH CONTROL
    const ctlB = lengthControl(rawB, target);
    const first = aFirst ? ctlA : ctlB;
    const second = aFirst ? ctlB : ctlA;
    // IDENTITY MASK: judge only sees positions, never arm labels.
    const choice = judgeFn({ first, second, meta: {} }) === 1 ? 1 : 0;
    const judgePrefersFirst = choice === 0;
    const prefersA = aFirst ? judgePrefersFirst : !judgePrefersFirst;
    preferA.push(prefersA ? 1 : 0);
    details.push({ aFirst, judgeChoseSecond: choice });
  }
  return { preferA, details };
}

// ---------------------------------------------------------------------------
// Built-in synthetic-but-HELD-OUT fixture. A multi-session corpus with a clear
// underlying persona, plus a DISJOINT, surface-varied probe set (different
// phrasings of the same preferences, in a later time window) and a NEGATIVE
// CONTROL persona (a profile that should NOT match the probes).
//
// Structured so a REAL session corpus can be dropped in: same shape
// (`{ sessions, probes, negativeControl }`), same field names the gates read.
// ---------------------------------------------------------------------------

/** A correction/preference feedback row in the .session-feedback.jsonl shape. */
function fb(session_id, ts, kind, phrase) {
  return { session_id, ts, kind, phrase, context: '' };
}

/**
 * makeHeldOutFixture(opts) -> { sessions, probes, negativeControl }.
 *
 * sessions: TRAIN-window sessions (early timestamps) carrying the persona's
 *   feedback + per-session style metadata.
 * probes:   PROBE-window sessions (later timestamps, DISJOINT ids) whose
 *   `goldSubjects` are surface-varied restatements of the SAME preferences — so
 *   recovering them tests generalization, not memorization. Each probe also
 *   carries `goldStyle` (the objective style target) for Gate B.
 * negativeControl: a persona whose gold prefs DIFFER, used to confirm the
 *   derived profile does NOT spuriously match an unrelated user.
 */
export function makeHeldOutFixture() {
  // Persona "Ada": terse, uses tabs, prefers TypeScript, no emoji, formal-ish.
  // Train window: 2026-06-01 .. 2026-06-05 (sessions t0..t4).
  const terseMeta = {
    avg_msg_chars: 38, emoji_per_msg: 0, code_block_ratio: 0.7,
    formality_markers: 0.55, turn_cadence_per_min: 6, msg_count: 22,
  };
  const sessions = [];
  // The SAME preference is corroborated across >=3 sessions so the brief's
  // evidence floor (>=3) and confidence floor (>0.6) can be cleared honestly.
  const personaPhrases = [
    'use tabs not spaces',
    'prefer typescript over javascript',
    'keep responses terse',
  ];
  for (let i = 0; i < 5; i++) {
    const sid = `train-${i}`;
    const ts = new Date(Date.UTC(2026, 5, 1 + i)).toISOString();
    const feedback = personaPhrases.map((p) => fb(sid, ts, 'correction', p));
    sessions.push({
      session_id: sid, sessionId: sid, host: 'claude', ts,
      metadata: { ...terseMeta },
      feedback,
    });
  }

  // PROBE window: 2026-06-20.. — DISJOINT ids, in a LATER time window.
  //
  // HONEST DESIGN (not a rigged 1.0): the heuristic derive keys a preference on
  // the EXACT phrase slug (phraseToSubject), so it recovers EXACT-restatement
  // probes but NOT genuine paraphrases. We deliberately include BOTH so Gate C
  // measures the REAL generalization gap instead of asserting perfect capture:
  //   - exact restatements -> recovered by the heuristic floor (capture works);
  //   - one PARAPHRASE ('avoid spaces, indent with tabs') of a known pref -> a
  //     DIFFERENT slug the heuristic MISSES, so recall is realistically < 1.0.
  // When the optional dialectic (semantic) tier is wired in, recall on the
  // paraphrase should rise — and Gate C will show it. That is the point of a
  // held-out probe: it can FAIL, which is what makes a passing score mean
  // something.
  const probes = [
    {
      session_id: 'probe-0', sessionId: 'probe-0', host: 'gemini',
      ts: new Date(Date.UTC(2026, 5, 20)).toISOString(),
      // exact restatements (heuristic recovers these):
      goldSubjects: ['use tabs not spaces', 'prefer typescript over javascript'],
      goldStyle: objectiveStyle('Use tabs. TypeScript. Short.'),
      prompt: 'How should I format and type this module?',
    },
    {
      session_id: 'probe-1', sessionId: 'probe-1', host: 'cursor',
      ts: new Date(Date.UTC(2026, 5, 21)).toISOString(),
      // exact restatement + one true PARAPHRASE the heuristic floor will MISS:
      goldSubjects: ['keep responses terse', 'avoid spaces indent with tabs'],
      goldStyle: objectiveStyle('Terse.'),
      prompt: 'Explain this function.',
    },
  ];

  // NEGATIVE CONTROL: persona "Bo" — verbose, spaces, JS, heavy emoji. A profile
  // derived from Ada must NOT match Bo's gold prefs (precision guard).
  const negativeControl = {
    name: 'Bo',
    goldSubjects: ['use spaces not tabs', 'prefer plain javascript', 'write detailed explanations'],
    goldStyle: objectiveStyle(
      'Sure! Let me walk you through this in detail, step by step, with lots of context. 😀🎉',
    ),
  };

  return { sessions, probes, negativeControl };
}

// ---------------------------------------------------------------------------
// LIVE-LLM transport resolution for the Gate B agent run. The ONLY env-gated
// part of the harness. When IJFW_PROFILE_EVAL_LIVE is set AND no transport is
// injected, we construct a REAL Ollama-compatible local HTTP caller (kept
// self-contained, same shape as derive.js — never reaches a cloud model). When a
// transport IS injected (tests), we use it. With neither, live runs refuse
// rather than silently faking a result.
// ---------------------------------------------------------------------------

function makeLocalAgentTransport(url) {
  return async ({ prompt, system, maxTokens, model }) => {
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    const res = await fetch(url.replace(/\/$/, '') + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3',
        prompt: fullPrompt,
        stream: false,
        options: { num_predict: maxTokens || 256 },
      }),
    });
    if (!res.ok) throw new Error(`profile eval live LLM HTTP ${res.status}`);
    const data = await res.json();
    return { text: (data && data.response) || '', via: 'local' };
  };
}

/**
 * resolveAgentTransport(opts) -> { transport, live } | { transport:null }.
 *
 * @param {object} [opts]
 *   @param {Function} [opts.agent]  injected transport (tests / explicit live).
 *   @param {object}   [opts.env]    defaults to process.env.
 *
 * Resolution order:
 *   1. an explicitly injected `agent` (deterministic fake in tests; real caller
 *      when an operator wires one) — used regardless of the live flag.
 *   2. IJFW_PROFILE_EVAL_LIVE set + a local URL (IJFW_PROFILE_LOCAL_URL /
 *      IJFW_BRAIN_LOCAL_URL) -> a real local HTTP transport.
 *   3. otherwise null (no transport) — the caller decides whether that's an
 *      error (live mode) or fine (offline objective-only scoring).
 */
export function resolveAgentTransport(opts = {}) {
  const env = opts.env || process.env;
  if (typeof opts.agent === 'function') return { transport: opts.agent, live: Boolean(env.IJFW_PROFILE_EVAL_LIVE) };
  if (env && env.IJFW_PROFILE_EVAL_LIVE) {
    const url = (env.IJFW_PROFILE_LOCAL_URL || env.IJFW_BRAIN_LOCAL_URL || '').trim();
    if (url) return { transport: makeLocalAgentTransport(url), live: true };
  }
  return { transport: null, live: false };
}

export default {
  bootstrapCI,
  mcnemar,
  mulberry32,
  splitByTime,
  precisionRecall,
  cohenKappa,
  expectedCalibrationError,
  objectiveStyle,
  styleDistance,
  biasControlledJudge,
  makeHeldOutFixture,
  resolveAgentTransport,
};
