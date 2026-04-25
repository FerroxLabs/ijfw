# IJFW Benchmark Harness
## Three-Arm Comparison: Baseline vs Terse vs IJFW

Proves IJFW adds value beyond generic terseness.
Follows caveman's eval methodology with additional test categories.

---

## Three Arms

| Arm | Setup | What It Proves |
|-----|-------|----------------|
| **Baseline** | Default Claude/Codex/Gemini, no instructions | How the agent normally behaves |
| **Terse** | One line: "Answer concisely, no filler, straight to the point" | What generic terseness achieves |
| **IJFW** | Full IJFW plugin active | What the complete system achieves |

IJFW must beat Terse on efficiency AND maintain quality.
If IJFW only matches Terse, the plugin isn't adding value.

---

## Metrics Per Task

| Metric | How to Measure |
|--------|---------------|
| **Output tokens** | API token count or tiktoken estimate |
| **Input tokens** | Total context sent (includes system prompt, skills, history) |
| **Total cost** | Tokens x model pricing |
| **Response latency** | Time from prompt to final response |
| **Task accuracy** | Does the code work? Tests pass? Content correct? |
| **First-attempt success** | Did the user need to correct/retry? |
| **Files re-read** | How many times were files read that were already in context? |
| **Unnecessary changes** | Lines changed outside the task scope |

---

## Test Tasks (14 tasks across 4 categories)

### Category 1: Simple Tasks (should be fast and cheap on all arms)

**T1: Explain a bug**
Prompt: "Why does this React component re-render on every click?"
Provide: 20-line component with inline object prop causing re-render.
Measure: Output tokens, accuracy, unnecessary elaboration.

**T2: Fix a typo**
Prompt: "Fix the typo in this function name"
Provide: File with `fucntion` instead of `function`.
Measure: Output tokens, whether it touches anything else.

**T3: One-line question**
Prompt: "What does the ?? operator do in JavaScript?"
Measure: Output tokens. Baseline will write a paragraph. Terse and IJFW should be 1-2 lines.

### Category 2: Implementation Tasks (where routing and efficiency matter)

**T4: Add a function**
Prompt: "Add a function that validates email addresses using regex"
Measure: Output tokens, code quality, whether it adds tests unprompted.

**T5: Scaffold a component**
Prompt: "Create a React component for a user profile card with name, email, avatar"
Measure: Output tokens, code completeness, unnecessary abstractions.

**T6: Write tests**
Prompt: "Write Jest tests for this authentication middleware"
Provide: 40-line auth middleware.
Measure: Test quality, coverage, output tokens.

**T7: Refactor**
Prompt: "Refactor this function to use async/await instead of callbacks"
Provide: 30-line callback-based function.
Measure: Output tokens, whether it changes ONLY the async pattern or also "improves" other things.

### Category 3: Complex Tasks (where deep thinking and planning matter)

**T8: Architecture question**
Prompt: "Should I use PostgreSQL or MongoDB for a multi-tenant SaaS with complex reporting?"
Measure: Quality of reasoning, whether tradeoffs are presented, output tokens.

**T9: Multi-file debugging**
Prompt: "Users report intermittent 500 errors on the /api/checkout endpoint"
Provide: 3 files (route, service, database) with a race condition.
Measure: Whether it finds the root cause, whether it plans before fixing, file re-reads.

**T10: Security review**
Prompt: "Review this authentication flow for security issues"
Provide: 50-line auth flow with 3 planted vulnerabilities (SQL injection, missing rate limit, token in URL).
Measure: Vulnerabilities found, false positives, output tokens.

### Category 4: Long Session Tasks (where context management matters)

**T11: Multi-step feature**
Prompt: "Add user registration with email verification to this Express app"
Run: 10+ turns of implementation.
Measure: Total session tokens, context growth rate, whether /compact is triggered, quality at turn 10 vs turn 1.

**T12: Codebase exploration**
Prompt: "Explain the architecture of this codebase" (provide 20-file project)
Measure: Files read, tokens consumed for exploration, whether index is used (IJFW only), accuracy.

