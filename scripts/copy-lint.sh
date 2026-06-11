#!/usr/bin/env bash
# scripts/copy-lint.sh -- IJFW copy-lint gate (V3-F1).
#
# Enforces two house rules on user-facing copy:
#   1. No "AI" / "artificial intelligence" as standalone words. IJFW positions
#      as smarter, not as another "AI tool". Hit -> FAIL.
#   2. Positive framing. Words like "failed", "error", "broken" in user copy
#      get a WARN (review for Sutherland reframe). Not a FAIL on their own.
#
# Targets: skills, MCP server hot-paths, Wayland plugin entry points,
# dashboard. Files that don't exist yet are skipped silently -- alpha files
# land in waves, the gate stays runnable from day 1.
#
# Exit codes:
#   0 -- clean, or only NEGATIVE warnings
#   1 -- one or more BAD hits (AI / artificial intelligence)
#
# Portable: uses `grep -rE` / `grep -nE`. Works on macOS BSD grep + GNU grep.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

# Concrete file targets. Globs are expanded below; literal paths are checked
# for existence and skipped when absent.
TARGETS=(
  "claude/skills/**/SKILL.md"
  "mcp-server/src/dispatch/colon-syntax.js"
  "mcp-server/src/compute/runner.js"
  "wayland-plugin/__init__.py"
  "wayland-plugin/ijfw_skills.py"
  # M6: hook scripts and platform plugin entry points -- user-visible copy.
  "gemini/extensions/ijfw/hooks/**/*.sh"
  "claude/hooks/scripts/**/*.sh"
  "codex/.codex/hooks/**/*.sh"
  "wayland/plugins/ijfw/**/*.py"
  "hermes/plugins/ijfw/**/*.py"
)

# Case-insensitive. Word boundaries keep "Aim", "fail-fast" etc. clean.
BAD_RE='\b(AI|artificial[[:space:]]+intelligence)\b'
NEGATIVE_RE='\b(failed|error|broken|cannot|unable|impossible)\b'

# Per-line allow marker. Recognised in shell (#), JS/TS (//), HTML (<!-- -->),
# and SQL (--) comments. When the flagged line OR the line immediately above
# carries this marker, the BAD hit is skipped (e.g. code comments documenting
# the rule, third-party proper nouns like "Gemini AI Ultra"). Format:
#   # copy-lint:allow             (shell, python, ruby)
#   // copy-lint:allow            (js, ts, c-style)
#   <!-- copy-lint:allow -->      (html, markdown)
#   -- copy-lint:allow            (sql)
ALLOW_MARK='copy-lint:allow'

BAD_HITS=0
NEG_HITS=0
SCANNED=0
SKIPPED=0

# Expand a target spec into actual files. Supports `**/SKILL.md` style.
expand_target() {
  local spec="$1"
  case "$spec" in
    *'**'*)
      # Pattern like claude/skills/**/SKILL.md -- walk with find.
      local root="${spec%%/\*\**}"
      local leaf="${spec##*/}"
      [ -d "$root" ] || return 0
      find "$root" -type f -name "$leaf" 2>/dev/null
      ;;
    *)
      [ -f "$spec" ] && printf '%s\n' "$spec"
      ;;
  esac
}

# Build full file list.
FILES=()
for spec in "${TARGETS[@]}"; do
  while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
  done < <(expand_target "$spec")
done

# Scan each file.
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { SKIPPED=$((SKIPPED + 1)); continue; }
  SCANNED=$((SCANNED + 1))

  # BAD_RE -- fail. Filter out lines that carry the allow marker on the same
  # line, OR on the immediately preceding line.
  bad_matches=$(grep -niE -- "$BAD_RE" "$f" 2>/dev/null || true)
  if [ -n "$bad_matches" ]; then
    while IFS= read -r line; do
      # Extract the line number prefix from grep -n output (NUM:content).
      lnum="${line%%:*}"
      content="${line#*:}"
      # Skip if the matched line itself carries the allow marker.
      if printf '%s' "$content" | grep -qF "$ALLOW_MARK"; then
        continue
      fi
      # Skip if the immediately preceding line carries the marker.
      if [ "$lnum" -gt 1 ] 2>/dev/null; then
        prev=$(sed -n "$((lnum - 1))p" "$f" 2>/dev/null || true)
        if printf '%s' "$prev" | grep -qF "$ALLOW_MARK"; then
          continue
        fi
      fi
      printf 'BAD  %s:%s\n' "$f" "$line" >&2
      BAD_HITS=$((BAD_HITS + 1))
    done <<< "$bad_matches"
  fi

  # NEGATIVE_RE -- warn only.
  neg_matches=$(grep -niE -- "$NEGATIVE_RE" "$f" 2>/dev/null || true)
  if [ -n "$neg_matches" ]; then
    while IFS= read -r line; do
      printf 'WARN %s:%s\n' "$f" "$line" >&2
      NEG_HITS=$((NEG_HITS + 1))
    done <<< "$neg_matches"
  fi
done

# Aggregate report.
printf '\n'
printf 'copy-lint: scanned %d file(s), skipped %d (alpha files not yet present).\n' \
  "$SCANNED" "$SKIPPED"

if [ "$BAD_HITS" -gt 0 ]; then
  printf 'copy-lint: %d BAD hit(s) -- "AI" / "artificial intelligence" must come out of user copy.\n' \
    "$BAD_HITS" >&2
  if [ "$NEG_HITS" -gt 0 ]; then
    printf 'copy-lint: %d additional negative-framing warning(s) (review for Sutherland reframe).\n' \
      "$NEG_HITS" >&2
  fi
  exit 1
fi

if [ "$NEG_HITS" -gt 0 ]; then
  printf 'copy-lint: %d negative-framing warning(s) -- review for Sutherland reframe (not a FAIL).\n' \
    "$NEG_HITS"
fi

printf 'copy-lint: clean.\n'
exit 0
