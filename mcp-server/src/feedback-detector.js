// --- Feedback detector (W3.7 / H3) ---
//
// Deterministic detection of user-feedback phrases that should be promoted
// to feedback memories at session end: corrections ("don't X"), confirmations
// ("yes that was right"), and preference drifts ("keep doing Y").
//
// The session-end synthesizer (W3.9) reads these as structured signals and
// asks the LLM to generalize them into feedback entries with Why + How-to-apply.
//
// Pure regex, no LLM. High precision, low recall.

const PATTERNS = [
  // Corrections -- "don't X", "stop X", "not that", "no/wrong"
  { kind: 'correction', re: /\bdon'?t\s+(do|add|use|call|write|include|keep|ever)\b/i },
  { kind: 'correction', re: /\bstop\s+(doing|adding|using|calling|writing|including)\b/i },
  { kind: 'correction', re: /\b(?:no|not|wrong|nope)[,.!]/i },
  { kind: 'correction', re: /\bdon'?t do (?:that|this|it)\b/i },

  // Confirmations -- "yes that was right", "perfect", "exactly"
  { kind: 'confirmation', re: /\b(?:yes|yep|yup)[,.!]?\s+(?:that|this)\s+(?:was|is)\s+(?:right|correct|good|great|perfect)\b/i },
  { kind: 'confirmation', re: /\b(?:perfect|exactly|spot on|nailed it|great job|well done)\b/i },
  { kind: 'confirmation', re: /\bkeep doing (?:that|this|it)\b/i },

  // Preferences -- "I prefer X", "from now on X"
  { kind: 'preference',  re: /\bI prefer\b/i },
  { kind: 'preference',  re: /\bfrom now on[, ]/i },
  { kind: 'preference',  re: /\b(?:always|never) (?:do|use|add|include)\b/i },

  // Generalization cues -- "every time", "each X"
  { kind: 'rule',        re: /\b(?:every time|each time|whenever|any time)\b/i },
];

// v1.5.0 audit-LOW-memory-#15: negation / sarcasm guards.
// When any of these phrases appears, suppress all feedback detection for the
// prompt — the user has signalled that the literal phrase shouldn't be taken
// as feedback (retraction, joke, hypothetical). High precision is more
// valuable than recall here; a false positive promotes a bogus rule into
// long-term memory which is expensive to unlearn.
const NEGATION_PATTERNS = [
  /\bnever ?mind\s+(?:that|this|it)?\b/i,
  /\bnvm\b/i,
  /\bactually,?\s+wait\b/i,
  /\bsarcasm:\s*yes\b/i,
  /\b\/s\b/i,                          // tumblr/reddit sarcasm tag
  /\bjust kidding\b/i,
  /\bscratch that\b/i,
  /\bdisregard (?:that|this|it|the (?:above|last))\b/i,
];

function isNegatedOrSarcastic(prompt) {
  for (const re of NEGATION_PATTERNS) {
    if (re.test(prompt)) return true;
  }
  return false;
}

export function detectFeedback(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  // Suppress detection when negation/sarcasm signal present.
  if (isNegatedOrSarcastic(prompt)) return [];
  const hits = [];
  for (const { kind, re } of PATTERNS) {
    const m = prompt.match(re);
    if (m) {
      hits.push({ kind, phrase: m[0].trim(), context: snippet(prompt, m.index ?? 0, 120) });
    }
  }
  // Deduplicate by kind -- one signal per kind per prompt is enough for synthesis.
  const seen = new Set();
  return hits.filter(h => {
    if (seen.has(h.kind)) return false;
    seen.add(h.kind);
    return true;
  });
}

function snippet(text, start, width) {
  const from = Math.max(0, start - 20);
  const to = Math.min(text.length, start + width);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return prefix + text.slice(from, to).replace(/\s+/g, ' ').trim() + suffix;
}
