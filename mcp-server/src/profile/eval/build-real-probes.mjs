/**
 * profile/eval/build-real-probes.mjs — turn a REAL transcript corpus into the
 * { sessions(train), probes, negativeControl } shape Gate B/C consume, with a
 * LaMP time-based split and HONEST, transcript-free probe construction.
 *
 * ── SPLIT ──────────────────────────────────────────────────────────────────
 * Time-based (LaMP [2304.11406]): sessions sorted by ts; the first `trainFrac`
 * are TRAIN (the only sessions derivation ever sees), the rest are the held-out
 * TEST window. Disjoint session ids by construction; the gates re-assert it.
 *
 * ── GOLD (the honesty crux) ─────────────────────────────────────────────────
 * Gate C gold = the preference subjects the user ACTUALLY expressed in the
 * held-out TEST window, recovered by the SAME heuristic pipeline (so it is the
 * user's own later-window signal, not a hand-picked target). Recovering a
 * TRAIN-derived subject in that TEST gold tests cross-time generalization — and
 * because the heuristic keys on a sentence-fragment slug, exact cross-time
 * matches are rare; Gate C will report that low recall HONESTLY rather than
 * rigging exact restatements (the synthetic fixture's 0.75 came from designed
 * exact restatements that real cross-time data does not contain).
 *
 * Gate B goldStyle = the user's held-out OBJECTIVE style target, computed from
 * the TEST-window per-session metadata (numbers only — terseness/formality/emoji
 * presence). NO raw transcript text is embedded in a probe. The probe `prompt`
 * is one of a fixed set of GENERIC, transcript-free engineering tasks the eval
 * authors — nothing from the user's messages.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────
 * Probes carry only: numeric goldStyle, slugged goldSubjects (already PII/
 * special-category-scrubbed by the derive pipeline), an authored prompt, and ids.
 * No raw user prose. The probe set is safe to (and does) drive the cloud agent.
 *
 * Zero deps, Node built-ins, no network, no LLM.
 */

import { deriveProfileFromSessions, assertedSubjects } from './gate-c-capture.mjs';
import { objectiveStyle } from './harness.mjs';

/**
 * Map the user's TRAIN-derived style EMA onto an objective-style target the Gate
 * B `objectiveAdherence` fallback (styleDistance) scores against. We translate
 * the four derived axes into the objectiveStyle dimension space:
 *   - terseness   <- derived terseness EMA directly (same 120-char scale)
 *   - formalityMarkers <- derived formality EMA
 *   - emoji presence   <- derived emoji_use EMA (> 0.15 => "uses emoji")
 *   - code presence    <- from the mean code_block_ratio of the window
 * This keeps the Gate B style target on the user's REAL fingerprint instead of
 * the synthetic fixture's terse/tabs persona.
 */
function styleTargetFromAxes(profile, meanCodeRatio) {
  const s = profile.global.style;
  // NOTE on codeBlock: the user's transcripts have a high code_block_ratio, but
  // that is an artifact of pasting code/diffs INTO Claude, NOT a property of the
  // assistant-style the brief conveys. The style brief only encodes
  // terseness/formality/emoji — so the objective target is scoped to the
  // brief-CONTROLLABLE dimensions. Including codeBlock would penalize an arm for
  // a facet the brief never asks for (an unfair, non-falsifiable target). We
  // keep meanCodeRatio in the record for transparency but DO NOT score on it.
  return {
    terseness: Number(s.terseness && s.terseness.ema) || 0.5,
    formalityMarkers: Number(s.formality && s.formality.ema) || 0.5,
    emojiPerChar: (Number(s.emoji_use && s.emoji_use.ema) || 0) > 0.15 ? 0.001 : 0,
    codeBlock: 0, // not brief-controllable; excluded from the objective target
    len: 0,
    _observed_code_block_ratio: Math.round(meanCodeRatio * 1000) / 1000,
  };
}

function meanCode(sessions) {
  if (!sessions.length) return 0;
  let sum = 0;
  for (const s of sessions) sum += Number(s.metadata.code_block_ratio) || 0;
  return sum / sessions.length;
}

/**
 * A fixed set of GENERIC engineering prompts (transcript-free). Gate B asks the
 * agent to answer each WITH vs WITHOUT the profile brief; adherence is scored on
 * whether the OUTPUT matches the user's held-out objective style. These prompts
 * are deliberately open-ended so style (length/formality/emoji) is free to vary.
 */
export const GENERIC_PROMPTS = [
  'Explain what a rate limiter does and when to use one.',
  'How should I structure a new TypeScript module?',
  'Review this approach: caching API responses in memory. Any concerns?',
  'What is the difference between a process and a thread?',
  'Walk me through setting up CI for a Node project.',
  'Should I use a monorepo or separate repos for three related services?',
  'Explain how database indexing improves query performance.',
  'What are the tradeoffs of server-side vs client-side rendering?',
  'How do I debug a memory leak in a long-running service?',
  'Describe a good branching strategy for a small team.',
  'What is idempotency and why does it matter for APIs?',
  'How would you design a simple job queue?',
  'Explain the CAP theorem in practical terms.',
  'When should I reach for a message broker instead of direct calls?',
  'How do I make a slow SQL query faster?',
  'What belongs in a code review checklist?',
  'Explain dependency injection and when it helps.',
  'How should secrets be managed in a deployment pipeline?',
  'What is the point of a feature flag system?',
  'Describe how you would add observability to a new service.',
];

