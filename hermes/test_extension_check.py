#!/usr/bin/env python3
"""Tests for hermes/plugins/ijfw/hooks/pre_tool_use_extension_check.py.

Pins tier-2 sandbox behavior on the Hermes platform. Stdlib only:
subprocess + tempfile + json + unittest + os + sys + pathlib.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HOOK_PATH = str(
    Path(__file__).resolve().parent
    / "plugins"
    / "ijfw"
    / "hooks"
    / "pre_tool_use_extension_check.py"
)


def run_hook(home_dir, payload_obj):
    """Invoke the hook with HOME pinned to home_dir and the given JSON payload."""
    env = os.environ.copy()
    env["HOME"] = home_dir
    # Also set USERPROFILE for Windows-friendliness; expanduser('~') falls back
    # to HOME on POSIX, but no harm in setting both.
    env["USERPROFILE"] = home_dir
    payload = json.dumps(payload_obj)
    return subprocess.run(
        [sys.executable, HOOK_PATH],
        input=payload,
        capture_output=True,
        text=True,
        env=env,
    )


def write_state(home_dir, state_obj_or_raw):
    """Write state file. If a dict is passed, JSON-encode; if str, write raw."""
    state_dir = Path(home_dir) / ".ijfw" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / "active-extension.json"
    if isinstance(state_obj_or_raw, str):
        state_path.write_text(state_obj_or_raw)
    else:
        state_path.write_text(json.dumps(state_obj_or_raw))
    return state_path


class ExtensionCheckHookTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self._orig_home = os.environ.get("HOME")

    def tearDown(self):
        if self._orig_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._orig_home
        self._tmp.cleanup()

    # (a) no state file present -> exit 0, no stderr
    def test_no_state_file(self):
        # Ensure no active-extension.json exists in tmpdir HOME
        state_path = Path(self.home) / ".ijfw" / "state" / "active-extension.json"
        self.assertFalse(state_path.exists())
        result = run_hook(self.home, {"tool": {"name": "Edit"}})
        self.assertEqual(result.returncode, 0, msg=f"stderr={result.stderr!r}")
        self.assertEqual(result.stderr, "")

    # (b) deny write tool when permissions lack tool:edit; verify
    # permission-events.jsonl side-effect with allowed:false.
    def test_deny_write_tool(self):
        write_state(
            self.home,
            {"name": "x", "permissions": {"reads": ["tool:read"], "writes": []}},
        )
        result = run_hook(self.home, {"tool": {"name": "Edit"}})
        self.assertEqual(result.returncode, 1)
        self.assertIn("lacks tool:edit", result.stderr)

        # Side-effect: permission-events.jsonl appended with allowed:false
        events_path = Path(self.home) / ".ijfw" / "state" / "permission-events.jsonl"
        self.assertTrue(
            events_path.exists(),
            msg="permission-events.jsonl should be created on deny",
        )
        lines = [
            ln for ln in events_path.read_text().splitlines() if ln.strip()
        ]
        self.assertGreaterEqual(len(lines), 1)
        last_event = json.loads(lines[-1])
        self.assertEqual(last_event.get("allowed"), False)
        self.assertEqual(last_event.get("tool"), "edit")
        self.assertEqual(last_event.get("extension"), "x")

    # (c) allow read tool when reads contains tool:read
    def test_allow_read_tool(self):
        write_state(
            self.home,
            {"name": "x", "permissions": {"reads": ["tool:read"], "writes": []}},
        )
        result = run_hook(self.home, {"tool": {"name": "Read"}})
        self.assertEqual(
            result.returncode, 0, msg=f"stderr={result.stderr!r}"
        )

    # (d) malformed state file -> fail-closed (exit 1)
    def test_malformed_state_fail_closed(self):
        write_state(self.home, "not json")
        result = run_hook(self.home, {"tool": {"name": "Edit"}})
        self.assertEqual(result.returncode, 1)

    # (e) wildcard writes ["tool:*"] allows any write tool (e.g. Bash)
    def test_wildcard_writes_allows_any(self):
        write_state(
            self.home,
            {"name": "x", "permissions": {"reads": [], "writes": ["tool:*"]}},
        )
        result = run_hook(self.home, {"tool": {"name": "Bash"}})
        self.assertEqual(
            result.returncode, 0, msg=f"stderr={result.stderr!r}"
        )


if __name__ == "__main__":
    unittest.main()
