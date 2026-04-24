#!/usr/bin/env bash
# IJFW end-to-end smoke harness.
#
# Two modes run back-to-back:
#
#   1. SCRATCH guard check
#      Runs the installer with IJFW_CUSTOM_DIR=1 pointed at a throwaway dir.
#      Before-and-after hashes of the user's real platform configs MUST match.
#      Failure here = "Bug A regressed, installer is leaking into real $HOME".
#
#   2. CANONICAL install into an isolated $HOME
#      Points HOME at a fresh mktemp dir, runs the installer, then parses
#      every platform's written config against the schema it should have.
#      Also spawns the ijfw-memory MCP server and asserts the initialize +
#      tools/list handshake completes.
#
# Exit 0 only if both modes pass every assertion. On failure, the script
# prints the specific gate that broke and leaves the scratch dirs in place
# so a human can inspect them. Use --cleanup to override and wipe on exit.
#
# Usage:
#   bash scripts/e2e-smoke.sh             # standard run
#   bash scripts/e2e-smoke.sh --cleanup   # always wipe scratch dirs
#   bash scripts/e2e-smoke.sh --verbose   # stream installer output

set -u

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLEANUP=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --cleanup) CLEANUP=1 ;;
    --verbose|-v) VERBOSE=1 ;;
  esac
done

# ------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  R=$'\033[0m'; B=$'\033[1m'
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  R=; B=; C_GREEN=; C_RED=; C_YELLOW=; C_CYAN=
fi

