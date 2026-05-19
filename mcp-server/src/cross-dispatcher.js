// --- Cross-dispatcher (Phase 7, Wave 1) ---
//
// Shared dispatcher for /cross-audit, /cross-research, /cross-critique.
// All modes use a JSON-in-fenced-block + prose response contract so that
// parseResponse can round-trip structured data regardless of auditor.
//
// Zero external deps. ES module.

// ---------------------------------------------------------------------------
// Internal templates
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// Format-contract footer shared by all templates -- tells auditors the exact
// fenced block schema to use so parseResponse can extract it reliably.
function formatContract(schema) {
  return `
## Response format (required)

Return your findings in **two parts**:

1. A single fenced JSON block -- the machine-readable payload:

\`\`\`json
${schema}
\`\`\`

2. After the block, any prose commentary you wish to add for context.

Rules:
- The \`\`\`json fence must appear exactly once.
- Every object key listed above is required; use an empty string for unknown values.
- Do not nest arrays inside arrays.
- Confidence values: "high" | "medium" | "low".
- Severity values: "critical" | "high" | "medium" | "low".`.trim();
}

const TEMPLATES = {
  audit: {
    general: {
      system: `You are a precise, adversarial code and design auditor. You find real problems -- not style preferences. Every finding must be actionable. If a dimension is clean, say so explicitly rather than omitting it. Findings: blunt and specific. Wrapping prose: neutral tone.`,
      format: formatContract(`[
  {
    "severity": "high",
    "dimension": "correctness",
    "location": "file.js:42",
    "issue": "one-sentence description of the problem",
    "whyItMatters": "one-sentence consequence if left unaddressed",
    "fix": "one-sentence recommended action"
  }
]`),
    },
  },
  research: {
    benchmarks: {
      system: `You are a research specialist focused on performance benchmarks, empirical comparisons, and quantitative data. Surface concrete numbers, published benchmarks, and real-world measurements. Attribute every claim to a source where possible.`,
      format: formatContract(`[
  {
    "claim": "the finding or data point",
    "evidence": "supporting detail or measurement",
    "source": "paper, repo, URL, or 'unpublished observation'",
    "confidence": "high"
  }
]`),
    },
    citations: {
      system: `You are a research specialist focused on academic citations, authoritative references, and prior art. Surface papers, RFCs, specifications, and documented precedents. When citing, include enough detail for the reader to locate the source.`,
      format: formatContract(`[
  {
    "claim": "the finding or referenced position",
    "evidence": "summary of the source's argument or data",
    "source": "author, title, year, URL",
    "confidence": "high"
  }
]`),
    },
    synthesis: {
      system: `You are a synthesis analyst. You have received research from THREE independent sources: Codex (benchmarks angle), Gemini (citations angle), and the in-session caller (observations angle). Your job is to find consensus, surface contradictions, flag open questions, and produce a coherent synthesis across all three -- not a summary of each. Be rigorous: if two claims conflict, say so; do not average them. Cluster semantically equivalent claims even when the wording differs -- that is your unique value over the lexical dispatcher merge.`,
      format: formatContract(`[
  {
    "claim": "synthesised finding",
    "evidence": "which sources support this and how",
    "source": "codex | gemini | both | inferred",
    "confidence": "high"
  }
]`),
    },
  },
  critique: {
    technical: {
      system: `You are a technical adversary. Your role is to find weaknesses in implementation, architecture, and engineering choices. Focus on correctness, scalability, failure modes, and technical debt. Be concrete -- every counter-argument must name a condition under which the weakness manifests.`,
      format: formatContract(`[
  {
    "counterArg": "the specific weakness or challenge",
    "conditions": "the scenario or context under which this weakness applies",
    "mitigation": "how the weakness could be addressed or accepted",
    "severity": "high"
  }
]`),
    },
    strategic: {
      system: `You are a strategic adversary. Your role is to find weaknesses in positioning, market assumptions, prioritisation, and long-term viability. Focus on adoption risks, competitive landscape, and resource constraints. Be concrete -- every counter-argument must name a condition under which the weakness manifests.`,
      format: formatContract(`[
  {
    "counterArg": "the specific strategic weakness",
    "conditions": "the scenario or context under which this weakness applies",
    "mitigation": "how the weakness could be addressed or accepted",
    "severity": "medium"
  }
]`),
    },
    ux: {
      system: `You are a UX and adoption adversary. Your role is to find weaknesses in user experience, onboarding, learnability, and real-world adoption. Focus on friction points, mental models, and the gap between what the system does and what users expect. Be concrete -- every counter-argument must name a condition under which the weakness manifests.`,
      format: formatContract(`[
  {
    "counterArg": "the specific UX or adoption weakness",
    "conditions": "the scenario or context under which this weakness applies",
    "mitigation": "how the weakness could be addressed or accepted",
    "severity": "medium"
  }
]`),
    },
  },
};

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

