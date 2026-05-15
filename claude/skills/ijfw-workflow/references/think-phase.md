# Think Phase -- Reference Detail

This file provides examples and detail for Steps 0-4 in SKILL.md.
SKILL.md is the enforcer. This file is supplementary.

---

## Interaction Style (Step 0C)

### Domain detection for default recommendation

| Domain signals in prompt | Default style | Why |
|---|---|---|
| book, novel, story, game, campaign, brand, music, art, creative | Let's talk | Creative work needs divergent exploration |
| app, landing page, API, dashboard, tool, website, component | Guided questions | Technical decisions benefit from structured options |
| plan, strategy, business, analysis | Guided questions | Analytical work benefits from structure |
| brainstorm, explore, "I have an idea", "what if" | Let's talk | Exploratory intent signals conversation |

---

## Guided Mode -- AskUserQuestion Examples

### Recommendation rule: only when you have a basis

- **Fact questions** (user's domain): product name, what it does, target market, asset classes, company details. NO recommendation.
- **Judgment questions** (your domain): tech stack, visual style, positioning, architecture. Recommend with reason cited inline.

### Example: Fact question -- NO recommendation

```json
AskUserQuestion({
  "questions": [{
    "question": "What does your SaaS product do?",
    "header": "Product",
    "multiSelect": false,
    "options": [
      { "label": "Developer tool / API", "description": "Technical audience -- code-focused copy, API examples, docs links" },
      { "label": "Business / productivity tool", "description": "B2B teams -- outcomes, ROI, integrations, social proof" },
      { "label": "Consumer / creator app", "description": "B2C -- visual, emotional hook, free tier emphasis" },
      { "label": "AI-powered tool", "description": "AI/ML product -- demo-heavy, capability showcase" }
    ]
  }]
})
```

### Example: Judgment question -- WITH recommendation + reason

```json
AskUserQuestion({
  "questions": [{
    "question": "Which tech stack for the landing page?",
    "header": "Stack",
    "multiSelect": false,
    "options": [
      { "label": "Next.js + Tailwind (Recommended)", "description": "Research: 6/8 competitors use this combo. SEO-friendly, fast DX, great component ecosystem." },
      { "label": "Astro + Tailwind", "description": "Lighter, ships zero JS by default -- best for pure content sites" },
      { "label": "Plain HTML/CSS", "description": "Maximum control, no framework overhead, but slower iteration" }
    ]
  }]
})
```

### Example: Design style with preview

```json
AskUserQuestion({
  "questions": [{
    "question": "Which visual style fits your brand?",
    "header": "Style",
    "multiSelect": false,
    "options": [
      { "label": "Dark, sleek, high-tech (Recommended)", "description": "Research: top fintech/AI trading sites use dark themes with cyan/violet accents.", "preview": "+-----------------------+\n| #0A0E17 bg + #22D3EE  |\n|    Product Name       |\n|    One clear tagline  |\n|    [ Get Started ]    |\n+-----------------------+" },
      { "label": "Bold / vibrant", "description": "Strong colors, dynamic -- stands out but less typical for fintech" },
      { "label": "Corporate / enterprise", "description": "Professional, trustworthy -- good for institutional clients" }
    ]
  }]
})
```

### Score rule: degree vs kind

**Kind choices (categorical -- NO score):** Options differ in type, not on a measurable scale. Adding a score would be false precision (gstack rule).

```json
AskUserQuestion({
  "questions": [{
    "question": "Which CSS framework?",
    "header": "Framework",
    "multiSelect": false,
    "options": [
      { "label": "Tailwind", "description": "Utility-first, minimal CSS bundle, fast iteration" },
      { "label": "Bootstrap", "description": "Component library, familiar grid system, broad browser support" },
      { "label": "Vanilla CSS", "description": "Zero deps, full control, higher maintenance cost" }
    ]
  }]
})
```

**Degree choices (measurable -- SCORE each option):** Options sit on a measurable scale. Prefix the description with the score.

```json
AskUserQuestion({
  "questions": [{
    "question": "How thorough should test coverage be?",
    "header": "Coverage strategy",
    "multiSelect": false,
    "options": [
      { "label": "Minimal", "description": "[Coverage: 40%] Happy-path only -- fast to write, misses edge cases" },
      { "label": "Focused", "description": "[Coverage: 70%] Core paths + known edge cases -- good balance" },
      { "label": "Thorough", "description": "[Coverage: 95%] Full branch coverage -- slow to write, catches regressions" }
    ]
  }]
})
```

### STRESS module -- risk-severity options (scored by severity tier)

```json
AskUserQuestion({
  "questions": [{
    "question": "Which risks need mitigation before we ship?",
    "header": "Risk triage",
    "multiSelect": true,
    "options": [
      { "label": "Unsigned migration", "description": "[Severity: HIGH] Blast radius unbounded -- data loss possible with no rollback" },
      { "label": "Token expiry collision", "description": "[Severity: MEDIUM] Auth failure recoverable in <1hr -- degraded UX only" },
      { "label": "Stale cache on restart", "description": "[Severity: LOW] Self-heals on next deploy -- no data risk" }
    ]
  }]
})
```

### Socratic arc (guided mode question order)

1. Product type (what does it do?)
2. Audience (who is it for?)
3. Key differentiator (why this over competitors?)
4. Tech stack preferences (if any)
5. Design style (visual direction)
6. Scope -- what's in, what's out

After every 2-3 answers, echo back: `So far: [product] for [audience], [style] style, with [sections]. Sound right?`

### Platform fallback (non-Claude-Code environments)

If AskUserQuestion is not available (Codex, Gemini, Cursor), use numbered text options.

---

## Conversation Mode -- How It Works

### The role of the model in conversation mode

You are a **creative collaborator**, not a questionnaire. Your job:
- Ask open-ended questions: "Tell me about this -- what are you building and why?"
- Build on the user's ideas: "That's interesting -- what if [extension of their idea]?"
- Challenge constructively: "One thing that could be tricky with that approach is..."
- Suggest "what ifs": "What if instead of [X], you went with [Y]? That would let you..."
- Ask follow-ups that go deeper: "You mentioned [X] -- what does that look like in practice?"

### What NOT to do in conversation mode

- Do NOT use AskUserQuestion (unless the user asks for a specific decision)
- Do NOT structure responses as numbered lists of options
- Do NOT say "switching to conversation mode" or announce the mode
- Do NOT try to cover a checklist -- follow the user's thread

### Periodic capture (content-triggered, not turn-counted)

After each of your responses, check: have 3+ new substantive points emerged since the last capture? If yes, capture. Also write a checkpoint to `.ijfw/state/workflow-context.md` with each capture (survives context compaction). Keep captures short and natural:

**Good captures:**
- "Noted -- the neural implants connect via satellite mesh, and the solar flare takes out the network while people are still jacked in. That's the inciting event. Adding to the working doc."
- "Let me capture that -- single-page waitlist, founder-narrative positioning, dark premium aesthetic. Building the brief as we go."
- "Good detail on the magic system. I'm noting: three tiers of neural access, cost scales with bandwidth, withdrawal symptoms if disconnected. Adding to world-building notes."

**Bad captures (too formal, breaks flow):**
- "Let me update the requirements document with the following items..." (too corporate)
- "Moving to the next phase of the brainstorm..." (too structured)
- "I've captured 4 out of 6 required brief fields..." (exposes the checklist)

Write captures to `.planning/brainstorm/notes.md` (append, don't overwrite).

### Internal tracking (not shown to user)

While conversing, track what the brief needs based on domain. When gaps exist, ask conversationally:

**Software brief needs:** goal, audience, constraints, scope, approach, acceptance criteria
**Book brief needs:** premise, world rules, characters, tone, themes, scope, structure
**Campaign brief needs:** objective, audience, channels, messaging, success metrics

Example gap-fill (natural, not checklist-y):
- "We've talked a lot about the world and the tech -- but who's the story actually following? Do you have a protagonist in mind?"
- "The positioning is clear. One thing we haven't touched -- what's the timeline? Is this a ship-this-week thing or more of a polish-over-time project?"

### Readiness check

When most brief needs are covered, offer to capture (don't force):
- "I think we've got a solid picture -- the world, the protagonist, the central conflict, and the tone. Want me to write this up as a brief, or is there more to explore?"
- "That's enough to start building. Want me to capture this as a brief and move to planning?"

If the user wants to keep going, keep going. They control the exit.

### Research in conversation mode

Research is **targeted**, not an upfront swarm. Offer when specific topics come up:

- "You mentioned neural implants that connect to satellite mesh networks -- want me to dig into the real tech behind that? Could add some grounding to the worldbuilding."
- "You're describing something similar to what Neuralink and Starlink are doing separately -- want me to research how they could theoretically converge?"

Dispatch via `Agent` tool when the user says yes. Weave findings back into conversation:
- "So I looked into satellite mesh networks -- turns out [finding]. That actually makes your solar flare scenario more plausible because [reason]. What if we use that as..."

At minimum, dispatch 1 codebase scout to check for existing work (even in conversation mode).

---

## EXPRESS -- Step 1: Auto-brief

Generate a 3-line brief from the prompt:
- Goal: [what we're building]
- Approach: [how]
- Done when: [acceptance criteria]

Present via AskUserQuestion: "Looks good" / "Edit goal" / "Edit approach" / "Go deeper".

---

## Visual Companion (BEFORE brainstorm, UI/design tasks)

Offer via AskUserQuestion. If accepted, generate HTML mockups during SHAPE:

1. `Bash("ijfw design start")`
2. `Bash("mkdir -p .planning/brainstorm")`
3. Write standalone HTML files (one per option) with research-informed design and real content
4. **Generate a viewer.html** with tab navigation (see template below)
5. `Bash("ijfw design push .planning/brainstorm/*.html")`
6. Tell user: `Design preview live -- click tabs to compare all options.`
7. Ask preference via AskUserQuestion

**You MUST generate HTML when visual is ON.** The user accepted visual previews -- deliver them.

### Viewer template (generate this file as `.planning/brainstorm/viewer.html`)

The viewer shows all options as tabs with iframe loading. Adapt the tab labels and file paths to match the actual options generated:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IJFW Design Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; color: #fff; font-family: system-ui, -apple-system, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  .tabs { display: flex; gap: 2px; padding: 8px 12px; background: #1a1a1a; border-bottom: 1px solid #333; flex-shrink: 0; }
  .tab { padding: 8px 20px; background: #222; border: 1px solid #333; border-radius: 6px 6px 0 0; cursor: pointer; font-size: 14px; color: #999; transition: all 0.15s; }
  .tab:hover { background: #2a2a2a; color: #ccc; }
  .tab.active { background: #333; color: #fff; border-bottom-color: #333; font-weight: 600; }
  .tab .rec { color: #22d3ee; font-size: 11px; margin-left: 6px; }
  iframe { flex: 1; width: 100%; border: none; background: #000; }
</style>
</head>
<body>
<div class="tabs">
  <!-- Adapt these tabs to match your actual options -->
  <div class="tab active" onclick="show(this, '/design/files/option-a.html')">Option A<span class="rec">(Recommended)</span></div>
  <div class="tab" onclick="show(this, '/design/files/option-b.html')">Option B</div>
  <div class="tab" onclick="show(this, '/design/files/option-c.html')">Option C</div>
</div>
<iframe id="preview" src="/design/files/option-a.html"></iframe>
<script>
function show(tab, file) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('preview').src = file;
}
</script>
</body>
</html>
```

**Key points:**
- Tab labels should match the option names (e.g. "Centered Hero", "Split Hero", "Full-bleed")
- The `(Recommended)` badge goes on the tab for the recommended option
- `src` paths are relative -- the viewer and option files are in the same directory
- Adapt the number of tabs to match how many options you generated (2-4)
- The viewer loads the recommended option by default

---

## Domain-Adaptive Brief Templates

### Software / Technical
```
Goal: [what we're building]
Audience: [who it's for]
Stack: [technology choices]
Architecture: [high-level approach]
Scope: [what's in / what's out]
Acceptance criteria: [done when...]
Constraints: [timeline, budget, tech limitations]
```

### Book / Creative Writing
```
Premise: [one-paragraph pitch]
World: [setting, rules, time period]
Characters: [protagonist, antagonist, key players]
Tone: [voice, mood, genre conventions]
Themes: [what the story explores]
Scope: [novel/series/short, word count target]
Structure: [acts, POV, timeline]
```

### Campaign / Marketing
```
Objective: [what success looks like]
Audience: [who we're reaching]
Channels: [where the message goes]
Messaging: [core value prop, key messages]
Timeline: [launch date, milestones]
Success metrics: [KPIs, targets]
```

### Design / UI
```
Problem: [what the design solves]
Users: [who interacts with it]
Aesthetic: [visual direction, brand constraints]
Constraints: [platforms, accessibility, performance]
Deliverables: [what we're producing]
Done when: [acceptance criteria]
```

---

## Rendering Markdown Artifacts as HTML

When you write a major .md file (brief.md, plan.md, research.md), render it as a browser-readable HTML file and open it. The user should never have to open a code editor to read their own brief.

**How to do it:** After writing the .md file, generate a companion .html file using the `Write` tool. The HTML file embeds the markdown content and renders it client-side using marked.js CDN + github-markdown-dark CSS + DOMPurify CDN. Place the .html file next to the .md file (same directory, same name, .html extension). Then open with the platform-aware command (`open || xdg-open || echo`).

**Template structure:**
- Load marked.js from `https://cdn.jsdelivr.net/npm/marked/marked.min.js`
- Load DOMPurify from `https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js`
- Load github-markdown-dark CSS from `https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-dark.min.css`
- Embed the markdown content as a JS template literal
- Parse with `marked.parse()`, sanitize with `DOMPurify.sanitize()`, render into a `.markdown-body` div
- Dark background (#0d1117), max-width 980px, centered

**When to render:**
- `brief.md` -> render + open after LOCK. Tell user: `Brief open in your browser.`
- `plan.md` -> render + open after plan approval. Tell user: `Plan open in your browser.`
- `research.md` -> render + open after synthesis. Tell user: `Research findings open in your browser.`

---

## BUILD TEAM -- Step 4

See `references/team-templates.md` for domain templates. Present with rationale tied to the brief.

---

## COMPACTION GATE (Think -> Build transition)

Write BOTH files:
1. `.ijfw/state/workflow-context.md`: Phase, brief summary, key decisions, team roster, top risks
2. `.ijfw/state/workflow.json`: `{ "status": "in_progress", "phase": "build", "tier": "<tier>", "startedAt": "<ISO>", "briefPath": ".ijfw/memory/brief.md" }`