pass() { printf "  %s[PASS]%s %s\n" "$C_GREEN" "$R" "$1"; }
fail() { printf "  %s[FAIL]%s %s\n" "$C_RED"   "$R" "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf "  %s[..]  %s%s\n" "$C_CYAN"  "$R" "$1"; }
hdr()  { printf "\n%s== %s ==%s\n" "$B" "$1" "$R"; }

FAILURES=0
SCRATCH_DIRS=()
cleanup_scratches() {
  if [ "$CLEANUP" = "1" ] || [ "$FAILURES" -eq 0 ]; then
    for d in "${SCRATCH_DIRS[@]}"; do rm -rf "$d" 2>/dev/null; done
  else
    printf "\n%sScratch dirs left for inspection:%s\n" "$C_YELLOW" "$R"
    for d in "${SCRATCH_DIRS[@]}"; do printf "  %s\n" "$d"; done
  fi
}
trap cleanup_scratches EXIT

run_installer() {
  # $1 = scratch dir, $2 = IJFW_CUSTOM_DIR value (0 or 1)
  local dir="$1" custom="$2"
  if [ "$VERBOSE" = "1" ]; then
    IJFW_CUSTOM_DIR="$custom" IJFW_HOME="$dir" bash "$dir/scripts/install.sh"
  else
    IJFW_CUSTOM_DIR="$custom" IJFW_HOME="$dir" bash "$dir/scripts/install.sh" \
      >"$dir/install.out" 2>"$dir/install.err" || return $?
  fi
}

# Compute a stable hash of a file for before/after compare. Uses shasum (present
# on macOS) or sha256sum (Linux). Missing file -> empty hash (not an error).
hash_file() {
  local f="$1"
  [ -f "$f" ] || { printf ""; return; }
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    sha256sum "$f" | awk '{print $1}'
  fi
}

# ------------------------------------------------------------
# Paths we want to prove are untouched in scratch mode.
# Every write target listed in the install.sh platform case blocks.
# ------------------------------------------------------------
GUARD_PATHS=(
  "$HOME/.claude/settings.json"
  "$HOME/.claude/plugins/known_marketplaces.json"
  "$HOME/.codex/config.toml"
  "$HOME/.codex/hooks.json"
  "$HOME/.gemini/settings.json"
  "$HOME/.codeium/windsurf/mcp_config.json"
  "$HOME/.hermes/config.yaml"
  "$HOME/.hermes/HERMES.md"
  "$HOME/.wayland/config.yaml"
  "$HOME/.wayland/WAYLAND.md"
)

# ============================================================
# MODE 1: SCRATCH guard check
# ============================================================
hdr "Mode 1 of 2 -- scratch-dir guard (Bug A regression gate)"

SCRATCH_A="$(mktemp -d -t ijfw-smoke-scratch-XXXXXX)"
SCRATCH_DIRS+=("$SCRATCH_A")
info "scratch dir: $SCRATCH_A"

info "mirroring repo into scratch..."
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.ijfw' \
      --exclude='.planning' --exclude='installer/docs' \
      "$REPO_ROOT/" "$SCRATCH_A/"

info "snapshotting real platform configs..."
declare -a BEFORE_HASHES
for p in "${GUARD_PATHS[@]}"; do
  BEFORE_HASHES+=("$(hash_file "$p")")
done

info "running installer with IJFW_CUSTOM_DIR=1 ..."
if run_installer "$SCRATCH_A" 1; then
  pass "installer exited 0 in scratch mode"
else
  fail "installer exited non-zero in scratch mode (see $SCRATCH_A/install.err)"
fi

info "comparing post-install hashes against snapshot..."
LEAK=0
for i in "${!GUARD_PATHS[@]}"; do
  p="${GUARD_PATHS[$i]}"
  before="${BEFORE_HASHES[$i]}"
  after="$(hash_file "$p")"
  if [ "$before" != "$after" ]; then
    fail "scope leak: $p changed during scratch install"
    LEAK=1
  fi
done
if [ "$LEAK" = "0" ]; then
  pass "zero drift across ${#GUARD_PATHS[@]} guard paths"
fi

# ============================================================
# Stale platform-count regression gate (runs before canonical install)
# ============================================================
hdr "Stale platform-count gate"
if (cd "$REPO_ROOT" && bash scripts/preflight-stale-count.sh); then
  pass "preflight-stale-count: no stale strings"
else
  fail "preflight-stale-count: stale '8 platforms' strings found -- fix before ship"
fi

# ============================================================
# MODE 2: CANONICAL install in isolated HOME
# ============================================================
hdr "Mode 2 of 2 -- canonical install in isolated HOME"

ISO_HOME="$(mktemp -d -t ijfw-smoke-home-XXXXXX)"
SCRATCH_DIRS+=("$ISO_HOME")
info "isolated HOME: $ISO_HOME"

info "mirroring repo into isolated ~/.ijfw ..."
mkdir -p "$ISO_HOME/.ijfw"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.ijfw' \
      --exclude='.planning' --exclude='installer/docs' \
      "$REPO_ROOT/" "$ISO_HOME/.ijfw/"

info "running installer with HOME=$ISO_HOME ..."
(
  export HOME="$ISO_HOME"
  export IJFW_HOME="$ISO_HOME/.ijfw"
  export IJFW_CUSTOM_DIR="0"
  cd "$ISO_HOME/.ijfw"
  if [ "$VERBOSE" = "1" ]; then
    bash scripts/install.sh
  else
    bash scripts/install.sh >"$ISO_HOME/install.out" 2>"$ISO_HOME/install.err"
  fi
) || fail "installer failed in isolated HOME (see $ISO_HOME/install.err)"
if [ "$FAILURES" -eq 0 ]; then pass "installer exited 0 in canonical mode"; fi

# ---- Assertions on written configs ----

# Claude settings.json: has ijfw plugin enabled + marketplace registered.
CL="$ISO_HOME/.claude/settings.json"
if [ -f "$CL" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$CL','utf8')); process.exit(d && d.enabledPlugins && d.enabledPlugins['ijfw@ijfw']===true ? 0 : 1)"; then
  pass "claude settings.json: ijfw plugin enabled"
else
  fail "claude settings.json missing or does not enable ijfw plugin"
fi

# Codex config.toml: has [mcp_servers.ijfw-memory] and suppress warning flag.
CX="$ISO_HOME/.codex/config.toml"
if [ -f "$CX" ] && grep -q '^\[mcp_servers.ijfw-memory\]' "$CX" \
               && grep -q '^command\s*=' "$CX" \
               && grep -q '^suppress_unstable_features_warning\s*=\s*true' "$CX"; then
  pass "codex config.toml: MCP block + warning suppression"
else
  fail "codex config.toml missing [mcp_servers.ijfw-memory] or suppress_unstable_features_warning"
fi

# Codex hooks.json: top-level {hooks: {EventName: [...]}} with PascalCase keys,
# each MatcherGroup has .hooks[] with {type:"command", command:"..."}
CH="$ISO_HOME/.codex/hooks.json"
if [ -f "$CH" ] && node -e '
  const fs=require("fs");
  const d=JSON.parse(fs.readFileSync("'"$CH"'","utf8"));
  if (!d || typeof d!=="object" || Array.isArray(d)) { process.exit(1); }
  if (!d.hooks || typeof d.hooks!=="object" || Array.isArray(d.hooks)) { process.exit(1); }
  const events=Object.keys(d.hooks);
  if (events.length===0) { process.exit(1); }
  for (const ev of events) {
    const grps=d.hooks[ev];
    if (!Array.isArray(grps)) { console.error("non-array event "+ev); process.exit(1); }
    for (const g of grps) {
      if (!g || !Array.isArray(g.hooks)) { console.error("bad group under "+ev); process.exit(1); }
      for (const h of g.hooks) {
        if (h.type!=="command" || typeof h.command!=="string" || !h.command) { console.error("bad handler under "+ev); process.exit(1); }
        if (!h.command.startsWith("/")) { console.error("non-abs command under "+ev+": "+h.command); process.exit(1); }
      }
    }
  }
  process.exit(0);
'; then
  pass "codex hooks.json: nested schema valid + absolute command paths"
else
  fail "codex hooks.json missing, malformed, or uses wrong schema"
fi

# Gemini settings.json: mcpServers.ijfw-memory.command resolves.
GM="$ISO_HOME/.gemini/settings.json"
if [ -f "$GM" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$GM','utf8')); const m=d.mcpServers&&d.mcpServers['ijfw-memory']; process.exit(m && m.command ? 0 : 1)"; then
  pass "gemini settings.json: ijfw-memory registered"
else
  fail "gemini settings.json missing ijfw-memory"
fi

# Windsurf mcp_config.json
WS="$ISO_HOME/.codeium/windsurf/mcp_config.json"
if [ -f "$WS" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$WS','utf8')); const m=d.mcpServers&&d.mcpServers['ijfw-memory']; process.exit(m && m.command ? 0 : 1)"; then
  pass "windsurf mcp_config.json: ijfw-memory registered"
else
  fail "windsurf mcp_config.json missing ijfw-memory"
fi

# Hermes config.yaml
HC="$ISO_HOME/.hermes/config.yaml"
if [ -f "$HC" ] && grep -q 'ijfw-memory' "$HC"; then
  pass "hermes config.yaml: ijfw-memory registered"
else
  fail "hermes config.yaml missing or lacks ijfw-memory"
fi
if [ -f "$ISO_HOME/.hermes/HERMES.md" ]; then
  pass "hermes HERMES.md present"
else
  fail "hermes HERMES.md missing"
fi
if [ -d "$ISO_HOME/.hermes/skills" ] && [ "$(find "$ISO_HOME/.hermes/skills" -maxdepth 1 -type d -name 'ijfw-*' 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ]; then
  pass "hermes skills/ijfw-* dirs installed"
else
  fail "hermes skills not copied"
fi

# Wayland config.yaml
WC="$ISO_HOME/.wayland/config.yaml"
if [ -f "$WC" ] && grep -q 'ijfw-memory' "$WC"; then
  pass "wayland config.yaml: ijfw-memory registered"
else
  fail "wayland config.yaml missing or lacks ijfw-memory"
fi
if [ -f "$ISO_HOME/.wayland/WAYLAND.md" ]; then
  pass "wayland WAYLAND.md present"
else
  fail "wayland WAYLAND.md missing"
fi
if [ -d "$ISO_HOME/.wayland/skills" ] && [ "$(find "$ISO_HOME/.wayland/skills" -maxdepth 1 -type d -name 'ijfw-*' 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ]; then
  pass "wayland skills/ijfw-* dirs installed"
else
  fail "wayland skills not copied"
fi

# ---- Cursor + Copilot gates (install into project dir = $ISO_HOME/.ijfw) ----
CURSOR_MCP="$ISO_HOME/.ijfw/.cursor/mcp.json"
CURSOR_RULES="$ISO_HOME/.ijfw/.cursor/rules/ijfw.mdc"
if [ -f "$CURSOR_MCP" ] && grep -q 'ijfw-memory' "$CURSOR_MCP"; then
  pass "cursor .cursor/mcp.json: ijfw-memory registered"
else
  fail "cursor .cursor/mcp.json missing or lacks ijfw-memory"
fi
if [ -f "$CURSOR_RULES" ]; then
  pass "cursor .cursor/rules/ijfw.mdc present"
else
  fail "cursor .cursor/rules/ijfw.mdc missing"
fi

COPILOT_MCP="$ISO_HOME/.ijfw/.vscode/mcp.json"
COPILOT_INST="$ISO_HOME/.ijfw/.github/copilot-instructions.md"
if [ -f "$COPILOT_MCP" ] && grep -q 'ijfw-memory' "$COPILOT_MCP"; then
  pass "copilot .vscode/mcp.json: ijfw-memory registered"
else
  fail "copilot .vscode/mcp.json missing or lacks ijfw-memory"
fi
if [ -f "$COPILOT_INST" ]; then
  pass "copilot .github/copilot-instructions.md present"
else
  fail "copilot .github/copilot-instructions.md missing"
fi

# ---- Picker-resource gates (1.1.5) ----
# For each platform that ships ijfw-design, verify the 1.1.5 picker resources
# landed: SKILL.md contains "Three-Option Picker", data/brand-atlas.json is
# valid JSON with 12 domains, templates/design/ has 12 .md files.
check_picker_resources() {
  local label="$1"
  local skill_root="$2"
  if [ ! -d "$skill_root" ]; then
    fail "$label: skill dir missing at $skill_root"
    return
  fi
  local skill_md="$skill_root/SKILL.md"
  local atlas="$skill_root/data/brand-atlas.json"
  local tpl_dir="$skill_root/templates/design"
  # SKILL.md contains picker logic
  if [ -f "$skill_md" ] && grep -q "Three-Option Picker" "$skill_md"; then
    pass "$label: SKILL.md carries 1.1.5 picker"
  else
    fail "$label: SKILL.md missing or lacks picker"
  fi
  # brand-atlas.json valid + 12 domains
  if [ -f "$atlas" ] && node -e "const a=JSON.parse(require('fs').readFileSync('$atlas','utf8')); process.exit(Array.isArray(a) && a.length===12 ? 0 : 1)"; then
    pass "$label: brand-atlas.json valid (12 domains)"
  else
    fail "$label: brand-atlas.json missing or malformed"
  fi
  # templates/design/ has 12 .md files
  if [ -d "$tpl_dir" ] && [ "$(find "$tpl_dir" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')" = "12" ]; then
    pass "$label: templates/design/ has 12 files"
  else
    fail "$label: templates/design/ missing or wrong count"
  fi
}

check_picker_resources "claude (repo tree)"  "$REPO_ROOT/claude/skills/ijfw-design"
check_picker_resources "codex (installed)"   "$ISO_HOME/.codex/skills/ijfw-design"
check_picker_resources "gemini (installed)"  "$ISO_HOME/.gemini/extensions/ijfw/skills/ijfw-design"
check_picker_resources "hermes (installed)"  "$ISO_HOME/.hermes/skills/ijfw-design"
check_picker_resources "wayland (installed)" "$ISO_HOME/.wayland/skills/ijfw-design"

# ---- Issue #6 regression gate ----
# Verify the installed cross-orchestrator-cli.js ships the resolveTarget fix.
# Bug: bare path was sent to auditors; fix reads file contents when target is
# a regular file. See https://github.com/TheRealSeanDonahoe/ijfw/issues/6
CLI_JS="$ISO_HOME/.ijfw/mcp-server/src/cross-orchestrator-cli.js"
if [ -f "$CLI_JS" ] \
   && grep -q "export function resolveTarget" "$CLI_JS" \
   && grep -q "target = resolveTarget(target)" "$CLI_JS"; then
  pass "issue #6 fix present: resolveTarget wired into cmdCross"
else
  fail "issue #6 regression: resolveTarget missing or not called in cmdCross"
fi

# ---- MCP server handshake test ----
info "handshaking with MCP server..."
SERVER_JS="$ISO_HOME/.ijfw/mcp-server/src/server.js"
if [ -f "$SERVER_JS" ]; then
  MCP_RESP=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
      sleep 0.2
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      sleep 0.2
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
      sleep 0.4
    ) | node "$SERVER_JS" 2>/dev/null | head -5
  )
  if echo "$MCP_RESP" | grep -q '"tools"'; then
    pass "MCP server completes full handshake (initialize + tools/list)"
  elif echo "$MCP_RESP" | grep -q '"result"'; then
    pass "MCP server responds to initialize (tools/list unverified)"
  else
    fail "MCP server silent during handshake"
  fi
else
  fail "MCP server entry point missing at $SERVER_JS"
fi

# ============================================================
# 1.1.6 GATES: state file, settings file, atomic-write, MCP update tools,
# re-entrancy, provenance workflow file presence, log rotation.
# ============================================================
hdr "1.1.6 -- state + update backend gates"

# 1) state.json + settings.json present after install (canonical install)
STATE_JSON="$ISO_HOME/.ijfw/state.json"
SETTINGS_JSON="$ISO_HOME/.ijfw/settings.json"
if [ -f "$STATE_JSON" ] && node -e "
  const d=JSON.parse(require('fs').readFileSync('$STATE_JSON','utf8'));
  process.exit(d && d.schema_version===1 && typeof d.installed_version==='string' && /^(npm-global|npm-local|git-clone|tarball|manual)$/.test(d.install_method) ? 0 : 1)
"; then
  pass "1.1.6: ~/.ijfw/state.json present + valid"
else
  fail "1.1.6: ~/.ijfw/state.json missing or malformed"
fi

if [ -f "$SETTINGS_JSON" ] && node -e "
  const d=JSON.parse(require('fs').readFileSync('$SETTINGS_JSON','utf8'));
  process.exit(d && d.schema_version===1 && d.statusline && d.update_check ? 0 : 1)
"; then
  pass "1.1.6: ~/.ijfw/settings.json seeded + valid"
else
  fail "1.1.6: ~/.ijfw/settings.json missing or malformed"
fi

# 2) install-method file (back-compat)
if [ -f "$ISO_HOME/.ijfw/install-method" ]; then
  pass "1.1.6: ~/.ijfw/install-method written"
else
  fail "1.1.6: ~/.ijfw/install-method missing"
fi

# 3) atomic-write self-test
if node -e "
  import('$ISO_HOME/.ijfw/mcp-server/src/lib/atomic-io.js').then(m => {
    const fs=require('fs'), p='$ISO_HOME/.ijfw/cache/atomic-test.json';
    m.writeAtomic(p, {ok:true, t:Date.now()});
    const r=m.readSafe(p);
    if (!r.ok || r.data.ok!==true) process.exit(1);
    fs.unlinkSync(p);
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(2); });
" 2>/dev/null; then
  pass "1.1.6: writeAtomic + readSafe roundtrip works"
else
  fail "1.1.6: atomic-io roundtrip failed"
fi

# 4) MCP update tools registered (cap 8 -> 10)
TOOLS_JSON=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    sleep 0.4
  ) | node "$SERVER_JS" 2>/dev/null
)
if echo "$TOOLS_JSON" | grep -q 'ijfw_update_check' && echo "$TOOLS_JSON" | grep -q 'ijfw_update_apply'; then
  pass "1.1.6: ijfw_update_check + ijfw_update_apply registered"
else
  fail "1.1.6: update tools missing from tools/list"
fi

# 5) ijfw --version reports the version from installer/package.json (auto-detect)
EXPECTED_VER=$(node -p "require('$REPO_ROOT/installer/package.json').version" 2>/dev/null)
VER_OUT=$(node "$ISO_HOME/.ijfw/mcp-server/src/cross-orchestrator-cli.js" --version 2>&1 | head -1)
if echo "$VER_OUT" | grep -q "@ijfw/install@${EXPECTED_VER}"; then
  pass "ijfw --version reports ${EXPECTED_VER} (matches installer/package.json)"
else
  fail "ijfw --version mismatch: expected ${EXPECTED_VER}, got: $VER_OUT"
fi

# 1.1.7: 5 new MCP platforms + Aider rules-only
hdr "1.1.7 -- new platform install assertions"

# OpenCode -- 1.1.8 corrected schema: top-level mcp.<name>.{type:"local", command:[arr]}
# (was mcpServers.<name> -- rejected by opencode-ai 1.14.20 with "Unrecognized key: mcpServers")
OC="$ISO_HOME/.config/opencode/opencode.json"
if [ -f "$OC" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$OC','utf8')); const s=d.mcp&&d.mcp['ijfw-memory']; process.exit(s&&s.type==='local'&&Array.isArray(s.command)&&s.command.length>0?0:1)"; then
  pass "1.1.8: OpenCode opencode.json registers ijfw-memory at mcp.<name> (type:local, command:[...])"
else
  fail "1.1.8: OpenCode opencode.json missing or schema wrong (expected mcp.<name>.{type:local,command:[...]})"
fi

# QwenCode -- ~/.qwen/settings.json
QW="$ISO_HOME/.qwen/settings.json"
if [ -f "$QW" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$QW','utf8')); process.exit(d.mcpServers && d.mcpServers['ijfw-memory'] && d.mcpServers['ijfw-memory'].command ? 0 : 1)"; then
  pass "1.1.7: Qwen Code settings.json registers ijfw-memory"
else
  fail "1.1.7: Qwen Code settings.json missing or lacks ijfw-memory"
fi

# Cline -- 1.1.9 RE-ENABLED. Live-verified in VS Code 1.117 + Cline 3.80.0 via
# round-tripped `ijfw_memory_prelude` native tool call (log evidence:
# `DEBUG [ToolCallProcessor] Native Tool Called: c04RcW0mcp0ijfw_memory_prelude`).
# Config lives at VS Code per-extension globalStorage; platform-specific user dir
# resolved below; Darwin is the CI default. Schema: mcpServers.<name>.{type:"stdio",
# command, args, disabled, autoApprove, timeout}. Cline has no shell CLI, so this
# structural gate is the authoritative check; live verification happens in VS Code.
case "$(uname -s 2>/dev/null)" in
  Darwin)                     CLINE_USER_DIR="$ISO_HOME/Library/Application Support/Code/User" ;;
  CYGWIN*|MINGW*|MSYS_NT*)    CLINE_USER_DIR="${APPDATA:-$ISO_HOME/AppData/Roaming}/Code/User" ;;
  *)                          CLINE_USER_DIR="$ISO_HOME/.config/Code/User" ;;
esac
CL="$CLINE_USER_DIR/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
if [ -f "$CL" ] && node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); const s=d.mcpServers&&d.mcpServers['ijfw-memory']; process.exit(s&&s.command&&s.type==='stdio'?0:1)" "$CL"; then
  pass "1.1.9: Cline globalStorage registers ijfw-memory with type:stdio"