export function getTemplate(mode, angle) {
  const modeTemplates = TEMPLATES[mode];
  if (!modeTemplates) throw new Error(`Unknown mode: ${mode}. Valid: audit | research | critique`);
  const template = modeTemplates[angle];
  if (!template) {
    const valid = Object.keys(modeTemplates).join(' | ');
    throw new Error(`Unknown angle "${angle}" for mode "${mode}". Valid: ${valid}`);
  }
  return { system: template.system, format: template.format };
}

// ---------------------------------------------------------------------------
// assignRoles
// ---------------------------------------------------------------------------

// Mode → required angles → preferred auditor ids (in priority order).
// These are the "natural fit" assignments per PHASE7-PLAN-v2.md.
const ROLE_PREFERENCES = {
  audit:    [{ angle: 'general',    preferred: ['codex', 'gemini', 'opencode', 'aider', 'copilot', 'claude'] }],
  research: [
    { angle: 'benchmarks', preferred: ['codex', 'opencode', 'aider'] },
    { angle: 'citations',  preferred: ['gemini', 'claude', 'copilot'] },
    { angle: 'synthesis',  preferred: ['claude'] }, // always Claude -- see spec
  ],
  critique: [
    { angle: 'technical',  preferred: ['codex', 'opencode', 'aider'] },
    { angle: 'strategic',  preferred: ['gemini', 'copilot'] },
    { angle: 'ux',         preferred: ['claude', 'gemini'] },
  ],
};

export function assignRoles(mode, roster, self) {
  const roleDefs = ROLE_PREFERENCES[mode];
  if (!roleDefs) throw new Error(`Unknown mode: ${mode}`);

  // roster is an array of auditor id strings that are installed.
  const installed = new Set(Array.isArray(roster) ? roster : []);

  const roles = [];
  const missing = [];

  for (const { angle, preferred } of roleDefs) {
    // Synthesis in research always goes to a fresh Claude session --
    // even when self=claude. The spec is explicit: "synthesis is fresh Claude
    // not the caller." So for synthesis we never exclude Claude.
    const isSynthesis = mode === 'research' && angle === 'synthesis';

    // Critique: caller's own angle is dropped -- they contribute in-session.
    // We still assign it to someone else if possible.
    const assignablePreferred = preferred.filter(id => {
      if (!isSynthesis && id === self) return false;
      return true;
    });

    // Find first preferred that's installed.
    const pick = assignablePreferred.find(id => installed.has(id));

    if (pick) {
      roles.push({ auditorId: pick, angle });
    } else {
      // No installed auditor for this angle.
      missing.push({ angle, wanted: assignablePreferred[0] || preferred[0] });
    }
  }

  return { roles, missing };
}

// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------

