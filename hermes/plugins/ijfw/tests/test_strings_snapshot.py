#!/usr/bin/env python3
"""test_strings_snapshot.py -- Sutherland enforcement (Hermes mirror).
Two checks:
1. No sentence-like string literals in __init__.py or _handlers.py live outside _strings.STRINGS.
2. _strings.STRINGS matches the approved strings-fixture.json snapshot exactly.
"""

import sys
import os
import json
import ast

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))

if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from _strings import STRINGS, format_string

FIXTURE_PATH = os.path.join(TESTS_DIR, "strings-fixture.json")

# Files to scan for bare string literals (non-import strings).
FILES_TO_SCAN = [
    os.path.join(PLUGIN_DIR, "__init__.py"),
    os.path.join(PLUGIN_DIR, "_handlers.py"),
]

# Minimum length for a string to be considered "user-facing".
MIN_USER_FACING_LEN = 20

STRINGS_VALUES = set(STRINGS.values())


def _collect_docstring_nodes(tree):
    """Return the set of AST node ids that are docstrings."""
    docstring_ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
            if (
                node.body
                and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
                and isinstance(node.body[0].value.value, str)
            ):
                docstring_ids.add(id(node.body[0].value))
    return docstring_ids


def _collect_non_docstring_strings(filepath):
    """Return all non-docstring string constants >= MIN_USER_FACING_LEN."""
    with open(filepath, encoding="utf-8") as fh:
        source = fh.read()
    tree = ast.parse(source, filename=filepath)
    docstring_ids = _collect_docstring_nodes(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstring_ids and len(node.value) >= MIN_USER_FACING_LEN:
                found.append(node.value)
    return found


def test_snapshot_matches_fixture():
    """_strings.STRINGS must exactly match strings-fixture.json."""
    with open(FIXTURE_PATH, encoding="utf-8") as fh:
        fixture = json.load(fh)

    registry = dict(STRINGS)

    extra_in_registry = set(registry.keys()) - set(fixture.keys())
    missing_from_registry = set(fixture.keys()) - set(registry.keys())
    value_mismatches = {
        k for k in (set(registry.keys()) & set(fixture.keys()))
        if registry[k] != fixture[k]
    }

    errors = []
    if extra_in_registry:
        errors.append(f"Keys in STRINGS not in fixture (add to fixture): {extra_in_registry}")
    if missing_from_registry:
        errors.append(f"Keys in fixture not in STRINGS (removed?): {missing_from_registry}")
    if value_mismatches:
        for k in value_mismatches:
            errors.append(
                f"Value mismatch for '{k}':\n"
                f"  registry: {registry[k]!r}\n"
                f"  fixture:  {fixture[k]!r}"
            )

    assert not errors, "\n".join(errors)
    print(f"  snapshot OK: {len(fixture)} strings match fixture")


def test_no_bare_user_facing_strings():
    """No sentence-like string literals should appear outside _strings.py."""
    violations = []
    for filepath in FILES_TO_SCAN:
        if not os.path.isfile(filepath):
            continue
        literals = _collect_non_docstring_strings(filepath)
        for s in literals:
            if s in STRINGS_VALUES:
                continue
            if s.startswith("\\b") or s.startswith("(") or "\\b" in s:
                continue
            if s.startswith("~/") or s.startswith("/"):
                continue
            # Allow filename-shaped tokens (no whitespace; ends with a known
            # extension). These are technical identifiers, not user copy.
            if " " not in s and s.endswith((".sh", ".py", ".json", ".md", ".js", ".txt")):
                continue
            if not any(c in s for c in ".!?,"):
                continue
            violations.append(f"  {os.path.basename(filepath)}: {s!r}")

    assert not violations, (
        "User-facing string literals found outside _strings.py registry "
        "(move them into STRINGS and the fixture):\n" + "\n".join(violations)
    )
    print(f"  bare-strings check OK ({len(FILES_TO_SCAN)} files scanned)")


# ---------------------------------------------------------------------------
# P5-L1: profile-home templating in format_string()
# ---------------------------------------------------------------------------

class _FakeCtxWithProfileHome:
    """Mock ctx that exposes a `profile_home()` callable returning a custom path."""

    def __init__(self, value):
        self._value = value

    def profile_home(self):
        return self._value


class _FakeCtxWithProfileHomeFor:
    """Mock ctx using the get_active_profile() + profile_home_for(profile) pattern."""

    def __init__(self, profile_name, value):
        self._profile = profile_name
        self._value = value

    def get_active_profile(self):
        return self._profile

    def profile_home_for(self, profile):
        assert profile == self._profile, f"unexpected profile: {profile}"
        return self._value


def test_format_string_resolves_profile_home_with_ctx():
    """format_string MUST replace {profile_home} with the resolved value."""
    ctx = _FakeCtxWithProfileHome("/opt/hermes-tester")
    out = format_string("skill_load_prompt_workflow", ctx)
    assert "/opt/hermes-tester/skills/ijfw-workflow/SKILL.md" in out, (
        f"profile_home not resolved: {out!r}"
    )
    assert "{profile_home}" not in out, (
        f"unrendered placeholder leaked: {out!r}"
    )
    print("  format_string resolves profile_home via ctx.profile_home()")


def test_format_string_resolves_profile_home_via_active_profile():
    """The get_active_profile + profile_home_for pattern must also resolve."""
    ctx = _FakeCtxWithProfileHomeFor("tester", "/var/hermes/profiles/tester")
    out = format_string("skill_load_prompt_handoff", ctx)
    assert "/var/hermes/profiles/tester/skills/ijfw-handoff/SKILL.md" in out, (
        f"profile_home_for not resolved: {out!r}"
    )
    print("  format_string resolves profile_home via profile_home_for(active_profile)")


def test_format_string_falls_back_to_legacy_literal():
    """No ctx + no env override -> falls back to ~/.hermes literal.

    Critical invariant: no surface ever ships an unrendered `{profile_home}`
    token, even when nothing is wired up. The legacy literal preserves prior
    behaviour for users who never set a non-default profile.
    """
    saved = os.environ.pop("IJFW_HERMES_PROFILE_HOME", None)
    try:
        out = format_string("skill_load_prompt_compress", None)
        assert "{profile_home}" not in out, (
            f"unrendered placeholder leaked: {out!r}"
        )
        assert "~/.hermes/skills/ijfw-compress/SKILL.md" in out, (
            f"legacy fallback path mismatch: {out!r}"
        )
        print("  format_string falls back to ~/.hermes literal when ctx is None")
    finally:
        if saved is not None:
            os.environ["IJFW_HERMES_PROFILE_HOME"] = saved


def test_format_string_env_override():
    """IJFW_HERMES_PROFILE_HOME env var overrides the legacy fallback."""
    saved = os.environ.get("IJFW_HERMES_PROFILE_HOME")
    os.environ["IJFW_HERMES_PROFILE_HOME"] = "/tmp/hermes-env-override"
    try:
        out = format_string("skill_load_prompt_workflow", None)
        assert "/tmp/hermes-env-override/skills/ijfw-workflow/SKILL.md" in out, (
            f"env override not honoured: {out!r}"
        )
        print("  format_string honours IJFW_HERMES_PROFILE_HOME env override")
    finally:
        if saved is None:
            os.environ.pop("IJFW_HERMES_PROFILE_HOME", None)
        else:
            os.environ["IJFW_HERMES_PROFILE_HOME"] = saved


def test_no_hardcoded_hermes_paths_in_skill_strings():
    """The three skill_load_prompt_* templates MUST template {profile_home}.

    Regression guard for P5-L1: if anyone re-introduces a hardcoded
    `~/.hermes/skills/...` literal in _strings.py the assert below catches
    it. Pair this with the snapshot test that validates the placeholder
    survived in strings-fixture.json.
    """
    for key in ("skill_load_prompt_workflow", "skill_load_prompt_handoff", "skill_load_prompt_compress"):
        template = STRINGS[key]
        assert "{profile_home}" in template, (
            f"{key} dropped the {{profile_home}} placeholder: {template!r}"
        )
        assert "~/.hermes/skills" not in template, (
            f"{key} re-introduced a hardcoded ~/.hermes literal: {template!r}"
        )
    print("  skill_load_prompt_* templates retain {profile_home} (no hardcoded paths)")


if __name__ == "__main__":
    tests = [
        test_snapshot_matches_fixture,
        test_no_bare_user_facing_strings,
        test_format_string_resolves_profile_home_with_ctx,
        test_format_string_resolves_profile_home_via_active_profile,
        test_format_string_falls_back_to_legacy_literal,
        test_format_string_env_override,
        test_no_hardcoded_hermes_paths_in_skill_strings,
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
