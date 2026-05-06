#!/usr/bin/env bash
# IJFW one-shot installer.
#
# Merges the ijfw-memory MCP registration into each platform's existing config
# rather than overwriting. Existing user MCP servers, model preferences, and
# per-project trust settings are preserved. If no config exists, creates one.
#
# Usage:
#   bash scripts/install.sh                # installs everything detected
#   bash scripts/install.sh claude codex   # only listed platforms
#
# Safety:
#   - Backs up existing configs to <config>.bak.<timestamp> before modifying.
#   - Never prompts -- merge is always the safe default.
#   - Shows what was added/kept at the end.

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Canonicalize HOME the same way. On macOS /var/folders is a symlink to
# /private/var/folders, so a raw-HOME vs cd-P-resolved REPO_ROOT comparison
# would always miss the self-loop even when they point at the same inode.
# Self-loop guards below (PLUGIN_DST, MCP_DST) rely on this equality holding.
HOME_REAL="$(cd -P "$HOME" 2>/dev/null && pwd || printf '%s' "$HOME")"

# Opt-in dev-tree protection: set IJFW_PROTECT_DEV_TREE=1 to block the installer
# from writing platform configs when PWD is the source repo. Off by default --
# the common case is "run install.sh from the source, configure the host".
if [ "${IJFW_PROTECT_DEV_TREE:-0}" = "1" ] && [ -f "$PWD/.ijfw-source" ]; then
  printf "IJFW source-repo detected and IJFW_PROTECT_DEV_TREE=1 -- platform-rule writes skipped.\n"
  exit 1
fi

# Scope guard: when invoked with a non-default install dir (--dir <scratch>),
# skip the user-home-mutating steps so dogfood/E2E runs do not clobber the
# user's real ~/.ijfw, ~/.local/bin, or ~/.claude plugin cache. install.js
# sets IJFW_CUSTOM_DIR=1 when the user passes --dir to a non-canonical path.
IJFW_CUSTOM_DIR="${IJFW_CUSTOM_DIR:-0}"

# 1.1.6: source-tree auto-detect. When the installer runs with PWD inside
# the IJFW source repo, project-scoped writes (Cursor .cursor/, Copilot
# .github/copilot-instructions.md + .vscode/mcp.json, Codex .codex/, etc.)
# would litter the source tree. Detect via the installer's package.json
# "@ijfw/install" identifier + PWD-equals-repo-root check, and refuse
# project-scoped writes when matched. The legacy .ijfw-source marker +
# IJFW_PROTECT_DEV_TREE env still work as overrides.
IS_IJFW_SOURCE=0
PWD_REAL="$(cd -P "$PWD" 2>/dev/null && pwd || printf '%s' "$PWD")"
# Triple condition keeps the auto-detect tight enough that e2e/VNV isolated
# installs (which rsync the source without .git) still proceed normally:
#   1. PWD equals REPO_ROOT (running install.sh from the source root)
#   2. installer/package.json identifies as @ijfw/install
#   3. .git/ exists (a real git checkout, not an rsync copy)
if [ "$PWD_REAL" = "$REPO_ROOT" ] \
   && [ -f "$REPO_ROOT/installer/package.json" ] \
   && [ -d "$REPO_ROOT/.git" ]; then
  if grep -q '"name": *"@ijfw/install"' "$REPO_ROOT/installer/package.json" 2>/dev/null; then
    IS_IJFW_SOURCE=1
  fi
fi

DEFAULT_REPO="https://gitlab.com/therealseandonahoe/ijfw.git"

# Origin-URL migration parity with install.js cloneOrPull (W6.4).
# When the repo's canonical URL has moved, silently re-point origin so future
# git operations (e.g. `ijfw update`) use the current host. Only runs when
# REPO_ROOT is a real git checkout (not an rsync/zip unpack).
if [ -d "$REPO_ROOT/.git" ]; then
  _current_origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  # Only migrate origins that are known stale canonical URLs -- never clobber
  # SSH remotes, forks, or user-customized origins.
  _migrate_origin=0
  case "$_current_origin" in
    "https://github.com/seandonahoe/ijfw.git" \
    | "https://github.com/seandonahoe/ijfw" \
    | "https://github.com/seandonahoe/ijfw.git/" \
    | "https://github.com/seandonahoe/ijfw/") _migrate_origin=1 ;;
  esac
  if [ "$_migrate_origin" = "1" ]; then
    if git -C "$REPO_ROOT" remote set-url origin "$DEFAULT_REPO" 2>/dev/null; then
      printf '  origin migration: %s -> %s\n' "$_current_origin" "$DEFAULT_REPO"
    else
      printf '  [!] origin migration failed -- could not repoint %s to %s\n' "$_current_origin" "$DEFAULT_REPO" >&2
    fi
  fi
fi

LAUNCHER="$REPO_ROOT/mcp-server/bin/ijfw-memory"

# Cross-platform MCP command: every MCP config writes `node <server.js>` directly
# (matching the Claude branch). The bash LAUNCHER above is preserved for manual
# CLI invocation; MCP clients use the node path so the same JSON shape works on
# macOS, Linux, and Windows. Fixes #8 (Windows OpenCode silent MCP-load failure
# caused by writing a bash-script path into a Windows MCP config).
is_windows_host() {
  case "$(uname -s 2>/dev/null)" in
    CYGWIN*|MINGW*|MSYS_NT*) return 0 ;;
  esac
  return 1
}

# Convert a Git Bash POSIX path to a Windows-native path on Windows; passthrough
# elsewhere. Windows MCP clients (OpenCode, Codex, Cursor, ...) parse the JSON
# natively and need backslash/drive-letter paths -- not /c/Users/... POSIX paths.
winpath() {
  if is_windows_host && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

SERVER_JS="$REPO_ROOT/mcp-server/src/server.js"
SERVER_JS_NATIVE="$(winpath "$SERVER_JS")"

# ============================================================
# PRE-FLIGHT: verify environment before touching anything
# ============================================================
PREFLIGHT_PASS=1
preflight_fail() { printf "  [!] %s\n" "$1"; PREFLIGHT_PASS=0; }
preflight_ok()   { printf "  [+] %s\n" "$1"; }

printf "\n  Pre-flight check\n  ────────────────\n"

# 1. Node.js exists
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node"/*/bin/node "$HOME/.volta/bin/node" /usr/bin/node; do
    for resolved in $candidate; do
      [ -x "$resolved" ] && { NODE_BIN="$resolved"; break 2; }
    done
  done
fi
if [ -n "$NODE_BIN" ]; then
  NODE_VER="$("$NODE_BIN" --version 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    preflight_ok "Node.js $NODE_VER at $NODE_BIN"
  else
    preflight_fail "Node.js $NODE_VER is too old (need 18+). Update: brew install node"
  fi
else
  preflight_fail "Node.js not found. Install: brew install node (macOS) or https://nodejs.org"
fi

# 2. Git exists
if command -v git >/dev/null 2>&1; then
  preflight_ok "git $(git --version | head -1 | sed 's/git version //')"
else
  preflight_fail "git not found. Install: brew install git (macOS) or https://git-scm.com"
fi

# 3. Launcher script exists
if [ -f "$LAUNCHER" ]; then
  preflight_ok "MCP launcher at $LAUNCHER"
else
  preflight_fail "MCP launcher missing at $LAUNCHER"
fi

# 4. Write permissions
if mkdir -p "$HOME/.ijfw" 2>/dev/null && [ -w "$HOME/.ijfw" ]; then
  preflight_ok "Write access to ~/.ijfw/"
else
  preflight_fail "Cannot write to ~/.ijfw/. Fix: chmod u+w \"$HOME\" && mkdir -p \"$HOME/.ijfw\""
fi

# 5. Claude Code PATH warning (the bug that bit us)
if [ -n "$NODE_BIN" ]; then
  NODE_DIR="$(dirname "$NODE_BIN")"
  STANDARD_PATHS="/usr/local/bin:/usr/bin:/bin"
  case "$STANDARD_PATHS" in
    *"$NODE_DIR"*) preflight_ok "Node.js in standard PATH ($NODE_DIR)" ;;
    *)
      preflight_ok "Node.js at $NODE_DIR (will inject into Claude Code env.PATH)"
      ;;
  esac
fi

if [ "$PREFLIGHT_PASS" -eq 0 ]; then
  printf "\n  Pre-flight failed. Fix the issues above and re-run.\n\n"
  exit 1
fi
printf "  ────────────────\n  All checks passed. Installing...\n\n"

# Parse flags and platform targets from args.
INSTALL_POST_COMMIT_HOOK=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --post-commit-hook) INSTALL_POST_COMMIT_HOOK=1 ;;
    *) TARGETS+=("$arg") ;;
  esac
done
# 1.1.9: cline re-enabled in default TARGETS. Live-verified in VS Code 1.117 +
# Cline 3.80.0 via round-tripped `ijfw_memory_prelude` native tool call (log
# marker: `DEBUG [ToolCallProcessor] Native Tool Called: c04RcW0mcp0ijfw_memory_prelude`).
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(claude codex gemini cursor windsurf copilot hermes wayland opencode qwen cline kimi openclaw aider)

if [ ! -x "$LAUNCHER" ]; then
  _chmod_rc=0
  chmod +x "$LAUNCHER" 2>/dev/null || _chmod_rc=$?
  if [ "$_chmod_rc" -ne 0 ]; then
    printf '  [!] chmod +x %s failed (exit %d) -- launcher may not be executable\n' "$LAUNCHER" "$_chmod_rc" \
      >> "${IJFW_INSTALL_LOG:-$HOME/.ijfw/logs/install.log}" 2>/dev/null || true
  fi
fi
if [ ! -f "$LAUNCHER" ]; then
  printf "MCP launcher missing at %s. Re-run the installer from the IJFW source tree.\n" "$LAUNCHER" >&2
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)

# ============================================================
# PLUGIN LINK: ensure ~/.ijfw/claude points at the source repo
# ============================================================
# Claude Code expects the plugin at $HOME/.ijfw/claude (see settings.json
# extraKnownMarketplaces.ijfw.source.path). Always reconcile this link so:
#   1. Fresh installs create it.
#   2. Broken links (target moved/deleted) get fixed.
#   3. Wrong targets (stale path from scp'd-over config) get retargeted.
# Platform-aware: symlink on POSIX, directory copy on Windows (no symlinks
# without developer mode or admin).
PLUGIN_DST="$HOME_REAL/.ijfw/claude"
PLUGIN_SRC="$REPO_ROOT/claude"
IS_WINDOWS=0
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

# Canonicalize both sides with cd -P so symlinked REPO_ROOT (e.g. on macOS
# where /var/folders is a symlink to /private/var/folders) doesn't produce a
# false negative in the self-loop comparison.
PLUGIN_SRC_REAL="$(cd -P "$PLUGIN_SRC" 2>/dev/null && pwd || printf '%s' "$PLUGIN_SRC")"
PLUGIN_DST_REAL_CMP="$(cd -P "$PLUGIN_DST" 2>/dev/null && pwd || printf '%s' "$PLUGIN_DST")"

# Skip user-home sibling links entirely when scoped to a custom dir.
if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
  printf "  [+] Custom-dir install -- skipping ~/.ijfw/ sibling links (canonical-dir feature).\n"
elif [ "$PLUGIN_SRC_REAL" = "$PLUGIN_DST_REAL_CMP" ]; then
  # Self-loop guard: when REPO_ROOT == $HOME/.ijfw (user installed into the
  # canonical home and the source happens to live there), the plugin is
  # already at PLUGIN_DST. Symlinking would create a self-loop.
  printf "  [+] Plugin source already at canonical path -- symlink not needed.\n"
