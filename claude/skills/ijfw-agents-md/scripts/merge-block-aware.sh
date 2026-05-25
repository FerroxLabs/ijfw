#!/usr/bin/env bash
# merge-block-aware.sh -- block-scoped AGENTS.md merger (V3-F1).
#
# Two invocation forms:
#   Single-pair (legacy):
#     merge-block-aware.sh <target> <BLOCK> <content>
#   Multi-pair (P2-M2 -- single transaction, single backup, single rename):
#     merge-block-aware.sh <target> <BLOCK1>:<file1> [<BLOCK2>:<file2> ...]
#
# Block names: MEMORY | ROUTING | AGENTS | BLACKBOARD | FRONTMATTER | DISCIPLINE
#
# Behaviour:
#   - If target file is absent: seed from templates/AGENTS.md.tmpl, then merge.
#   - Replace bytes between <!-- IJFW-<NAME>-START --> and <!-- IJFW-<NAME>-END -->
#     atomically. Bytes outside the named block are byte-identical before/after.
#   - If markers for that block do not exist in an existing file, append a
#     fresh marker pair (containing the new content) at end of file.
#   - Backups land at ~/.ijfw/state/agents-md/backups/<project-hash>/
#     with millisecond timestamps. Retention cap: last 3 per project.
#   - Frontmatter handled by hoist-frontmatter.sh (this merger only touches
#     marker-bounded body blocks).
#
# Atomicity: writes to AGENTS.md.tmp.<random>, then renames. POSIX rename(2)
# is atomic on the same filesystem.
#
# ASCII only. No emojis.

set -euo pipefail
export LC_ALL=C

if [ "$#" -lt 2 ]; then
  printf '[ijfw-agents-md] usage: merge-block-aware.sh <target> <BLOCK> <content>\n' >&2
  printf '                  or: merge-block-aware.sh <target> <BLOCK1>:<file1> [<BLOCK2>:<file2> ...]\n' >&2
  exit 2
fi

TARGET="$1"
shift

# Detect form: single-pair takes exactly 2 remaining args (BLOCK + content);
# multi-pair takes 1+ pairs of <BLOCK>:<file>.
PAIRS_BLOCKS=()
PAIRS_CONTENT=()

is_pair_form() {
  # First remaining arg must contain a colon AND its prefix must be a valid
  # block name. This avoids mistaking single-pair `BLOCK "content with: colon"`.
  case "$1" in
    MEMORY:*|ROUTING:*|AGENTS:*|BLACKBOARD:*|FRONTMATTER:*|DISCIPLINE:*) return 0 ;;
  esac
  return 1
}

if [ "$#" -ge 1 ] && is_pair_form "$1"; then
  # Multi-pair form. Read each <BLOCK>:<file>.
  for pair in "$@"; do
    BLOCK="${pair%%:*}"
    FILE="${pair#*:}"
    case "$BLOCK" in
      MEMORY|ROUTING|AGENTS|BLACKBOARD|FRONTMATTER|DISCIPLINE) ;;
      *)
        printf '[ijfw-agents-md] block name reserved set: MEMORY ROUTING AGENTS BLACKBOARD FRONTMATTER DISCIPLINE (got %s)\n' "$BLOCK" >&2
        exit 2
        ;;
    esac
    if [ ! -f "$FILE" ]; then
      printf '[ijfw-agents-md] multi-pair content file missing: %s\n' "$FILE" >&2
      exit 2
    fi
    PAIRS_BLOCKS+=("$BLOCK")
    # Read raw bytes via cat -- preserves newlines and unusual chars.
    PAIRS_CONTENT+=("$(cat "$FILE")")
  done
elif [ "$#" -eq 2 ]; then
  # Single-pair legacy form.
  BLOCK="$1"
  CONTENT="$2"
  case "$BLOCK" in
    MEMORY|ROUTING|AGENTS|BLACKBOARD|FRONTMATTER|DISCIPLINE) ;;
    *)
      printf '[ijfw-agents-md] block name reserved set: MEMORY ROUTING AGENTS BLACKBOARD FRONTMATTER DISCIPLINE (got %s)\n' "$BLOCK" >&2
      exit 2
      ;;
  esac
  PAIRS_BLOCKS+=("$BLOCK")
  PAIRS_CONTENT+=("$CONTENT")
else
  printf '[ijfw-agents-md] usage: merge-block-aware.sh <target> <BLOCK> <content>\n' >&2
  printf '                  or: merge-block-aware.sh <target> <BLOCK1>:<file1> [<BLOCK2>:<file2> ...]\n' >&2
  exit 2
fi

# Resolve template path relative to this script.
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
TEMPLATE="$SCRIPT_DIR/../templates/AGENTS.md.tmpl"

TARGET_DIR="$(cd -P "$(dirname "$TARGET")" 2>/dev/null && pwd)"
TARGET_BASE="$(basename "$TARGET")"
TARGET_ABS="$TARGET_DIR/$TARGET_BASE"

