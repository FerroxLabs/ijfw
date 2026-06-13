#!/usr/bin/env python3
"""test_seed_gate.py -- _should_seed gates AGENTS.md / cold-scan on a real project.

A throwaway scratch dir (no VCS / manifest / `ijfw init`) must be refused so the
Wayland plugin does not litter ephemeral "temporary spaces" with AGENTS.md. A dir
with a marker, or one blessed by `ijfw init` (.ijfw/project), must be allowed.
"""

import sys
import os
import pathlib
import tempfile
import shutil

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

from mock_ctx import MockPluginContext
import _handlers
from _handlers import _should_seed

# Force resolution to the REPO scripts dir (which ships seed-gate.sh). On a dev
# machine the installed copy at ~/.ijfw/... may predate this file and would make
# the gate fail-open; the live install picks it up once shipped. Tests must
# exercise the gate itself, so pin the resolver to the repo copy.
# parents[4] of wayland/plugins/ijfw/tests/test_seed_gate.py == repo root.
_REPO_SCRIPTS = (
    pathlib.Path(__file__).resolve().parents[4]
    / "claude" / "skills" / "ijfw-agents-md" / "scripts"
)
assert (_REPO_SCRIPTS / "seed-gate.sh").is_file(), f"seed-gate.sh missing at {_REPO_SCRIPTS}"
_handlers._agents_md_scripts_dir = lambda ctx: _REPO_SCRIPTS


def _ctx():
    return MockPluginContext()


def test_bare_scratch_dir_refused():
    d = tempfile.mkdtemp(prefix="seedgate-bare-")
    try:
        assert _should_seed(_ctx(), d) is False
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_git_repo_allowed():
    d = tempfile.mkdtemp(prefix="seedgate-git-")
    try:
        os.makedirs(os.path.join(d, ".git"))
        assert _should_seed(_ctx(), d) is True
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_manifest_allowed():
    d = tempfile.mkdtemp(prefix="seedgate-pkg-")
    try:
        with open(os.path.join(d, "package.json"), "w") as fh:
            fh.write("{}")
        assert _should_seed(_ctx(), d) is True
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_ijfw_init_marker_allowed():
    d = tempfile.mkdtemp(prefix="seedgate-bless-")
    try:
        os.makedirs(os.path.join(d, ".ijfw"))
        with open(os.path.join(d, ".ijfw", "project"), "w") as fh:
            fh.write("# blessed")
        assert _should_seed(_ctx(), d) is True
    finally:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
    print(f"Pytest: {passed} passed")
