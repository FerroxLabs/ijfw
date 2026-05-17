#!/usr/bin/env python3
"""Hermes hook: gate tool calls against ~/.ijfw/state/active-extension.json."""
import json, os, sys


def has(perms, want):
    return want in perms or 'tool:*' in perms


def main():
    payload = json.loads(sys.stdin.read() or '{}')
    tool_name = payload.get('tool', {}).get('name', '').lower()
    active_path = os.path.expanduser('~/.ijfw/state/active-extension.json')
    if not os.path.isfile(active_path):
        sys.exit(0)  # no active extension = allow (same invariant as Claude hook)
    try:
        with open(active_path) as f:
            active = json.load(f)
    except (OSError, json.JSONDecodeError):
        sys.exit(0)
    perms = active.get('permissions', {})
    write_tools = {'edit', 'write', 'bash', 'notebookedit'}
    read_tools = {'read', 'glob', 'grep', 'ls', 'notebookread', 'webfetch', 'websearch'}
    perm_key = 'writes' if tool_name in write_tools else 'reads' if tool_name in read_tools else None
    if perm_key is None:
        sys.exit(0)
    if not has(perms.get(perm_key, []), f'tool:{tool_name}'):
        sys.stderr.write(f"[ijfw] extension '{active.get('name')}' lacks tool:{tool_name}\n")
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()
