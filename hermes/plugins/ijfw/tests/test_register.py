#!/usr/bin/env python3
"""test_register.py -- verify register(ctx) wires all 6 hooks + 6 commands (Hermes)."""

import sys
import os

# Ensure plugin root is on path.
PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

from mock_ctx import MockPluginContext
from _handlers import build_register_fn

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


def test_all_hooks_registered():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    registered = set(ctx.hooks.keys())
    missing = EXPECTED_HOOKS - registered
    assert not missing, f"Missing hooks: {missing}"
    print(f"  hooks OK: {sorted(registered)}")


def test_all_commands_registered():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    registered = set(ctx.commands.keys())
    missing = EXPECTED_COMMANDS - registered
    assert not missing, f"Missing commands: {missing}"
    print(f"  commands OK: {sorted(registered)}")


def test_hook_callables():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    for hook_name in EXPECTED_HOOKS:
        callbacks = ctx.hooks.get(hook_name, [])
        assert len(callbacks) == 1, f"{hook_name} has {len(callbacks)} callbacks (expected 1)"
        assert callable(callbacks[0]), f"{hook_name} callback is not callable"
    print("  all hook callbacks are callable")


def test_command_handlers_callable():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    for cmd_name in EXPECTED_COMMANDS:
        handler, desc, _ = ctx.commands[cmd_name]
        assert callable(handler), f"/{cmd_name} handler is not callable"
    print("  all command handlers are callable")


def test_hermes_args_hint_present():
    """Hermes host should pass args_hint through to register_command."""
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    _, _, args_hint = ctx.commands["cross-audit"]
    assert args_hint, "cross-audit args_hint should be non-empty for hermes host"
    print(f"  hermes args_hint OK for cross-audit: '{args_hint}'")


def test_on_session_start_fires_mcp():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    results = ctx.invoke_hook("on_session_start", session_id="s1", model="x", platform="hermes")
    assert results, "on_session_start returned nothing"
    banner = results[0]
    assert "IJFW ready" in banner, f"Unexpected banner: {banner}"
    print(f"  on_session_start banner OK: '{banner[:60]}...'")


def test_pre_tool_call_pass_through():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    result = ctx.invoke_hook(
        "pre_tool_call",
        tool_name="read_file",
        args={"path": "/tmp/foo.txt"},
        task_id="t1",
        session_id="s1",
        tool_call_id="tc1",
    )
    assert result == [], f"Expected empty result for safe command, got: {result}"
    print("  pre_tool_call pass-through OK")


if __name__ == "__main__":
    tests = [
        test_all_hooks_registered,
        test_all_commands_registered,
        test_hook_callables,
        test_command_handlers_callable,
        test_hermes_args_hint_present,
        test_on_session_start_fires_mcp,
        test_pre_tool_call_pass_through,
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