export function buildRequest(mode, target, auditorId, angle, priorResponses = null) {
  const { system, format } = getTemplate(mode, angle);

  const isSynthesis = mode === 'research' && angle === 'synthesis';

  let priorSection = '';
  if (isSynthesis && priorResponses) {
    priorSection = `
## Prior research (Phase A -- synthesise across these)

${priorResponses}

---
`;
  }

  return `# IJFW Cross-${capitalise(mode)} Request
Auditor: ${auditorId}
Mode:    ${mode}
Angle:   ${angle}
Stamp:   ${new Date().toISOString()}

## Your role

${system}

## Operating constraints (mandatory)

- You ARE the auditor. Do not delegate this work.
- Do not shell out, do not invoke other CLIs, do not call gemini/codex/claude/aider/opencode/copilot, do not spawn subagents.
- Do not attempt to convene additional auditors -- the orchestrator already runs them in parallel.
- Produce findings inline in the response format below. Nothing else.
- If the target is clean for your angle, return an empty findings array and say so in the prose.

${format}
${priorSection}
## Target

${target}`.trim();
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

export function parseResponse(_mode, raw) {
  if (typeof raw !== 'string') return { items: [], prose: '' };

  // Extract first ```json fence.
  const match = raw.match(/```json\s*([\s\S]*?)```/);
  let items = [];
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  }

  // Prose is everything outside the fence (before + after), trimmed.
  const prose = raw.replace(/```json[\s\S]*?```/, '').trim();

  return { items, prose };
}

// ---------------------------------------------------------------------------
// scoreRebuttalSurvival
// ---------------------------------------------------------------------------

