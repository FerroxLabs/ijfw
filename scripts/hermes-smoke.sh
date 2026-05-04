#!/usr/bin/env bash
# hermes-smoke.sh -- smoke test for IJFW Hermes plugin install
#
# Verifies:
#   1. install.sh provisions ~/.hermes/plugins/ijfw/
#   2. __init__.py is importable as Python with a register() fn
#   3. plugin.yaml is valid YAML
#   4. register(MockCtx()) records all 6 hooks + 6 commands
#   5. ~/.hermes/config.yaml has "ijfw" in plugins.enabled[]
#
# Usage:
#   bash scripts/hermes-smoke.sh           # live (backs up ~/.hermes/plugins/ijfw)
#   bash scripts/hermes-smoke.sh --no-backup   # CI (skip backup/restore)

set -u

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NO_BACKUP=0
for arg in "$@"; do [ "$arg" = "--no-backup" ] && NO_BACKUP=1; done

PLUGIN_DST="$HOME/.hermes/plugins/ijfw"
HERMES_CFG="$HOME/.hermes/config.yaml"
BAK_TS="$(date +%Y%m%d-%H%M%S)"
BAK_PLUGIN="$HOME/.hermes/plugins/ijfw.bak.$BAK_TS"
BAK_CFG="$HOME/.hermes/config.yaml.bak.$BAK_TS"

fail() {
  printf "hermes-smoke: FAIL -- %s\n" "$1" >&2
  if [ "$NO_BACKUP" -eq 0 ]; then
    if [ -d "$BAK_PLUGIN" ]; then
      printf "  Restoring plugin backup from %s\n" "$BAK_PLUGIN" >&2
      rm -rf "$PLUGIN_DST" 2>/dev/null
      mv "$BAK_PLUGIN" "$PLUGIN_DST" 2>/dev/null || true
    elif [ -d "$PLUGIN_DST" ]; then
      # Plugin was freshly created by install, remove it on failure.
      rm -rf "$PLUGIN_DST" 2>/dev/null || true
    fi
    if [ -f "$BAK_CFG" ]; then
      printf "  Restoring config backup from %s\n" "$BAK_CFG" >&2
      cp "$BAK_CFG" "$HERMES_CFG" 2>/dev/null || true
    fi
  fi
  exit 1
}

# Backup existing plugin + config if present.
if [ "$NO_BACKUP" -eq 0 ]; then
  [ -d "$PLUGIN_DST" ] && cp -r "$PLUGIN_DST" "$BAK_PLUGIN" 2>/dev/null || true
  [ -f "$HERMES_CFG" ] && cp "$HERMES_CFG" "$BAK_CFG" 2>/dev/null || true
fi

# Step 1: run installer targeting hermes only.
printf "hermes-smoke: running install.sh...\n"
if ! bash "$REPO_ROOT/scripts/install.sh" hermes > /tmp/hermes-smoke-install.log 2>&1; then
  fail "install.sh exited non-zero (see /tmp/hermes-smoke-install.log)"
fi

# Step 2: __init__.py exists.
[ -f "$PLUGIN_DST/__init__.py" ] || fail "__init__.py not found at $PLUGIN_DST/__init__.py"

# Step 3: plugin.yaml valid YAML.
python3 -c "import yaml; yaml.safe_load(open('$PLUGIN_DST/plugin.yaml'))" 2>/dev/null \
  || fail "plugin.yaml is not valid YAML"

# Step 4: importable + has register().
python3 - <<PYEOF || fail "__init__.py not importable or missing register()"
import importlib.util, sys, os
p = os.path.expanduser("~/.hermes/plugins/ijfw/__init__.py")
spec = importlib.util.spec_from_file_location("h_ijfw", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert hasattr(m, "register"), "register not found in module"
PYEOF

# Step 5: register(MockCtx()) fires all 6 hooks + 6 commands.
python3 - <<PYEOF || fail "register(MockCtx()) did not wire expected hooks/commands"
import sys, os

PLUGIN_DIR = os.path.expanduser("~/.wayland/plugins/ijfw")
TESTS_DIR  = os.path.join("$REPO_ROOT", "wayland", "plugins", "ijfw", "tests")
for d in [PLUGIN_DIR, TESTS_DIR]:
    if d not in sys.path:
        sys.path.insert(0, d)

import importlib.util, os as _os

HERMES_INIT = _os.path.expanduser("~/.hermes/plugins/ijfw/__init__.py")
spec = importlib.util.spec_from_file_location("h_ijfw_mod", HERMES_INIT)
hermes_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hermes_mod)

from mock_ctx import MockPluginContext

EXPECTED_HOOKS    = {"on_session_start","pre_llm_call","pre_tool_call","post_tool_call","post_llm_call","on_session_end"}
EXPECTED_COMMANDS = {"cross-audit","cross-research","cross-critique","workflow","handoff","compress"}

ctx = MockPluginContext()
hermes_mod.register(ctx)

missing_hooks = EXPECTED_HOOKS - set(ctx.hooks.keys())
assert not missing_hooks, f"Missing hooks: {missing_hooks}"

missing_cmds = EXPECTED_COMMANDS - set(ctx.commands.keys())
assert not missing_cmds, f"Missing commands: {missing_cmds}"

print(f"  hooks: {sorted(ctx.hooks.keys())}")
print(f"  commands: {sorted(ctx.commands.keys())}")
PYEOF

# Step 6: plugins.enabled[] in ~/.hermes/config.yaml contains "ijfw".
if [ -f "$HERMES_CFG" ]; then
  python3 - <<PYEOF || fail "$HOME/.hermes/config.yaml does not have ijfw in plugins.enabled[]"
import yaml, os
cfg = yaml.safe_load(open(os.path.expanduser("~/.hermes/config.yaml"))) or {}
enabled = (cfg.get("plugins") or {}).get("enabled") or []
assert "ijfw" in enabled, f"ijfw not in plugins.enabled (found: {enabled})"
print(f"  plugins.enabled: {enabled}")
PYEOF
else
  fail "$HOME/.hermes/config.yaml not found after install"
fi

# Cleanup backup (test passed).
if [ "$NO_BACKUP" -eq 0 ]; then
  [ -d "$BAK_PLUGIN" ] && rm -rf "$BAK_PLUGIN" 2>/dev/null || true
  [ -f "$BAK_CFG"    ] && rm -f  "$BAK_CFG"    2>/dev/null || true
fi

printf "hermes-smoke: PASS (clean install)\n"