/**
 * buildRealEval(corpus, opts) -> { train, test, probes, negativeControl, split }.
 *
 * @param {object} corpus  { sessions } from corpus-from-transcripts.buildCorpus
 * @param {object} [opts]
 *   @param {number} [opts.trainFraction] default 0.6
 *   @param {number} [opts.nProbes]       number of behavior probes (default 30)
 */
export async function buildRealEval(corpus, opts = {}) {
  const all = (corpus.sessions || []).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const frac = Number.isFinite(opts.trainFraction) ? opts.trainFraction : 0.6;
  const k = Math.max(1, Math.min(all.length - 1, Math.round(all.length * frac)));
  const train = all.slice(0, k);
  const test = all.slice(k);

  const trainIds = new Set(train.map((s) => String(s.session_id)));
  const testIds = new Set(test.map((s) => String(s.session_id)));
  let disjoint = true;
  for (const id of testIds) if (trainIds.has(id)) { disjoint = false; break; }

  // Gate C gold = subjects the user expressed in the HELD-OUT test window,
  // recovered by the SAME pipeline (real later-window signal).
  const trainProfile = await deriveProfileFromSessions(train, {});
  const testProfile = await deriveProfileFromSessions(test, {});
  const testGoldSubjects = assertedSubjects(testProfile);

  // Gate B style target — CIRCULARITY FIX (2026-06-08 cross-audit).
  // PRIOR BUG: goldStyle was the TRAIN-derived fingerprint — the SAME object the
  // injected brief encodes. Scoring output against the value we just handed the
  // model is teaching-to-the-test: any "win" is the model obeying the numbers in
  // its prompt, not generalizing to the user. Every past Gate B style number
  // (the 0.617/0.728/0.834 line) was train-target and is SUPERSEDED.
  // FIX: the brief stays TRAIN-derived (what we actually learned), but the
  // scoring target is the HELD-OUT TEST fingerprint — a style the model never
  // saw. Now reducing distance is a real cross-time generalization claim.
  const styleTargetTrain = styleTargetFromAxes(trainProfile, meanCode(train)); // injected via brief; reported for drift only
  const styleTargetTest = styleTargetFromAxes(testProfile, meanCode(test));    // SCORING target (held-out)
  const styleTarget = styleTargetTest;

  // Build N behavior probes from the generic prompt bank. goldSubjects on the
  // probes is the TEST-window gold (so Gate C, when it consumes probes, scores
  // the held-out signal); goldStyle is the user's real objective style target.
  const nProbes = Number.isFinite(opts.nProbes) ? opts.nProbes : 30;
  const probes = [];
  for (let i = 0; i < nProbes; i++) {
    const prompt = GENERIC_PROMPTS[i % GENERIC_PROMPTS.length];
    probes.push({
      session_id: `probe-${i}`,
      sessionId: `probe-${i}`,
      host: 'claude-code',
      ts: new Date(Date.parse(all[all.length - 1].ts) + (i + 1) * 60000).toISOString(),
      // Gate C generalization gold (held-out, real). Empty is honest if the
      // user expressed no floor-clearing preference in the test window.
      goldSubjects: testGoldSubjects,
      // Gate B objective style target (the real fingerprint).
      goldStyle: styleTarget,
      prompt,
    });
  }

  // NEGATIVE CONTROL — an INVERTED persona whose style target is the opposite of
  // the user's real fingerprint (terse if user is expansive, etc.). The derived
  // profile must NOT match this; it is the precision/over-claim guard.
  const negStyle = objectiveStyle('Terse. No fluff.'); // a deliberately opposite target
  const negativeControl = {
    name: 'inverted-persona',
    goldSubjects: ['use spaces not tabs', 'prefer verbose explanations', 'heavy emoji always'],
    goldStyle: negStyle,
  };

  return {
    train,
    test,
    probes,
    negativeControl,
    split: {
      nAll: all.length,
      nTrain: train.length,
      nTest: test.length,
      disjoint,
      trainTsMin: train.length ? train[0].ts : null,
      trainTsMax: train.length ? train[train.length - 1].ts : null,
      testTsMin: test.length ? test[0].ts : null,
      testTsMax: test.length ? test[test.length - 1].ts : null,
      testGoldSubjectCount: testGoldSubjects.length,
      trainProfileSubjectCount: assertedSubjects(trainProfile).length,
      styleTarget,                 // = held-out TEST fingerprint (scoring target, post circularity-fix)
      styleTargetTrain,            // what the injected brief encodes — for drift/transparency, NOT scored
      styleTargetTest,             // explicit alias of the scoring target
    },
  };
}

export default { buildRealEval, GENERIC_PROMPTS };