else
  fail "1.1.9: Cline globalStorage path missing or schema wrong"
fi

# KimiCode -- ~/.kimi/mcp.json (schema unchanged, verified live in 1.1.8)
KM="$ISO_HOME/.kimi/mcp.json"
if [ -f "$KM" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$KM','utf8')); process.exit(d.mcpServers && d.mcpServers['ijfw-memory'] && d.mcpServers['ijfw-memory'].command ? 0 : 1)"; then
  pass "1.1.7: Kimi Code mcp.json registers ijfw-memory"
else
  fail "1.1.7: Kimi Code mcp.json missing or lacks ijfw-memory"
fi

# OpenClaw -- 1.1.8 corrected to ~/.openclaw/openclaw.json with mcp.servers.<name>
# nested (was ~/.openclaw/config.json with top-level mcpServers -- rejected by
# openclaw 2026.4.21 validator). CLI-set is preferred when openclaw on PATH; this
# gate covers the fallback direct-write path that fires in the isolated CI HOME.
OW="$ISO_HOME/.openclaw/openclaw.json"
if [ -f "$OW" ] && node -e "const d=JSON.parse(require('fs').readFileSync('$OW','utf8')); const s=d.mcp&&d.mcp.servers&&d.mcp.servers['ijfw-memory']; process.exit(s&&s.command?0:1)"; then
  pass "1.1.8: OpenClaw openclaw.json registers ijfw-memory at mcp.servers"
else
  fail "1.1.8: OpenClaw openclaw.json missing or schema wrong (expected mcp.servers.<name>)"
fi

# Aider -- rules-only (no MCP). ~/.aider.conf.yml + ~/CONVENTIONS.md present
if [ -f "$ISO_HOME/.aider.conf.yml" ] && grep -q 'CONVENTIONS.md' "$ISO_HOME/.aider.conf.yml"; then
  pass "1.1.7: Aider rules: ~/.aider.conf.yml present and references CONVENTIONS.md"
else
  fail "1.1.7: Aider .aider.conf.yml missing or malformed"
fi
if [ -f "$ISO_HOME/CONVENTIONS.md" ]; then
  pass "1.1.7: Aider rules: ~/CONVENTIONS.md present"
else
  fail "1.1.7: Aider CONVENTIONS.md missing"
fi

# ------------------------------------------------------------------------------
# 1.1.8 -- live CLI invocation gates.
# The structural gates above prove JSON shape. These gates prove the platform's
# OWN CLI accepts our config. Added because 1.1.7 shipped an OpenCode config
# that was valid JSON but rejected by opencode-ai 1.14.20 -- structural green
# gave a false pass. A CLI-invocation gate would have caught it pre-publish.
#
# Each gate: if <cli> is on PATH, invoke `<cli> mcp list` and assert the output
# references "ijfw-memory". Skip+note when CLI absent (most CI boxes won't have
# all five installed).
# ------------------------------------------------------------------------------
hdr "1.1.8 -- live CLI invocation gates (skip when CLI absent)"

_live_cli_gate() {
  local platform="$1" cmd="$2" listcmd="$3" needle="$4"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    info "SKIP 1.1.8: $platform CLI not on PATH"
    return 0
  fi
  # The CLI reads the REAL user config (not $ISO_HOME) -- this gate proves the
  # shape installs into a real user environment, using the dev-tree install
  # that the outer test runner has already applied to the developer's HOME.
  if eval "$listcmd" 2>&1 | grep -Fq "$needle"; then
    pass "1.1.8: $platform '$listcmd' reports $needle"
  else
    fail "1.1.8: $platform '$listcmd' did NOT report $needle"
  fi
}

_live_cli_gate "OpenCode" "opencode"  "opencode mcp list"  "ijfw-memory"
_live_cli_gate "Qwen Code" "qwen"     "qwen mcp list"      "ijfw-memory"
_live_cli_gate "Kimi Code" "kimi"     "kimi mcp list"      "ijfw-memory"
_live_cli_gate "OpenClaw"  "openclaw" "openclaw mcp list"  "ijfw-memory"
# Cline has no CLI (VS Code extension only). Structural gate above is the
# authoritative check; user verifies "Connected" live in VS Code after install.

# 6) re-entrancy guard: when state.last_applied_version >= cache.last_latest_seen, available=false
node -e "
  process.env.IJFW_HOME='$ISO_HOME/.ijfw';
  Promise.resolve().then(async () => {
    const { writeAtomic } = await import('$ISO_HOME/.ijfw/mcp-server/src/lib/atomic-io.js');
    const { ijfwUpdateCheck, writeCachedCheck } = await import('$ISO_HOME/.ijfw/mcp-server/src/update-check.js');
    writeAtomic('$ISO_HOME/.ijfw/state.json', { schema_version: 1, install_method: 'manual', installed_version: '99.99.99', last_applied_version: '99.99.99' });
    writeCachedCheck({ last_latest_seen: '99.99.99', last_failure: null });
    const r = ijfwUpdateCheck();
    if (r.available !== false) { console.error('expected available:false, got', JSON.stringify(r)); process.exit(1); }
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(2); });
" 2>/dev/null
if [ "$?" -eq 0 ]; then
  pass "1.1.6: re-entrancy sentinel suppresses re-nudge"
else
  fail "1.1.6: re-entrancy sentinel did NOT suppress nudge"
fi

# 7) provenance workflow file present (publish.yml on v* tag)
PUBLISH_YML="$REPO_ROOT/.github/workflows/publish.yml"
if [ -f "$PUBLISH_YML" ] \
   && grep -q "tags:" "$PUBLISH_YML" \
   && grep -q "'v\*'" "$PUBLISH_YML" \
   && grep -q "id-token: write" "$PUBLISH_YML" \
   && grep -q -- "--provenance" "$PUBLISH_YML"; then
  pass "1.1.6: publish.yml triggers on v*, has OIDC + --provenance"
else
  fail "1.1.6: publish.yml missing required publish-with-provenance contract"
fi

# 8) installer/package.json has publishConfig.provenance:true
if node -e "
  const d=JSON.parse(require('fs').readFileSync('$REPO_ROOT/installer/package.json','utf8'));
  process.exit(d && d.publishConfig && d.publishConfig.provenance===true ? 0 : 1)
"; then
  pass "1.1.6: installer/package.json publishConfig.provenance:true"
else
  fail "1.1.6: installer/package.json missing publishConfig.provenance"
fi

# 9) ijfw-update skill mirrored across 4 trees with identical content
SHARED_SKILL="$REPO_ROOT/shared/skills/ijfw-update/SKILL.md"
EXPECTED_HASH=$(hash_file "$SHARED_SKILL")
ALL_MATCH=1
for tree in \
    "$REPO_ROOT/claude/skills/ijfw-update/SKILL.md" \
    "$REPO_ROOT/codex/skills/ijfw-update/SKILL.md" \
    "$REPO_ROOT/gemini/extensions/ijfw/skills/ijfw-update/SKILL.md"; do
  if [ "$(hash_file "$tree")" != "$EXPECTED_HASH" ]; then
    ALL_MATCH=0
  fi
done
if [ "$ALL_MATCH" = "1" ]; then
  pass "1.1.6: ijfw-update skill identical across 4 trees"
else
  fail "1.1.6: ijfw-update skill drift across trees"
fi

# 10) Wave-1 unit tests pass (in-process)
if (cd "$REPO_ROOT/mcp-server" && node --test test-1.1.6.js >/dev/null 2>&1); then
  pass "1.1.6: Wave-1 unit tests (test-1.1.6.js) all green"
else
  fail "1.1.6: Wave-1 unit tests failed"
fi

# 1.1.6b -- statusline + context bar gates
hdr "1.1.6b -- statusline + context bar gates"

# Wave-2 unit tests (statusline behavior + hot-path budget)
if (cd "$REPO_ROOT/mcp-server" && node --test test-1.1.6b.js >/dev/null 2>&1); then
  pass "1.1.6b: Wave-2 unit tests (test-1.1.6b.js) all green"
else
  fail "1.1.6b: Wave-2 unit tests failed"
fi

# statusline script exists + executable + hot-path renders under 500ms (CI ceiling)
STATUSLINE_JS="$ISO_HOME/.ijfw/claude/hooks/scripts/ijfw-statusline.js"
if [ -f "$STATUSLINE_JS" ]; then
  pass "1.1.6b: ijfw-statusline.js shipped"
else
  fail "1.1.6b: ijfw-statusline.js missing from install"
fi

CTX_MONITOR_JS="$ISO_HOME/.ijfw/claude/hooks/scripts/ijfw-context-monitor.js"
if [ -f "$CTX_MONITOR_JS" ]; then
  pass "1.1.6b: ijfw-context-monitor.js shipped"
else
  fail "1.1.6b: ijfw-context-monitor.js missing from install"
fi

# Statusline renders update nudge + context bar in cache-hit path
ST_HOME="$ISO_HOME/.ijfw"
mkdir -p "$ST_HOME/cache"
echo '{"schema_version":1,"installed_version":"1.1.5"}' > "$ST_HOME/state.json"
echo '{"schema_version":1,"last_check":1,"last_latest_seen":"1.1.6","last_failure":null}' > "$ST_HOME/cache/update-check.json"
ST_OUT=$(echo '{"context_window":{"remaining_percentage":50}}' | IJFW_HOME="$ST_HOME" node "$STATUSLINE_JS" 2>&1)
if echo "$ST_OUT" | grep -q '1.1.6 available' && echo "$ST_OUT" | grep -qE 'left|runway|used'; then
  pass "1.1.6b: statusline renders update nudge + context bar"
else
  fail "1.1.6b: statusline output unexpected: $ST_OUT"
fi

# Statusline suppresses nudge after re-entrancy sentinel
echo '{"schema_version":1,"installed_version":"1.1.5","last_applied_version":"1.1.6"}' > "$ST_HOME/state.json"
ST_OUT=$(echo '{"context_window":{"remaining_percentage":50}}' | IJFW_HOME="$ST_HOME" node "$STATUSLINE_JS" 2>&1)
if echo "$ST_OUT" | grep -q '1.1.6 available'; then
  fail "1.1.6b: re-entrancy sentinel did NOT suppress statusline nudge"
else
  pass "1.1.6b: re-entrancy sentinel suppresses statusline nudge"
fi

# Statusline fail-open: malformed cache + state -> exit 0
echo 'not json{' > "$ST_HOME/state.json"
echo 'also bad{' > "$ST_HOME/cache/update-check.json"
if echo 'garbage' | IJFW_HOME="$ST_HOME" node "$STATUSLINE_JS" >/dev/null 2>&1; then
  pass "1.1.6b: statusline fail-open invariant (exit 0 on garbage input)"
else
  fail "1.1.6b: statusline crashed on garbage input -- fail-open broken"
fi

# Cross-platform parity: memory prelude surfaces update nudge when behind
# (this is the path Codex/Gemini/Cursor/Windsurf/Copilot/Hermes/Wayland use)
echo '{"schema_version":1,"installed_version":"1.1.5"}' > "$ST_HOME/state.json"
echo '{"schema_version":1,"last_check":1,"last_latest_seen":"1.1.6","last_failure":null}' > "$ST_HOME/cache/update-check.json"
PRELUDE_OUT=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ijfw_memory_prelude","arguments":{"detail_level":"summary"}}}'
    sleep 0.4
  ) | IJFW_HOME="$ST_HOME" node "$SERVER_JS" 2>/dev/null
)
if echo "$PRELUDE_OUT" | grep -q 'IJFW update available'; then
  pass "1.1.6: prelude surfaces update nudge (Codex/Gemini/Cursor parity)"