# Seed from template if absent.
if [ ! -f "$TARGET_ABS" ]; then
  if [ ! -f "$TEMPLATE" ]; then
    printf '[ijfw-agents-md] template missing at %s\n' "$TEMPLATE" >&2
    exit 3
  fi
  cp "$TEMPLATE" "$TARGET_ABS"
fi

# Resolve node binary (used for both the merge and the project-hash).
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$cand" ] && { NODE_BIN="$cand"; break; }
  done
fi
if [ -z "$NODE_BIN" ]; then
  printf '[ijfw-agents-md] node executable not on PATH; AGENTS.md merge skipped\n' >&2
  exit 4
fi

# Backup retention (P2-B1 + P2-H3): relocate to ~/.ijfw/state/agents-md/backups/<project-hash>/
# with millisecond timestamps. Cap last 3 per project. HOME canonicalised via
# cd -P (HOME symlink gotcha memo).
HOME_CANON="$(cd -P "$HOME" 2>/dev/null && pwd)"
[ -z "$HOME_CANON" ] && HOME_CANON="$HOME"
PROJECT_HASH="$(printf '%s' "$TARGET_DIR" | "$NODE_BIN" -e '
  const crypto = require("crypto");
  let buf = "";
  process.stdin.on("data", c => buf += c);
  process.stdin.on("end", () => {
    process.stdout.write(crypto.createHash("sha256").update(buf).digest("hex").slice(0,12));
  });
' 2>/dev/null)"
[ -z "$PROJECT_HASH" ] && PROJECT_HASH="unknown"
BACKUP_DIR="$HOME_CANON/.ijfw/state/agents-md/backups/$PROJECT_HASH"

if [ -s "$TARGET_ABS" ]; then
  mkdir -p "$BACKUP_DIR" 2>/dev/null || true
  if [ -d "$BACKUP_DIR" ]; then
    # Millisecond timestamp avoids second-level collisions on tight loops.
    TS_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))' 2>/dev/null)"
    [ -z "$TS_MS" ] && TS_MS="$(date -u +%s 2>/dev/null || printf 'unknown')000"
    cp "$TARGET_ABS" "$BACKUP_DIR/AGENTS.md.bak.$TS_MS" 2>/dev/null || true

    # Retention cap: keep newest 3, prune the rest. POSIX-safe sort by mtime
    # using stat -- handles BSD (-f) and GNU (-c) syntaxes.
    "$NODE_BIN" -e '
      const fs = require("fs");
      const path = require("path");
      const dir = process.argv[1];
      try {
        const entries = fs.readdirSync(dir)
          .filter(n => n.startsWith("AGENTS.md.bak."))
          .map(n => ({ n, mt: fs.statSync(path.join(dir, n)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt);
        for (const e of entries.slice(3)) {
          try { fs.unlinkSync(path.join(dir, e.n)); } catch {}
        }
      } catch {}
    ' "$BACKUP_DIR" 2>/dev/null || true
  fi
fi

# Build env-encoded payload arrays for node. We pass the count + per-index
# vars to avoid argv length limits and quoting traps.
TMP_OUT="$TARGET_ABS.tmp.$$"
export IJFW_PAIR_COUNT="${#PAIRS_BLOCKS[@]}"
i=0
while [ "$i" -lt "$IJFW_PAIR_COUNT" ]; do
  export "IJFW_PAIR_BLOCK_$i=${PAIRS_BLOCKS[$i]}"
  export "IJFW_PAIR_CONTENT_$i=${PAIRS_CONTENT[$i]}"
  i=$(( i + 1 ))
done

"$NODE_BIN" -e '
  const fs = require("fs");
  const target = process.argv[1];
  const out = process.argv[2];
  const count = parseInt(process.env.IJFW_PAIR_COUNT || "0", 10);
  let src = fs.readFileSync(target, "utf8");
  for (let i = 0; i < count; i++) {
    const block = process.env["IJFW_PAIR_BLOCK_" + i] || "";
    const content = process.env["IJFW_PAIR_CONTENT_" + i] || "";
    if (!block) continue;
    const startM = "<!-- IJFW-" + block + "-START -->";
    const endM   = "<!-- IJFW-" + block + "-END -->";
    const startIdx = src.indexOf(startM);
    const endIdx = src.indexOf(endM);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = src.slice(0, startIdx + startM.length);
      const after = src.slice(endIdx);
      const inner = content && content.length ? "\n" + content + "\n" : "\n";
      src = before + inner + after;
    } else {
      const sep = src.endsWith("\n") ? "" : "\n";
      const inner = content && content.length ? "\n" + content + "\n" : "\n";
      src = src + sep + "\n" + startM + inner + endM + "\n";
    }
  }
  fs.writeFileSync(out, src);
' "$TARGET_ABS" "$TMP_OUT"

# Atomic rename on same filesystem.
mv -f "$TMP_OUT" "$TARGET_ABS"

# Clean up exported pair vars (best-effort).
i=0
while [ "$i" -lt "$IJFW_PAIR_COUNT" ]; do
  unset "IJFW_PAIR_BLOCK_$i" "IJFW_PAIR_CONTENT_$i"
  i=$(( i + 1 ))
done
unset IJFW_PAIR_COUNT

exit 0
