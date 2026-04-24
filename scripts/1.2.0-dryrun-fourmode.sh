#!/usr/bin/env bash
set -euo pipefail
FAIL=0

# Step 7 exists
grep -q "Step 7 -- Plan review modes" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: Step 7 missing in plan-check SKILL.md"; FAIL=1; }

# All four modes named
grep -qE "SCOPE.EXPANSION|SCOPE_EXPANSION" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: mode 'SCOPE EXPANSION/SCOPE_EXPANSION' missing"; FAIL=1; }
for m in "SELECTIVE" "HOLD" "REDUCTION"; do
  grep -q "$m" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: mode '$m' missing"; FAIL=1; }
done

# Default logic references metrics block keys
for key in "budget_overrun" "dep_inversions" "under_specified_pct" "goal_alignment_fail"; do
  grep -q "$key" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: metric key '$key' not in Step 7 default logic"; FAIL=1; }
done

# BLOCK verdict skips Step 7 documented
grep -qE "BLOCK.*(skip|rework)" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: BLOCK verdict skip-Step-7 rule missing"; FAIL=1; }

# Unified ledger path referenced (NOT plan-issues.json)
grep -q "execute-issues\.json" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: unified ledger path missing"; FAIL=1; }
grep -v "Do NOT reference" claude/skills/ijfw-plan-check/SKILL.md | grep -q "plan-issues\.json" && { echo "FAIL: orphan plan-issues.json referenced (should be unified execute-issues.json)"; FAIL=1; }

# kind: plan-review discriminator
grep -q 'kind.*plan-review' claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: kind discriminator for plan-review ISSUEs missing"; FAIL=1; }

# HOLD routing + resume intent
grep -q "plan-hold\.md" claude/skills/ijfw-plan-check/SKILL.md || { echo "FAIL: HOLD state file missing"; FAIL=1; }
grep -qi "resume" claude/commands/ijfw-plan.md || { echo "FAIL: resume intent missing from ijfw-plan.md"; FAIL=1; }

# Command-doc appends
grep -q "four-mode review\|four modes" claude/commands/ijfw-plan.md || { echo "FAIL: ijfw-plan.md description missing four-mode mention"; FAIL=1; }

if [ $FAIL -eq 0 ]; then
  echo "OK: Phase 2 Four-mode plan review structural checks pass"
  exit 0
else
  echo "ISSUE: Phase 2 structural checks failed"
  exit 1
fi
