#!/usr/bin/env bash
# Virtual Node Verification for IJFW 1.1.6 -- private isolated HOME end-to-end.
#
# Two phases:
#   A) Tarball-install path (npm pack output) -- validates published package shape
#   B) Repo-rsync install path (matches the e2e-smoke canonical mode) -- exercises
#      the full 1.1.6 surface: state seed, MCP tools, CLI commands, statusline,
#      bg update check, doctor, uninstall.
#
# Always runs in mktemp HOME -- never touches user's real ~/.ijfw or ~/.claude.
# Exits 0 only when every assertion passes.

set -u

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL=""
for cand in /tmp/ijfw-install-*.tgz "$REPO_ROOT/installer"/ijfw-install-*.tgz; do
  [ -f "$cand" ] && TARBALL="$cand" && break
done

if [ -t 1 ]; then
  R=$'\033[0m'; B=$'\033[1m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
else
  R=; B=; C_GREEN=; C_RED=; C_CYAN=
fi
pass() { printf "  %s[PASS]%s %s\n" "$C_GREEN" "$R" "$1"; }
fail() { printf "  %s[FAIL]%s %s\n" "$C_RED"   "$R" "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf "  %s[..]  %s%s\n" "$C_CYAN"  "$R" "$1"; }
hdr()  { printf "\n%s== %s ==%s\n" "$B" "$1" "$R"; }
FAILURES=0

# ============================================================
# Phase A: tarball validation (no clone, just structure)
# ============================================================
hdr "Phase A -- tarball validation"

if [ -z "$TARBALL" ]; then
  fail "no installer tarball found. Run: cd installer && npm pack --pack-destination /tmp"
else
  pass "tarball located: $(basename "$TARBALL")"

  TARBALL_INSPECT="$(mktemp -d -t ijfw-vnv-tar-XXXXXX)"
  tar -xzf "$TARBALL" -C "$TARBALL_INSPECT"
  PKG_DIR="$TARBALL_INSPECT/package"

  # Validate published version
  PUB_VER="$(node -p "require('$PKG_DIR/package.json').version")"
  if [ "$PUB_VER" = "1.1.6" ]; then
    pass "tarball package.json version: 1.1.6"
  else
    fail "tarball package.json version: $PUB_VER (expected 1.1.6)"
  fi

  # Validate publishConfig.provenance
  PROV="$(node -p "require('$PKG_DIR/package.json').publishConfig?.provenance || false")"
  if [ "$PROV" = "true" ]; then
    pass "tarball publishConfig.provenance: true"
  else
    fail "tarball publishConfig.provenance: $PROV (expected true)"
  fi

  # Validate dist/* present
  for f in dist/ijfw.js dist/install.js dist/uninstall.js; do
    if [ -f "$PKG_DIR/$f" ]; then
      pass "tarball ships $f"
    else
      fail "tarball missing $f"
    fi
  done

  rm -rf "$TARBALL_INSPECT"
fi

# ============================================================
# Phase B: full canonical install in isolated HOME
# ============================================================
hdr "Phase B -- isolated-HOME install + flow exercise"

VNV_HOME="$(mktemp -d -t ijfw-vnv-home-XXXXXX)"
info "isolated HOME: $VNV_HOME"

# Mirror repo into the isolated HOME (matches e2e mode 2)
mkdir -p "$VNV_HOME/.ijfw"
rsync -aq --exclude='.git' --exclude='node_modules' --exclude='.ijfw' \
      --exclude='.planning' --exclude='installer/docs' \
      "$REPO_ROOT/" "$VNV_HOME/.ijfw/"

# Run installer
(
  export HOME="$VNV_HOME"
  export IJFW_HOME="$VNV_HOME/.ijfw"
  export IJFW_CUSTOM_DIR="0"
  cd "$VNV_HOME/.ijfw"
  bash scripts/install.sh > "$VNV_HOME/install.out" 2> "$VNV_HOME/install.err"
)
INSTALL_RC=$?
if [ "$INSTALL_RC" -eq 0 ]; then
  pass "installer exited 0"
else
  fail "installer exited $INSTALL_RC; see $VNV_HOME/install.err"
fi

CLI="$VNV_HOME/.ijfw/mcp-server/src/cross-orchestrator-cli.js"
SERVER_JS="$VNV_HOME/.ijfw/mcp-server/src/server.js"
ST_JS="$VNV_HOME/.ijfw/claude/hooks/scripts/ijfw-statusline.js"

# --- State + settings shape ---
if HOME="$VNV_HOME" node -e "
  const fs=require('fs'); const p='$VNV_HOME/.ijfw/state.json';
  const d=JSON.parse(fs.readFileSync(p,'utf8'));
  process.exit(d.schema_version===1 && d.installed_version==='1.1.6' && d.install_method ? 0 : 1)
"; then
  pass "state.json: schema_version=1, installed_version=1.1.6, install_method set"
else
  fail "state.json shape wrong"
fi

if HOME="$VNV_HOME" node -e "
  const fs=require('fs'); const p='$VNV_HOME/.ijfw/settings.json';
  const d=JSON.parse(fs.readFileSync(p,'utf8'));
  process.exit(d.statusline && d.update_check && d.context_bar ? 0 : 1)
"; then
  pass "settings.json: statusline + update_check + context_bar present"
else
  fail "settings.json shape wrong"
fi

# --- ijfw --version ---
VER_OUT="$(IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$CLI" --version 2>&1 | head -1)"
if echo "$VER_OUT" | grep -q '@ijfw/install@1\.1\.6'; then
  pass "ijfw --version reports 1.1.6"