else
  mkdir -p "$HOME/.ijfw"
  if [ "$IS_WINDOWS" -eq 1 ]; then
    # No reliable symlinks on Windows without admin/dev-mode. Mirror the tree.
    if [ -d "$PLUGIN_DST" ] && [ ! -L "$PLUGIN_DST" ]; then
      cp -r "$PLUGIN_SRC"/. "$PLUGIN_DST"/
    else
      rm -rf "$PLUGIN_DST" 2>/dev/null || true
      cp -r "$PLUGIN_SRC" "$PLUGIN_DST"
    fi
  else
    # POSIX: symlink, retargeting if wrong, fixing if broken.
    if [ -L "$PLUGIN_DST" ]; then
      CUR_TARGET="$(readlink "$PLUGIN_DST")"
      if [ "$CUR_TARGET" != "$PLUGIN_SRC" ]; then
        ln -sfn "$PLUGIN_SRC" "$PLUGIN_DST"
      fi
    elif [ -e "$PLUGIN_DST" ]; then
      # Existing real directory -- preserve by renaming aside.
      mv "$PLUGIN_DST" "$PLUGIN_DST.backup.$TS"
      ln -sfn "$PLUGIN_SRC" "$PLUGIN_DST"
    else
      ln -sfn "$PLUGIN_SRC" "$PLUGIN_DST"
    fi
  fi
fi

# Verify the plugin manifest is reachable (catches symlink-into-emptiness).
if [ ! -f "$PLUGIN_DST/.claude-plugin/plugin.json" ]; then
  printf "  [!] Plugin at %s is missing .claude-plugin/plugin.json -- install may be incomplete.\n" "$PLUGIN_DST"
fi

# ============================================================
# 1.1.6: STATE + SETTINGS SEED -- durable facts + user preferences
# ============================================================
# State ownership model (v3 �section 1):
#   ~/.ijfw/state.json    durable facts written by installer + update flow
#   ~/.ijfw/settings.json user preferences (created once, never overwritten)
#   ~/.ijfw/cache/        disposable network results
#   ~/.ijfw/run/<sid>/    ephemeral per-session
#   ~/.ijfw/logs/         observability, rotated at 1MB
# Permissions: dir 0700, files 0600 -- only mutated in cold paths (here).
# State writes are unconditional: even custom-dir installs need state.json
# at $HOME/.ijfw because the MCP server resolves `homedir() + "/.ijfw"`
# regardless of the user's chosen install location. Without this, the
# version-detection path falls through to "0.0.0" and the in-band update
# nudge becomes inaccurate.
IJFW_STATE_DIR="$HOME_REAL/.ijfw"
mkdir -p "$IJFW_STATE_DIR/cache" "$IJFW_STATE_DIR/run" "$IJFW_STATE_DIR/logs"
chmod 700 "$IJFW_STATE_DIR" 2>/dev/null || true

# Detect install_method
INSTALL_METHOD="manual"
if [ -d "$REPO_ROOT/.git" ]; then
  INSTALL_METHOD="git-clone"
fi
NPM_GROOT="$(command -v npm >/dev/null 2>&1 && npm root -g 2>/dev/null || true)"
if [ -n "$NPM_GROOT" ] && [ "${REPO_ROOT#"$NPM_GROOT"}" != "$REPO_ROOT" ]; then
  INSTALL_METHOD="npm-global"
fi

# Read installed version from installer/package.json
INSTALLED_VER="$( [ -n "${NODE_BIN:-}" ] && "$NODE_BIN" -e '
  try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version || "0.0.0"); }
  catch { console.log("0.0.0"); }
' "$REPO_ROOT/installer/package.json" 2>/dev/null || echo "0.0.0" )"

NOW_TS="$(date +%s)"

# state.json -- always rewritten (durable facts, installer-owned)
STATE_TMP="$IJFW_STATE_DIR/state.json.tmp.$$"
cat > "$STATE_TMP" <<JSON
{
  "schema_version": 1,
  "install_method": "$INSTALL_METHOD",
  "installed_version": "$INSTALLED_VER",
  "last_applied_version": "$INSTALLED_VER",
  "last_good_shasum": null,
  "settings_reseeded_at": null,
  "installed_at": $NOW_TS
}
JSON
mv -f "$STATE_TMP" "$IJFW_STATE_DIR/state.json"
chmod 600 "$IJFW_STATE_DIR/state.json" 2>/dev/null || true

# settings.json -- seed only if absent (preserve user prefs across upgrades)
if [ ! -f "$IJFW_STATE_DIR/settings.json" ]; then
  if [ -f "$REPO_ROOT/installer/src/settings-seed.json" ]; then
    cp "$REPO_ROOT/installer/src/settings-seed.json" "$IJFW_STATE_DIR/settings.json.tmp.$$"
    mv -f "$IJFW_STATE_DIR/settings.json.tmp.$$" "$IJFW_STATE_DIR/settings.json"
    chmod 600 "$IJFW_STATE_DIR/settings.json" 2>/dev/null || true
  fi
fi

# install-method legacy file (back-compat for older callers)
printf '%s\n' "$INSTALL_METHOD" > "$IJFW_STATE_DIR/install-method"
chmod 600 "$IJFW_STATE_DIR/install-method" 2>/dev/null || true

printf "  [+] State seeded (%s, v%s)\n" "$INSTALL_METHOD" "$INSTALLED_VER"

# Statusline detection only runs on canonical-dir installs because it
# touches Claude Code's own settings.json and bin links.
if [ "$IJFW_CUSTOM_DIR" != "1" ]; then
  # ============================================================
  # 1.1.6b: statusline GSD detection + safe compose default.
  #
  # Decision matrix (v3 sec 8 + statusline behavior):
  #   - existing statusLine in claude settings, allowlisted path -> silent compose
  #   - existing statusLine, non-allowlist path                  -> skip + note
  #   - no existing statusLine                                   -> off (fresh install)
  # User can always run: ijfw statusline --install|--compose|--disable
  # ============================================================
  CLAUDE_SETTINGS="$HOME_REAL/.claude/settings.json"
  if [ -f "$CLAUDE_SETTINGS" ] && [ -n "${NODE_BIN:-}" ]; then
    EXISTING_STATUSLINE_CMD="$("$NODE_BIN" -e '
      try {
        const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(d.statusLine && d.statusLine.command ? d.statusLine.command : "");
      } catch { process.stdout.write(""); }
    ' "$CLAUDE_SETTINGS" 2>/dev/null || printf '')"
    if [ -n "$EXISTING_STATUSLINE_CMD" ]; then
      ALLOWLISTED=0
      case "$EXISTING_STATUSLINE_CMD" in
        *"/.claude/"*|*"/.gsd/"*|*"/.ijfw/claude/"*|*"/.cursor/"*) ALLOWLISTED=1 ;;
      esac
      if [ "$ALLOWLISTED" = "1" ]; then
        # Silent compose: persist the existing command in IJFW settings; the
        # statusline script renders alongside it. We do NOT mutate Claude's
        # settings.json -- the existing tool stays in charge until the user
        # explicitly runs `ijfw statusline --compose` to wrap.
        "$NODE_BIN" -e '
          const fs = require("fs"), p = process.argv[1], cmd = process.argv[2];
          let s = {}; try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch { s = {}; }
          if (!s.schema_version) s.schema_version = 1;
          if (!s.statusline) s.statusline = {};
          s.statusline.composed_command = cmd;
          s.statusline.mode = "compose";
          s.statusline.enabled = "auto";
          const tmp = p + ".tmp." + process.pid;
          fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
          fs.renameSync(tmp, p);
        ' "$IJFW_STATE_DIR/settings.json" "$EXISTING_STATUSLINE_CMD" 2>/dev/null || true
        printf "  [+] Composed alongside existing statusLine. Run 'ijfw statusline --disable' to opt out.\n"
      else
        printf "  [!] Existing statusLine at %s -- not composing for security.\n" "$EXISTING_STATUSLINE_CMD"
        printf "      Run 'ijfw statusline --install' to replace, or '--compose' if trusted.\n"
      fi
    else
      # No existing statusLine -- respect minimalists (v3 default change)
      printf "  [+] statusLine off by default. Run 'ijfw statusline --install' to enable.\n"
    fi
  fi
fi

# Patch the plugin's .mcp.json with an ABSOLUTE node path detected by
# pre-flight. Claude Code spawns MCP servers with an empty env by default,
# meaning "command": "node" fails because the subprocess has no PATH and
# can't resolve the node binary. Writing the absolute path sidesteps PATH
# entirely -- works on macOS, Linux, and Windows (where NODE_BIN is
# C:\...\node.exe).
# Skip for custom-dir installs so we don't mutate the user's real plugin .mcp.json.
# Also skip when PLUGIN_DST resolves into the IJFW source repo (dev installs
# where ~/.ijfw/claude is a symlink back to a clone) -- patching there would
# rewrite the source template with developer-machine-specific absolute paths.
PLUGIN_DST_REAL=""
if [ -e "$PLUGIN_DST" ]; then
  PLUGIN_DST_REAL="$(cd -P "$PLUGIN_DST" 2>/dev/null && pwd || printf '%s' "$PLUGIN_DST")"
fi
PLUGIN_TARGETS_SOURCE=0
if [ -n "$PLUGIN_DST_REAL" ] && [ -d "$REPO_ROOT/.git" ] \
   && [ "${PLUGIN_DST_REAL#"$REPO_ROOT"}" != "$PLUGIN_DST_REAL" ]; then
  PLUGIN_TARGETS_SOURCE=1
