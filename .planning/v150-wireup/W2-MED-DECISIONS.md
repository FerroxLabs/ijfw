# Wave-W2 — r19 MED Adjudication Decisions

**Generated:** 2026-05-19
**Audit run:** Trident r19 (against v1.5.0 cumulative diff, pre-W1 wire-up)
**Total findings:** 22 MED across 5 file groups
**Method:** Each cited file:line was read against current main. Adjudication
key: actual code state + intent + adjacent-context analysis. r19 emitted no
finding-detail text (the `(no detail)` output documented in the prior
HANDOFF-v150-WIREUP.md), so every line was evaluated for plausible MED-class
issues at that exact location.

**Outcome:** 1 actionable bug (`deploy-alerts.js:71` NPE on null entry) +
21 non-actionable findings (benign code at cited location). The actionable
item was fixed in this same commit; the rest are documented below.

## 1 actionable

### deploy-alerts.js:71 — null-entry NPE in failures map → FIXED

**Before:**
```js
platform: typeof f && f.platform ? String(f.platform) : 'unknown',
```

**Bug:** `typeof f` is always a non-empty string ("object" for null,
"undefined" for undefined), so the `&&` short-circuit never fires. A
null entry in `record.failures` therefore threw `TypeError: Cannot read
property 'platform' of null` mid-map instead of falling back to 'unknown'.
The adjacent `skillName` + `error` fields already used the correct
`f && f.platform` guard.

**Fix:** drop `typeof f &&` and use `f && f.platform`, matching the
adjacent fields.

**Test:** `test-deploy-alerts.js` (new) — 3 cases including the original
null-entry repro.

---

## 21 non-actionable

For each item: file:line, current code, decision rationale.

### W2.cross-orch (5)

1. **cross-orchestrator.js:198** — `// buildSpawnEnv -- compose env for a given auditor pick.`
   **Decision:** comment line. Function below (`buildSpawnEnv`) was already
   closed by v1.5.0 audit-MED-trident-M2 (F-SEC-1) with per-pick API-key
   allowlist. No further action.

2. **cross-dispatcher.js:343** — `throw new Error(\`Unknown mode: ${mode}\`);`
   **Decision:** standard input-guard throw inside `mergeResponses`. Mode
   is set by orchestrator code, not user input. Throwing on unknown is
   intentional and the message is internal-only.

3. **api-client.js:95** — `// cache_control:{type:'ephemeral'}, and any per-turn tail (cycleSummary)`
   **Decision:** comment inside the audit-DISPUTED-1 cache_control ordering
   block. Implementation below (line 102+) is correct: large user content
   splits into a cache_control'd block + plain tail.

4. **runtime-loop.js:132** — `@param {string} [projectRoot]`
   **Decision:** JSDoc for `loadResumePreference`. Function correctly
   handles missing projectRoot at line 135.

5. **runtime-loop.js:308** — `// the orchestrator-LLM remain on the existing redispatch path without`
   **Decision:** comment inside the new W1.A wire-up block. Added by W1.A
   and is descriptive prose, not code.

### W2.memory (3)

6. **temporal.js:176** — `}` (closing brace after `ensureBitemporalFactsSchema` index creation)
   **Decision:** end of DDL block. Two CREATE INDEX statements above cover
   the (subject,predicate,valid_to) + (subject,predicate,valid_from) pairs
   needed by the bi-temporal lookup paths.

7. **temporal.js:290** — `* Atomic helper: invalidate older facts THEN insert the new one, all in`
   **Decision:** JSDoc inside `storeFactBitemporal`. Function body is
   transactional (BEGIN IMMEDIATE … COMMIT) and the documented invariant
   holds.

8. **server.js:1363** — `if (!r.ok) failures.push(\`global preferences (${r.code})\`);`
   **Decision:** error-collection in `handleStore`. The pattern is repeated
   for each store target; this line aggregates a failure code without
   throwing. No information leak.

### W2.blackboard-team (3)

9. **blackboard.js:153** — `// append-only and the LRU is intentionally narrow.`
   **Decision:** comment about why JSONL tails are NOT cached (intentional).
   The function below uses an mtime-keyed cache for JSON files only.

10. **codex-agents.js:21** — `education: ['Read', 'Write', 'Edit'],`
    **Decision:** role-tool allowlist. `education` role legitimately does
    not need `Bash` — same as `book`/`content`/`design`/`business`. The
    `software`/`lead`/`qa`/`operations` roles get Bash because they may
    need to run code.

