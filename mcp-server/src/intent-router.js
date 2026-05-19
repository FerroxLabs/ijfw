// --- Intent router (W2.1 / A1) ---
// Deterministic keyword → skill dispatch. Runs in UserPromptSubmit hook
// before the vague-prompt check. When a recognized intent hits, emits a
// positive-framed nudge that tells the agent which IJFW skill/tool to use.
//
// This is the "brainstorm auto-fires workflow" moment: we don't leave the
// matching to the LLM; we match deterministically and surface the choice.
//
// Policy: high precision over recall. False positives are expensive (wrong
// skill fired), false negatives cheap (agent just picks normally).

const INTENTS = [
  {
    intent: 'brainstorm',
    skill:  'ijfw-workflow',
    priority: 8,  // High: primary workflow entry point, should beat most other intents
    // Bare "build" is too vague; "build X" + "brainstorm" + "let's design"
    // are the high-signal ones.
    patterns: [
      /\bbrainstorm(?:\s|ing)\b/i,
      /\blet'?s\s+(?:think|design|plan|figure)\b/i,
      /\b(?:new project|starting a project|greenfield)\b/i,
      /\bhelp me (?:build|design|plan|figure)\b/i,
      // Non-software project triggers
      /\b(build|create|design|launch|start|develop|write|outline)\s+(a|an|the|my|our)\s+(?!pr\b|commit\b|branch\b|tag\b|comment\b|variable\b|file\b|line\b|test\b|function\b|class\b|method\b)\w{3,}/i,
      /\b(?:build|create|design|launch|plan|make|start)\s+(?:a|an|the|my|our)\s+(?:landing page|website|app|dashboard|campaign|book|course|brand|product|platform|service)\b/i,
      /\b(from scratch|greenfield|new\s+(?:project|venture|initiative|business|idea))\b/i,
      /\b(strategy for|roadmap for|plan for|outline for)\b/i,
      /\b(social media|content marketing|email sequence|sales funnel|launch plan)\b/i,
    ],
    nudge: "Looks like you want to plan a new project. Try: /ijfw-workflow (quick mode for rapid exploration, deep mode for full project planning).",
  },
  {
    intent: 'project-scale',
    skill:  'ijfw-workflow',
    priority: 7,  // Just below brainstorm -- scale detection is a fallback for non-keyword matches
    patterns: [], // no keyword patterns -- uses check() instead
    check: (prompt) => {
      const words = prompt.split(/\s+/).length;
      const hasMultipleDeliverables = (prompt.match(/\band\b/gi) || []).length >= 2;
      const hasTimeline = /\b(by|before|deadline|launch|next\s+(week|month)|this\s+(week|month))\b/i.test(prompt);
      const hasBudget = /\$\d|budget|resource|team of/i.test(prompt);
      const hasScope = /\b(full|complete|entire|end.to.end|comprehensive)\b/i.test(prompt);
      return words > 40 && (hasMultipleDeliverables || hasTimeline || hasBudget || hasScope);
    },
    nudge: 'This sounds like a project. Want me to brainstorm it with you? I\'ll ask a few questions, do some research, and come back with recommendations.',
  },
  {
    intent: 'ship',
    skill:  'ijfw-commit',
    priority: 5,
    patterns: [
      /\b(?:ship it|let'?s ship|ready to commit|commit this|push this)\b/i,
      /\bmake a commit\b/i,
      /\b(?:create|open) (?:a )?PR\b/i,
    ],
    nudge: "Looks like you want to commit and ship your changes. Try: /ijfw-commit for a terse conventional commit, then open a PR following your git conventions.",
  },
  {
    intent: 'review',
    skill:  'ijfw-review',
    priority: 5,
    patterns: [
      /\b(?:code review|review (?:the|this|my) (?:code|diff|PR|change))/i,
      /\breview PR\b/i,
    ],
    nudge: "Looks like you want to review code or a diff. Try: /ijfw-review for concise, actionable findings.",
  },
  {
    intent: 'remember',
    skill:  'ijfw_memory_store',
    priority: 5,
    patterns: [
      /\b(?:remember (?:this|that)|store (?:this|that)|save (?:this|that) (?:for (?:later|next time)|to memory))\b/i,
      /\b(?:this is|that'?s) important (?:to remember|for (?:later|next time))\b/i,
      /\b(?:note to self|save for later)\b/i,
    ],
    nudge: "Looks like you want to save something to memory. Try: ijfw_memory_store with a type (decision, observation, pattern, handoff, or preference) and a brief summary.",
  },
  {
    intent: 'recall',
    skill:  'ijfw_memory_recall',
    priority: 5,
    patterns: [
      /\b(?:what did we|what (?:did|have) I|do you remember)\b/i,
      /\b(?:recall|pull up|look up) (?:from|in) memory\b/i,
      /\bshow me what you remember\b/i,
    ],
    nudge: "Looks like you want to recall something from memory. Try: ijfw_memory_recall or ijfw_memory_search to pull up what was stored.",
  },
  {
    intent: 'cross-research',
    skill:  '/cross-research',
    priority: 10,
    patterns: [
      /\bcross[- ]?research(?:\s|ing)?\b/i,
      /\blet'?s cross[- ]?research\b/i,
      /\bdig into .+ from multiple angles\b/i,
      /\bmulti[- ]?angle research\b/i,
      /\bresearch (?:this|that) from multiple angles\b/i,
    ],
    nudge: "Looks like you want to research a topic from multiple angles. Try: /cross-research (auto-detects target; no args needed). Phase A fans out to Codex and Gemini in parallel, Phase B synthesizes results -- all via background bash.",
  },
  {
    intent: 'cross-critique',
    skill:  '/cross-critique',
    priority: 10,
    patterns: [
      /\bcross[- ]?critique(?:\s|ing)?\b/i,
      /\blet'?s cross[- ]?critique\b/i,
      /\bstress[- ]?test this claim\b/i,
      /\badversarial (?:critique|review)\b/i,
      /\bchallenge this from every angle\b/i,
      /\battack this from all sides\b/i,
    ],
    nudge: "Looks like you want to stress-test a claim or plan from multiple angles. Try: /cross-critique (auto-detects target). Codex covers technical weaknesses, Gemini covers strategic weaknesses, and a fresh Claude instance covers UX and adoption -- all auto-fired via background bash.",
  },
  {
    intent: 'critique',
    skill:  'ijfw-critique',
    priority: 1,
    patterns: [
      /\b(?:should I|what if|is this (?:right|correct|the best))\b/i,
      /\b(?:critique|poke holes|challenge this)\b/i,
      /\b(?:counter[- ]?argument|devil'?s advocate)\b/i,
    ],
    nudge: "Looks like you want to pressure-test an idea or plan. Try: /ijfw-critique -- steelmans the current approach, then surfaces 2-3 concrete counter-arguments with the conditions that trigger each.",
  },
  {
    intent: 'cross-audit',
    skill:  '/cross-audit',
    priority: 10,
    patterns: [
      /\bcross[- ]?audit(?:\s|ing)?\b/i,
      // eslint-disable-next-line security/detect-unsafe-regex -- intent checks run on one user prompt string; alternations are small and token-bounded.
      /\b(?:get|need)\s+(?:a\s+)?second opinion\b/i,
      // eslint-disable-next-line security/detect-unsafe-regex -- intent checks run on one user prompt string; alternations are small and token-bounded.
      /\b(?:have|ask)\s+(?:codex|gemini|opencode|aider|copilot)\s+(?:to\s+)?(?:review|audit|check)\b/i,
      /\bsecond[- ]model (?:review|opinion|audit)\b/i,
      /\b(?:peer|adversarial)[- ]?(?:review|audit)\b/i,
    ],
    nudge: "Looks like you want a second-model audit of your code. Try: /cross-audit (no args = auto-picks staged and recent-change files; --with <id> to target a specific auditor). Writes .ijfw/cross-audit/request.md and auto-fires the auditor via background bash.",
  },
  {
    intent: 'handoff',
    skill:  'ijfw-handoff',
    priority: 5,
    patterns: [
      /\b(?:session (?:handoff|summary)|wrapping up|end of session)\b/i,
      /\bcontext (?:is )?getting full\b/i,
    ],
    nudge: "Looks like you want to wrap up this session cleanly. Try: /ijfw-handoff -- writes a structured handoff with decisions made, next steps, and open questions.",
  },
  {
    intent: 'mode-brutal',
    skill:  'ijfw-core',
    priority: 5,
    patterns: [
      /\b(?:brutal mode|be brutal|caveman mode|ultra[- ]?terse)\b/i,
    ],
    nudge: "Looks like you want maximum terseness. Try: /ijfw-mode brutal -- code and single-sentence answers only, no narration unless you ask.",
  },
];

function adaptProjectScaleNudge(prompt) {
  const p = prompt.toLowerCase();
  let verb;
  if (/\b(app|api|dashboard|backend|frontend|service|platform|software|saas|microservice)\b/.test(p)) {
    verb = 'brainstorm the architecture';
  } else if (/\b(book|outline|chapter|manuscript|write)\b/.test(p)) {
    verb = 'outline the structure';
  } else if (/\b(campaign|marketing|social|email sequence|sales funnel|launch plan|content)\b/.test(p)) {
    verb = 'plan the strategy';
  } else if (/\b(design|landing page|ui|ux|brand|visual)\b/.test(p)) {
    verb = 'explore the design';
  } else {
    verb = 'map out the approach';
  }
  return `This sounds like a project. Want me to ${verb} with you? I'll ask a few questions, do some research, and come back with recommendations.`;
}

/**
 * detectIntent — deterministic keyword → skill router.
 *
 * Resolution order (v1.5.0 audit-LOW-work-L6, documented for op-clarity):
 *
 *   1. **Priority (DESC).** Each intent entry declares a numeric `priority`.
 *      Higher numbers beat lower numbers. Reserved bands:
 *        - 10 : cross-* analytic intents (cross-research / cross-critique /
 *               cross-audit). These are explicit operator commands and should
 *               override any prose-pattern match.
 *        - 8  : brainstorm (primary workflow entry point).
 *        - 7  : project-scale (length-based fallback for brainstorm).
 *        - 5  : ship / review / remember / recall / handoff / mode (default
 *               band for everyday skills).
 *        - 1  : critique (broad-pattern; intentionally lowest so it never
 *               steals a more specific intent).
 *      Adding a new intent? Pick the band, don't invent a new one.
 *
 *   2. **Match length (DESC).** If two intents tie on priority, the one
 *      whose regex matched a longer substring wins. Rationale: longer match
 *      = more specific signal. (Skills that use `check()` instead of regex
 *      patterns report matchLen=0 and lose this tiebreak by design — their
 *      `check()` already encodes the specificity.)
 *
 *   3. **Declaration order (ASC).** Final stable tiebreak: the intent listed
 *      earlier in the INTENTS array wins. This makes the resolution fully
 *      deterministic — no Map/Set ordering surprises across Node versions.
 *
 * Bypass: a prompt with a leading `*` or containing `ijfw off` returns null
 * without entering the resolver. This is the documented escape hatch for
 * users who want to suppress all routing for one prompt.
 *
 * @param {string} prompt
 * @returns {{intent: string, skill: string, nudge: string} | null}
 */
export function detectIntent(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;
  // Skip if user explicitly bypasses (leading * or `ijfw off`).
  if (/^\s*\*/.test(prompt)) return null;
  if (/\bijfw off\b/i.test(prompt)) return null;

  // Collect ALL matching entries with the longest matching pattern length.
  const matches = [];
  for (const entry of INTENTS) {
    // check() function takes precedence over patterns for entries that declare it.
    if (typeof entry.check === 'function') {
      if (entry.check(prompt)) {
        matches.push({ entry, matchLen: 0 });
      }
      continue;
    }
    for (const re of entry.patterns) {
      const m = prompt.match(re);
      if (m) {
        matches.push({ entry, matchLen: m[0].length });
        break; // one match per entry is enough
      }
    }
  }

  if (matches.length === 0) return null;

  // Sort: (a) priority DESC, (b) matchLen DESC, (c) INTENTS array order ASC (stable via index).
  matches.sort((a, b) => {
    const pd = (b.entry.priority ?? 0) - (a.entry.priority ?? 0);
    if (pd !== 0) return pd;
    const ld = b.matchLen - a.matchLen;
    if (ld !== 0) return ld;
    return INTENTS.indexOf(a.entry) - INTENTS.indexOf(b.entry);
  });

  const winner = matches[0].entry;
  const nudge = winner.intent === 'project-scale'
    ? adaptProjectScaleNudge(prompt)
    : winner.nudge;
  return { intent: winner.intent, skill: winner.skill, nudge };
}