fi
if [ "$IJFW_CUSTOM_DIR" != "1" ] && [ "$PLUGIN_TARGETS_SOURCE" != "1" ] \
   && [ -n "${NODE_BIN:-}" ] && [ -f "$PLUGIN_DST/.mcp.json" ]; then
  ABS_SERVER_JS="$REPO_ROOT/mcp-server/src/server.js"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const p = process.argv[1];
    const nodeBin = process.argv[2];
    const serverJs = process.argv[3];
    const nodeDir = path.dirname(nodeBin);
    let d;
    try { d = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
    if (!d || !d.mcpServers || !d.mcpServers["ijfw-memory"]) process.exit(0);
    // Write ABSOLUTE paths for both node and server.js. Claude Code does not
    // reliably expand ${CLAUDE_PLUGIN_ROOT} inside args -- observed on Linux
    // where the literal value got mangled into a wrong path. Absolute paths
    // sidestep variable expansion entirely.
    d.mcpServers["ijfw-memory"].command = nodeBin;
    d.mcpServers["ijfw-memory"].args = [serverJs];
    const envSep = process.platform === "win32" ? ";" : ":";
    const commonPaths = process.platform === "win32"
      ? [nodeDir, "C:\\Windows\\System32"]
      : [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    const dedup = [...new Set(commonPaths.filter(x => x && fs.existsSync(x)))];
    d.mcpServers["ijfw-memory"].env = { PATH: dedup.join(envSep) };
    fs.writeFileSync(p + ".tmp", JSON.stringify(d, null, 2) + "\n");
    fs.renameSync(p + ".tmp", p);
  ' "$PLUGIN_DST/.mcp.json" "$NODE_BIN" "$ABS_SERVER_JS"
fi

# Nuke Claude Code's plugin cache for ijfw so the updated .mcp.json lands.
# Claude Code maintains its own copy of directory-source plugins at
# ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ and does NOT
# automatically re-sync on source changes. Cache invalidation is required
# after any plugin file update (hooks, skills, .mcp.json).
if [ "$IJFW_CUSTOM_DIR" != "1" ]; then
  CLAUDE_PLUGIN_CACHE="$HOME/.claude/plugins/cache/ijfw"
  if [ -d "$CLAUDE_PLUGIN_CACHE" ]; then
    rm -rf "$CLAUDE_PLUGIN_CACHE" 2>/dev/null || true
  fi
fi

# Also link/copy mcp-server as a SIBLING of the plugin so the plugin's
# .mcp.json args ("${CLAUDE_PLUGIN_ROOT}/../mcp-server/src/server.js") resolve
# correctly when Claude Code passes the symlinked CLAUDE_PLUGIN_ROOT path.
# Without this, ${CLAUDE_PLUGIN_ROOT}/../mcp-server looks for mcp-server under
# ~/.ijfw/ which doesn't exist -- plugin MCP spawn fails.
MCP_SRC="$REPO_ROOT/mcp-server"
MCP_DST="$HOME_REAL/.ijfw/mcp-server"

# Same scope guard for the MCP sibling link.
if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
  : # custom-dir install already skipped in plugin section above
else
  MCP_SRC_REAL="$(cd -P "$MCP_SRC" 2>/dev/null && pwd || printf '%s' "$MCP_SRC")"
  MCP_DST_REAL="$(cd -P "$MCP_DST" 2>/dev/null && pwd || printf '%s' "$MCP_DST")"
  if [ -n "$MCP_SRC_REAL" ] && [ "$MCP_SRC_REAL" = "$MCP_DST_REAL" ]; then
    # Self-loop guard: source and destination resolve to the same path.
    printf "  [+] MCP source already at canonical path -- symlink not needed.\n"
  elif [ "$IS_WINDOWS" -eq 1 ]; then
    if [ -d "$MCP_DST" ] && [ ! -L "$MCP_DST" ]; then
      cp -r "$MCP_SRC"/. "$MCP_DST"/
    else
      rm -rf "$MCP_DST" 2>/dev/null || true
      cp -r "$MCP_SRC" "$MCP_DST"
    fi
  else
    if [ -L "$MCP_DST" ]; then
      CUR_TARGET="$(readlink "$MCP_DST")"
      [ "$CUR_TARGET" != "$MCP_SRC" ] && ln -sfn "$MCP_SRC" "$MCP_DST"
    elif [ -e "$MCP_DST" ]; then
      mv "$MCP_DST" "$MCP_DST.backup.$TS"
      ln -sfn "$MCP_SRC" "$MCP_DST"
    else
      ln -sfn "$MCP_SRC" "$MCP_DST"
    fi
  fi
fi

if [ ! -f "$MCP_DST/src/server.js" ]; then
  printf "  [!] MCP server at %s is missing src/server.js -- install may be incomplete.\n" "$MCP_DST"
fi

# S6 -- prune backups older than 30 days from common config dirs.
for d in "$HOME/.codex" "$HOME/.gemini" "$HOME/.codeium/windsurf" "$HOME/.hermes" "$HOME/.wayland" ".vscode" ".cursor"; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 2 -name '*.bak.*' -type f -mtime +30 -print 2>/dev/null \
    | while IFS= read -r old; do rm -f "$old" 2>/dev/null; done
done

ok()   { printf "  [ok] %s\n" "$1"; }
note() { printf "  [--] %s\n" "$1"; }
info() { printf "  -- %s\n" "$1"; }

# ANSI colors. Skip if NO_COLOR is set or stdout is not a TTY.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_WHITE=$'\033[97m'; C_RED=$'\033[31m'
else
  C_RESET=; C_BOLD=; C_DIM=; C_CYAN=; C_GREEN=; C_YELLOW=; C_WHITE=; C_RED=
fi

# Native-path display: Git Bash sees /d/... style paths but users think in
# backslashes. Use cygpath -w when available to render native Windows form.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

# Runtime detection: "is this platform actually installed on the user's box?"
# True -> the platform goes in "Live now" -- configs fire immediately.
# False -> "Standing by" -- configs are pre-staged and auto-activate on install.
is_live() {
  case "$1" in
    claude)   command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ] ;;
    codex)    command -v codex  >/dev/null 2>&1 || [ -d "$HOME/.codex" ]  ;;
    gemini)   command -v gemini >/dev/null 2>&1 || [ -d "$HOME/.gemini" ] ;;
    cursor)   command -v cursor >/dev/null 2>&1 ;;
    windsurf) command -v windsurf >/dev/null 2>&1 || [ -d "$HOME/.codeium/windsurf" ] ;;
    copilot)  command -v code    >/dev/null 2>&1 || [ -d "$HOME/.vscode" ] || [ -d "$HOME/.config/Code" ] || [ -d "$HOME/Library/Application Support/Code" ] || [ -d "${APPDATA:-}/Code" ] ;;
    hermes)   command -v hermes  >/dev/null 2>&1 || [ -d "$HOME/.hermes" ] ;;
    wayland)  command -v wayland >/dev/null 2>&1 || [ -d "$HOME/.wayland" ] ;;
    opencode) command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ] ;;
    qwen)     command -v qwen >/dev/null 2>&1 || [ -d "$HOME/.qwen" ] ;;
    cline)    [ -d "$HOME/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/Library/Application Support/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/Library/Application Support/VSCodium/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/.config/Code/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/.config/VSCodium/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/.var/app/com.visualstudio.code/config/Code/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/snap/code/current/.config/Code/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "${APPDATA:-}/Code/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "${APPDATA:-}/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "${APPDATA:-}/VSCodium/User/globalStorage/saoudrizwan.claude-dev" ] \
              || [ -d "$HOME/.vscode/extensions" ] ;;
    kimi)     command -v kimi >/dev/null 2>&1 || [ -d "$HOME/.kimi" ] ;;
    openclaw) command -v openclaw >/dev/null 2>&1 || [ -d "$HOME/.openclaw" ] ;;
    aider)    command -v aider >/dev/null 2>&1 || [ -f "$HOME/.aider.conf.yml" ] ;;
    *) return 1 ;;
  esac
}

pretty_name() {
  case "$1" in
    claude)   printf 'Claude Code' ;;
    codex)    printf 'Codex' ;;
    gemini)   printf 'Gemini' ;;
    cursor)   printf 'Cursor' ;;
    windsurf) printf 'Windsurf' ;;
    copilot)  printf 'Copilot' ;;
    hermes)   printf 'Hermes' ;;
    wayland)  printf 'Wayland' ;;
    opencode) printf 'OpenCode' ;;
    qwen)     printf 'Qwen Code' ;;
    cline)    printf 'Cline' ;;
    kimi)     printf 'Kimi Code' ;;
    openclaw) printf 'OpenClaw' ;;
    aider)    printf 'Aider' ;;
    *)        printf '%s' "$1" ;;
  esac
}

backup() {
  local path="$1"
  if [ -f "$path" ]; then
    cp "$path" "$path.bak.$TS" 2>/dev/null && info "backup: $(basename "$path").bak.$TS"
  fi
}

_safe_checksum() {
  local f="$1"
  if command -v md5sum >/dev/null 2>&1; then md5sum "$f" 2>/dev/null | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then md5 -q "$f" 2>/dev/null
  elif command -v sha1sum >/dev/null 2>&1; then sha1sum "$f" 2>/dev/null | awk '{print $1}'
  else printf ''
  fi
  return 0
}

# install_hook <src> <dst>
# Always deploys the latest hook. If dst exists and differs from src:
#   - check if dst also differs from the original installed version (user-modified)
#   - if so, back up and log; otherwise silently overwrite.
install_hook() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  if [ -f "$dst" ]; then
    local src_sum dst_sum
    src_sum=$(_safe_checksum "$src")
    dst_sum=$(_safe_checksum "$dst")
    # 1.2.5 (B4.5): if no checksum util is on host (md5sum + md5 + sha1sum all
    # missing -- rare but real on stripped containers), both vars are empty
    # and would compare equal, so updates would be silently skipped. Force a
    # back-up-then-copy in that case so updates always apply.
    if [ -z "$src_sum" ] || [ -z "$dst_sum" ]; then
      cp "$dst" "$dst.bak.$TS" 2>/dev/null || true
      log "  [--] Updated $(basename "$dst") (no checksum util on host -- precautionary backup)"
    elif [ "$src_sum" = "$dst_sum" ]; then
      return 0  # identical -- nothing to do
    else
      cp "$dst" "$dst.bak.$TS" 2>/dev/null || true
      log "  [--] Updated $(basename "$dst") (your custom version backed up to $(basename "$dst").bak.$TS)"
    fi
  fi
  cp "$src" "$dst"
  chmod +x "$dst" 2>/dev/null || true
}

# --- OpenCode-shaped merge: top-level "mcp" with type:"local" + command:[arr] ---
# Verified against opencode-ai 1.14.20: rejects mcpServers with
# "Configuration is invalid ... Unrecognized key: mcpServers".
opencode_merge() {
  local dst="$1" server_js="$2"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const serverJs = process.argv[2];
    let doc = {};
    if (fs.existsSync(path)) {
      try { doc = JSON.parse(fs.readFileSync(path, "utf8") || "{}"); } catch { doc = {}; }
    }
    if (!doc || typeof doc !== "object") doc = {};
    doc.mcp = doc.mcp || {};
    // Cross-platform: command:["node", serverJs] -- works on Windows where the
    // bash launcher path cannot be spawned. Fixes #8.
    doc.mcp["ijfw-memory"] = { type: "local", command: ["node", serverJs] };
    fs.writeFileSync(path + ".tmp", JSON.stringify(doc, null, 2));
    fs.renameSync(path + ".tmp", path);
  ' "$dst" "$server_js"
}

# --- OpenClaw-shaped merge: ~/.openclaw/openclaw.json, mcp.servers.<name> nested ---
# Verified against openclaw 2026.4.21: src/cli/mcp-cli.ts + src/config/mcp-config.ts
# + src/config/paths.ts. Config file is "openclaw.json" (NOT "config.json").
# Used as fallback when `openclaw mcp set` CLI isn't on PATH.
openclaw_merge() {
  local dst="$1" server_js="$2"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const serverJs = process.argv[2];
    let doc = {};
    if (fs.existsSync(path)) {
      try { doc = JSON.parse(fs.readFileSync(path, "utf8") || "{}"); } catch { doc = {}; }
    }
    if (!doc || typeof doc !== "object") doc = {};
    if (!doc.mcp || typeof doc.mcp !== "object") doc.mcp = {};
    if (!doc.mcp.servers || typeof doc.mcp.servers !== "object") doc.mcp.servers = {};
    // Cross-platform: command:"node", args:[serverJs]. Fixes #8.
    doc.mcp.servers["ijfw-memory"] = { command: "node", args: [serverJs] };
    fs.writeFileSync(path + ".tmp", JSON.stringify(doc, null, 2));
    fs.renameSync(path + ".tmp", path);
  ' "$dst" "$server_js"
}

# --- Cline-shaped merge: VS Code globalStorage per-extension path ---
# Extension publisher id: saoudrizwan.claude-dev. Schema requires type:"stdio".
# Verified against Cline src/core/storage/disk.ts:227 + src/extension.ts:586
# + src/services/mcp/schemas.ts. ~/.cline/ is not read by any current Cline
# code path; VS Code globalStorage is the only live location.
# Writes stdout: the destination path (so callers can log it).
cline_merge() {
  local server_js="$1"
  local user_dir=""
  local _os; _os="$(uname -s 2>/dev/null)"
  # Build ordered candidate list; first existing globalStorage dir wins.
  local _candidates=()
  case "$_os" in
    Darwin)
      _candidates=(
        "$HOME/Library/Application Support/Code/User"
        "$HOME/Library/Application Support/Code - Insiders/User"
        "$HOME/Library/Application Support/VSCodium/User"
      )
      ;;
    CYGWIN*|MINGW*|MSYS_NT*)
      _candidates=(
        "${APPDATA:-$HOME/AppData/Roaming}/Code/User"
        "${APPDATA:-$HOME/AppData/Roaming}/Code - Insiders/User"
        "${APPDATA:-$HOME/AppData/Roaming}/VSCodium/User"
      )
      ;;
    *)
      _candidates=(
        "$HOME/.config/Code/User"
        "$HOME/.config/VSCodium/User"
        "$HOME/.var/app/com.visualstudio.code/config/Code/User"
        "$HOME/snap/code/current/.config/Code/User"
      )
      ;;
  esac
  for _c in "${_candidates[@]}"; do
    if [ -d "$_c/globalStorage/saoudrizwan.claude-dev" ]; then
      user_dir="$_c"; break
    fi
  done
  # Fall back to OS default when no existing install detected.
  if [ -z "$user_dir" ]; then
    case "$_os" in
      Darwin)              user_dir="$HOME/Library/Application Support/Code/User" ;;
      CYGWIN*|MINGW*|MSYS_NT*) user_dir="${APPDATA:-$HOME/AppData/Roaming}/Code/User" ;;
      *)                   user_dir="$HOME/.config/Code/User" ;;
    esac
  fi
  local dst="$user_dir/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const serverJs = process.argv[2];
    let doc = {};
    if (fs.existsSync(path)) {
      try { doc = JSON.parse(fs.readFileSync(path, "utf8") || "{}"); } catch { doc = {}; }
    }
    if (!doc || typeof doc !== "object") doc = {};
    doc.mcpServers = doc.mcpServers || {};
    // Cross-platform: command:"node", args:[serverJs]. Fixes #8.
    doc.mcpServers["ijfw-memory"] = {
      type: "stdio",
      command: "node",
      args: [serverJs],
      disabled: false,
      autoApprove: [],
      timeout: 60
    };
    fs.writeFileSync(path + ".tmp", JSON.stringify(doc, null, 2));
    fs.renameSync(path + ".tmp", path);
  ' "$dst" "$server_js"
  printf '%s' "$dst"
}

