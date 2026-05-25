#!/usr/bin/env bash
# check-routing-agents.sh — verify the Sonnet-vs-Opus routing agents are
# shipped in the source repo with the correct frontmatter and SCOPE GATE
# markers intact.
#
# Catches the v1.5.2 regression class: routing-fix files manually present
# on a maintainer's machine but never committed to the source repo, so
# fresh installs ship without them.
#
# Exit code 0 = green. Non-zero = something is broken; the script prints
# what's missing and why it matters.
#
# Usage:
#   bash scripts/check-routing-agents.sh
#
# Wire into preflight: invoke from scripts/e2e-smoke.sh or a CI workflow.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$REPO_ROOT/claude/agents"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "OK: $*"
}

# 1. The three routing agents must exist in source.
for f in builder.md architect.md scout.md ijfw-executor.md; do
  if [ ! -f "$AGENTS_DIR/$f" ]; then
    fail "$AGENTS_DIR/$f missing — fresh installs will not have ijfw:${f%.md}"
  fi
done
ok "all four routing agents present in claude/agents/"

# 2. Frontmatter must declare the correct model tier on each.
check_model() {
  local file="$1"
  local expected="$2"
  local actual
  actual=$(grep -E '^model:' "$AGENTS_DIR/$file" | head -1 | awk '{print $2}' | tr -d '"')
  if [ "$actual" != "$expected" ]; then
    fail "$file expected 'model: $expected', got '$actual' — tier mismatch breaks routing"
  fi
}

check_model builder.md   sonnet
check_model architect.md opus
check_model scout.md     haiku
check_model ijfw-executor.md sonnet
ok "model tiers correct (builder=sonnet, architect=opus, scout=haiku, executor=sonnet)"

# 3. builder.md must carry the SCOPE GATE markers — without them the
# reactive backstop is gone.
if ! grep -q '## SCOPE GATE' "$AGENTS_DIR/builder.md"; then
  fail "builder.md missing '## SCOPE GATE' section — anti-hallucination backstop is gone"
fi
if ! grep -q 'NEEDS_ESCALATION' "$AGENTS_DIR/builder.md"; then
  fail "builder.md missing 'NEEDS_ESCALATION' escalation status — gate cannot escalate"
fi
if ! grep -q 'Pre-report verification gate' "$AGENTS_DIR/builder.md"; then
  fail "builder.md missing pre-report verification gate — hallucination signature can sneak through"
fi
ok "builder.md SCOPE GATE + escalation + verification gate all present"

# 4. architect.md must accept escalations from builder.
if ! grep -q 'Accepts escalations from builder' "$AGENTS_DIR/architect.md"; then
  fail "architect.md missing 'Accepts escalations from builder' clause — escalation chain breaks"
fi
ok "architect.md escalation-accept clause present"

# 5. ijfw-executor.md must NOT contain the bogus MODEL ROUTING section.
# That section claimed to be a defensive layer but is unenforceable from
# inside the executor (no Agent tool in allowed-tools). Reintroducing it
# regresses the v1.5.2.1 cleanup.
if grep -q '## MODEL ROUTING' "$AGENTS_DIR/ijfw-executor.md"; then
  fail "ijfw-executor.md contains '## MODEL ROUTING' section — unenforceable (no Agent in allowed-tools); routing belongs in CLAUDE.md"
fi
ok "ijfw-executor.md does not contain the unenforceable MODEL ROUTING section"

# 6. CLAUDE.md must contain the canonical routing rule.
if ! grep -q 'Subagent Model Routing' "$REPO_ROOT/CLAUDE.md"; then
  fail "CLAUDE.md missing 'Subagent Model Routing' section — the proactive layer is gone"
fi
ok "CLAUDE.md routing policy present"

echo ""
echo "all routing-agent checks passed"