else
  fail "1.1.6: prelude does NOT surface update nudge -- cross-platform parity broken"
fi

# Re-entrancy in prelude path: after sentinel set, prelude does NOT nudge
echo '{"schema_version":1,"installed_version":"1.1.5","last_applied_version":"1.1.6"}' > "$ST_HOME/state.json"
PRELUDE_OUT2=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.2
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ijfw_memory_prelude","arguments":{"detail_level":"summary"}}}'
    sleep 0.4
  ) | IJFW_HOME="$ST_HOME" node "$SERVER_JS" 2>/dev/null
)
if echo "$PRELUDE_OUT2" | grep -q 'IJFW update available'; then
  fail "1.1.6: prelude re-entrancy guard NOT working (still nudges after apply)"
else
  pass "1.1.6: prelude re-entrancy sentinel suppresses nudge"
fi

# Codex session-start fires bg update check (cross-platform parity)
if grep -q "ijfw-check-update.sh" "$ISO_HOME/.codex/hooks/session-start.sh" 2>/dev/null; then
  pass "1.1.6: Codex session-start.sh wires bg update-check"
else
  fail "1.1.6: Codex session-start.sh does NOT fire bg update-check"
fi

# Cross-platform per-turn status card (Codex + Gemini)
# Set up an isolated state so the composer surfaces a real nudge
SC_HOME="$(mktemp -d -t ijfw-sc-XXXXXX)"
mkdir -p "$SC_HOME/.ijfw/cache"
echo '{"schema_version":1,"installed_version":"1.1.5"}' > "$SC_HOME/.ijfw/state.json"
echo '{"schema_version":1,"last_check":1,"last_latest_seen":"1.1.6","last_failure":null}' > "$SC_HOME/.ijfw/cache/update-check.json"
ln -s "$REPO_ROOT/mcp-server" "$SC_HOME/.ijfw/mcp-server"