# --- JSON merge helper (Gemini / Cursor / Windsurf / Copilot / Qwen / Kimi) ---
# Parses existing JSON, sets mcpServers['ijfw-memory'], writes back formatted.
# Cross-platform: writes `command: "node", args: [serverJs]` so the JSON shape
# is identical on macOS, Linux, Windows (no bash launcher in config). Fixes #8.
merge_json() {
  local dst="$1" server_js="$2"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const serverJs = process.argv[2];
    let doc = {};
    if (fs.existsSync(path)) {
      try { doc = JSON.parse(fs.readFileSync(path, "utf8") || "{}"); } catch {
        // Corrupt existing config -- keep the backup, start fresh.
        doc = {};
      }
    }
    if (!doc || typeof doc !== "object") doc = {};
    doc.mcpServers = doc.mcpServers || {};
    // PATH override: macOS Claude strips PATH for spawned MCPs; harmless
    // elsewhere. On Windows we omit it (Windows uses Path with different
    // separator, and node is reliably on Path after preflight).
    const isWin = process.platform === "win32";
    const nodeDir = require("path").dirname(process.execPath);
    const envPath = isWin ? "" : [
      nodeDir, "/opt/homebrew/bin", "/usr/local/bin",
      process.env.HOME + "/.nvm/versions/node/" + process.version + "/bin",
      "/usr/bin", "/bin"
    ].filter(d => { try { return typeof d === "string" && d.length > 0 && require("fs").existsSync(d); } catch { return false; } }).join(":");
    const entry = { command: "node", args: [serverJs] };
    if (envPath) entry.env = { PATH: envPath };
    doc.mcpServers["ijfw-memory"] = entry;
    fs.writeFileSync(path + ".tmp", JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(path + ".tmp", path);
  ' "$dst" "$server_js"
}

# --- TOML merge helper (Codex) ---
# S4 -- atomic variant: write to sibling .tmp, append block, then atomic rename.
# Eliminates the crash-mid-pipeline window where $dst could be truncated.
merge_toml() {
  local dst="$1" server_js="$2"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  if [ ! -f "$dst" ]; then
    : > "$dst"
  fi
  local tmp="$dst.merge.$$.tmp"
  # Strip the [mcp_servers.ijfw-memory] section so the append below is idempotent.
  awk '
    BEGIN { skip = 0 }
    /^\[mcp_servers\.ijfw-memory\][[:space:]]*$/ { skip = 1; next }
    skip && /^\[/ && !/^\[mcp_servers\.ijfw-memory\]/ { skip = 0 }
    skip { next }
    { print }
  ' "$dst" > "$tmp" || { rm -f "$tmp"; return 1; }
  # Upsert codex_hooks = true inside [features], and the top-level
  # suppress_unstable_features_warning = true key (so users don't see the
  # under-development banner on every startup). Node-driven to avoid TOML-
  # section duplication on idempotent re-runs.
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    let text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    // --- [features] codex_hooks = true ---
    const key = "codex_hooks = true";
    if (/^\[features\]/m.test(text)) {
      if (!/^codex_hooks\s*=/m.test(text)) {
        text = text.replace(/^(\[features\][^\n]*\n)/m, "$1" + key + "\n");
      }
    } else {
      text = text.replace(/\n+$/, "") + "\n\n[features]\n" + key + "\n";
    }
    // --- top-level suppress_unstable_features_warning = true ---
    if (!/^suppress_unstable_features_warning\s*=/m.test(text)) {
      // Insert before the first section header so it stays in the root table.
      if (/^\[/m.test(text)) {
        text = text.replace(/^(\[)/m, "suppress_unstable_features_warning = true\n\n$1");
      } else {
        text = text.replace(/\n+$/, "") + "\nsuppress_unstable_features_warning = true\n";
      }
    }
    fs.writeFileSync(f, text);
  ' "$tmp" || { rm -f "$tmp"; return 1; }
  # Append the MCP server block. Cross-platform: command="node", args=[serverJs].
  # Fixes #8 (Windows Codex couldn't spawn the bash launcher).
  escaped_server_js=$(printf '%s' "$server_js" | sed 's/\\/\\\\/g; s/"/\\"/g')
  {
    printf '\n[mcp_servers.ijfw-memory]\n'
    printf 'command = "node"\n'
    printf 'args = ["%s"]\n' "$escaped_server_js"
    printf 'enabled = true\n'
    printf 'startup_timeout_sec = 10\n'
    printf 'tool_timeout_sec = 30\n'
  } >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$dst"
}

# --- YAML merge helper (Hermes / Wayland) ---
# Both CLIs share the schema ~/.<name>/config.yaml with an mcp_servers: top-level
# dict (command/args/env style, same as Codex TOML / Gemini JSON semantics). We
# prefer python3+PyYAML for parser-safe merging. If unavailable we fall back to
# a sentinel-anchored append, which stays idempotent across re-runs.
merge_yaml_mcp() {
  local dst="$1" server_js="$2"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  [ ! -f "$dst" ] && : > "$dst"
  # Try python3+PyYAML first (clean, schema-preserving).
  # Cross-platform: command="node", args=[serverJs]. Fixes #8.
  if python3 -c "import yaml" >/dev/null 2>&1; then
    python3 - "$dst" "$server_js" <<'PY'
import os, sys, yaml
dst, server_js = sys.argv[1], sys.argv[2]
with open(dst, "r") as f:
    raw = f.read()
doc = yaml.safe_load(raw) if raw.strip() else {}
if not isinstance(doc, dict):
    doc = {}
doc.setdefault("mcp_servers", {})
if not isinstance(doc["mcp_servers"], dict):
    doc["mcp_servers"] = {}
doc["mcp_servers"]["ijfw-memory"] = {
    "command": "node",
    "args": [server_js],
    "enabled": True,
}
tmp = dst + ".tmp"
with open(tmp, "w") as f:
    yaml.safe_dump(doc, f, sort_keys=False, default_flow_style=False)
os.replace(tmp, dst)
PY
    return 0
  fi
  # Fallback: sentinel-anchored strip-and-append (idempotent).
  local tmp="$dst.merge.$$.tmp"
  awk '
    BEGIN { skip = 0 }
    /^# IJFW-MCP-BEGIN ijfw-memory$/ { skip = 1; next }
    /^# IJFW-MCP-END ijfw-memory$/   { skip = 0; next }
    skip { next }
    { print }
  ' "$dst" > "$tmp" || { rm -f "$tmp"; return 1; }
  if ! grep -qE '^mcp_servers:' "$tmp"; then
    printf '\nmcp_servers:\n' >> "$tmp"
  fi
  escaped_server_js=$(printf '%s' "$server_js" | sed 's/"/\\"/g')
  {
    printf '# IJFW-MCP-BEGIN ijfw-memory\n'
    printf '  ijfw-memory:\n'
    printf '    command: "node"\n'
    printf '    args: ["%s"]\n' "$escaped_server_js"
    printf '    enabled: true\n'
    printf '# IJFW-MCP-END ijfw-memory\n'
  } >> "$tmp"
  mv "$tmp" "$dst"
}

# --- YAML plugins.enabled merge helper (Hermes opt-in allow-list) ---
# Hermes requires plugins.enabled[] in config.yaml (opt-in allow-list).
# This function adds <plugin_name> to that list, deduplicating if already
# present. Uses python3+PyYAML when available; falls back to sentinel-anchored
# append (same pattern as merge_yaml_mcp).
merge_yaml_plugins_enabled() {
  local dst="$1" plugin_name="$2"
  mkdir -p "$(dirname "$dst")"
  backup "$dst"
  [ ! -f "$dst" ] && : > "$dst"
  if python3 -c "import yaml" >/dev/null 2>&1; then
    python3 - "$dst" "$plugin_name" <<'PY'
import os, sys, yaml
dst, plugin_name = sys.argv[1], sys.argv[2]
with open(dst, "r") as f:
    raw = f.read()
doc = yaml.safe_load(raw) if raw.strip() else {}
if not isinstance(doc, dict):
    doc = {}
doc.setdefault("plugins", {})
if not isinstance(doc["plugins"], dict):
    doc["plugins"] = {}
enabled = doc["plugins"].get("enabled", [])
if not isinstance(enabled, list):
    enabled = []
if plugin_name not in enabled:
    enabled.append(plugin_name)
doc["plugins"]["enabled"] = enabled
tmp = dst + ".tmp"
with open(tmp, "w") as f:
    yaml.safe_dump(doc, f, sort_keys=False, default_flow_style=False)
os.replace(tmp, dst)
PY
    return 0
  fi
  # Fallback: sentinel-anchored strip-and-append (idempotent).
  local tmp="$dst.pluginsenable.$$.tmp"
  awk '
    BEGIN { skip = 0 }
    /^# IJFW-PLUGINS-BEGIN$/ { skip = 1; next }
    /^# IJFW-PLUGINS-END$/   { skip = 0; next }
    skip { next }
    { print }
  ' "$dst" > "$tmp" || { rm -f "$tmp"; return 1; }
  if ! grep -qE '^plugins:' "$tmp"; then
    printf '\nplugins:\n' >> "$tmp"
  fi
  if ! grep -qE '^\s+enabled:' "$tmp"; then
    printf '  enabled: []\n' >> "$tmp"
  fi
  {
    printf '# IJFW-PLUGINS-BEGIN\n'
    printf '# plugin %s registered by IJFW installer\n' "$plugin_name"
    printf '# IJFW-PLUGINS-END\n'
  } >> "$tmp"
  # Inline-append the name into the enabled list if not already present.
  if ! grep -qE "^\s+- $plugin_name\$" "$tmp"; then
    sed -i.bak "s/^  enabled: \[\]/  enabled:\n    - $plugin_name/" "$tmp" 2>/dev/null || \
    printf '    - %s\n' "$plugin_name" >> "$tmp"
    rm -f "$tmp.bak" 2>/dev/null || true
  fi
  mv "$tmp" "$dst"
}

# Route verbose per-platform chatter to a logfile. The console gets the
# tight Live-now / Standing-by summary at the end. Power users hit --verbose
# to see everything, or tail the log.
LOGFILE="${IJFW_INSTALL_LOG:-$HOME/.ijfw/install.log}"
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
: > "$LOGFILE" 2>/dev/null || LOGFILE=/dev/null

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
  esac
done

log() {
  if [ "$VERBOSE" -eq 1 ]; then printf '%s\n' "$1"; fi
  printf '%s\n' "$1" >> "$LOGFILE" 2>/dev/null || true
}

# Redefine ok/note/info to write through log() so the loop stays quiet by
# default. The original functions were console-only.
ok()   { log "  [ok] $1"; }
note() { log "  [--] $1"; }
info() { log "  -- $1"; }

log "IJFW install -- launcher: $LAUNCHER"
log ""

LIVE=()
STANDBY=()
FAILED=()
CLAUDE_NEEDS_RESTART=0

for target in "${TARGETS[@]}"; do
  case "$target" in
    claude)
      log "[Claude Code]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.claude/settings.json merge."
        ok "Claude Code: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      # Auto-register: write enabledPlugins + extraKnownMarketplaces into
      # ~/.claude/settings.json and ~/.claude/plugins/known_marketplaces.json.
      # Uses node for atomic read-modify-write; idempotent on re-run.
      CLAUDE_PLUGIN_PATH="$HOME/.ijfw/claude"
      CLAUDE_SETTINGS="$HOME/.claude/settings.json"
      CLAUDE_MARKETPLACES="$HOME/.claude/plugins/known_marketplaces.json"
      mkdir -p "$HOME/.claude/plugins" 2>/dev/null || true
      # Backup settings.json before modifying.
      backup "$CLAUDE_SETTINGS"
      node -e '
        const fs = require("fs");
        const settingsPath = process.argv[1];
        const pluginPath   = process.argv[2];
        const now = new Date().toISOString();

        // --- settings.json ---
        let settings = {};
        if (fs.existsSync(settingsPath)) {
          try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}"); } catch { settings = {}; }
        }
        if (!settings || typeof settings !== "object") settings = {};
        settings.enabledPlugins = settings.enabledPlugins || {};
        settings.enabledPlugins["ijfw@ijfw"] = true;
        settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
        settings.extraKnownMarketplaces["ijfw"] = {
          source: { source: "directory", path: pluginPath }
        };
        fs.writeFileSync(settingsPath + ".tmp", JSON.stringify(settings, null, 2) + "\n");
        fs.renameSync(settingsPath + ".tmp", settingsPath);

        // --- known_marketplaces.json ---
        const mpPath = process.argv[3];
        let mp = {};
        if (fs.existsSync(mpPath)) {
          try { mp = JSON.parse(fs.readFileSync(mpPath, "utf8") || "{}"); } catch { mp = {}; }
        }
        if (!mp || typeof mp !== "object") mp = {};
        mp["ijfw"] = {
          source: { source: "directory", path: pluginPath },
          installLocation: pluginPath,
          lastUpdated: now
        };
        fs.writeFileSync(mpPath + ".tmp", JSON.stringify(mp, null, 2) + "\n");
        fs.renameSync(mpPath + ".tmp", mpPath);
      ' "$CLAUDE_SETTINGS" "$CLAUDE_PLUGIN_PATH" "$CLAUDE_MARKETPLACES"

      # Register MCP server in Claude's settings.json (redundant with plugin's
      # own .mcp.json but provides a fallback when the plugin hasn't been
      # activated yet). Cross-platform: direct node invocation, no bash
      # launcher, no PATH manipulation. Stale absolute paths in existing
      # settings get detected and rewritten. SERVER_JS_NATIVE is converted
      # to a Windows-native path on Windows (Git Bash) so Claude Code Windows
      # build can spawn node with the correct path.
      node -e '
        const fs = require("fs");
        const path = require("path");
        const settingsPath = process.argv[1];
        const serverJs     = process.argv[2];
        let settings = {};
        if (fs.existsSync(settingsPath)) {
          try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}"); } catch { settings = {}; }
        }
        if (!settings || typeof settings !== "object") settings = {};
        settings.mcpServers = settings.mcpServers || {};

        // Stale-path detection: if existing config points at a launcher that
        // no longer exists (e.g. scp-migrated settings from a different host),
        // drop it so we write a fresh one below.
        const existing = settings.mcpServers["ijfw-memory"];
        if (existing && existing.command) {
          const cmd = existing.command;
          // Only verify absolute paths -- bare "node" is always valid.
          if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
            // Stale -- drop it so we write fresh config below.
            delete settings.mcpServers["ijfw-memory"];
          }
        }

        // Write cross-platform config: direct node invocation with an absolute
        // path to server.js. Works identically on macOS, Linux, Windows --
        // Claude Code spawns Node (which is on PATH wherever CC runs) and Node
        // handles path resolution.
        settings.mcpServers["ijfw-memory"] = {
          command: "node",
          args: [serverJs],
          env: {}
        };
        fs.writeFileSync(settingsPath + ".tmp", JSON.stringify(settings, null, 2) + "\n");
        fs.renameSync(settingsPath + ".tmp", settingsPath);
      ' "$CLAUDE_SETTINGS" "$SERVER_JS_NATIVE"

      # Ensure launcher is executable (zip transfers may strip chmod +x).
      _chmod_rc2=0
      chmod +x "$LAUNCHER" 2>/dev/null || _chmod_rc2=$?
      if [ "$_chmod_rc2" -ne 0 ]; then
        printf '  [!] chmod +x %s failed (exit %d) -- launcher may not be executable\n' "$LAUNCHER" "$_chmod_rc2" \
          >> "${IJFW_INSTALL_LOG:-$HOME/.ijfw/logs/install.log}" 2>/dev/null || true
      fi

      ok "Claude Code ready."
      note ".claudeignore template at $REPO_ROOT/claude/.claudeignore"
      note "  Copy to your project root for instant context savings."
      # D-F1: if Claude Code is currently running, surface a prominent restart note.
      # Use exact binary match (-x claude) to avoid false positives on claude-mem,
      # claudette, or any binary containing "claude" in its argv.
      if pgrep -x claude >/dev/null 2>&1; then
        CLAUDE_NEEDS_RESTART=1
      fi
      ;;
    codex)
      log "[Codex CLI]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.codex/ merges."
        ok "Codex: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      # Merge MCP registration into user config.toml.
      dst="$HOME/.codex/config.toml"
      merge_toml "$dst" "$SERVER_JS_NATIVE"
      # Merge IJFW entries into ~/.codex/hooks.json (additive, idempotent).
      mkdir -p "$HOME/.codex/hooks"
      _hooks_dst="$HOME/.codex/hooks.json"
      _hooks_src="$REPO_ROOT/codex/.codex/hooks.json"
      # Build absolute-path IJFW entries pointing at where the hook scripts
      # are actually installed (line below: install_hook ... "$HOME/.codex/hooks/$bname").
      _hooks_base="$HOME/.codex/hooks"
      node -e '
        const fs = require("fs");
        const dst = process.argv[1];
        const src = process.argv[2];
        const base = process.argv[3];
        // Codex hooks.json schema (authoritative as of codex-cli 0.122.x):
        //   { "hooks": { EventName: [ MatcherGroup, ... ] } }
        //   MatcherGroup = { matcher?: string, hooks: [{type:"command", command, timeout?, ...}] }
        // Valid events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PermissionRequest.
        // Read side: migrate from legacy shapes so users upgrading dont break.
        let doc = {};
        let rawForBackup = null;
        if (fs.existsSync(dst)) {
          rawForBackup = fs.readFileSync(dst, "utf8");
          try { doc = JSON.parse(rawForBackup || "{}"); } catch { doc = {}; }
        }
        // Detect legacy shape (bare array, or hooks-as-array) and snapshot the
        // file before rewriting so non-IJFW entries are recoverable. Codex moved
        // to {hooks: {EventName: [...]}} -- prior shapes do not survive the
        // structural shift, but we never silently drop user data.
        const isLegacyShape =
          (Array.isArray(doc)) ||
          (doc && typeof doc === "object" && doc.hooks && (Array.isArray(doc.hooks) || typeof doc.hooks !== "object"));
        if (isLegacyShape && rawForBackup) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const backup = dst + ".legacy.bak." + ts;
          try { fs.writeFileSync(backup, rawForBackup); console.error("[install] preserved legacy hooks.json at " + backup); } catch {}
        }
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
        if (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)) doc.hooks = {};
        const VALID_EVENTS = ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Stop","PermissionRequest"];
        for (const ev of VALID_EVENTS) {
          if (!Array.isArray(doc.hooks[ev])) doc.hooks[ev] = [];
          // Drop any prior IJFW matcher-group (idempotent re-run).
          doc.hooks[ev] = doc.hooks[ev].filter(g => {
            if (!g || !Array.isArray(g.hooks)) return true;
            return !g.hooks.some(h => h && h._ijfw);
          });
        }
        // Load IJFW source (new nested shape) and rewrite command paths to absolute.
        // Codex shell-parses the command value (verified empirically: a path with
        // spaces fires "hook: ... Failed"), so single-quote any path containing
        // shell-special chars. POSIX single-quote escape: end-quote + backslash-
        // single-quote + start-quote to embed a literal single quote.
        // Quote unless the path is fully POSIX-safe (alphanum + . _ / @ -).
        // Allowlist is more conservative than a deny-set: catches []!*?<> etc.
        // without enumerating every shell metachar.
        function shellQuote(p) {
          if (/^[A-Za-z0-9_./@-]+$/.test(p)) return p;
          return "\x27" + p.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
        }
        const ijfw = JSON.parse(fs.readFileSync(src, "utf8"));
        const srcHooks = (ijfw && ijfw.hooks) ? ijfw.hooks : {};
        for (const [ev, groups] of Object.entries(srcHooks)) {
          if (!VALID_EVENTS.includes(ev)) continue;
          if (!Array.isArray(groups)) continue;
          for (const g of groups) {
            if (!g || !Array.isArray(g.hooks)) continue;
            const rewritten = g.hooks.map(h => {
              if (!h || h.type !== "command" || !h.command) return h;
              const cmd = shellQuote(base + "/" + String(h.command).replace(/^hooks\//, ""));
              return { ...h, command: cmd };
            });
            doc.hooks[ev].push({ ...(g.matcher ? { matcher: g.matcher } : {}), hooks: rewritten });
          }
        }
        fs.writeFileSync(dst + ".tmp", JSON.stringify(doc, null, 2) + "\n");
        fs.renameSync(dst + ".tmp", dst);
      ' "$_hooks_dst" "$_hooks_src" "$_hooks_base"
      # Copy hook scripts -- always deploy latest; back up user-modified versions.
      for hscript in "$REPO_ROOT/codex/.codex/hooks/"*.sh; do
        bname=$(basename "$hscript")
        install_hook "$hscript" "$HOME/.codex/hooks/$bname"
      done
      # Drop IJFW context file (absorbs old instructions.md; merge-safe).
      if [ ! -f "$HOME/.codex/IJFW.md" ]; then
        cp "$REPO_ROOT/codex/.codex/IJFW.md" "$HOME/.codex/IJFW.md"
      fi
      # Drop skills to ~/.codex/skills/ (project skills go to .codex/skills/).
      mkdir -p "$HOME/.codex/skills"
      for skill_dir in "$REPO_ROOT/codex/skills/"*/; do
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$HOME/.codex/skills/$skill_name" ]; then
          cp -r "$skill_dir" "$HOME/.codex/skills/$skill_name"
        fi
      done
      # Also drop skills to project .codex/skills/ if we're in a project.
      if [ -f ".codex/config.toml" ] || [ -d ".ijfw" ]; then
        mkdir -p ".codex/skills"
        for skill_dir in "$REPO_ROOT/codex/skills/"*/; do
          skill_name=$(basename "$skill_dir")
          if [ ! -d ".codex/skills/$skill_name" ]; then
            cp -r "$skill_dir" ".codex/skills/$skill_name"
          fi
        done
      fi
      ok "Installed Codex bundle: MCP + hooks + 15 skills + context"
      ;;
    gemini)
      log "[Gemini CLI]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.gemini/ merges."
        ok "Gemini: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      # Merge MCP registration into user settings.json.
      dst="$HOME/.gemini/settings.json"
      merge_json "$dst" "$SERVER_JS_NATIVE"
      # Drop full extension bundle to ~/.gemini/extensions/ijfw/.
      # Never overwrite files the user has modified (check mtime vs repo).
      EXT_DST="$HOME/.gemini/extensions/ijfw"
      EXT_SRC="$REPO_ROOT/gemini/extensions/ijfw"
      mkdir -p "$EXT_DST/hooks" "$EXT_DST/skills" "$EXT_DST/commands" \
               "$EXT_DST/agents" "$EXT_DST/policies" 2>/dev/null || true
      # Manifest, context file, hooks.json, policy -- copy if absent.
      for f in gemini-extension.json IJFW.md hooks/hooks.json policies/ijfw.toml; do
        if [ ! -f "$EXT_DST/$f" ]; then
          ddir=$(dirname "$EXT_DST/$f")
          mkdir -p "$ddir" 2>/dev/null || true
          cp "$EXT_SRC/$f" "$EXT_DST/$f" 2>/dev/null || true
        fi
      done
      # Expand {{extensionPath}} in hooks.json to the absolute install dir.
      # Gemini CLI does NOT expand this template variable (verified empirically
      # 2026-04-25 on Ubuntu 24.04 + Gemini hook: "bash: {{extensionPath}}/...:
      # No such file or directory"). The IJFW-shipped hooks.json carries the
      # literal "{{extensionPath}}" string from the source tree, so we resolve
      # it to "$EXT_DST" at install time. Idempotent: only acts when the
      # literal placeholder is still present, so user-edited files are left
      # alone. Replacement uses perl with \Q...\E literal-quote on the
      # pattern and an env-var on the replacement: this is the only form
      # that survives `&`, `|`, and `\` in $HOME without escape gymnastics
      # (codex + gemini Round-5 audit close -- sed and awk gsub both treat
      # `&` as the matched-text backref). Perl is on every Linux + macOS
      # default install, so portability is fine.
      if [ -f "$EXT_DST/hooks/hooks.json" ] && grep -q '{{extensionPath}}' "$EXT_DST/hooks/hooks.json" 2>/dev/null; then
        # Pass $EXT_DST to perl as $ARGV[0] (literal) -- no env-var leak, no
        # regex metacharacter risk, no shellcheck SC2097/SC2098 ambiguity.
        # Perl shifts the path arg out of @ARGV before the file-loop processes
        # the hooks.json target.
        perl -pe 'BEGIN { $ext = shift @ARGV } s/\Q{{extensionPath}}\E/$ext/g' \
          "$EXT_DST" "$EXT_DST/hooks/hooks.json" > "$EXT_DST/hooks/hooks.json.new" \
          && mv "$EXT_DST/hooks/hooks.json.new" "$EXT_DST/hooks/hooks.json"
      fi
      # Hook scripts -- always deploy latest; back up user-modified versions.
      for hscript in "$EXT_SRC/hooks/"*.sh; do
        bname=$(basename "$hscript")
        install_hook "$hscript" "$EXT_DST/hooks/$bname"
      done
      # Skills -- copy if absent.
      for skill_dir in "$EXT_SRC/skills/"*/; do
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$EXT_DST/skills/$skill_name" ]; then
          cp -r "$skill_dir" "$EXT_DST/skills/$skill_name"
        fi
      done
      # TOML commands -- copy if absent.
      for cmd_file in "$EXT_SRC/commands/"*.toml; do
        bname=$(basename "$cmd_file")
        if [ ! -f "$EXT_DST/commands/$bname" ]; then
          cp "$cmd_file" "$EXT_DST/commands/$bname"
        fi
      done
      # Agents -- copy if absent.
      for agent_file in "$EXT_SRC/agents/"*.md; do
        bname=$(basename "$agent_file")
        if [ ! -f "$EXT_DST/agents/$bname" ]; then
          cp "$agent_file" "$EXT_DST/agents/$bname"
        fi
      done
      ok "Installed Gemini bundle: MCP + extension + 15 skills + 11 hooks + policy"
      ;;
    cursor)
      log "[Cursor]"
      if [ "$IS_IJFW_SOURCE" = "1" ]; then
        info "IJFW source tree detected -- skipping Cursor project writes (would litter source)."
        ok "Cursor: source tree left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst=".cursor/mcp.json"
      merge_json "$dst" "$SERVER_JS_NATIVE"
      mkdir -p .cursor/rules
      cp "$REPO_ROOT/cursor/.cursor/rules/ijfw.mdc" .cursor/rules/ijfw.mdc
      ok "Merged MCP + installed rule to project ./.cursor/"
      ;;
    windsurf)
      log "[Windsurf]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ] || [ "$IS_IJFW_SOURCE" = "1" ]; then
        info "Skipping Windsurf platform writes (custom-dir or IJFW source tree)."
        ok "Windsurf: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst="$HOME/.codeium/windsurf/mcp_config.json"
      merge_json "$dst" "$SERVER_JS_NATIVE"
      # W4.1 / E2 -- copy the .windsurfrules to the current project.
      if [ ! -f ".windsurfrules" ] && [ -f "$REPO_ROOT/windsurf/.windsurfrules" ]; then
        cp "$REPO_ROOT/windsurf/.windsurfrules" .windsurfrules 2>/dev/null \
          && ok "Merged MCP + installed .windsurfrules" \
          || ok "Merged MCP into $dst"
      else
        ok "Merged MCP into $dst"
      fi
      ;;
    copilot)
      log "[Copilot (VS Code)]"
      if [ "$IS_IJFW_SOURCE" = "1" ]; then
        info "IJFW source tree detected -- skipping Copilot project writes (would litter source)."
        ok "Copilot: source tree left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst=".vscode/mcp.json"
      merge_json "$dst" "$SERVER_JS_NATIVE"
      # W4.1 / E2 -- copy the copilot-instructions.md to .github/ (Copilot's
      # project-instructions convention) if not already present.
      if [ ! -f ".github/copilot-instructions.md" ] && [ -f "$REPO_ROOT/copilot/copilot-instructions.md" ]; then
        mkdir -p .github 2>/dev/null || true
        cp "$REPO_ROOT/copilot/copilot-instructions.md" .github/copilot-instructions.md 2>/dev/null \
          && ok "Merged MCP + installed .github/copilot-instructions.md" \
          || ok "Merged MCP into project ./.vscode/mcp.json"
      else
        ok "Merged MCP into project ./.vscode/mcp.json"
      fi
      ;;
    hermes)
      log "[Hermes]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.hermes/ merges."
        ok "Hermes: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst="$HOME/.hermes/config.yaml"
      merge_yaml_mcp "$dst" "$SERVER_JS_NATIVE"
      # Drop HERMES.md context file if absent (don't overwrite user edits).
      if [ ! -f "$HOME/.hermes/HERMES.md" ] && [ -f "$REPO_ROOT/hermes/HERMES.md" ]; then
        mkdir -p "$HOME/.hermes" 2>/dev/null || true
        cp "$REPO_ROOT/hermes/HERMES.md" "$HOME/.hermes/HERMES.md" 2>/dev/null || true
      fi
      # Skills: Hermes reads ~/.hermes/skills/<name>/SKILL.md (agentskills.io format).
      # IJFW's shared/skills/ is already in that format -- copy new ones only.
      mkdir -p "$HOME/.hermes/skills" 2>/dev/null || true
      for skill_dir in "$REPO_ROOT/shared/skills/"*/; do
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$HOME/.hermes/skills/$skill_name" ]; then
          cp -r "$skill_dir" "$HOME/.hermes/skills/$skill_name"
        fi
      done
      # Plugin: copy wayland-parity plugin layer to ~/.hermes/plugins/ijfw/.
      if [ -d "$REPO_ROOT/hermes/plugins/ijfw" ]; then
        mkdir -p "$HOME/.hermes/plugins/ijfw" 2>/dev/null || true
        find "$REPO_ROOT/hermes/plugins/ijfw" -mindepth 1 -maxdepth 1 \
          ! -name '__pycache__' -exec cp -r {} "$HOME/.hermes/plugins/ijfw/" \;
      fi
      # Hermes uses an opt-in allow-list -- add "ijfw" to plugins.enabled[].
      merge_yaml_plugins_enabled "$HOME/.hermes/config.yaml" "ijfw"
      ok "Installed Hermes bundle: MCP + HERMES.md + skills + plugin"
      ;;
    wayland)
      log "[Wayland]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.wayland/ merges."
        ok "Wayland: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst="$HOME/.wayland/config.yaml"
      merge_yaml_mcp "$dst" "$SERVER_JS_NATIVE"
      # Drop WAYLAND.md context file if absent.
      if [ ! -f "$HOME/.wayland/WAYLAND.md" ] && [ -f "$REPO_ROOT/wayland/WAYLAND.md" ]; then
        mkdir -p "$HOME/.wayland" 2>/dev/null || true
        cp "$REPO_ROOT/wayland/WAYLAND.md" "$HOME/.wayland/WAYLAND.md" 2>/dev/null || true
      fi
      # Skills: Wayland reads ~/.wayland/skills/<name>/SKILL.md.
      mkdir -p "$HOME/.wayland/skills" 2>/dev/null || true
      for skill_dir in "$REPO_ROOT/shared/skills/"*/; do
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$HOME/.wayland/skills/$skill_name" ]; then
          cp -r "$skill_dir" "$HOME/.wayland/skills/$skill_name"
        fi
      done
      # Plugin: copy wayland-parity plugin layer to ~/.wayland/plugins/ijfw/.
      if [ -d "$REPO_ROOT/wayland/plugins/ijfw" ]; then
        mkdir -p "$HOME/.wayland/plugins/ijfw" 2>/dev/null || true
        find "$REPO_ROOT/wayland/plugins/ijfw" -mindepth 1 -maxdepth 1 \
          ! -name '__pycache__' -exec cp -r {} "$HOME/.wayland/plugins/ijfw/" \;
      fi
      ok "Installed Wayland bundle: MCP + WAYLAND.md + skills + plugin"
      ;;
    opencode)
      log "[OpenCode]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.config/opencode/ merge."
        ok "OpenCode: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst="$HOME/.config/opencode/opencode.json"
      opencode_merge "$dst" "$SERVER_JS_NATIVE"
      ok "Merged MCP into $dst (opencode mcp.local schema)"
      ;;
    qwen)
      log "[Qwen Code]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.qwen/ merge."
        ok "Qwen Code: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst="$HOME/.qwen/settings.json"
      merge_json "$dst" "$SERVER_JS_NATIVE"
      ok "Merged MCP into $dst"
      ;;
    cline)
      log "[Cline]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping Cline merges."
        ok "Cline: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      # Cline MCP config lives under VS Code's globalStorage for extension
      # saoudrizwan.claude-dev -- platform-specific path resolved inside cline_merge.
      dst=$(cline_merge "$SERVER_JS_NATIVE")
      ok "Merged MCP into $dst (cline globalStorage schema)"
      ;;
    kimi)
      log "[Kimi Code]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping ~/.kimi/ merge."
        ok "Kimi Code: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      dst="$HOME/.kimi/mcp.json"
      merge_json "$dst" "$SERVER_JS_NATIVE"
      ok "Merged MCP into $dst"
      ;;
    openclaw)
      log "[OpenClaw]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping OpenClaw merges."
        ok "OpenClaw: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      # OpenClaw MCP config: ~/.openclaw/openclaw.json, mcp.servers.<name> nested.
      # Verified against openclaw 2026.4.21 (src/cli/mcp-cli.ts, src/config/mcp-config.ts,
      # src/config/paths.ts). The `openclaw mcp set` shell subcommand is the official
      # path and runs the daemon validator, so we prefer it when the CLI is on PATH.
      # Direct file-write fallback handles the "standing by" case where OpenClaw
      # isn't installed yet; it will be picked up the moment the user installs it.
      dst="$HOME/.openclaw/openclaw.json"
      if command -v openclaw >/dev/null 2>&1 \
         && openclaw mcp set ijfw-memory "{\"command\":\"node\",\"args\":[\"$SERVER_JS_NATIVE\"]}" >/dev/null 2>&1; then
        ok "Registered ijfw-memory via 'openclaw mcp set' ($dst)"
      else
        openclaw_merge "$dst" "$SERVER_JS_NATIVE"
        ok "Merged MCP into $dst (openclaw mcp.servers schema)"
      fi
      ;;
    aider)
      log "[Aider]"
      if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
        info "Custom-dir install -- skipping Aider merges."
        ok "Aider: real platform config left untouched."
        log ""
        if is_live "$target"; then LIVE+=("$(pretty_name "$target")"); else STANDBY+=("$(pretty_name "$target")"); fi
        continue
      fi
      # Aider has no native MCP client. Tier 3: ship rules-only via
      # ~/.aider.conf.yml + ~/CONVENTIONS.md (Aider's documented convention
      # files for project-wide style + system prompt).
      if [ ! -f "$HOME/.aider.conf.yml" ] && [ -f "$REPO_ROOT/aider/aider.conf.yml" ]; then
        cp "$REPO_ROOT/aider/aider.conf.yml" "$HOME/.aider.conf.yml" 2>/dev/null || true
      fi
      if [ ! -f "$HOME/CONVENTIONS.md" ] && [ -f "$REPO_ROOT/aider/CONVENTIONS.md" ]; then
        cp "$REPO_ROOT/aider/CONVENTIONS.md" "$HOME/CONVENTIONS.md" 2>/dev/null || true
      fi
      ok "Aider: rules-only install (~/.aider.conf.yml + ~/CONVENTIONS.md). No MCP -- Aider lacks a native MCP client."
      ;;
    *)
      info "skipping unknown target: $target"
      continue
      ;;
  esac
  log ""
  # Classify: live if the platform's runtime is detectable on this machine,
  # standing-by if we pre-staged config for when they install it later.
  if is_live "$target"; then
    LIVE+=("$(pretty_name "$target")")
  else
    STANDBY+=("$(pretty_name "$target")")
  fi
