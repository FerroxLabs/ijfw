#!/usr/bin/env bash
# scripts/lint/check-skill-descriptions.sh
#
# CSO (Claude Skill Onboarding) description discipline.
#
# Superpowers' empirical testing showed that workflow-summary descriptions
# cause Claude to "follow the description shortcut" and skip the skill body.
# Descriptions should be PURE "Use when..." triggers -- not workflow summaries,
# mode descriptions, or step listings.
#
# Per-file checks on frontmatter `description:` value:
#   FAIL  -- matches workflow-keyword regex (steps, phases, modes, workflow,
#            stage, process, sub-skill, skill-name)
#   FAIL  -- length > 1024 chars
#   WARN  -- does not contain a "when" trigger (doesn't start with "Use when"
#            or contain "when" / "Trigger:")
#   PASS  -- otherwise
#
# Exit codes:
#   0 -- no FAILs (WARNs allowed)
#   1 -- one or more FAILs

set -euo pipefail

cd "$(dirname "$0")/../.." || exit 1

# Color codes (only emit if stdout is a TTY).
if [[ -t 1 ]]; then
  RED=$'\033[31m'
  YELLOW=$'\033[33m'
  GREEN=$'\033[32m'
  RESET=$'\033[0m'
else
  RED=""; YELLOW=""; GREEN=""; RESET=""
fi

# Forbidden workflow-summary keywords. Match as whole words, case-insensitive.
# These signal "the description is summarising the skill body" rather than
# triggering load.
FORBIDDEN_REGEX='\b(steps?|phases?|modes?|workflow|stage|process|sub-skill|skill-name)\b'

# Platforms with skill directories. We lint every present platform; missing
# platforms are skipped silently (some are alpha and land in later waves).
PLATFORM_GLOBS=(
  "claude/skills/ijfw-*/SKILL.md"
  "codex/skills/ijfw-*/SKILL.md"
  "gemini/extensions/ijfw/skills/ijfw-*/SKILL.md"
  "hermes/skills/ijfw-*/SKILL.md"
  "wayland/skills/ijfw-*/SKILL.md"
)

# Gather all candidate files. Shell globbing tolerates missing dirs because
# we expand inside `compgen -G` which returns empty on no-match.
FILES=()
for glob in "${PLATFORM_GLOBS[@]}"; do
  while IFS= read -r f; do
    [[ -n "$f" ]] && FILES+=("$f")
  done < <(compgen -G "$glob" || true)
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "${YELLOW}WARN${RESET} no IJFW skill files found -- nothing to lint"
  exit 0
fi

fail_count=0
warn_count=0
pass_count=0
total=${#FILES[@]}

# Extract the value of the YAML `description:` field from the frontmatter.
# Strips quotes (single or double) and trailing whitespace.
extract_description() {
  local file="$1"
  # Read the frontmatter (lines between the first two `---` markers) and
  # pull out the description field. Multiline descriptions are flattened.
  awk '
    /^---[[:space:]]*$/ {
      fm++
      if (fm == 2) exit
      next
    }
    fm == 1 {
      if (/^description:[[:space:]]*/) {
        sub(/^description:[[:space:]]*/, "")
        in_desc = 1
        printf "%s", $0
        next
      }
      if (in_desc) {
        # YAML continuation: next line starts with whitespace and is not a new key.
        if (/^[[:space:]]+/ && !/^[a-zA-Z_-]+:/) {
          sub(/^[[:space:]]+/, " ")
          printf "%s", $0
          next
        }
        in_desc = 0
      }
    }
  ' "$file" | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' | sed -E 's/[[:space:]]+$//'
}

for file in "${FILES[@]}"; do
  desc=$(extract_description "$file")

  if [[ -z "$desc" ]]; then
    echo "${RED}FAIL${RESET}  $file  -- missing or empty description"
    fail_count=$((fail_count + 1))
    continue
  fi

  status="PASS"
  reasons=()

  # Length check (1024 chars max).
  if [[ ${#desc} -gt 1024 ]]; then
    status="FAIL"
    reasons+=("length ${#desc} > 1024")
  fi

  # Workflow-keyword check (case-insensitive whole-word).
  if echo "$desc" | grep -qiE "$FORBIDDEN_REGEX"; then
    matched=$(echo "$desc" | grep -oiE "$FORBIDDEN_REGEX" | sort -u | head -3 | tr '\n' ',' | sed 's/,$//')
    status="FAIL"
    reasons+=("workflow-summary keyword(s): $matched")
  fi

  # Trigger-shape check. Must contain "Use when", "when", or "Trigger:".
  # Case-insensitive. If absent, WARN (don't fail) -- some legacy skills
  # use "Auto-fired" / "Always active" which are valid trigger surfaces.
  if [[ "$status" == "PASS" ]]; then
    if ! echo "$desc" | grep -qiE '(\buse when\b|\bwhen \b|\btrigger:)'; then
      status="WARN"
      reasons+=("no 'Use when' / 'Trigger:' shape -- consider rewriting as 'Use when X'")
    fi
  fi

  case "$status" in
    PASS)
      pass_count=$((pass_count + 1))
      echo "${GREEN}PASS${RESET}  $file"
      ;;
    WARN)
      warn_count=$((warn_count + 1))
      echo "${YELLOW}WARN${RESET}  $file  -- ${reasons[*]}"
      ;;
    FAIL)
      fail_count=$((fail_count + 1))
      echo "${RED}FAIL${RESET}  $file  -- ${reasons[*]}"
      ;;
  esac
done

echo ""
echo "----"
echo "Total: $total  ${GREEN}PASS${RESET}: $pass_count  ${YELLOW}WARN${RESET}: $warn_count  ${RED}FAIL${RESET}: $fail_count"

if [[ $fail_count -gt 0 ]]; then
  echo ""
  echo "${RED}CSO description discipline check FAILED.${RESET}"
  echo "Descriptions should be pure 'Use when X' triggers, not workflow summaries."
  echo "See scripts/lint/check-skill-descriptions.sh header for rules."
  exit 1
fi

exit 0
