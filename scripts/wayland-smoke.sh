#!/usr/bin/env bash
# wayland-smoke.sh -- smoke test for IJFW Wayland plugin install
#
# Verifies:
#   1. install.sh provisions ~/.wayland/plugins/ijfw/
#   2. __init__.py is importable as Python with a register() fn
#   3. plugin.yaml is valid YAML
#   4. register(MockCtx()) records all 6 hooks + 6 commands
#   5. Idempotency: second install run produces no diff in plugin files
#
# Usage:
#   bash scripts/wayland-smoke.sh           # live (backs up ~/.wayland/plugins/ijfw)
#   bash scripts/wayland-smoke.sh --no-backup   # CI (skip backup/restore)

set -u

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NO_BACKUP=0
for arg in "$@"; do [ "$arg" = "--no-backup" ] && NO_BACKUP=1; done

PLUGIN_DST="$HOME/.wayland/plugins/ijfw"
BAK_TS="$(date +%Y%m%d-%H%M%S)"
BAK_DIR="$HOME/.wayland/plugins/ijfw.bak.$BAK_TS"

fail() {
  printf "wayland-smoke: FAIL -- %s\n" "$1" >&2
  if [ "$NO_BACKUP" -eq 0 ] && [ -d "$BAK_DIR" ]; then
    printf "  Restoring backup from %s\n" "$BAK_DIR" >&2
    rm -rf "$PLUGIN_DST" 2>/dev/null
    mv "$BAK_DIR" "$PLUGIN_DST" 2>/dev/null || true
  fi
  exit 1
}

# Backup existing plugin if present (idempotent: one bak per run via timestamp).
if [ "$NO_BACKUP" -eq 0 ] && [ -d "$PLUGIN_DST" ]; then
  cp -r "$PLUGIN_DST" "$BAK_DIR" 2>/dev/null || true
fi

# Step 1: run installer targeting wayland only.
printf "wayland-smoke: running install.sh...\n"
if ! bash "$REPO_ROOT/scripts/install.sh" wayland > /tmp/wayland-smoke-install.log 2>&1; then
  fail "install.sh exited non-zero (see /tmp/wayland-smoke-install.log)"
fi

# Step 2: __init__.py exists.
[ -f "$PLUGIN_DST/__init__.py" ] || fail "__init__.py not found at $PLUGIN_DST/__init__.py"

# Step 3: plugin.yaml valid YAML.
python3 -c "import yaml; yaml.safe_load(open('$PLUGIN_DST/plugin.yaml'))" 2>/dev/null \
  || fail "plugin.yaml is not valid YAML"

# Step 4: importable + has register().
python3 - <<PYEOF || fail "__init__.py not importable or missing register()"
import importlib.util, sys, os
p = os.path.expanduser("~/.wayland/plugins/ijfw/__init__.py")
spec = importlib.util.spec_from_file_location("w_ijfw", p)
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

from mock_ctx import MockPluginContext
from _handlers import build_register_fn

EXPECTED_HOOKS    = {"on_session_start","pre_llm_call","pre_tool_call","post_tool_call","post_llm_call","on_session_end"}
EXPECTED_COMMANDS = {"cross-audit","cross-research","cross-critique","workflow","handoff","compress"}

ctx = MockPluginContext()
build_register_fn("wayland")(ctx)

missing_hooks = EXPECTED_HOOKS - set(ctx.hooks.keys())
assert not missing_hooks, f"Missing hooks: {missing_hooks}"

missing_cmds = EXPECTED_COMMANDS - set(ctx.commands.keys())
assert not missing_cmds, f"Missing commands: {missing_cmds}"

print(f"  hooks: {sorted(ctx.hooks.keys())}")
print(f"  commands: {sorted(ctx.commands.keys())}")
PYEOF

# Step 6: idempotency -- run install again, diff plugin dir.
printf "wayland-smoke: idempotency check (second install)...\n"
CHECKSUM_BEFORE="$(find "$PLUGIN_DST" -type f ! -name '*.pyc' -exec md5 -q {} \; 2>/dev/null | sort | md5 -q)"
bash "$REPO_ROOT/scripts/install.sh" wayland > /tmp/wayland-smoke-install2.log 2>&1 || true
CHECKSUM_AFTER="$(find "$PLUGIN_DST" -type f ! -name '*.pyc' -exec md5 -q {} \; 2>/dev/null | sort | md5 -q)"
if [ "$CHECKSUM_BEFORE" != "$CHECKSUM_AFTER" ]; then
  fail "idempotency: plugin files changed on second install"
fi

# Cleanup backup (test passed, no need to keep it).
if [ "$NO_BACKUP" -eq 0 ] && [ -d "$BAK_DIR" ]; then
  rm -rf "$BAK_DIR" 2>/dev/null || true
fi

printf "wayland-smoke: PASS (clean install + idempotency)\n"
