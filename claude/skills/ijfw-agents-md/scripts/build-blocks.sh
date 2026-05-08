#!/usr/bin/env bash
# build-blocks.sh -- shared builder for AGENTS.md MEMORY + AGENTS blocks
# (P2-M1 -- single point of maintenance across all 5 platform hooks).
#
# Args:
#   $1  project root (the dir containing .ijfw/)
#   $2  output mode: "stdout" (default) or "files:<dir>"
#
# Output for stdout mode (two stanzas separated by ---NEXT-BLOCK--- on its
# own line; trailing newline on each stanza preserved as the legacy hooks did):
#   <MEMORY block content (may be multi-line)>
#   ---NEXT-BLOCK---
#   <AGENTS block content (may have trailing blank line)>
#
# Output for files:<dir> mode: writes <dir>/memory.txt + <dir>/agents.txt
# (trailing-newline preserving) and prints the two paths to stdout, one per
# line. Hooks that need byte-identity with the legacy multi-pair invocation
# should use this mode.
#
# Behaviour:
#   - MEMORY: pointer line + first 2 non-empty / non-comment lines of
#     <project>/.ijfw/memory/handoff.md when present (handoff sniff).
#   - AGENTS: bullet list of <project>/.ijfw/agents/*.md, with description:
#     line if present. Falls back to "No project agents yet..." line.
#
# ASCII only. No emojis.

set -euo pipefail
export LC_ALL=C

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '[ijfw-agents-md] usage: build-blocks.sh <project-root> [stdout|files:<dir>]\n' >&2
  exit 2
fi

PROJECT_ROOT="$1"
MODE="${2:-stdout}"

# --- MEMORY block ---
MEMORY_BLOCK="Project memory at .ijfw/memory/. Call \`ijfw_memory_prelude\` for full context."
HANDOFF="$PROJECT_ROOT/.ijfw/memory/handoff.md"
if [ -s "$HANDOFF" ]; then
  _LH="$(grep -v '^<!-- ijfw' "$HANDOFF" 2>/dev/null | grep -v '^$' | head -2 || true)"
  if [ -n "$_LH" ]; then
    MEMORY_BLOCK="$MEMORY_BLOCK"$'\n\n'"Last handoff: $_LH"
  fi
fi

# --- AGENTS block --- (preserve trailing newline shape of legacy _AGENTS_LIST)
AGENTS_BLOCK=""
AGENTS_DIR="$PROJECT_ROOT/.ijfw/agents"
if [ -d "$AGENTS_DIR" ]; then
  for _af in "$AGENTS_DIR"/*.md; do
    [ -f "$_af" ] || continue
    _name="$(basename "$_af" .md)"
    _desc="$(grep -m1 '^description:' "$_af" 2>/dev/null | sed 's/^description:[[:space:]]*//' || true)"
    if [ -n "$_desc" ]; then
      AGENTS_BLOCK="$AGENTS_BLOCK- **$_name** -- $_desc"$'\n'
    else
      AGENTS_BLOCK="$AGENTS_BLOCK- **$_name**"$'\n'
    fi
  done
fi
[ -z "$AGENTS_BLOCK" ] && AGENTS_BLOCK="No project agents yet. Run \`ijfw team\` to set them up."

case "$MODE" in
  stdout)
    # Two stanzas, separated by sentinel. Use printf %s (no auto-newline) so
    # trailing-newline shape of each block is preserved literally.
    printf '%s' "$MEMORY_BLOCK"
    printf '\n---NEXT-BLOCK---\n'
    printf '%s' "$AGENTS_BLOCK"
    ;;
  files:*)
    OUT_DIR="${MODE#files:}"
    mkdir -p "$OUT_DIR" 2>/dev/null || true
    # %s preserves trailing newline-or-no-newline shape exactly.
    printf '%s' "$MEMORY_BLOCK" > "$OUT_DIR/memory.txt"
    printf '%s' "$AGENTS_BLOCK" > "$OUT_DIR/agents.txt"
    printf '%s\n%s\n' "$OUT_DIR/memory.txt" "$OUT_DIR/agents.txt"
    ;;
  *)
    printf '[ijfw-agents-md] build-blocks.sh: unknown mode %s\n' "$MODE" >&2
    exit 2
    ;;
esac

exit 0