done

# --- Shared post-install steps (run once, platform-agnostic) ---
# Deploy patterns.json to ~/.ijfw/shared/lib/ so all plugin adapters can read it.
if [ -f "$REPO_ROOT/shared/lib/patterns.json" ]; then
  mkdir -p "$HOME/.ijfw/shared/lib" 2>/dev/null || true
  cp "$REPO_ROOT/shared/lib/patterns.json" "$HOME/.ijfw/shared/lib/patterns.json" 2>/dev/null || true
fi
# Regenerate per-platform rules files from shared/rules/IJFW.md.
# Output files (wayland/WAYLAND.md, hermes/HERMES.md, claude/rules/IJFW-CLAUDE.md)
# are committed to the repo; this keeps them in sync after any install.
if command -v node >/dev/null 2>&1; then
  node "$REPO_ROOT/scripts/generate-platform-rules.js" 2>/dev/null || true
fi

# --- Polished summary (Homebrew + rustup aesthetic) ---
NATIVE_REPO="$(native_path "$REPO_ROOT")"
NATIVE_LOG="$(native_path "$LOGFILE")"

echo
printf '  %s+----------------------------------------+%s\n'   "$C_BOLD$C_CYAN" "$C_RESET"
printf '  %s|%s                                        %s|%s\n' "$C_BOLD$C_CYAN" "$C_RESET" "$C_BOLD$C_CYAN" "$C_RESET"
printf '  %s|%s  %sIJFW%s  %sIt just f*cking works.%s          %s|%s\n' "$C_BOLD$C_CYAN" "$C_RESET" "$C_BOLD$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET" "$C_BOLD$C_CYAN" "$C_RESET"
printf '  %s|%s                                        %s|%s\n' "$C_BOLD$C_CYAN" "$C_RESET" "$C_BOLD$C_CYAN" "$C_RESET"
printf '  %s+----------------------------------------+%s\n'   "$C_BOLD$C_CYAN" "$C_RESET"
echo
printf '  %sInstalled at%s  %s\n' "$C_DIM" "$C_RESET" "$NATIVE_REPO"
echo
if [ ${#LIVE[@]} -gt 0 ]; then
  printf '  %s==> LIVE NOW (%d)%s\n' "$C_BOLD$C_GREEN" "${#LIVE[@]}" "$C_RESET"
  for p in "${LIVE[@]}"; do
    printf '      %so%s  %s\n' "$C_GREEN" "$C_RESET" "$p"
  done
  echo
fi
if [ ${#STANDBY[@]} -gt 0 ]; then
  printf '  %s==> STANDING BY (%d)%s  %sauto-activate on install%s\n' "$C_BOLD$C_YELLOW" "${#STANDBY[@]}" "$C_RESET" "$C_DIM" "$C_RESET"
  for p in "${STANDBY[@]}"; do
    printf '      %so%s  %s\n' "$C_YELLOW" "$C_RESET" "$p"
  done
  echo
fi
if [ ${#LIVE[@]} -eq 0 ] && [ ${#STANDBY[@]} -eq 0 ]; then
  printf '  %sReady to configure%s  -- pass a platform name to get started: %sbash scripts/install.sh claude%s\n' "$C_YELLOW" "$C_RESET" "$C_BOLD" "$C_RESET"
  echo
fi
if [ "$CLAUDE_NEEDS_RESTART" -eq 1 ]; then
  printf '  %s==> RESTART REQUIRED%s  Claude Code is running -- %srestart your sessions now to activate IJFW.%s\n' "$C_BOLD$C_YELLOW" "$C_RESET" "$C_BOLD" "$C_RESET"
  echo
fi

# --- Post-commit hook (opt-in only) ---
HOOK_MARKER="# IJFW-POST-COMMIT-HOOK"
HOOK_BLOCK='# IJFW-POST-COMMIT-HOOK (v1)
ijfw_post_commit() {
  if command -v ijfw >/dev/null 2>&1; then
    (ijfw cross critique "HEAD~1..HEAD" >/dev/null 2>&1 &) || true
  fi
}
ijfw_post_commit
# IJFW-POST-COMMIT-HOOK-END'

install_post_commit_hook() {
  if [ ! -d ".git" ]; then
    note "Post-commit hook is available once you run git init here -- skipping for now."
    return
  fi
  HOOK_FILE=".git/hooks/post-commit"
  note "Modifying: $(pwd)/$HOOK_FILE"
  if [ -f "$HOOK_FILE" ] && grep -qF "$HOOK_MARKER" "$HOOK_FILE" 2>/dev/null; then
    ok "Post-commit hook already installed -- no change."
    return
  fi
  if [ -f "$HOOK_FILE" ]; then
    # Append IJFW block to preserve existing hook content
    printf '\n%s\n' "$HOOK_BLOCK" >> "$HOOK_FILE"
  else
    printf '#!/usr/bin/env bash\n%s\n' "$HOOK_BLOCK" > "$HOOK_FILE"
  fi
  chmod 755 "$HOOK_FILE"
  ok "Post-commit auto-critique enabled. Commits now trigger a background Trident review."
}

if [ "$INSTALL_POST_COMMIT_HOOK" -eq 1 ]; then
  log "[Post-commit hook]"
  install_post_commit_hook
  log ""
elif [ -d ".git" ]; then
  note "Tip: background Trident critique on every commit -- run with --post-commit-hook to enable."
fi

# Polish 3: auto-detect existing claude-mem install and suggest absorbing it.
# Silent if nothing detected.
if [ -d "$HOME/.claude-mem" ] || [ -f "$HOME/.claude-mem/claude-mem.db" ]; then
  echo
  printf '  %s==> NOTICED%s  %sclaude-mem looks active at ~/.claude-mem%s\n' "$C_BOLD$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '      Run %sijfw import claude-mem --dry-run%s to preview the migration.\n' "$C_BOLD" "$C_RESET"
fi

# ============================================================
# CLI WIRING: put ijfw commands on PATH
# ============================================================
# Symlink the mcp-server/bin/* binaries into a PATH location so users can
# run `ijfw`, `ijfw-memory`, etc. from any directory without typing full paths.
#
# Preference order for the link target dir:
#   1. ~/.local/bin     (XDG standard, already on PATH for most distros)
#   2. ~/bin            (classic fallback, on PATH in most shells)
#   3. /usr/local/bin   (system-wide, requires writeability)
# If none of those is on PATH, we still create ~/.local/bin, install the
# links, and tell the user how to add it to their shell rc.

printf '\n  CLI wiring\n  ──────────\n'

# Skip ~/.local/bin wiring when scoped to a custom dir -- avoids polluting
# the user's PATH with symlinks that point at a scratch install location.
if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
  printf '  [+] Custom-dir install -- skipping ~/.local/bin wiring.\n'
  printf "      Run binaries directly from %s/mcp-server/bin/ or add that dir to PATH.\n" "$REPO_ROOT"
  CLI_LINKED=0
  CLI_FAILED=0
elif [ "$IS_WINDOWS" -eq 1 ]; then
  # On Windows, mcp-server/bin/* are unix bash scripts (#!/usr/bin/env bash).
  # Linking them into ~/.local/bin would put them ahead of npm's ijfw.cmd shim
  # on PATH -- PowerShell can't execute the bash file and Windows opens it in
  # Notepad (the "Windows can't execute the bash file -> default file handler"
  # bug we hit on 1.1.6 RDP installs). The npm shim from `npm install -g
  # @ijfw/install` is the correct PATH entry on Windows.
  printf '  [+] Windows detected -- skipping ~/.local/bin wiring (npm shims own PATH on Windows).\n'
  printf '      If `ijfw` is not on PATH, run: npm install -g @ijfw/install\n'
  CLI_LINKED=0
  CLI_FAILED=0
else
  # Sweep stale Windows .cmd launchers that should never exist on POSIX.
  # These appear when a user migrates a Windows home dir to Linux/macOS.
  for _cmd_stale in "$HOME/.local/bin/ijfw.cmd" "$HOME/.local/bin/ijfw-dashboard.cmd" \
                    "$HOME/.local/bin/ijfw-dispatch-plan.cmd" "$HOME/.local/bin/ijfw-memorize.cmd" \
                    "$HOME/.local/bin/ijfw-memory.cmd"; do
    if [ -f "$_cmd_stale" ]; then
      rm -f "$_cmd_stale" 2>/dev/null || true
      printf '  [+] Removed stale Windows launcher: %s\n' "$_cmd_stale"
    fi
  done

  CLI_BINS="ijfw ijfw-memory ijfw-dispatch-plan ijfw-dashboard ijfw-memorize"
  CLI_SRC_DIR="$REPO_ROOT/mcp-server/bin"
  CLI_LINK_DIR=""
  CLI_LINK_ON_PATH=0

  # Find a suitable link dir. Prefer ones already on PATH.
  for candidate in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
    case ":$PATH:" in
      *":$candidate:"*)
        if [ -d "$candidate" ] && [ -w "$candidate" ]; then
          CLI_LINK_DIR="$candidate"
          CLI_LINK_ON_PATH=1
          break
        fi
        ;;
    esac
  done

  # Fall back to ~/.local/bin even if not on PATH. We'll tell the user how to add it.
  if [ -z "$CLI_LINK_DIR" ]; then
    CLI_LINK_DIR="$HOME/.local/bin"
    mkdir -p "$CLI_LINK_DIR" 2>/dev/null || true
  fi

  CLI_LINKED=0
  CLI_FAILED=0
  CLI_COPIED=0
  for bin in $CLI_BINS; do
    src="$CLI_SRC_DIR/$bin"
    dst="$CLI_LINK_DIR/$bin"
    if [ -f "$src" ]; then
      if ln -sfn "$src" "$dst" 2>/dev/null; then
        # Git Bash / MINGW64 silently falls back to a file copy when the user
        # lacks Windows symlink privileges (no admin, no Developer Mode, no
        # MSYS=winsymlinks:nativestrict). The copy sits in ~/.local/bin with no
        # way to resolve back to the install tree, so the launcher's readlink
        # walk fails and `ijfw` errors out. Verify with -L and treat a copy as
        # a failure so the user gets a real fix hint instead of silent breakage.
        if [ -L "$dst" ]; then
          CLI_LINKED=$((CLI_LINKED + 1))
        else
          CLI_COPIED=$((CLI_COPIED + 1))
          rm -f "$dst"
        fi
      else
        CLI_FAILED=$((CLI_FAILED + 1))
      fi
    fi
  done

  if [ "$CLI_LINKED" -gt 0 ]; then
    printf '  %s[+]%s %d commands linked into %s\n' "$C_GREEN" "$C_RESET" "$CLI_LINKED" "$CLI_LINK_DIR"
    if [ "$CLI_LINK_ON_PATH" -eq 1 ]; then
      printf '      Try now: %sijfw doctor%s\n' "$C_BOLD" "$C_RESET"
    else
      printf '  %s[!]%s %s is not on your PATH yet.\n' "$C_YELLOW" "$C_RESET" "$CLI_LINK_DIR"
      printf '      Add this to your shell rc (~/.bashrc or ~/.zshrc):\n'
      printf '        %sexport PATH="$HOME/.local/bin:$PATH"%s\n' "$C_BOLD" "$C_RESET"
      printf '      Then: %ssource ~/.bashrc%s (or restart your terminal)\n' "$C_BOLD" "$C_RESET"
      CLI_NEEDS_PATH=1
    fi
  fi
  if [ "$CLI_FAILED" -gt 0 ]; then
    printf '  %s[!]%s %d commands could not be linked (check permissions on %s)\n' "$C_YELLOW" "$C_RESET" "$CLI_FAILED" "$CLI_LINK_DIR"
  fi
  if [ "$CLI_COPIED" -gt 0 ]; then
    printf '  %s[!]%s %d commands could not be symlinked on this Windows shell.\n' "$C_YELLOW" "$C_RESET" "$CLI_COPIED"
    printf '      Git Bash falls back to copies without symlink privileges, which breaks the launcher.\n'
    printf '      Fix one of:\n'
    printf '        %s1.%s Enable Developer Mode (Settings > Privacy & security > For developers), then rerun.\n' "$C_BOLD" "$C_RESET"
    printf '        %s2.%s Rerun this installer from Git Bash launched as Administrator.\n' "$C_BOLD" "$C_RESET"
    printf '        %s3.%s In Git Bash: %sexport MSYS=winsymlinks:nativestrict%s, then rerun.\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    printf '      Or skip ~/.local/bin wiring and add %s%s%s to PATH directly.\n' "$C_BOLD" "$CLI_SRC_DIR" "$C_RESET"
    CLI_NEEDS_SYMLINK_FIX=1
  fi
fi

# ============================================================
# POST-INSTALL: verify MCP server actually starts
# ============================================================
printf '\n  Post-install verification\n  ────────────────────────\n'

POST_OK=1

# Gate 1: plugin link resolves to a valid manifest.
# Skipped for custom-dir installs (IJFW_CUSTOM_DIR=1) since the sibling link at
# $HOME/.ijfw/claude is intentionally not created -- checking it would always
# false-fail and exit 1 on a perfectly-good scratch install.
if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
  printf '  %s[+]%s Custom-dir install -- canonical plugin-manifest check skipped (by design).\n' "$C_GREEN" "$C_RESET"
elif [ -f "$PLUGIN_DST/.claude-plugin/plugin.json" ]; then
  printf '  %s[+]%s Plugin manifest reachable at %s\n' "$C_GREEN" "$C_RESET" "$PLUGIN_DST"
else
  printf '  %s[!]%s Plugin manifest NOT reachable at %s/.claude-plugin/plugin.json\n' "$C_RED" "$C_RESET" "$PLUGIN_DST"
  POST_OK=0
fi

# Gate 2: server.js exists and is readable AT THE PATH THE PLUGIN WILL USE.
# The plugin's .mcp.json args = "${CLAUDE_PLUGIN_ROOT}/../mcp-server/src/server.js"
# which resolves to $HOME/.ijfw/mcp-server/src/server.js (symlinked sibling).
SERVER_JS="$REPO_ROOT/mcp-server/src/server.js"
PLUGIN_SERVER_JS="$HOME/.ijfw/mcp-server/src/server.js"
if [ -f "$SERVER_JS" ] && [ -r "$SERVER_JS" ]; then
  printf '  %s[+]%s server.js readable at %s\n' "$C_GREEN" "$C_RESET" "$SERVER_JS"
else
  printf '  %s[!]%s server.js NOT readable at %s\n' "$C_RED" "$C_RESET" "$SERVER_JS"
  POST_OK=0
fi
# Plugin sibling link check is only meaningful for canonical installs. Custom-dir
# installs intentionally skip the $HOME/.ijfw/mcp-server sibling link creation.
if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
  printf '  %s[+]%s Custom-dir install -- canonical plugin-sibling check skipped (by design).\n' "$C_GREEN" "$C_RESET"
elif [ -f "$PLUGIN_SERVER_JS" ] && [ -r "$PLUGIN_SERVER_JS" ]; then
  printf '  %s[+]%s Plugin sibling link resolves: %s\n' "$C_GREEN" "$C_RESET" "$PLUGIN_SERVER_JS"
else
  printf '  %s[!]%s Plugin sibling path unreachable: %s (plugin MCP spawn will fail)\n' "$C_RED" "$C_RESET" "$PLUGIN_SERVER_JS"
  POST_OK=0
fi

# Gate 3: MCP server completes full handshake (initialize + notifications/initialized + tools/list).
MCP_OK=0
if [ -n "${NODE_BIN:-}" ] && [ -f "$SERVER_JS" ]; then
  MCP_RESPONSE=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
      sleep 0.3
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      sleep 0.3
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
      sleep 0.5
    ) | "$NODE_BIN" "$SERVER_JS" 2>/dev/null | head -5
  )
  if echo "$MCP_RESPONSE" | grep -q '"tools"' 2>/dev/null; then
    printf '  %s[+]%s MCP server completes full handshake (initialize + tools/list)\n' "$C_GREEN" "$C_RESET"
    MCP_OK=1
  elif echo "$MCP_RESPONSE" | grep -q '"result"' 2>/dev/null; then
    printf '  %s[~]%s MCP server responds to initialize but not tools/list\n' "$C_YELLOW" "$C_RESET"
    MCP_OK=1
  else
    printf '  %s[!]%s MCP server did not respond -- run manually: %s %s\n' "$C_RED" "$C_RESET" "$NODE_BIN" "$SERVER_JS"
    POST_OK=0
  fi
else
  printf '  %s[!]%s Could not verify MCP server (node or server.js missing)\n' "$C_RED" "$C_RESET"
  POST_OK=0
fi

# Gate 4: settings.json has ijfw-memory registered with a command we can verify.
# Skipped for custom-dir installs -- we intentionally don't touch ~/.claude/settings.json.
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ "$IJFW_CUSTOM_DIR" = "1" ]; then
  printf '  %s[+]%s Custom-dir install -- canonical settings.json check skipped (by design).\n' "$C_GREEN" "$C_RESET"
elif [ -f "$CLAUDE_SETTINGS" ]; then
  SETTINGS_CHECK=$(
    "$NODE_BIN" -e '
      const fs = require("fs");
      try {
        const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const m = d && d.mcpServers && d.mcpServers["ijfw-memory"];
        if (!m || !m.command) { console.log("missing"); process.exit(0); }
        if (m.command === "node") { console.log("ok:node"); process.exit(0); }
        if (require("path").isAbsolute(m.command) && !fs.existsSync(m.command)) {
          console.log("stale:" + m.command);
        } else {
          console.log("ok:" + m.command);
        }
      } catch (e) { console.log("error:" + e.message); }
    ' "$CLAUDE_SETTINGS"
  )
  case "$SETTINGS_CHECK" in
    ok:*)      printf '  %s[+]%s settings.json: ijfw-memory registered (%s)\n' "$C_GREEN" "$C_RESET" "${SETTINGS_CHECK#ok:}" ;;
    stale:*)   printf '  %s[!]%s settings.json: stale path %s\n' "$C_RED" "$C_RESET" "${SETTINGS_CHECK#stale:}"; POST_OK=0 ;;
    missing)   printf '  %s[!]%s settings.json: ijfw-memory NOT registered\n' "$C_RED" "$C_RESET"; POST_OK=0 ;;
    error:*)   printf '  %s[!]%s settings.json: parse error (%s)\n' "$C_RED" "$C_RESET" "${SETTINGS_CHECK#error:}"; POST_OK=0 ;;
  esac
