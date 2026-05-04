#!/usr/bin/env python3
"""test_strings_snapshot.py -- Sutherland enforcement.
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

from _strings import STRINGS

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
            # Allow strings that come directly from STRINGS registry.
            if s in STRINGS_VALUES:
                continue
            # Allow regex patterns (contain backslash-b word boundary or parens).
            if s.startswith("\\b") or s.startswith("(") or "\\b" in s:
                continue
            # Allow filesystem paths (start with ~/ or /).
            if s.startswith("~/") or s.startswith("/"):
                continue
            # Allow f-string fragment keys and short technical tokens.
            if not any(c in s for c in ".!?,"):
                continue
            violations.append(f"  {os.path.basename(filepath)}: {s!r}")

    assert not violations, (
        "User-facing string literals found outside _strings.py registry "
        "(move them into STRINGS and the fixture):\n" + "\n".join(violations)
    )
    print(f"  bare-strings check OK ({len(FILES_TO_SCAN)} files scanned)")


if __name__ == "__main__":
    tests = [
        test_snapshot_matches_fixture,
        test_no_bare_user_facing_strings,
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
