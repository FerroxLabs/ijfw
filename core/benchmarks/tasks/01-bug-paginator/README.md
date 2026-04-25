# Task 01 - Bug fix: off-by-one in paginator

A Python paginator in `paginate.py` returns the wrong page count when the total
is an exact multiple of `page_size`. Fix the bug. Do not change the function
signature. Tests in `tests/hidden/` must pass.
