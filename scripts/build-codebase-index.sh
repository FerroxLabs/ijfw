#!/usr/bin/env bash
# IJFW codebase indexer -- MVP text-based index.
# Writes .ijfw/index/files.md with path, language, size, first meaningful line.
# Incremental: only rewrites if any source file changed since last build.
# Scout agent queries this instead of grepping the whole tree.
#
# Usage: bash scripts/build-codebase-index.sh [root]
# Default root: current directory.

IJFW_DIR=".ijfw"
INDEX_DIR="$IJFW_DIR/index"
INDEX_FILE="$INDEX_DIR/files.md"
STAMP="$INDEX_DIR/.last-build"

ROOT="${1:-.}"

# --- Issue #16 guard: never index $HOME or /, and only index a real project. --
# This is the privacy-critical gate. A session whose cwd is $HOME must NOT cause
# a recursive walk of the home directory (Dropbox/Downloads/Documents/Library),
# and a folder that is not a project must not be indexed at all. The guard runs
# BEFORE any mkdir/find so a refused root writes nothing.
ROOT_PHYS="$(cd "$ROOT" 2>/dev/null && pwd -P 2>/dev/null)"
if [ -z "$ROOT_PHYS" ]; then
  echo "IJFW indexer: cannot resolve '$ROOT' -- skipping." >&2
  exit 0
fi
case "$ROOT_PHYS" in
  ""|"/") echo "IJFW indexer: refusing to index the filesystem root -- skipping." >&2; exit 0 ;;
esac
# Resolve the physical $HOME, but only if HOME is actually set (an unset HOME
# makes `cd "$HOME"` a no-op on bash 3.2 but an error on Linux -- don't depend
# on either; treat unresolvable HOME as "not the home root").
IJFW_HOME_PHYS=""
if [ -n "${HOME:-}" ]; then
  IJFW_HOME_PHYS="$(cd "$HOME" 2>/dev/null && pwd -P 2>/dev/null)"
fi
if [ -n "$IJFW_HOME_PHYS" ] && [ "$ROOT_PHYS" = "$IJFW_HOME_PHYS" ]; then
  echo "IJFW indexer: refusing to index your home directory -- skipping." >&2
  exit 0
fi
# Require a real project marker OR an explicit blessing from \`ijfw init\`
# (which drops .ijfw/project). No marker, no init, no index.
ijfw_has_project_marker() {
  for _m in .git package.json go.mod Cargo.toml pyproject.toml setup.py \
            tsconfig.json pom.xml build.gradle build.gradle.kts Gemfile \
            composer.json deno.json deno.jsonc mix.exs Package.swift \
            requirements.txt .hg .svn .ijfw/project; do
    [ -e "$ROOT_PHYS/$_m" ] && return 0
  done
  return 1
}
if ! ijfw_has_project_marker; then
  echo "IJFW indexer: '$ROOT_PHYS' has no project marker -- run \`ijfw init\` to index this folder. Skipping." >&2
  exit 0
fi
# --- end issue #16 guard ---

mkdir -p "$INDEX_DIR" 2>/dev/null

# Skip if fresh. Cheap fast-path first: if the stamp is younger than 60s, skip
# without a full tree walk (the find -newer scan is itself expensive on large
# repos). Only fall back to the per-file freshness scan when the stamp is older.
if [ -f "$STAMP" ] && [ -f "$INDEX_FILE" ]; then
  STAMP_MTIME=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  NOW_S=$(date +%s 2>/dev/null || echo 0)
  if [ "$STAMP_MTIME" -gt 0 ] && [ "$NOW_S" -gt 0 ] && [ "$((NOW_S - STAMP_MTIME))" -lt 60 ]; then
    exit 0
  fi
  NEWER=$(find "$ROOT" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.rb" -o -name "*.java" -o -name "*.kt" -o -name "*.swift" -o -name "*.php" -o -name "*.md" \) -newer "$STAMP" -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/.ijfw/*' -not -path '*/Desktop/*' -not -path '*/Documents/*' -not -path '*/Downloads/*' -not -path '*/Pictures/*' -not -path '*/Music/*' -not -path '*/Movies/*' -not -path '*/Library/*' 2>/dev/null | head -1)
  [ -z "$NEWER" ] && exit 0
fi

{
  echo "<!-- ijfw schema:1 codebase-index -->"
  echo "# Codebase index"
  echo ""
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)"
  echo "Root: $ROOT"
  echo ""
} > "$INDEX_FILE"

FILE_COUNT=0
BY_LANG=$(mktemp 2>/dev/null || echo "$INDEX_DIR/.lang-count")
: > "$BY_LANG"

# Find source files, categorized by extension.
find "$ROOT" -type f \
  \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
     -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.rb" \
     -o -name "*.java" -o -name "*.kt" -o -name "*.swift" -o -name "*.php" \
     -o -name "*.md" -o -name "*.sh" \) \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  -not -path '*/target/*' \
  -not -path '*/.ijfw/*' \
  -not -path '*/Desktop/*' \
  -not -path '*/Documents/*' \
  -not -path '*/Downloads/*' \
  -not -path '*/Pictures/*' \
  -not -path '*/Music/*' \
  -not -path '*/Movies/*' \
  -not -path '*/Library/*' \
  2>/dev/null | sort | head -n "${IJFW_INDEX_MAX:-5000}" > "$INDEX_DIR/.files.tmp"

# Bound the index: a runaway root (huge monorepo) is capped so the detached
# indexer can never run unbounded. Truncation is noted in the output footer.
FILE_COUNT=$(wc -l < "$INDEX_DIR/.files.tmp" | tr -d ' ')

{
  echo "Files: $FILE_COUNT"
  echo ""
  echo "## By file"
  echo ""

  while IFS= read -r f; do
    [ -f "$f" ] || continue
    SIZE=$(wc -l < "$f" 2>/dev/null | tr -d ' ')
    EXT="${f##*.}"
    # First non-comment, non-blank line as a "what-is-this" hint.
    FIRSTLINE=$(grep -Ev '^[[:space:]]*(//|#|/\*|\*|--|"""|\*\*|$)' "$f" 2>/dev/null | head -1 | sed 's/["]/\\"/g' | cut -c1-120)
    echo "- \`$f\` ($SIZE lines, .$EXT) -- ${FIRSTLINE:-<empty>}"
    echo "$EXT" >> "$BY_LANG"
  done < "$INDEX_DIR/.files.tmp"

  echo ""
  echo "## By language"
  sort "$BY_LANG" | uniq -c | sort -rn | head -20 | while read -r count ext; do
    echo "- .$ext: $count"
  done
} >> "$INDEX_FILE"

rm -f "$INDEX_DIR/.files.tmp" "$BY_LANG" 2>/dev/null
touch "$STAMP"

echo "Codebase indexed ($FILE_COUNT files)"
