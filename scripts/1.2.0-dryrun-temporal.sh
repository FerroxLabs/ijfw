#!/usr/bin/env bash
set -euo pipefail
FAIL=0

# Assert Step S5.0 exists in Deep-mode section
grep -q "S5\.0 Temporal Interrogation" claude/skills/ijfw-workflow/SKILL.md || { echo "FAIL: Step S5.0 not in workflow SKILL.md"; FAIL=1; }

# Assert all 4 buckets mentioned
for b in "HOUR 1" "HOUR 2-3" "HOUR 4-5" "HOUR 6+"; do
  grep -q "$b" claude/skills/ijfw-workflow/SKILL.md || { echo "FAIL: bucket '$b' missing"; FAIL=1; }
done

# Assert the ceilings table exists
grep -q "Max tasks" claude/skills/ijfw-workflow/SKILL.md || { echo "FAIL: ceilings table missing"; FAIL=1; }

# Assert NO auto-default / no "(Recommended)" tag applied to an option in the temporal block
# Exclude the explanatory "No '(Recommended)' tag" prose line itself
grep -A 30 "S5\.0 Temporal" claude/skills/ijfw-workflow/SKILL.md | grep "(Recommended)" | grep -qv "^No " && { echo "FAIL: auto-default / (Recommended) tag present -- must be a fact question"; FAIL=1; } || true

# Assert tier gate documented
grep -q "tier.*deep\|Deep mode only" claude/skills/ijfw-workflow/SKILL.md || { echo "FAIL: Deep-mode tier gate missing"; FAIL=1; }

# Assert command doc updated
grep -q "time-budget" claude/commands/ijfw-plan.md || { echo "FAIL: ijfw-plan.md command doc not updated"; FAIL=1; }

if [ $FAIL -eq 0 ]; then
  echo "OK: Phase 1 Temporal Interrogation structural checks pass"
  exit 0
else
  echo "ISSUE: Phase 1 structural checks failed"
  exit 1
fi