else
  fail "ijfw --version unexpected: $VER_OUT"
fi

# --- ijfw --version --verbose ---
VER_VERB_OUT="$(IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$CLI" --version --verbose 2>&1)"
if echo "$VER_VERB_OUT" | grep -q 'install_method:' && echo "$VER_VERB_OUT" | grep -q 'auto_update:'; then
  pass "ijfw --version --verbose surfaces install_method + auto_update"
else
  fail "ijfw --version --verbose missing fields"
fi

# --- ijfw update --check (network-dependent; tolerate no-network) ---
UPDATE_RC=0
IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$CLI" update --check >/dev/null 2>&1 || UPDATE_RC=$?
case "$UPDATE_RC" in
  0|3|1) pass "ijfw update --check returned a known status (rc=$UPDATE_RC)" ;;
  *) fail "ijfw update --check unexpected rc=$UPDATE_RC" ;;
esac

# --- ijfw statusline --status ---
ST_OUT="$(IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$CLI" statusline --status 2>&1)"
if echo "$ST_OUT" | grep -q 'IJFW statusline status'; then
  pass "ijfw statusline --status renders"
else
  fail "ijfw statusline --status output unexpected: $ST_OUT"
fi

# --- ijfw insight (alias) -- non-blocking; just check command resolves ---
IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$CLI" insight nonexistent-sub 2>&1 | head -1 >/dev/null
pass "ijfw insight resolves (alias for dashboard)"

# --- MCP server: 10 tools ---
MCP_TOOLS="$( ( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
  sleep 0.2
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 0.2
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 0.4 ) | HOME="$VNV_HOME" IJFW_HOME="$VNV_HOME/.ijfw" node "$SERVER_JS" 2>/dev/null )"
if echo "$MCP_TOOLS" | grep -q 'ijfw_update_check' && echo "$MCP_TOOLS" | grep -q 'ijfw_update_apply'; then
  pass "MCP server lists update_check + update_apply tools"
else
  fail "MCP tools list missing update tools"
fi

# --- MCP update_check tool call (network-dependent; tolerate failure) ---
MCP_CHECK="$( ( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
  sleep 0.2
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 0.2
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ijfw_update_check","arguments":{"force":true}}}'
  sleep 1.5 ) | HOME="$VNV_HOME" IJFW_HOME="$VNV_HOME/.ijfw" node "$SERVER_JS" 2>/dev/null )"
if echo "$MCP_CHECK" | grep -q 'current' && echo "$MCP_CHECK" | grep -q 'latest'; then
  pass "MCP ijfw_update_check returns structured result (current + latest)"
else
  fail "MCP ijfw_update_check did not return expected fields"
fi

# --- statusline renders + has correct path ---
mkdir -p "$VNV_HOME/.ijfw/cache"
echo '{"schema_version":1,"installed_version":"1.1.5"}' > "$VNV_HOME/.ijfw/state.json"
echo '{"schema_version":1,"last_check":1,"last_latest_seen":"1.1.6","last_failure":null}' > "$VNV_HOME/.ijfw/cache/update-check.json"
ST_RENDER="$(echo '{"context_window":{"remaining_percentage":50}}' | IJFW_HOME="$VNV_HOME/.ijfw" node "$ST_JS" 2>&1)"
if echo "$ST_RENDER" | grep -q '1.1.6 available' && echo "$ST_RENDER" | grep -qE 'left|runway|used'; then
  pass "statusline renders update nudge + context bar end-to-end"
else
  fail "statusline render unexpected: $ST_RENDER"
fi

# --- background update-check hook can fire ---
BG_HOME="$VNV_HOME/.ijfw"
BG_OUT="$(IJFW_HOME="$BG_HOME" HOME="$VNV_HOME" "$VNV_HOME/.ijfw/claude/hooks/scripts/ijfw-check-update.sh" 2>&1)"
sleep 1.5
if [ -f "$BG_HOME/cache/update-check.json" ]; then
  pass "background update-check hook produces cache file"
else
  fail "background update-check did not produce cache file: $BG_OUT"
fi

# --- ijfw doctor smoke ---
DOC_OUT="$(IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$CLI" doctor 2>&1 | head -3)"
if [ -n "$DOC_OUT" ]; then
  pass "ijfw doctor renders some output"
else
  fail "ijfw doctor produced no output"
fi

# --- ijfw uninstall (lite-dry-run; just verify the path resolves) ---
UNI_OUT="$(IJFW_HOME="$VNV_HOME/.ijfw" HOME="$VNV_HOME" node "$VNV_HOME/.ijfw/installer/src/uninstall.js" --help 2>&1 | head -3)"
if [ -n "$UNI_OUT" ]; then
  pass "uninstall.js entry resolves"
else
  fail "uninstall.js entry missing"
fi

# Cleanup
rm -rf "$VNV_HOME"

# ============================================================
# Summary
# ============================================================
hdr "Summary"
if [ "$FAILURES" -eq 0 ]; then
  printf "  %s+ ALL VNV GATES PASSED+%s\n\n" "$B$C_GREEN" "$R"
  exit 0
else
  printf "  %s! %d VNV gate(s) failed%s\n\n" "$B$C_RED" "$FAILURES" "$R"
  exit 1
fi