// Deterministic structural rubric -- NOT length-based (length bias was a
// dogfood-critique finding, consensus between Codex + Gemini). Scores by
// presence of falsifiability signals, actionable mitigation verbs, concrete
// code-level evidence, and explicit severity tier. Same input → same score.
const _CONDITION_MARKERS = /\b(when|if|once|under|during|assuming|in ci|in prod|at runtime|in production)\b/i;
const _MITIGATION_VERBS = /\b(add|implement|replace|route|switch|pin|lock|gate|require|drop|move|rename|enforce|promote|defer|merge|split|refactor|rewrite|extract|parse|validate|sandbox|isolate|audit)\b/i;
const _CODE_EVIDENCE = /`[^`]+`|\bline \d+|\bcommit [0-9a-f]{6,}|\.(js|md|sh|json|ts|py|mjs|cjs)\b|[A-Za-z_][A-Za-z0-9_.]*\(\)|\bfile:/i;

export function scoreRebuttalSurvival(counterArg) {
  if (!counterArg || typeof counterArg !== 'object') return 1;
  const { conditions = '', mitigation = '', counterArg: arg = '', severity = '' } = counterArg;

  let score = 1;
  if (['high', 'critical'].includes(String(severity).toLowerCase())) score++;
  if (typeof conditions === 'string' && _CONDITION_MARKERS.test(conditions)) score++;
  if (typeof mitigation === 'string' && _MITIGATION_VERBS.test(mitigation)) score++;
  if (typeof arg === 'string' && _CODE_EVIDENCE.test(arg)) score++;

  return Math.min(5, Math.max(1, score));
}

// ---------------------------------------------------------------------------
// mergeResponses
// ---------------------------------------------------------------------------

export function mergeResponses(mode, responses) {
  if (mode === 'audit') return mergeAudit(responses);
  if (mode === 'research') return mergeResearch(responses);
  if (mode === 'critique') return mergeCritique(responses);
  throw new Error(`Unknown mode: ${mode}`);
}

function mergeAudit(responses) {
  const all = responses.flatMap(r => (r && Array.isArray(r.items) ? r.items : []));
  return all.slice().sort((a, b) => {
    const sa = SEVERITY_ORDER[String(a.severity).toLowerCase()] ?? 99;
    const sb = SEVERITY_ORDER[String(b.severity).toLowerCase()] ?? 99;
    return sa - sb;
  });
}

function normaliseClaim(claim) {
  return String(claim).toLowerCase().trim().replace(/\s+/g, ' ');
}

function mergeResearch(responses) {
  // Lexical clustering only -- exact normalised text match. Semantic clustering
  // (paraphrases, opposing directions) is DELEGATED to the Claude synthesis
  // pass (see research template line: "if two claims conflict, say so"). If
  // the caller has not yet run Phase B, `synthesisPending` flags that the
  // consensus here is lexical-only and the authoritative matrix comes from
  // synthesis. This was M2 in DOGFOOD-CRITIQUE.md -- Codex flagged that exact
  // normalisation misses semantic equivalence; delegating fixes it without
  // baking a similarity heuristic into the dispatcher.
  const hasSynthesis = responses.some(r => r && r.items && r.items.some(i => i && i.synthesis === true));

  const buckets = new Map();
  responses.forEach((r, auditorIdx) => {
    const items = r && Array.isArray(r.items) ? r.items : [];
    for (const item of items) {
      const key = normaliseClaim(item.claim || '');
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ item, auditorIdx });
    }
  });

  const consensus = [];
  const contested = [];
  const unique = {};
  const openQuestions = [];

  for (const [, entries] of buckets) {
    if (entries.length >= 2) {
      const confidences = new Set(entries.map(e => String(e.item.confidence || '').toLowerCase()));
      const evidences = new Set(entries.map(e => String(e.item.evidence || '').toLowerCase().trim()));
      if (confidences.size > 1 || evidences.size > 1) {
        contested.push(...entries.map(e => e.item));
      } else {
        consensus.push(entries[0].item);
      }
    } else {
      const { item, auditorIdx } = entries[0];
      if (!unique[auditorIdx]) unique[auditorIdx] = [];
      unique[auditorIdx].push(item);
    }
  }

  return { consensus, contested, unique, openQuestions, synthesisPending: !hasSynthesis };
}

function mergeCritique(responses) {
  const all = responses.flatMap(r => (r && Array.isArray(r.items) ? r.items : []));
  return all.slice().sort((a, b) => {
    const sa = scoreRebuttalSurvival(a);
    const sb = scoreRebuttalSurvival(b);
    if (sb !== sa) return sb - sa; // DESC survival
    const ra = SEVERITY_ORDER[String(a.severity).toLowerCase()] ?? 99;
    const rb = SEVERITY_ORDER[String(b.severity).toLowerCase()] ?? 99;
    return ra - rb; // DESC severity (lower index = higher sev)
  });
}

// ---------------------------------------------------------------------------
// Budget guard (Step 10B.6)
// ---------------------------------------------------------------------------

// Per-provider input-token price (USD/token), sourced from the canonical
// pricing module. Used only for pre-flight estimation -- not for billing.
// Single source of truth = mcp-server/src/cost/pricing.js. H4.8 audit fix.
import { getProviderInputRate } from './cost/pricing.js';

const DEFAULT_PRICE_PER_TOKEN = 0.000_010; // fallback for unknown providers

// estimateCost(target, picks) -- rough cost in USD for one runCrossOp call.
// char-count / 4 approximates token count; multiply by provider price.
export function estimateCost(target, picks) {
  const charCount = typeof target === 'string' ? target.length : 0;
  const tokens = charCount / 4;
  let total = 0;
  for (const pick of picks) {
    const price = getProviderInputRate(pick.id) ?? DEFAULT_PRICE_PER_TOKEN;
    total += tokens * price;
  }
  return total;
}

// checkBudget({ target, picks, receipts, sessionStart, env }) -- returns null
// if within budget, or a string error message to emit to stderr before exit 2.
//
// Post-flight accumulation only: first call is always allowed; the guard
// refuses when accumulated prior receipts + estimated next call exceed budget.
// (first-call surprise is unavoidable -- budget enforces on 2nd+ calls.)
export function checkBudget({ target, picks, receipts, sessionStart, env = {} }) {
  const raw = env.IJFW_AUDIT_BUDGET_USD;
  const budget = raw !== undefined ? parseFloat(raw) : 2.00;
  if (!isFinite(budget) || budget <= 0) return null; // invalid → no guard

  // Sum cost_usd from receipts in current session window.
  const accumulated = receipts
    .filter(r => r && r.timestamp && new Date(r.timestamp) >= sessionStart)
    .reduce((sum, r) => sum + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);

  const estimated = estimateCost(target, picks);

  if (accumulated + estimated > budget) {
    const fmt = (n) => `$${n.toFixed(2)}`;
    return (
      `Budget ${fmt(budget)} reached (accumulated ${fmt(accumulated)} + next ~${fmt(estimated)}). ` +
      `Raise IJFW_AUDIT_BUDGET_USD to continue.`
    );
  }
  return null;
}
