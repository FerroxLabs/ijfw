#!/usr/bin/env bash
# IJFW positive-framing CI guard.
# Greps user-facing surfaces (hooks + commands + skill descriptions) for
# negative-framed phrases that violate the Sutherland reframe rule.
# Exits non-zero on any violation, listing offending file:line.
#
# Run: bash scripts/check-positive-framing.sh
# Add to CI: any new contributor that adds a "Warning:" or "Failed to" string
# to a user-facing surface fails the build.
#
# This is the executable enforcement of P22 -- Standards Encoded.

set -u
cd "$(dirname "$0")/.." || exit 1

# Phrases that are NEVER acceptable in user-facing output. The agent/skill
# files contain INSTRUCTIONS that may legitimately discuss errors -- those are
# audited separately. Hooks and slash-command output go DIRECTLY to the user.
NEGATIVE_PATTERNS=(
  '\bWarning:'
  '\bError:'
  '\bFailed to '
  '\bnot found\b'
  '[Ww]arning' # broader sweep
  'No structured handoff'
  '[Mm]issing[: ]'
)

# Files that ARE user-facing output (echoes/printf going to stdout/stderr that
# Claude Code surfaces). Skill bodies and agent prompts are excluded -- they
# are LLM instructions, not user output.
SCAN=(
  claude/hooks/scripts/session-start.sh
  claude/hooks/scripts/session-end.sh
  claude/hooks/scripts/pre-compact.sh
  claude/hooks/scripts/pre-tool-use.sh
  mcp-server/src/prompt-check.js
  core/benchmarks/run.js
  core/benchmarks/report.js
  installer/src/install.js
  installer/src/uninstall.js
  installer/src/marketplace.js
)

# Emit-statement matcher: bash echo/printf/cat and JS console.*/process.stdout
EMIT_RE='^[[:space:]]*(echo|printf|cat|console\.(log|error|warn|info)|process\.stdout\.write|process\.stderr\.write)'

VIOLATIONS=0

# Collect claude/commands/*.md into a separate glob-expanded list so the
# fixed SCAN array stays tidy and new command files are auto-included.
COMMAND_FILES=()
for f in claude/commands/*.md; do
  [ -f "$f" ] && COMMAND_FILES+=("$f")
done

ALL_SCAN=("${SCAN[@]}" "${COMMAND_FILES[@]}")

for file in "${ALL_SCAN[@]}"; do
  [ -f "$file" ] || continue
  # Only scan lines that emit output (echo/printf/cat <<).
  # Use awk to extract those lines with line numbers, then grep against patterns.
  while IFS= read -r line; do
    LINENUM="${line%%:*}"
    CONTENT="${line#*:}"
    for pat in "${NEGATIVE_PATTERNS[@]}"; do
      if printf '%s' "$CONTENT" | grep -Eq -- "$pat"; then
        # Allow comments -- only flag actual emit statements.
        case "$CONTENT" in
          *'#'*[[:space:]]*"$pat"*) ;;
          *)
            printf '  %s:%s  %s\n' "$file" "$LINENUM" "$CONTENT" >&2
            VIOLATIONS=$((VIOLATIONS + 1))
            ;;
        esac
      fi
    done
  done < <(grep -nE "$EMIT_RE" "$file" 2>/dev/null)
done

if [ $VIOLATIONS -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $VIOLATIONS positive-framing violation(s) in user-facing output." >&2
  echo "User-facing surfaces must show value delivered, not problems found." >&2
  echo "(See CLAUDE.md and feedback_positive_framing_sacred memory.)" >&2
  exit 1
fi

# ----------------------------------------------------------------------------
# Brand-rule scan for shippable copy (CHANGELOG, README, release-notes drafts).
# These surfaces go to npm tarballs / GitHub release pages / the user's terminal
# via `ijfw update --changelog`. The rule per feedback_positive_framing_in_release_surfaces:
# never lead with what was broken; lead with what works now.
# ----------------------------------------------------------------------------
COPY_SCAN=(CHANGELOG.md installer/CHANGELOG.md README.md)
# Add any draft release notes parked under .planning/.
while IFS= read -r f; do COPY_SCAN+=("$f"); done < <(find .planning -maxdepth 3 -name "*release-notes*.md" 2>/dev/null)

# Word-boundaries around the brand-banned vocabulary. These words signal
# backward-frame writing in release copy. Allow them inside fenced code blocks
# (those are technical citations, not copy).
COPY_BANNED='\b(bug|bugs|broken|fixed a |the fix |regression|crashed?|burned through|leak|leaked)\b'
COPY_VIOLATIONS=0
for cf in "${COPY_SCAN[@]}"; do
  [ -f "$cf" ] || continue
  # Strip fenced ```...``` blocks before the scan so technical citations pass.
  matches=$(LC_ALL=C awk '/^```/{f=!f; next} !f{print NR ":" $0}' "$cf" \
    | grep -inE -- "$COPY_BANNED" 2>/dev/null) || true
  if [ -n "$matches" ]; then
    while IFS= read -r m; do
      printf '  %s:%s\n' "$cf" "$m" >&2
      COPY_VIOLATIONS=$((COPY_VIOLATIONS + 1))
    done <<< "$matches"
  fi
done
if [ $COPY_VIOLATIONS -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $COPY_VIOLATIONS brand-banned word(s) in shippable copy." >&2
  echo "Release surfaces describe what works now, not what was wrong before." >&2
  echo "Replace with: improved, optimized, enhanced, now does X, X now does Y." >&2
  exit 1
fi

echo "OK: positive-framing clean across $(echo "${ALL_SCAN[@]}" | wc -w | tr -d ' ') user-facing files + $(echo "${COPY_SCAN[@]}" | wc -w | tr -d ' ') copy surfaces."
exit 0
