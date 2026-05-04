#!/usr/bin/env python3
"""test_shim.py -- verify the Hermes shim registers all 6 hooks + 6 commands."""

import sys
import os
import importlib.util

# Add wayland tests dir for MockPluginContext.
WAYLAND_TESTS = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "wayland", "plugins", "ijfw", "tests")
)
if WAYLAND_TESTS not in sys.path:
    sys.path.insert(0, WAYLAND_TESTS)

from mock_ctx import MockPluginContext

EXPECTED_HOOKS = {
    "on_session_start",
    "pre_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "post_llm_call",
    "on_session_end",
}

EXPECTED_COMMANDS = {
    "cross-audit",
    "cross-research",
    "cross-critique",
    "workflow",
    "handoff",
    "compress",
}


def load_hermes_shim():
    shim_path = os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "__init__.py")
    )
    spec = importlib.util.spec_from_file_location("hermes_ijfw_shim", shim_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_all_hooks_registered():
    mod = load_hermes_shim()
    ctx = MockPluginContext()
    mod.register(ctx)
    registered = set(ctx.hooks.keys())
    missing = EXPECTED_HOOKS - registered
    assert not missing, f"Missing hooks: {missing}"
    print(f"  hooks OK: {sorted(registered)}")


def test_all_commands_registered():
    mod = load_hermes_shim()
    ctx = MockPluginContext()
    mod.register(ctx)
    registered = set(ctx.commands.keys())
    missing = EXPECTED_COMMANDS - registered
    assert not missing, f"Missing commands: {missing}"
    print(f"  commands OK: {sorted(registered)}")


def test_hermes_args_hint():
    """Hermes host should pass args_hint through to register_command."""
    mod = load_hermes_shim()
    ctx = MockPluginContext()
    mod.register(ctx)
    _, _, args_hint = ctx.commands["cross-audit"]
    assert args_hint, "cross-audit args_hint should be non-empty for hermes host"
    print(f"  hermes args_hint OK for cross-audit: '{args_hint}'")


def test_wayland_plugin_resolved():
    """Shim must resolve WAYLAND_PLUGIN to an existing directory."""
    mod = load_hermes_shim()
    assert os.path.isdir(mod.WAYLAND_PLUGIN), f"WAYLAND_PLUGIN not a dir: {mod.WAYLAND_PLUGIN}"
    print(f"  WAYLAND_PLUGIN resolved: {mod.WAYLAND_PLUGIN}")


if __name__ == "__main__":
    tests = [
        test_all_hooks_registered,
        test_all_commands_registered,
        test_hermes_args_hint,
        test_wayland_plugin_resolved,
    ]
    failed = []
    for t in tests:
        try:
            print(f"[RUN] {t.__name__}")
            t()
            print(f"[PASS] {t.__name__}")
        except AssertionError as e:
            print(f"[FAIL] {t.__name__}: {e}")
            failed.append(t.__name__)
        except Exception as e:
            print(f"[ERROR] {t.__name__}: {e}")
            failed.append(t.__name__)

    if failed:
        print(f"\nFAILED: {failed}")
        sys.exit(1)
    print(f"\nAll {len(tests)} tests passed.")