**T13: Boilerplate generation**
Prompt: "Generate CRUD endpoints for users, posts, and comments"
Measure: Total tokens, whether cheapest model is used (IJFW routing), code quality.

**T14: Content creation (non-code)**
Prompt: "Write a blog post about the benefits of test-driven development, 800 words"
Measure: Output tokens, quality, whether IJFW's terse mode correctly switches to normal verbosity for content.

---

## Running Benchmarks

### Manual (Phase 1)

For each task:
1. Start fresh session (clear context)
2. Run with Baseline: default agent, no instructions
3. Record: output tokens, time, quality score (1-5), notes
4. Start fresh session
5. Run with Terse: "Answer concisely, no filler, straight to the point" as first message
6. Record same metrics
7. Start fresh session with IJFW installed
8. Run with IJFW
9. Record same metrics

### Automated (Phase 3)

```bash
# Using Claude CLI's -p flag for non-interactive mode
# Baseline
claude -p "TASK_PROMPT" --no-plugins 2>&1 | tee results/baseline_T1.txt

# Terse
claude -p "Answer concisely, no filler. TASK_PROMPT" --no-plugins 2>&1 | tee results/terse_T1.txt

# IJFW
claude -p "TASK_PROMPT" --plugin-dir ./claude 2>&1 | tee results/ijfw_T1.txt
```

Token counting: use tiktoken (cl100k_base) on the output, or parse API response headers if available.

### Scoring

Quality score per task (1-5):
- 5: Perfect - correct, complete, no unnecessary content
- 4: Good - correct, minor extras or minor omission
- 3: Adequate - works but verbose or missing edge cases
- 2: Poor - partially correct, significant issues
- 1: Fail - wrong, broken, or wildly off-task

---

## Expected Results

Based on caveman benchmarks and our design:

| Metric | Baseline | Terse | IJFW | IJFW Advantage |
|--------|----------|-------|------|----------------|
| Output tokens (simple) | ~800 | ~200 | ~180 | Matches terse |
| Output tokens (complex) | ~2000 | ~500 | ~450 | Slightly better |
| Total session tokens (long) | ~50K | ~45K | ~30K | 33% less (context discipline) |
| Model routing savings | 0% | 0% | ~40-60% | Unique to IJFW |
| First-attempt success | ~70% | ~70% | ~85% | Quality gates + verification |
| Unnecessary changes | ~3/task | ~2/task | ~0.5/task | Surgical change rules |
| Security findings | ~1/3 | ~1/3 | ~2.5/3 | Architect security checklist |

The key claims to prove:
1. IJFW matches or beats Terse on output efficiency
2. IJFW beats both on total session cost (context + routing)
3. IJFW beats both on quality (first-attempt success, fewer unnecessary changes)
4. IJFW uniquely provides: memory continuity, model routing, security checking

---

## Reporting

After running benchmarks, generate a summary:

```
--- IJFW Benchmark Results -----------
14 tasks | 3 arms | measured on Opus 4.6

Output Efficiency:
  Baseline avg: 1,214 tokens/task
  Terse avg:      294 tokens/task (76% reduction)
  IJFW avg:       261 tokens/task (78% reduction)

Total Session Cost (T11, 10-turn task):
  Baseline: $2.34
  Terse:    $2.10 (10% savings)
  IJFW:     $1.12 (52% savings - routing + context discipline)

Quality (first-attempt success):
  Baseline: 71%
  Terse:    71%
  IJFW:     86%

Security (T10, 3 planted vulnerabilities):
  Baseline: 1 found
  Terse:    1 found
  IJFW:     3 found

Unique IJFW Features:
  [ok] Cross-session memory (not available in baseline or terse)
  [ok] Model routing ($1.22 saved on T11 alone)
  [ok] Session handoff (seamless continuation)
  [ok] Context discipline (33% fewer input tokens over long sessions)
--------------------------------------
```
