#!/usr/bin/env python3
"""Wayland hook: gate tool calls against ~/.ijfw/state/active-extension.json."""
import json, os, sys
from datetime import datetime, timezone


def has(perms, want):
    return want in perms or 'tool:*' in perms


def emit_event(tool_name, ext_name, allowed, reason=None):
    """Append one JSON line to permission-events.jsonl. Best-effort: never aborts."""
    try:
        events_path = os.path.expanduser('~/.ijfw/state/permission-events.jsonl')
        os.makedirs(os.path.dirname(events_path), exist_ok=True)
        event = {'ts': datetime.now(timezone.utc).isoformat(), 'extension': ext_name,
                 'tool': tool_name, 'allowed': allowed}
        if reason:
            event['reason'] = reason
        with open(events_path, 'a') as f:
            f.write(json.dumps(event) + '\n')
    except (OSError, IOError):
        pass


def main():
    payload = json.loads(sys.stdin.read() or '{}')
    tool_name = payload.get('tool', {}).get('name', '').lower()
    active_path = os.path.expanduser('~/.ijfw/state/active-extension.json')
    if not os.path.isfile(active_path):
        sys.exit(0)  # no active extension = allow (same invariant as Claude hook)
    try:
        with open(active_path) as f:
            active = json.load(f)
    except FileNotFoundError:
        sys.exit(0)  # vanished between isfile and open = allow
    except (json.JSONDecodeError, OSError):
        sys.exit(1)  # corrupt file = fail-closed (deny)
    ext_name = active.get('name', '')
    perms = active.get('permissions', {})
    write_tools = {'edit', 'write', 'bash', 'notebookedit'}
    read_tools = {'read', 'glob', 'grep', 'ls', 'notebookread', 'webfetch', 'websearch'}
    perm_key = 'writes' if tool_name in write_tools else 'reads' if tool_name in read_tools else None
    if perm_key is None:
        emit_event(tool_name, ext_name, True, 'unrecognised tool, allow')
        sys.exit(0)
    if not has(perms.get(perm_key, []), f'tool:{tool_name}'):
        sys.stderr.write(f"[ijfw] extension '{ext_name}' lacks tool:{tool_name}\n")
        emit_event(tool_name, ext_name, False, f'missing tool:{tool_name}')
        sys.exit(1)
    emit_event(tool_name, ext_name, True)
    sys.exit(0)


if __name__ == '__main__':
    main()
