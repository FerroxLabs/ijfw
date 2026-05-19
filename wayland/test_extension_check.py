#!/usr/bin/env python3
"""Lock-in tests for wayland tier-2 sandbox hook (pre_tool_use_extension_check.py).

Pins the tier-2 contract so future refactors of the wayland extension-check
hook can't silently regress the sandbox guarantees:
  - missing state file = allow (no active extension)
  - corrupt state = fail-closed (deny)
  - write tools require an explicit tool:<name> or tool:* in writes
  - read tools (grep, glob, read, ...) check the reads bucket
  - permission events are appended as JSONL on every gated decision

Pure stdlib only. Each test uses an isolated tmpdir HOME so we never touch
the developer's real ~/.ijfw state.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "plugins",
    "ijfw",
    "hooks",
    "pre_tool_use_extension_check.py",
)


def run_hook(home_dir, payload_obj):
    """Invoke the hook with HOME set to ``home_dir`` and ``payload_obj`` as stdin JSON."""
    env = os.environ.copy()
    env["HOME"] = home_dir
    # Windows expands ~ from USERPROFILE; mirror HOME so the test works there too.
    env["USERPROFILE"] = home_dir
    return subprocess.run(
        [sys.executable, HOOK_PATH],
        input=json.dumps(payload_obj),
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )


def write_state(home_dir, state_obj_or_raw):
    """Write active-extension.json under ``home_dir``. Accepts dict or raw str."""
    state_dir = os.path.join(home_dir, ".ijfw", "state")
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, "active-extension.json")
    with open(path, "w") as f:
        if isinstance(state_obj_or_raw, str):
            f.write(state_obj_or_raw)
        else:
            json.dump(state_obj_or_raw, f)
    return path


class ExtensionCheckHookTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    # --- a ---------------------------------------------------------------
    def test_no_state_file_allows(self):
        """No active-extension.json => exit 0 (no active extension = allow)."""
        result = run_hook(self.home, {"tool": {"name": "Edit"}})
        self.assertEqual(
            result.returncode,
            0,
            msg=f"expected exit 0, got {result.returncode}; stderr={result.stderr!r}",
        )

    # --- b ---------------------------------------------------------------
    def test_deny_write_tool_without_permission(self):
        """Extension with only reads:[tool:read] cannot call Write."""
        write_state(
            self.home,
            {
                "name": "x",
                "permissions": {"reads": ["tool:read"], "writes": []},
            },
        )
        result = run_hook(self.home, {"tool": {"name": "Write"}})
        self.assertEqual(
            result.returncode,
            1,
            msg=f"expected exit 1, got {result.returncode}; stderr={result.stderr!r}",
        )
        self.assertIn("lacks tool:write", result.stderr)

        # 6th assertion: permission-events.jsonl was created and the deny was logged.
        events_path = os.path.join(
            self.home, ".ijfw", "state", "permission-events.jsonl"
        )
        self.assertTrue(
            os.path.isfile(events_path),
            msg="permission-events.jsonl was not created",
        )
        with open(events_path) as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip()]
        self.assertTrue(lines, msg="permission-events.jsonl is empty")
        matched = False
        for ln in lines:
            event = json.loads(ln)
            if (
                event.get("tool") == "write"
                and event.get("allowed") is False
            ):
                matched = True
                break
        self.assertTrue(
            matched,
            msg=f"no allowed:false event for tool 'write' found in {lines!r}",
        )

    # --- c ---------------------------------------------------------------
    def test_allow_read_tool(self):
        """Grep is in the read_tools set; tool:read in reads should allow it."""
        write_state(
            self.home,
            {
                "name": "x",
                "permissions": {"reads": ["tool:read", "tool:grep"], "writes": []},
            },
        )
        result = run_hook(self.home, {"tool": {"name": "Grep"}})
        self.assertEqual(
            result.returncode,
            0,
            msg=f"expected exit 0, got {result.returncode}; stderr={result.stderr!r}",
        )

    # --- d ---------------------------------------------------------------
    def test_malformed_state_fails_closed(self):
        """Corrupt JSON state must fail-closed (deny)."""
        write_state(self.home, "{ not json")
        result = run_hook(self.home, {"tool": {"name": "Edit"}})
        self.assertEqual(
            result.returncode,
            1,
            msg=f"expected exit 1 (fail-closed), got {result.returncode}; stderr={result.stderr!r}",
        )

    # --- e ---------------------------------------------------------------
    def test_wildcard_writes_allows_edit(self):
        """writes:['tool:*'] should allow any write tool, including Edit."""
        write_state(
            self.home,
            {
                "name": "x",
                "permissions": {"reads": [], "writes": ["tool:*"]},
            },
        )
        result = run_hook(self.home, {"tool": {"name": "Edit"}})
        self.assertEqual(
            result.returncode,
            0,
            msg=f"expected exit 0, got {result.returncode}; stderr={result.stderr!r}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
