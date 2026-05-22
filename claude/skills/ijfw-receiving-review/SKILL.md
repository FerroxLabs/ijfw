---
name: ijfw-receiving-review
description: "Reply to code review without blind agreement or performative pushback. Use when you have received feedback, need to address review, respond to review, handle review comments, or PR comments came back. Trigger: received feedback, address review, respond to review, review comments to handle, PR comments came back, /ijfw-receiving-review"
since: "1.5.0"
---

# IJFW Receiving Review -- technical rigor over performance

Paired with `ijfw-review` (reviewer side). This is the implementer side: how to react to findings from `ijfw-review`, `ijfw-cross-audit`, a human PR reviewer, a book editor, a design critic, or any other source -- without two failure modes.

**Failure mode A: blind agreement.** "You're absolutely right!" then implement. The finding was never verified. Half the time the reviewer was wrong, the cited line moved, or the suggested fix breaks an invariant they did not know about. You now own a regression.

**Failure mode B: performative pushback.** "I disagree, this is fine." No technical specifics, no citation, no evidence. Reviewer pushes back harder. You either cave (back to A) or dig in (the regression ships anyway).

The rule: every finding gets ONE of three legitimate replies, and each reply has an evidence bar.

---

## 1. Three legitimate replies to a finding

Pick ONE per finding. Never "I'll think about it" -- that is silent deferral and rots the review thread.

- **Agree-and-fix** -- reproduce the finding, accept it, change the code, link the commit.
- **Disagree-with-reason** -- cite the file, the line, the contract, the test, or the invariant that makes the finding wrong. No vibes.
- **Need-more-info** -- ask ONE specific question. Not "can you explain?" Instead: "you flagged L42 as a null deref -- is the concern the early-return path on L38 or the catch block on L51?"

If you cannot pick one within 60 seconds of reading the finding, you have not understood it yet. Re-read it twice before replying.

---

## 2. Before agreeing -- verify the finding is real

Reproduce it. Open the cited file at the cited line. Run the failing command, the failing test, the failing query. If the bug does not reproduce, that is a Disagree-with-reason -- and a memory entry about the reviewer's hit rate.

A finding you cannot reproduce is a finding you cannot fix. "Agreeing" without reproduction means you will guess at a fix, the guess will be wrong, and the next reviewer round will flag it again.

---

## 3. Before disagreeing -- read the finding twice and look up what you do not know

Reviewers cite domain knowledge, codebase invariants, security contracts, or framework rules you may not have loaded. Before pushing back:

- Read the finding twice. The second read often surfaces what the first missed.
- If the finding cites a contract, file, or rule you do not recognise, look it up. `grep`, `git log -S`, read the linked doc.
- Only then push back -- with technical specifics. Quote the line. Cite the test. Reference the contract.

"I disagree" alone is performative. "I disagree because L88 already handles this branch -- see test_null_email at L201" is technical.

---

## 4. Technical-rigor red flags -- stop, verify, then reply

These reply patterns are the ones that ship regressions. When you catch yourself writing one, stop and verify before sending.

- **"This is fine because the existing code does it too."** Verify the existing code is actually correct first. "Two wrongs" is not a refutation; it is a second bug you just inherited.
- **"I tested it and it works."** Show the test output. If you did not actually run it, run it now and paste the output. "It works on my machine" without evidence is not evidence.
- **"The reviewer is wrong about X."** Quote the specific line, name the specific contract, link the specific test. Vague disagreement is performative pushback.
- **"I'll address this later."** Either do it now or open a tracked issue (GitHub, Linear, ticket id) AND link the tracker in your reply. "Later" with no link is silent deferral.
- **"That is out of scope."** Maybe true -- but if the finding is a BLOCK severity, scope is the wrong axis. Either fix it now or downgrade the PR.

---

## 5. Severity calibration -- match reply rigor to finding severity

From `ijfw-review` severity vocabulary (BLOCK / FLAG / NIT, or in `ijfw-review` shorthand bug / warn / suggest / nice):

- **BLOCK / bug** -- ALWAYS agree-and-fix OR a fully-cited disagree with reproducible evidence. Never defer. Never NIT-batch. Never "out of scope."
- **FLAG / warn** -- agree-and-fix OR explicit defer-with-tracking (issue link required). A FLAG you accept without tracking is one you will forget.
- **NIT / suggest / nice** -- batch-resolve in one commit OR explicit won't-fix-because. Reviewers earn the right to ignore your NITs after you ignore three of theirs without reason; do not burn that bank.

Mis-calibration in either direction is the bug. Treating a BLOCK as a NIT ships regressions; treating a NIT as a BLOCK burns trust and slows the cycle.

---

## 6. When the reviewer is wrong -- push back specifically

Reviewers are wrong sometimes. Cross-audit lenses are wrong sometimes. Even careful human reviewers miss invariants. Pushing back is legitimate -- when you have evidence.

A specific pushback contains: the file, the line, the cited behavior or contract, and the test or invocation that proves it. Example: "L42 is not a null deref -- `validateInput` at L38 throws before L42 can run. See test_null_input_throws at tests/input.test.ts:14."

A non-specific pushback contains: "I disagree." "This is intentional." "That's how it works." These are vibes. Vibes lose review threads.

---

## 7. Memory feedback -- track reviewer patterns

When you Disagree-with-reason on a finding from the same reviewer for the third time on the same kind of issue (same false-positive pattern), record a memory entry:

- Key: `reviewer_pattern_<reviewer-id>`
- Body: "Reviewer X tends to flag <pattern> as <severity>; in this codebase that pattern is correct because <reason>. Future findings from X on <pattern> get a quick verify-then-disagree, not full re-investigation."

This routes into the `ijfw-memory-audit` surface and lets future review rounds weight that reviewer's findings appropriately without dismissing them. Do NOT use this to silence a reviewer wholesale -- only to skip re-investigating a known false-positive pattern.

If a reviewer's hit rate climbs (their flagged issues turn out real on repeat), record the inverse: "Reviewer Y's findings on <pattern> have a >90% true-positive rate; treat as BLOCK on receipt, verify second."

---

## 8. Multi-domain -- the reply discipline travels

The same three-reply structure works wherever feedback arrives.

- **Code review.** File + line + claim + fix.
- **Book editor's notes.** Chapter + paragraph + claim + revision.
- **Campaign copy critique.** Asset + line + claim + rewrite.
- **Design / UI critique.** Component + property + claim + change.
- **Cross-audit consensus from `ijfw-cross-audit`.** Lens + finding-id + claim + remediation.

In every domain: cite the artifact location, restate the claim in your own words, reply with one of the three legitimate replies, and meet the evidence bar for the reply you picked.

---

## Done When

- [ ] Every finding in the review thread has exactly one reply: agree-and-fix, disagree-with-reason, or need-more-info. No silent skips.
- [ ] Every Disagree-with-reason cites file + line + contract or test. No vibes.
- [ ] Every defer has a tracker link (issue, ticket, follow-up PR). No "later."

## See also

- `ijfw-review` -- the reviewer-side counterpart. Together they form one closed feedback loop: `ijfw-review` emits findings, `ijfw-receiving-review` replies with rigor.
- `ijfw-cross-audit` -- multi-lens audit consensus; replies still route through this skill.
- `ijfw-memory-audit` -- where reviewer-pattern memory entries surface.
