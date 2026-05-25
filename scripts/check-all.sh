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
# v1.5.2.1 banned set: unicode minus and multiplication sign ONLY.
#
# Rationale: these are the two glyphs that LOOK identical to ASCII characters
# (`-` and `x`) but are different codepoints (U+2212 MINUS SIGN, U+00D7
# MULTIPLICATION SIGN). They cause real bugs when copy-pasted into code:
# the unicode minus next to a number is not the ASCII minus operator, and
# the unicode multiplication sign in a string can masquerade as letter x.
#
# Dropped vs the original Phase 10+11+12 audit:
#   - em-dash `--`        : proper prose punctuation, 200+ legitimate uses
#   - section sign `s`    : standard technical-writing section reference
#   - box-drawing `=`     : intentional visual section dividers in skill markdown
#   - middle dot `*`      : intentional breadcrumb separator in dashboard HTML titles
#   - check marks `OK`    : intentional UI status indicators in dashboard HTML
#   - heavy check mark    : same
#   - Greek delta `D`     : no legitimate hit pattern observed; would be decorative
#
# Visual UI glyphs render fine in browsers + modern terminals and are
# stylistically distinct from ASCII. The original audit targeted user-visible
# CLI strings, then the TARGETS list drifted broader over time. The narrowed
# set keeps the genuinely-dangerous look-alike check; everything else moved
# into the "intentional UI choice" bucket.
TARGETS=(
  ".planning/wayland-parity"
  "claude/skills" "claude/commands" "claude/hooks/scripts" "claude/rules"
  "codex/.codex-plugin" "codex/.codex" "codex/skills" "codex/.agents"
  "cursor" "copilot"
  "gemini/extensions/ijfw"
  "hermes/plugins/ijfw"
  "installer/src" "installer/README.md" "installer/CHANGELOG.md"
  "mcp-server/src" "mcp-server/bin"
  "scripts"
  "shared/lib" "shared/rules" "shared/skills"
  "universal" "windsurf"
  "wayland/plugins/ijfw"
  "README.md" "CHANGELOG.md" "CLAUDE.md" "PUBLISH-CHECKLIST.md" "NO_TELEMETRY.md" "docs"
)
HITS=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  if matches=$(LC_ALL=C grep -RInE $'\303\227|\342\210\222' "$t" 2>/dev/null); then
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
echo "== JSON validity =="
PATTERNS_JSON="shared/lib/patterns.json"
if [ -e "$PATTERNS_JSON" ]; then
  if ! node -e "JSON.parse(require('fs').readFileSync('$PATTERNS_JSON','utf8'))" 2>/dev/null; then
    fail "$PATTERNS_JSON is not valid JSON"
    exit 1
  fi
  ok "$PATTERNS_JSON is valid JSON"
else
  ok "$PATTERNS_JSON not present -- skipped"
fi

echo
echo "== platform drift =="
node scripts/check-platform-drift.js
ok "platform capabilities match shipped surfaces"

echo
echo "== plugin Python syntax =="
for pydir in "wayland/plugins/ijfw" "hermes/plugins/ijfw"; do
  [ -e "$pydir" ] || continue
  while IFS= read -r -d '' pyfile; do
    if ! python3 -m py_compile "$pyfile" 2>/dev/null; then
      fail "Python syntax error: $pyfile"
      exit 1
    fi
    ok "py_compile: $pyfile"
  done < <(find "$pydir" -name '*.py' -print0)
done
ok "plugin Python syntax clean"

echo
echo "All checks passed."
