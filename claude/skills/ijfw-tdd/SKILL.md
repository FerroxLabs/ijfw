---
name: ijfw-tdd
description: "RED-GREEN-REFACTOR enforcement. Use when implementing a feature or bugfix before writing implementation code. Trigger: tdd, test first, red green refactor, /ijfw-tdd"
since: "1.5.0"
---

# IJFW TDD -- RED-GREEN-REFACTOR

Write the test first. Watch it fail for the right reason. Write the minimum code to make it pass. Then improve structure without changing behavior.

**Iron law:** No production code without a failing test first. If you wrote code before the test, delete it. Implement fresh from the test.

This skill enforces three distinct moves. Each move has a green light that you must hit before advancing. Skipping a green light is not "pragmatic" -- it is the bug.

---

## Move 1: RED -- write a test that fails for the RIGHT reason

Write ONE minimal test for ONE behavior. Use a descriptive name. Use real code (no mocks unless unavoidable).

Before running the test, write down the failure message you EXPECT to see. Example: "AssertionError: expected 'Email required', got undefined" or "AttributeError: module has no attribute 'retryOperation'".

Then run it:

```bash
npm test path/to/test.ts   # or pytest, cargo test, go test, etc.
```

Paste the actual failure into your scratch. Compare against what you predicted.

**Green light to advance:** the test FAILS, and the failure message is the one you predicted (an assertion failure on the intended behavior, or a "missing symbol" error if the function does not exist yet).

**Red flags that block advancing:**
- Test passes immediately -- you are testing existing behavior. Rewrite.
- Test errors on a typo, import, or syntax issue -- fix and re-run until it fails meaningfully.
- Failure message surprises you -- you do not yet understand what you are building. Stop and think before writing implementation.

---

## Move 2: GREEN -- write the minimum code to pass

Write the simplest implementation that turns the failing test green. No extra parameters. No "while I am here" cleanup. No anticipating tomorrow's tests. YAGNI.

Run the test. Paste the pass output. Run the full suite -- nothing else may regress.

**Green light to advance:** target test passes, full suite passes, output is pristine (no warnings, no stack-trace noise, no skipped tests you forgot about).

**Red flags that block advancing:**
- You added a feature the test does not cover -- delete it.
- Other tests broke -- fix now, do not defer.
- You changed the test to make it pass -- revert. The test defines the contract; the code is what bends.

---

## Move 3: REFACTOR -- improve structure WITHOUT changing behavior

Now and only now: rename, extract helpers, remove duplication, tighten types, collapse branches. The behavior must stay identical.

Run the FULL test suite after each meaningful change. Not at the end -- after each change. If you cannot remember which change broke green, you waited too long.

**Green light to advance to the next test:** every refactor kept the suite green. No new behavior was added under the cover of "cleanup."

**Red flag:** you find yourself wanting to add a feature mid-refactor. Stop. Commit the refactor. Start a new RED test for the new feature.

---

## Anti-patterns (and WHY each is wrong)

1. **Testing the mock, not the code.** Asserting `screen.getByTestId('sidebar-mock')` proves the mock loaded, not that the component works. The test passes for the wrong reason and gives false confidence.
2. **Tautological assertion.** `expect(result).toBe(result)` or `expect(fn()).toEqual(fn())`. Always green, proves nothing, exists only to push coverage numbers.
3. **Coverage-driven test that asserts nothing.** Calls the function, never checks the return value. The line counter goes up; the bug count does too.
4. **Skipping RED because "I know what it will fail on."** You don't. Half the time the test passes immediately (you tested the wrong thing) or errors on a typo (you tested nothing). Watching it fail is the only proof the test can ever fail.
5. **Test-only methods on production classes.** A `destroy()` that exists "for tests" is production API that real callers will eventually invoke. Put cleanup helpers in test utilities.
6. **Incomplete mocks.** Mocking only the fields your test reads hides the structural contract. Downstream code that consumes other fields fails silently. Mirror the real shape completely or do not mock at all.

---

## Multi-domain examples

TDD is not a software-only discipline. It applies anywhere you have a falsifiable claim about what "done" means.

- **Book continuity** -- writing chapter 7? Before drafting, write the continuity check: "By end of ch7, Maya knows about the letter AND has not yet met Olu." Draft until the check holds. Re-run the check after every revision.
- **Campaign metrics** -- launching a landing page? Before shipping, define the test: "Launch worked = 100 signups in 7 days AND CAC < $12 AND bounce < 60%." Anything else is "I think it went OK," which is a manual ad-hoc test.
- **Design-system contrast** -- before picking a palette, write the test: "Every text/background pair scores WCAG AA (4.5:1) or better, verified by axe-core." Palette choices that fail the test never enter the system.
- **Onboarding copy** -- before writing the welcome email, write the test: "A reader who has never used the product can name the first action to take in under 10 seconds." Read the draft to a non-user and time them.

In every domain, the move is the same: write the falsifiable claim FIRST, watch reality fail to meet it, then build until the check holds.

---

## When stuck

| Problem | Move |
|---------|------|
| Don't know how to test it | Write the wished-for API. Write the assertion. Ask for help. |
| Test feels too complicated | The design is too complicated. Simplify the interface. |
| Must mock everything | Code is too coupled. Use dependency injection. |
| Test setup is huge | Extract helpers. Still huge? The design is wrong. |

## Final rule

Production artifact exists -- a function, a chapter, a metric, a palette -- a test failed for it first. Otherwise: not TDD. Delete and restart.
