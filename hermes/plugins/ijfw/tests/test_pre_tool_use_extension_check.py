"""pytest coverage for hermes pre_tool_use_extension_check.py"""
import json, os, subprocess, sys
import pytest

HOOK = os.path.join(os.path.dirname(__file__), '..', 'hooks', 'pre_tool_use_extension_check.py')


def run_hook(payload, tmp_path, monkeypatch):
    """Run the hook as a subprocess with HOME pointed at tmp_path."""
    env = os.environ.copy()
    env['HOME'] = str(tmp_path)
    env['USERPROFILE'] = str(tmp_path)  # cross-platform
    result = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps(payload),
        capture_output=True, text=True, env=env
    )
    return result


def make_active(tmp_path, data):
    state = tmp_path / '.ijfw' / 'state'
    state.mkdir(parents=True, exist_ok=True)
    (state / 'active-extension.json').write_text(json.dumps(data))


def read_events(tmp_path):
    path = tmp_path / '.ijfw' / 'state' / 'permission-events.jsonl'
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# --- missing active-extension.json → allow ---

def test_no_active_extension_allows(tmp_path, monkeypatch):
    result = run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)
    assert result.returncode == 0


def test_no_active_extension_no_event(tmp_path, monkeypatch):
    run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)
    assert read_events(tmp_path) == []


# --- corrupt JSON → deny (fail-closed) ---

def test_corrupt_json_denies(tmp_path, monkeypatch):
    state = tmp_path / '.ijfw' / 'state'
    state.mkdir(parents=True, exist_ok=True)
    (state / 'active-extension.json').write_text('{not valid json')
    result = run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)
    assert result.returncode != 0


# --- allowed tool ---

def test_allowed_tool_exits_zero(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:edit']}
    })
    result = run_hook({'tool': {'name': 'edit'}}, tmp_path, monkeypatch)
    assert result.returncode == 0


def test_allowed_tool_emits_event(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:edit']}
    })
    run_hook({'tool': {'name': 'edit'}}, tmp_path, monkeypatch)
    events = read_events(tmp_path)
    assert len(events) == 1
    assert events[0]['allowed'] is True
    assert events[0]['tool'] == 'edit'
    assert events[0]['extension'] == 'my-ext'
    assert 'ts' in events[0]


# --- denied tool ---

def test_denied_tool_exits_nonzero(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:edit']}
    })
    result = run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)
    assert result.returncode != 0


def test_denied_tool_emits_event(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:edit']}
    })
    run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)
    events = read_events(tmp_path)
    assert len(events) == 1
    assert events[0]['allowed'] is False
    assert events[0]['tool'] == 'bash'


# --- tool:* wildcard allows any tool ---

def test_wildcard_allows_any_write_tool(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:*']}
    })
    result = run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)
    assert result.returncode == 0


def test_wildcard_allows_any_read_tool(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'reads': ['tool:*']}
    })
    result = run_hook({'tool': {'name': 'grep'}}, tmp_path, monkeypatch)
    assert result.returncode == 0


# --- both allow and deny emit events ---

def test_both_allow_and_deny_emit_events(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:edit']}
    })
    run_hook({'tool': {'name': 'edit'}}, tmp_path, monkeypatch)   # allow
    run_hook({'tool': {'name': 'bash'}}, tmp_path, monkeypatch)   # deny
    events = read_events(tmp_path)
    assert len(events) == 2
    allowed_flags = {e['allowed'] for e in events}
    assert allowed_flags == {True, False}


# --- best-effort: unwritable events dir still lets hook work ---

def test_unwritable_events_dir_hook_still_works(tmp_path, monkeypatch):
    make_active(tmp_path, {
        'name': 'my-ext',
        'permissions': {'writes': ['tool:edit']}
    })
    # Create events dir as a file (makes append fail) to simulate unwritable path
    state = tmp_path / '.ijfw' / 'state'
    events_path = state / 'permission-events.jsonl'
    # Replace the dir that makedirs would create with a read-only file
    events_path.parent.mkdir(parents=True, exist_ok=True)
    # Overwrite with a directory where a file is expected (makedirs will succeed,
    # but open(..., 'a') on a directory raises IsADirectoryError / OSError)
    events_path.mkdir()  # now it's a dir, open() for append will fail
    result = run_hook({'tool': {'name': 'edit'}}, tmp_path, monkeypatch)
    assert result.returncode == 0  # hook must not abort
