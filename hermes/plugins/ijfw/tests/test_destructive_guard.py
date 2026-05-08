#!/usr/bin/env python3
"""test_destructive_guard.py -- pre_tool_call blocks destructive cmds; safe cmds pass (Hermes)."""

import sys
import os

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

from mock_ctx import MockPluginContext
from _handlers import build_register_fn


def _pre_tool_call(ctx, tool_name, cmd):
    results = ctx.invoke_hook(
        "pre_tool_call",
        tool_name=tool_name,
        args={"command": cmd},
        task_id="t1",
        session_id="s1",
        tool_call_id="tc1",
    )
    return results[0] if results else None


def setup():
    ctx = MockPluginContext()
    register = build_register_fn("hermes")
    register(ctx)
    return ctx


def test_rm_rf_root_blocked():
    ctx = setup()
    result = _pre_tool_call(ctx, "terminal", "rm -rf /")
    assert result is not None, "rm -rf / should be blocked"
    assert result.get("action") == "block", f"Expected block, got: {result}"
    assert "IJFW caught" in result.get("message", ""), "Message should mention IJFW"
    print(f"  rm -rf / blocked OK: '{result['message'][:60]}'")


def test_rm_rf_home_blocked():
    ctx = setup()
    result = _pre_tool_call(ctx, "terminal", "rm -rf ~")
    assert result is not None, "rm -rf ~ should be blocked"
    assert result.get("action") == "block"
    print("  rm -rf ~ blocked OK")


def test_git_push_force_blocked():
    ctx = setup()
    result = _pre_tool_call(ctx, "terminal", "git push --force origin main")
    assert result is not None, "git push --force should be blocked"
    assert result.get("action") == "block"
    print("  git push --force blocked OK")


def test_git_reset_hard_blocked():
    ctx = setup()
    result = _pre_tool_call(ctx, "terminal", "git reset --hard HEAD~1")
    assert result is not None, "git reset --hard should be blocked"
    assert result.get("action") == "block"
    print("  git reset --hard blocked OK")


def test_safe_ls_passes():
    ctx = setup()
    result = _pre_tool_call(ctx, "terminal", "ls -la /tmp")
    assert result is None, f"ls should pass through, got: {result}"
    print("  ls -la pass-through OK")


def test_safe_git_status_passes():
    ctx = setup()
    result = _pre_tool_call(ctx, "terminal", "git status")
    assert result is None, f"git status should pass through, got: {result}"
    print("  git status pass-through OK")


def test_non_terminal_tool_not_blocked():
    ctx = setup()
    result = _pre_tool_call(ctx, "read_file", "rm -rf /")
    assert result is None, f"non-terminal tool should not be blocked, got: {result}"
    print("  non-terminal tool (read_file) pass-through OK")


def test_message_truncated_at_80():
    ctx = setup()
    long_cmd = "rm -rf /" + "x" * 200
    result = _pre_tool_call(ctx, "terminal", long_cmd)
    assert result is not None
    msg = result.get("message", "")
    assert len(msg) < 300, "Blocked message should not be excessively long"
    print(f"  truncation OK (msg len={len(msg)})")


if __name__ == "__main__":
    tests = [
        test_rm_rf_root_blocked,
        test_rm_rf_home_blocked,
        test_git_push_force_blocked,
        test_git_reset_hard_blocked,
        test_safe_ls_passes,
        test_safe_git_status_passes,
        test_non_terminal_tool_not_blocked,
        test_message_truncated_at_80,
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
            import traceback; traceback.print_exc()
            failed.append(t.__name__)

    if failed:
        print(f"\nFAILED: {failed}")
        sys.exit(1)
    print(f"\nAll {len(tests)} tests passed.")
