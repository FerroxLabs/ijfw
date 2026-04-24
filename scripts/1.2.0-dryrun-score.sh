#!/usr/bin/env bash
set -euo pipefail

run_checks() {
  local FAIL=0

  # Core skill references the rule
  grep -q "AskUserQuestion" claude/skills/ijfw-core/SKILL.md || { echo "FAIL: core SKILL.md missing score rule reference"; FAIL=1; }

  # Workflow INVARIANTS carries the reminder
  grep -q "AskUserQuestion scoring\|score rule\|differ by degree\|differ by kind" claude/skills/ijfw-workflow/SKILL.md || { echo "FAIL: workflow INVARIANTS missing score-rule reminder"; FAIL=1; }

  # think-phase.md has both scored + unscored worked examples
  grep -q "Coverage:" claude/skills/ijfw-workflow/references/think-phase.md || { echo "FAIL: think-phase.md missing scored example"; FAIL=1; }
  grep -q "Severity:" claude/skills/ijfw-workflow/references/think-phase.md || { echo "FAIL: think-phase.md missing severity example"; FAIL=1; }

  # build-phase.md acknowledges plan-review modes are unscored
  grep -q "differ by KIND\|never score\|no score" claude/skills/ijfw-workflow/references/build-phase.md || { echo "FAIL: build-phase.md missing kind-not-scored note"; FAIL=1; }

  # score-examples.md exists with 3 scored + 3 unscored + counter-example
  test -f claude/skills/ijfw-workflow/references/score-examples.md || { echo "FAIL: score-examples.md not created"; FAIL=1; }
  if [ -f claude/skills/ijfw-workflow/references/score-examples.md ]; then
    SCORED_COUNT=$(grep -cE '\[Coverage:|\[Risk:|\[Severity:|\[Time:' claude/skills/ijfw-workflow/references/score-examples.md || true)
    if [ "$SCORED_COUNT" -lt 3 ]; then echo "FAIL: score-examples.md needs >=3 scored examples (found $SCORED_COUNT)"; FAIL=1; fi
    grep -q -i "deceptive" claude/skills/ijfw-workflow/references/score-examples.md || { echo "FAIL: score-examples.md missing 'Deceptive degree' counter-example"; FAIL=1; }
  fi

  if [ $FAIL -eq 0 ]; then
    echo "OK: Phase 3 Completeness score structural checks pass"
    return 0
  else
    echo "ISSUE: Phase 3 structural checks failed"
    return 1
  fi
}

# 3x run for non-determinism receipt (per 3.4 round-3 note)
OVERALL=0
for i in 1 2 3; do
  echo "--- run $i ---"
  run_checks || OVERALL=1
done

exit $OVERALL
