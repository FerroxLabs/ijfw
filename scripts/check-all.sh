#!/usr/bin/env bash
# check-all.sh -- single gate for IJFW CI + publish-day health.
#
# Runs: banned-char lint, mcp-server unit suite, installer syntax check.
# Exits 0 only when every check passes. Fail-fast.

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  [ok] %s\n" "$1"; }
fail() { printf "  [fail] %s\n" "$1" >&2; }

echo "== banned-char lint =="
# Banned set: section sign, box-drawing heavy horizontal, em-dash, Greek delta,
# multiplication sign, unicode minus, check marks, middle dot. Covers the same
# surfaces Phase 10+11+12 audited.
TARGETS=(
  "claude/skills" "claude/commands" "claude/hooks/scripts" "claude/rules"
  "mcp-server/src" "mcp-server/bin" "installer/src" "installer/README.md" "installer/CHANGELOG.md"
  "scripts" "codex/.codex-plugin" "codex/.codex" "codex/skills" "codex/.agents"
  "gemini/extensions/ijfw" "cursor" "windsurf" "copilot" "universal" "shared/skills"
  "README.md" "CHANGELOG.md" "CLAUDE.md" "PUBLISH-CHECKLIST.md" "NO_TELEMETRY.md" "docs"
)
HITS=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  if matches=$(LC_ALL=C grep -RInE $'\302\247|\342\224\201|\342\200\224|\316\224|\303\227|\342\210\222|\342\234\223|\342\234\224|\302\267' "$t" 2>/dev/null); then
    if [ -n "$matches" ]; then
      echo "$matches" >&2
      HITS=$((HITS + 1))
    fi
  fi
done
if [ "$HITS" -gt 0 ]; then
  fail "banned-char lint found $HITS offending file(s)"
  exit 1
fi
ok "banned-char lint clean"

echo
echo "== mcp-server unit tests =="
if ! command -v node >/dev/null 2>&1; then
  fail "node not on PATH"
  exit 1
fi
(cd mcp-server && node --test 2>&1 | tail -8)
ok "mcp-server suite passed"

echo
echo "== installer syntax check =="
bash -n scripts/install.sh && ok "scripts/install.sh parses"
# install.ps1 is validated by Windows CI; ASCII-only check is the unix guard.
if LC_ALL=C grep -q '[^ -~	]' installer/src/install.ps1; then
  fail "installer/src/install.ps1 contains non-ASCII"
  exit 1
fi
ok "installer/src/install.ps1 ASCII-clean"

echo
echo "== ijfw-design skill tests =="
node --test shared/skills/ijfw-design/tests/test-search.js 2>&1 | tail -6
ok "ijfw-design search suite passed"
node --test shared/skills/ijfw-design/tests/test-reasoning.js 2>&1 | tail -6
ok "ijfw-design reasoning suite passed"
node --test shared/skills/ijfw-design/tests/test-mockup-generator.js 2>&1 | tail -6
ok "ijfw-design mockup-generator suite passed"
bash shared/skills/ijfw-design/tests/test-design-pass.sh 2>&1 | tail -2
ok "ijfw-design design-pass.sh suite passed"
bash shared/skills/ijfw-design/tests/test-dispatch.sh 2>&1 | tail -2
ok "ijfw-design dispatch.sh suite passed"

echo
echo "All checks passed."