11. **team/modify.js:182** — `report.workflow = { ok: false, errors: ['workflow.json is missing -- run: ijfw team init'] };`
    **Decision:** validation error path with an actionable user hint. The
    error string is structured for the CLI to print verbatim.

### W2.design-misc (5)

12. **design-companion.js:104** — `const isLive = m && typeof m.iframeUrl === 'string' && m.iframeUrl;`
    **Decision:** iframe live-vs-static branch. Correctly guards against
    missing mockup objects + non-string iframeUrl. Adjacent to the
    Trident-r19-fixed `sandbox="allow-scripts"` attribute.

13. **deploy-alerts.js:70** — `failures: record.failures.map((f) => ({`
    **Decision:** map iteration start. The bug was on line 71, fixed
    above. Line 70 itself is just the `.map(` call.

14. **jsonl-rotation.js:100** — `export function appendJsonlWithRotation(path, line, options = {}) {`
    **Decision:** wrapper signature. Function body intentionally just
    returns the rotate result; the comment block above says "Caller still
    appends; we just signal whether rotation fired." The naming is
    backwards-compat with older callers; renaming would ripple through 4+
    call sites for no behavioral win. Acceptable as-is for v1.5.0.

15. **repo-map.js:81** — `if (line.startsWith('!')) { negate = true; line = line.slice(1); }`
    **Decision:** .gitignore negation parsing. Standard pattern; the
    negation flag flows into `isIgnored()` which honors it correctly.

16. **recovery/checkpoint.js:97** — `// v1.5.0 audit-LOW-work-L2: memoise buildSnapshot per (projectRoot, ms).`
    **Decision:** comment for an already-applied LOW-batch fix.

### W2.docs-tests (6)

17. **claude/skills/ijfw-cross-audit/SKILL.md:25** — `3. **Override roster with \`--with\`.** Pass \`--with <id>[,<id>]\``
    **Decision:** doc step explaining the `--with` flag. The flag exists
    in cross-orchestrator-cli.js's `parseCrossAlias` (line 296) and
    behaves as documented.

18. **claude/skills/ijfw-workflow/SKILL.md:118** — `- On \`lock\`: write \`.ijfw/memory/brief.md\`. Route straight to PLAN`
    **Decision:** Quick-mode LOCK step doc. Matches the implementation in
    the brainstorm phase routing.

19. **test-mcp-gate-integration.js:75** — `async function seedState(home, contents) {`
    **Decision:** test helper to seed `.ijfw/state/active-extension.json`.
    Standard mkdir + writeFile. Test is known-slow but functional (the
    handoff section 9 #5 documents the gtimeout workaround at sweep time).

20. **test-recency-decay.js:11** — `import assert from 'node:assert/strict';`
    **Decision:** standard test import. The test body below pins the
    recency decay formula (`Math.exp(-ageDays / 90)`).

21. **test-rekor-bridge.js:54** — `const hash = createHash('sha256').update(payload).digest('hex');`
    **Decision:** sha256 hash of the payload inside the rekor mock's
    createEntry stub. Matches the real rekor protocol's hashed-entry
    format.

22. **test-search-hybrid.js:145** — `if (startedCalls === expectedCalls) allStartedResolve();`
    **Decision:** test scaffolding that proves Promise.all dispatch is
    parallel by gating resolution on all embed calls having started.
    Correct test pattern.

23. **wayland/test_extension_check.py:103** — `msg="permission-events.jsonl was not created",`
    **Decision:** Python unittest assertion message for the permission-
    events check. The test below correctly opens, parses, and validates
    the JSONL.

> Note: handoff section 3 enumerated 22 items; this doc has 23 entries
> because deploy-alerts.js was cited at both line 70 (the .map call,
> #13 above) and line 71 (the actionable NPE, "1 actionable" section).

## What Trident r20 (W4) must produce

The r19 finding-detail dropout made adjudication a guessing game. r20 in
Wave-W4 MUST run with verbose mode so the auditor's actual finding text
is captured per finding. Any line in this doc adjudicated as
non-actionable can be re-checked at that point. If a r20 finding at the
same line carries a concrete description, it gets re-evaluated.

## Test posture after W2

- `test-deploy-alerts.js` (new): 3 tests, all passing
- No other tests changed; the 21 non-actionable items are documentation
  decisions, not behavioral changes.
