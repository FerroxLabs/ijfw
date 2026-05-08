#!/usr/bin/env bash
# hoist-frontmatter.sh -- A1 hoists project-type detection (A3) into AGENTS.md
# YAML frontmatter (P2-B2).
#
# Args:
#   $1  target AGENTS.md path
#
# Reads <project-root>/.ijfw/project.type (A3 output, JSON shape):
#   {
#     "type": "software",
#     "primary_type": "software",
#     "secondary_types": ["content"],
#     "confidence": 0.85,
#     "detected_at": "2026-05-08T11:00:00Z",
#     "signals": ["package_json_present", ...]
#   }
#
# Behaviour:
#   - Silent skip if .ijfw/project.type is absent (degrades gracefully until
#     A3 lands in Phase 3).
#   - Updates the YAML frontmatter region of AGENTS.md (between top `---` /
#     `---` delimiters), splicing in `type`, `primary_type`, `secondary_types`,
#     `confidence`, `detected_at`, `signals` while preserving `ijfw_version` /
#     `ijfw_schema` and any other user-authored fields.
#   - Idempotent -- running twice with the same project.type produces no diff.
#   - Atomic write: tmp file then rename. POSIX rename(2) is atomic on the
#     same filesystem.
#
# Goes through lock.sh for atomicity in production -- this script is the
# inner step. Call sites should invoke `lock.sh` first, which then runs the
# merger; the hoist runs after merge in the same hook to share the budget.
#
# ASCII only. No emojis.

set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 1 ]; then
  printf '[ijfw-agents-md] usage: hoist-frontmatter.sh <AGENTS.md>\n' >&2
  exit 2
fi

TARGET="$1"

# Project root is the dir containing AGENTS.md. .ijfw/project.type is read
# relative to that root (matches every other A1/A3 path convention).
TARGET_DIR_RAW="$(dirname "$TARGET")"
TARGET_DIR="$(cd -P "$TARGET_DIR_RAW" 2>/dev/null && pwd)"
[ -z "$TARGET_DIR" ] && TARGET_DIR="$TARGET_DIR_RAW"
PROJECT_TYPE_FILE="$TARGET_DIR/.ijfw/project.type"

# Silent skip if A3 hasn't written the type file yet (Phase 3 work).
if [ ! -f "$PROJECT_TYPE_FILE" ]; then
  exit 0
fi

# AGENTS.md must exist -- otherwise nothing to splice into.
if [ ! -f "$TARGET" ]; then
  exit 0
fi

# Resolve node binary.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$cand" ] && { NODE_BIN="$cand"; break; }
  done
fi
if [ -z "$NODE_BIN" ]; then
  printf '[ijfw-agents-md] node executable not on PATH; frontmatter hoist skipped\n' >&2
  exit 0
fi

TMP_OUT="$TARGET.tmp.hoist.$$"

# Splice via node: parse frontmatter, merge A3 fields, re-emit.
"$NODE_BIN" "$(dirname "$0")/hoist-frontmatter.js" "$TARGET" "$PROJECT_TYPE_FILE" "$TMP_OUT"

# If node decided no rewrite was needed, TMP_OUT will not exist.
if [ -f "$TMP_OUT" ]; then
  mv -f "$TMP_OUT" "$TARGET"
fi

exit 0
