# AskUserQuestion Score Examples

Rule: options that differ by DEGREE (measurable) -> score prefix. Options that differ by KIND (categorical) -> no score.

---

## SCORED examples

### 1. Coverage % (degree -- measurable scale)

```json
{
  "question": "How thorough should test coverage be?",
  "header": "Coverage strategy",
  "options": [
    { "label": "Minimal", "description": "[Coverage: 40%] Happy-path only" },
    { "label": "Focused",  "description": "[Coverage: 70%] Core paths + edge cases" },
    { "label": "Thorough", "description": "[Coverage: 95%] Full branch coverage" }
  ]
}
```

Why scored: options sit on a single measurable axis (% covered). Each label maps to a real number.

### 2. Risk severity (degree -- HIGH/MEDIUM/LOW tier)

```json
{
  "question": "Which risks need mitigation before ship?",
  "header": "Risk triage",
  "options": [
    { "label": "Unsigned migration",      "description": "[Risk: HIGH] Blast radius unbounded -- data loss possible" },
    { "label": "Token expiry collision",  "description": "[Risk: MEDIUM] Auth failure recoverable in <1hr" },
    { "label": "Stale cache on restart",  "description": "[Risk: LOW] Self-heals on next deploy" }
  ]
}
```

Why scored: severity is an ordinal scale (HIGH > MEDIUM > LOW) with defined impact tiers.

### 3. Time-to-ship (degree -- wall-clock duration)

```json
{
  "question": "How long should this phase take?",
  "header": "Time budget",
  "options": [
    { "label": "Quick slice",    "description": "[Time: ~1hr] One commit, one verify" },
    { "label": "Feature scope",  "description": "[Time: ~3hr] Full feature with tests" },
    { "label": "Deep pass",      "description": "[Time: ~6hr] Multi-wave, rollback plan" }
  ]
}
```

Why scored: options differ only in elapsed time -- a single measurable dimension.

---

## UNSCORED examples

### 4. Framework choice (kind -- categorical)

```json
{
  "question": "Which CSS framework?",
  "header": "Framework",
  "options": [
    { "label": "Tailwind",     "description": "Utility-first, minimal bundle" },
    { "label": "Bootstrap",    "description": "Component library, familiar grid" },
    { "label": "Vanilla CSS",  "description": "Zero deps, full control" }
  ]
}
```

Why unscored: frameworks differ in kind, not on a shared measurable scale. Assigning a score implies one is objectively better -- that's false precision.

### 5. Visual style choice (kind -- categorical)

```json
{
  "question": "Which visual style fits the brand?",
  "header": "Style",
  "options": [
    { "label": "Dark, high-tech",        "description": "Dark bg, cyan accents -- premium feel" },
    { "label": "Bold / vibrant",         "description": "Strong colors, dynamic -- stands out" },
    { "label": "Corporate / enterprise", "description": "Professional, trustworthy" }
  ]
}
```

Why unscored: aesthetic directions are categorical. There is no shared axis to score against.

### 6. Architectural pattern (kind -- categorical)

```json
{
  "question": "Which architecture for the API?",
  "header": "Architecture",
  "options": [
    { "label": "REST",       "description": "Stateless, wide tooling support, familiar" },
    { "label": "GraphQL",    "description": "Flexible queries, strong typing, client-driven" },
    { "label": "tRPC",       "description": "End-to-end type safety, TypeScript-only" }
  ]
}
```

Why unscored: REST vs GraphQL vs tRPC are qualitatively different approaches. No single dimension to score.

---

## Deceptive degree counter-example

### 7. "Fast / Medium / Slow" without actual numbers

```json
{
  "question": "How fast should the rollout be?",
  "header": "Rollout speed",
  "options": [
    { "label": "Fast",   "description": "[Speed: FAST] Ship everything at once" },
    { "label": "Medium", "description": "[Speed: MEDIUM] Two-phase rollout" },
    { "label": "Slow",   "description": "[Speed: SLOW] Canary then full" }
  ]
}
```

**WRONG.** `[Speed: FAST]` is not a measurement -- it just restates the label. This is fake precision.

Correct fix: either drop the score prefix (these are kind-level labels with no shared numeric axis) OR replace with real numbers:

```json
{ "label": "Immediate", "description": "[Time: <1hr] Deploy all instances now" },
{ "label": "Staged",    "description": "[Time: ~4hr] 10% canary -> 50% -> 100%" },
{ "label": "Gradual",   "description": "[Time: ~24hr] 5% per hour with rollback gates" }
```

Rule: if you can't write a real unit after the colon, don't fake it.
