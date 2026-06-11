#!/usr/bin/env bash
# Regression test for issue #16 -- the codebase indexer must never walk $HOME or
# / and must never index a folder that is not a real project (no marker and not
# blessed via `ijfw init`). Defense-in-depth: even a valid project root must not
# descend into user-data dirs (Documents/Downloads/etc).
#
# Exit 0 = all cases pass. Exit 1 = a regression. Run standalone or from
# e2e-smoke.sh.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INDEXER="$SCRIPT_DIR/build-codebase-index.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IJFW_CLI="$REPO_ROOT/mcp-server/bin/ijfw"

PASS=0
FAIL=0
note() { printf '  %s\n' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

# Each case runs the indexer in an isolated cwd with an isolated $HOME so a bug
# can never touch the real home directory.
run_indexer() { # $1=cwd $2=home  (args after = passed to indexer)
  local cwd="$1" home="$2"; shift 2
  ( cd "$cwd" && HOME="$home" bash "$INDEXER" "$@" 2>&1 )
}

echo "issue #16 indexer guard regression test"

# ---------------------------------------------------------------------------
# Case 1: ROOT resolving to $HOME refuses, writes nothing, says why.
# ---------------------------------------------------------------------------
H1="$(mktemp -d)"
OUT="$(run_indexer "$H1" "$H1" .)"
if [ ! -f "$H1/.ijfw/index/files.md" ] && printf '%s' "$OUT" | grep -qi "home"; then
  ok "refuses \$HOME (no index written, reason mentions home)"
else
  bad "refuses \$HOME -- wrote index or gave no reason. out: $OUT"
fi
rm -rf "$H1"

# ---------------------------------------------------------------------------
# Case 2: ROOT resolving to / refuses, writes nothing.
# ---------------------------------------------------------------------------
H2="$(mktemp -d)"
OUT="$(run_indexer "$H2" "$H2" /)"
if [ ! -f "$H2/.ijfw/index/files.md" ]; then
  ok "refuses / (no index written)"
else
  bad "refuses / -- wrote an index"
fi
rm -rf "$H2"

# ---------------------------------------------------------------------------
# Case 3: marker-less folder (not $HOME) refuses and points at `ijfw init`.
# ---------------------------------------------------------------------------
H3="$(mktemp -d)"; P3="$H3/plainfolder"; mkdir -p "$P3"; : > "$P3/notes.md"
OUT="$(run_indexer "$P3" "$H3" .)"
if [ ! -f "$P3/.ijfw/index/files.md" ] && printf '%s' "$OUT" | grep -qi "init"; then
  ok "refuses marker-less folder and suggests \`ijfw init\`"
else
  bad "marker-less folder -- indexed it or gave no init hint. out: $OUT"
fi
rm -rf "$H3"

# ---------------------------------------------------------------------------
# Case 4: a real project (.git) still produces the index.
# ---------------------------------------------------------------------------
H4="$(mktemp -d)"; P4="$H4/proj"; mkdir -p "$P4/src"
git -C "$P4" init -q 2>/dev/null
: > "$P4/package.json"; printf 'const x = 1\n' > "$P4/src/app.js"
OUT="$(run_indexer "$P4" "$H4" .)"
if [ -f "$P4/.ijfw/index/files.md" ] && grep -q "app.js" "$P4/.ijfw/index/files.md"; then
  ok "indexes a real project (.git / package.json)"
else
  bad "real project -- no index produced. out: $OUT"
fi
rm -rf "$H4"

# ---------------------------------------------------------------------------
# Case 5: `ijfw init` blesses a marker-less folder so it indexes afterwards.
# ---------------------------------------------------------------------------
if [ -x "$IJFW_CLI" ] && command -v node >/dev/null 2>&1; then
  H5="$(mktemp -d)"; P5="$H5/blessed"; mkdir -p "$P5"; printf 'print(1)\n' > "$P5/main.py"
  ( cd "$P5" && HOME="$H5" "$IJFW_CLI" init >/dev/null 2>&1 )
  OUT="$(run_indexer "$P5" "$H5" .)"
  if [ -f "$P5/.ijfw/index/files.md" ] && grep -q "main.py" "$P5/.ijfw/index/files.md"; then
    ok "\`ijfw init\` blesses a marker-less folder -> indexes"
  else
    bad "ijfw init -- folder still not indexable. out: $OUT"
  fi
  rm -rf "$H5"
else
  note "SKIP case 5 (ijfw CLI or node unavailable)"
fi

# ---------------------------------------------------------------------------
# Case 6: defense-in-depth -- a valid project must not descend into user-data
# dirs (Documents/Downloads/etc) even when one sits inside the project root.
# ---------------------------------------------------------------------------
H6="$(mktemp -d)"; P6="$H6/proj2"; mkdir -p "$P6/src" "$P6/Documents" "$P6/Downloads"
git -C "$P6" init -q 2>/dev/null
printf 'ok\n' > "$P6/src/keep.js"
printf 'secret\n' > "$P6/Documents/private.md"
printf 'secret\n' > "$P6/Downloads/leak.js"
run_indexer "$P6" "$H6" . >/dev/null 2>&1
IDX="$P6/.ijfw/index/files.md"
if [ -f "$IDX" ] && grep -q "keep.js" "$IDX" \
   && ! grep -q "private.md" "$IDX" && ! grep -q "leak.js" "$IDX"; then
  ok "excludes user-data dirs (Documents/Downloads) inside a project"
else
  bad "user-data dirs leaked into the index"
fi
rm -rf "$H6"

# ---------------------------------------------------------------------------
# Case 7: explicit-root invocation writes the index into ROOT/.ijfw, never the
# cwd's .ijfw (regression: cwd-relative paths clobbered another project's index).
# ---------------------------------------------------------------------------
H7="$(mktemp -d)"; PA="$H7/projA"; PB="$H7/projB"
mkdir -p "$PA" "$PB/.ijfw/index"
git -C "$PA" init -q 2>/dev/null; : > "$PA/package.json"
printf 'const a = 1\n' > "$PA/a.js"
printf 'SENTINEL-B\n' > "$PB/.ijfw/index/files.md"
run_indexer "$PB" "$H7" "$PA" >/dev/null 2>&1
if [ -f "$PA/.ijfw/index/files.md" ] && grep -q "a.js" "$PA/.ijfw/index/files.md" \
   && grep -q "SENTINEL-B" "$PB/.ijfw/index/files.md"; then
  ok "explicit root writes into ROOT/.ijfw, cwd's index untouched"
else
  bad "explicit root wrote into the wrong .ijfw (cwd clobber regression)"
fi
rm -rf "$H7"

# ---------------------------------------------------------------------------
# Case 8: a shell-file edit triggers a rebuild (regression: the freshness scan
# omitted *.sh while the build walk included it -- stale index forever).
# ---------------------------------------------------------------------------
H8="$(mktemp -d)"; P8="$H8/shproj"; mkdir -p "$P8"
: > "$P8/package.json"   # marker only; *.json is not an indexed type
printf 'old_hint=1\n' > "$P8/tool.sh"
run_indexer "$P8" "$H8" . >/dev/null 2>&1
# Age the stamp past the 60s fast-path, then edit only the .sh file.
touch -t 202001010000 "$P8/.ijfw/index/.last-build" 2>/dev/null
printf 'new_hint_xyz=1\n' > "$P8/tool.sh"
run_indexer "$P8" "$H8" . >/dev/null 2>&1
if grep -q "new_hint_xyz" "$P8/.ijfw/index/files.md" 2>/dev/null; then
  ok "editing only a .sh file triggers a rebuild"
else
  bad ".sh edit did not trigger a rebuild (freshness filter drift)"
fi
rm -rf "$H8"

# ---------------------------------------------------------------------------
# Case 9: malformed IJFW_INDEX_MAX falls back to the default cap instead of
# finalizing an empty index over a good one.
# ---------------------------------------------------------------------------
H9="$(mktemp -d)"; P9="$H9/capproj"; mkdir -p "$P9"
: > "$P9/package.json"
printf 'const k = 1\n' > "$P9/keep.js"
( cd "$P9" && HOME="$H9" IJFW_INDEX_MAX="5,000" bash "$INDEXER" . ) >/dev/null 2>&1
if grep -q "keep.js" "$P9/.ijfw/index/files.md" 2>/dev/null; then
  ok "malformed IJFW_INDEX_MAX falls back to default (index intact)"
else
  bad "malformed IJFW_INDEX_MAX produced an empty/broken index"
fi
rm -rf "$H9"

# ---------------------------------------------------------------------------
# Case 10: truncation is noted in the footer when the cap bites.
# ---------------------------------------------------------------------------
H10="$(mktemp -d)"; P10="$H10/bigproj"; mkdir -p "$P10"
: > "$P10/package.json"
printf 'x\n' > "$P10/f1.js"; printf 'x\n' > "$P10/f2.js"; printf 'x\n' > "$P10/f3.js"
( cd "$P10" && HOME="$H10" IJFW_INDEX_MAX=2 bash "$INDEXER" . ) >/dev/null 2>&1
if grep -q "truncated to 2 of 3" "$P10/.ijfw/index/files.md" 2>/dev/null; then
  ok "truncation footer notes capped index (2 of 3)"
else
  bad "no truncation footer when IJFW_INDEX_MAX caps the index"
fi
rm -rf "$H10"

echo ""
echo "indexer guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