# Gemini AfterAgent hook should emit the status card via additionalContext
GEMINI_HOOK="$REPO_ROOT/gemini/extensions/ijfw/hooks/after-agent.sh"
if [ -f "$GEMINI_HOOK" ]; then
  GEM_OUT=$(echo '{"event":"AfterAgent","session_id":"test-12345678"}' | HOME="$SC_HOME" IJFW_HOME="$SC_HOME/.ijfw" bash "$GEMINI_HOOK" 2>/dev/null)
  if echo "$GEM_OUT" | grep -q '1.1.6 available' && echo "$GEM_OUT" | grep -q 'additionalContext'; then
    pass "1.1.6: Gemini AfterAgent emits status card with update nudge"
  else
    fail "1.1.6: Gemini AfterAgent did NOT emit status card: $GEM_OUT"
  fi
else
  fail "1.1.6: Gemini after-agent.sh missing"
fi

# Codex Stop hook should emit the status card via systemMessage (in receipt line)
CODEX_HOOK="$REPO_ROOT/codex/.codex/hooks/session-end.sh"
if [ -f "$CODEX_HOOK" ]; then
  COD_OUT=$(echo '{"event":"Stop","session_id":"test-12345678"}' | HOME="$SC_HOME" IJFW_HOME="$SC_HOME/.ijfw" bash "$CODEX_HOOK" 2>/dev/null | head -1)
  if echo "$COD_OUT" | grep -q '1.1.6 available' && echo "$COD_OUT" | grep -q 'systemMessage'; then
    pass "1.1.6: Codex Stop emits status card with update nudge"
  else
    fail "1.1.6: Codex Stop did NOT emit status card: $COD_OUT"
  fi
else
  fail "1.1.6: Codex session-end.sh missing"
fi

rm -rf "$SC_HOME"

# ============================================================
# SUMMARY
# ============================================================
hdr "Summary"
if [ "$FAILURES" -eq 0 ]; then
  printf "  %s+ ALL GATES PASSED+%s\n\n" "$B$C_GREEN" "$R"
  exit 0
else
  printf "  %s! %d gate(s) failed%s\n\n" "$B$C_RED" "$FAILURES" "$R"
  exit 1
fi
