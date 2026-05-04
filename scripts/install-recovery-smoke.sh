#!/usr/bin/env bash
# install-recovery-smoke.sh -- broken-state recovery smoke test
#
# Procedure:
#   1. Backs up ~/.claude/settings.json
#   2. Wedges it: writes a broken ijfw marketplace entry (github source)
#   3. Runs bash scripts/install.sh (claude target)
#   4. Verifies the installer healed it to directory source
#   5. Always restores the real settings.json on exit (pass or fail)
#   6. Runs a quick post-install Wayland plugin importability check
#
# Usage:
#   bash scripts/install-recovery-smoke.sh
#   bash scripts/install-recovery-smoke.sh --no-backup   # CI (skips restore)

set -u

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NO_BACKUP=0
for arg in "$@"; do [ "$arg" = "--no-backup" ] && NO_BACKUP=1; done

SETTINGS="$HOME/.claude/settings.json"
BAK_TS="$(date +%Y%m%d-%H%M%S)"
BAK_FILE="$HOME/.claude/settings.json.recovery-smoke.$BAK_TS"
WEDGED=0

# Always restore on EXIT (both success and failure paths).
# This test is a wedge-and-heal; we never leave the user in a broken state.
restore_settings() {
  if [ "$NO_BACKUP" -eq 0 ] && [ "$WEDGED" -eq 1 ] && [ -f "$BAK_FILE" ]; then
    cp "$BAK_FILE" "$SETTINGS" 2>/dev/null || true
    rm -f "$BAK_FILE" 2>/dev/null || true
  fi
}
trap restore_settings EXIT

fail() {
  printf "install-recovery-smoke: FAIL -- %s\n" "$1" >&2
  exit 1
}

# Step 1: backup real settings.json.
if [ ! -f "$SETTINGS" ]; then
  fail "$HOME/.claude/settings.json not found -- cannot run recovery test"
fi
if [ "$NO_BACKUP" -eq 0 ]; then
  cp "$SETTINGS" "$BAK_FILE" || fail "could not backup $SETTINGS"
fi

# Step 2: wedge -- write settings.json with broken github marketplace source.
# Reads real settings, merges in broken ijfw entry, writes back.
printf "install-recovery-smoke: wedging ~/.claude/settings.json with broken github source...\n"
node - "$SETTINGS" <<'JSEOF' || fail "could not wedge settings.json"
const fs = require("fs");
const p = process.argv[2];  // argv[1] == "-" when using heredoc; path is argv[2]
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8") || "{}"); } catch { s = {}; }
if (!s || typeof s !== "object") s = {};
s.extraKnownMarketplaces = s.extraKnownMarketplaces || {};
// This is the broken state: github source instead of directory source.
s.extraKnownMarketplaces["ijfw"] = {
  source: { source: "github", repo: "TheRealSeanDonahoe/ijfw" }
};
fs.writeFileSync(p + ".tmp", JSON.stringify(s, null, 2) + "\n");
fs.renameSync(p + ".tmp", p);
console.log("  wedged: extraKnownMarketplaces.ijfw.source.source = github");
JSEOF
WEDGED=1

# Confirm wedge took effect.
WEDGE_VAL="$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS', 'utf8') || '{}');
  console.log((s.extraKnownMarketplaces || {}).ijfw ? s.extraKnownMarketplaces.ijfw.source.source : 'missing');
")"
[ "$WEDGE_VAL" = "github" ] || fail "wedge did not take effect (got: $WEDGE_VAL)"

# Step 3: run installer (claude target only -- heals settings.json).
printf "install-recovery-smoke: running install.sh (claude target)...\n"
if ! bash "$REPO_ROOT/scripts/install.sh" claude > /tmp/recovery-smoke-install.log 2>&1; then
  fail "install.sh exited non-zero (see /tmp/recovery-smoke-install.log)"
fi

# Step 4: verify the heal.
HEALED_SOURCE="$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS', 'utf8') || '{}');
  const mp = (s.extraKnownMarketplaces || {}).ijfw;
  if (!mp) { console.log('missing'); process.exit(0); }
  console.log(mp.source ? mp.source.source : 'no-source-key');
")"

[ "$HEALED_SOURCE" = "directory" ] \
  || fail "marketplace source not healed (expected: directory, got: $HEALED_SOURCE)"

HEALED_PATH="$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS', 'utf8') || '{}');
  const mp = (s.extraKnownMarketplaces || {}).ijfw;
  console.log(mp && mp.source ? mp.source.path : 'missing');
")"

[ -n "$HEALED_PATH" ] || fail "marketplace source.path is empty after heal"
printf "  healed source: directory at %s\n" "$HEALED_PATH"

# Step 5: verify Wayland plugin is still importable (collateral check).
if [ -f "$HOME/.wayland/plugins/ijfw/__init__.py" ]; then
  python3 - <<PYEOF || fail "Wayland plugin not importable post-heal"
import importlib.util, os
p = os.path.expanduser("~/.wayland/plugins/ijfw/__init__.py")
spec = importlib.util.spec_from_file_location("w_ijfw_rec", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert hasattr(m, "register")
print("  Wayland plugin importable: OK")
PYEOF
else
  printf "  Wayland plugin not installed -- skipping plugin importability check\n"
fi

# Restore happens via trap EXIT.
printf "install-recovery-smoke: PASS (broken-state healed to directory source)\n"
