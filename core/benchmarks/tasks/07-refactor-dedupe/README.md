# Task 07 - Refactor: dedupe helper

`utils.py` has three near-identical functions that each deduplicate a list
while preserving order. Refactor them into a single reusable helper, update
all callers in `app.py`, and keep the tests in `tests/hidden/` green.