else
  printf '  %s[~]%s settings.json not yet created (Claude Code will create it on first launch)\n' "$C_YELLOW" "$C_RESET"
fi

if [ "$POST_OK" -eq 0 ]; then
  printf '\n  %sInstall completed with issues above.%s Fix them before using IJFW in Claude Code.\n\n' "$C_RED" "$C_RESET"
  # Non-zero exit so CI and scripted installs catch the failure.
  INSTALL_EXIT_CODE=1
else
  INSTALL_EXIT_CODE=0
fi

# ============================================================
# RESTART BANNER: impossible to miss
# ============================================================
printf '\n'
printf '  %s╔══════════════════════════════════════════════════════════════╗%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
printf '  %s║                                                              ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
if [ "${CLAUDE_NEEDS_RESTART:-0}" -eq 1 ]; then
  printf '  %s║   ⚠  RESTART CLAUDE CODE NOW                                ║%s\n' "$C_BOLD$C_YELLOW" "$C_RESET"
  printf '  %s║                                                              ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
  printf '  %s║   Cmd+Q to quit Claude Code completely, then relaunch.       ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
  printf '  %s║   A new tab is NOT enough -- full quit + reopen required.    ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
  printf '  %s║   Claude Code reads settings.json once at startup.           ║%s\n' "$C_DIM" "$C_RESET"
else
  printf '  %s║   IJFW is ready.                                             ║%s\n' "$C_BOLD$C_GREEN" "$C_RESET"
  printf '  %s║                                                              ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
  printf '  %s║   Open Claude Code and start a new session.                  ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
  printf '  %s║   You should see: [ijfw] Ready.                              ║%s\n' "$C_DIM" "$C_RESET"
fi
printf '  %s║                                                              ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
if [ "$MCP_OK" -eq 1 ]; then
  printf '  %s║   MCP server: verified working                               ║%s\n' "$C_GREEN" "$C_RESET"
else
  printf '  %s║   MCP server: could not verify (check node installation)     ║%s\n' "$C_YELLOW" "$C_RESET"
fi
if [ "${CLI_NEEDS_SYMLINK_FIX:-0}" -eq 1 ] && [ "${CLI_LINKED:-0}" -eq 0 ]; then
  printf '  %s║   CLI: symlinks blocked on Windows (see fix above)           ║%s\n' "$C_YELLOW" "$C_RESET"
elif [ "${CLI_NEEDS_PATH:-0}" -eq 1 ]; then
  printf '  %s║   CLI: add ~/.local/bin to PATH (see above) for `ijfw` cmd   ║%s\n' "$C_YELLOW" "$C_RESET"
elif [ "${CLI_LINKED:-0}" -gt 0 ]; then
  printf '  %s║   CLI: ijfw command ready (try: ijfw doctor)                 ║%s\n' "$C_GREEN" "$C_RESET"
fi
printf '  %s║                                                              ║%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
printf '  %s╚══════════════════════════════════════════════════════════════╝%s\n' "$C_BOLD$C_CYAN" "$C_RESET"
printf '\n'

# Closer: PS wrapper sets IJFW_SKIP_CLOSER=1 so it can print after running
# its own Merge-Marketplace step (keeps warnings above the closer, not below).
if [ "${IJFW_SKIP_CLOSER:-0}" != "1" ]; then
  printf '  %sFull log%s   %s\n' "$C_DIM" "$C_RESET" "$NATIVE_LOG"
  echo
fi

# Exit with non-zero if any post-install gate failed so CI and scripted
# installs notice. Default: exit 0 (success).
exit "${INSTALL_EXIT_CODE:-0}"
