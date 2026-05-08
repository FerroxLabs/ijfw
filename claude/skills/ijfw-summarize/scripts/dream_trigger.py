# dream_trigger.py -- shared D3 dream-cycle trigger (V3-F3 / D3 inline).
#
# Python sibling of dream-trigger.sh. Fired from Wayland / Hermes plugin
# on_session_end hooks. Replaces the legacy `SESSION_NUM % 5 == 0`
# startup-flag mechanism with INLINE detached spawn. Mirrors
# cold_scan_trigger.py contract verbatim:
#   - 50ms hook-latency budget (subprocess.Popen + start_new_session)
#   - 4-hour cooldown via .ijfw/.dream-state.json (read by the runner)
#   - Silent skip when node is missing, runner is missing, cooldown
#     is active, or another dream cycle is in progress
#   - IJFW_DREAM_LEGACY=1 env reverts to the old startup-flag path
#
# Usage (from Wayland / Hermes hook):
#   from dream_trigger import trigger_dream
#   trigger_dream(os.getcwd(), host="wayland", session_id=session_id)
#
# Discipline:
#   - ASCII only.
#   - No exception ever escapes -- a session-end hook must never crash.
#   - Silent skip when node is missing, runner is missing, cooldown
#     active, or another scan is in progress.

import json
import os
import pathlib
import shutil
import subprocess
import time

# 4-hour default cooldown. IJFW_DREAM_COOLDOWN_MS overrides for tests.
_DEFAULT_COOLDOWN_MS = 4 * 60 * 60 * 1000


def _cooldown_ms():
    raw = os.environ.get("IJFW_DREAM_COOLDOWN_MS")
    if raw is None:
        return _DEFAULT_COOLDOWN_MS
    try:
        v = int(raw)
        return v if v >= 0 else _DEFAULT_COOLDOWN_MS
    except (TypeError, ValueError):
        return _DEFAULT_COOLDOWN_MS


def _resolve_node():
    """Return an absolute path to a usable node binary, or None."""
    on_path = shutil.which("node")
    if on_path:
        return on_path
    for cand in (
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ):
        if pathlib.Path(cand).is_file() and os.access(cand, os.X_OK):
            return cand
    return None


def _resolve_runner(project_root):
    """Return absolute path to dream/runner.mjs, or None.

    Search candidates mirror dream-trigger.sh so the two stay in sync.
    """
    here = pathlib.Path(__file__).resolve().parent
    ijfw_home_env = os.environ.get("IJFW_HOME")
    candidates = [
        pathlib.Path(os.path.expanduser("~/.ijfw/mcp-server/src/dream/runner.mjs")),
    ]
    if ijfw_home_env:
        candidates.append(pathlib.Path(ijfw_home_env) / "mcp-server" / "src" / "dream" / "runner.mjs")
    candidates.append(pathlib.Path(project_root) / "mcp-server" / "src" / "dream" / "runner.mjs")
    # scripts/ -> ijfw-summarize/ -> skills/ -> claude/ -> repo root
    candidates.append(here.parent.parent.parent.parent / "mcp-server" / "src" / "dream" / "runner.mjs")
    for c in candidates:
        try:
            if c and c.is_file():
                return str(c)
        except OSError:
            continue
    return None


def _legacy_path(ijfw_dir):
    """Reproduce the legacy SESSION_NUM % 5 startup-flag write so users
    can revert via IJFW_DREAM_LEGACY=1 without a config swap."""
    try:
        ijfw_dir.mkdir(parents=True, exist_ok=True)
        counter_path = ijfw_dir / ".session-counter"
        cur = 0
        try:
            cur = int(counter_path.read_text(encoding="utf-8").strip() or "0")
        except (OSError, ValueError):
            cur = 0
        if cur > 0 and cur % 5 == 0:
            with open(ijfw_dir / ".startup-flags", "a", encoding="utf-8") as fh:
                fh.write("IJFW_NEEDS_CONSOLIDATE=1\n")
        return {"spawned": False, "reason": "legacy_path"}
    except OSError as exc:
        return {"spawned": False, "reason": "legacy_path failed: {0}".format(exc)}


def _on_cooldown(state_file):
    """Return True if last_run_at is within the cooldown window."""
    if not state_file.is_file():
        return False
    try:
        with open(state_file, encoding="utf-8") as fh:
            obj = json.load(fh)
    except (OSError, ValueError):
        return False
    last = obj.get("last_run_at") if isinstance(obj, dict) else None
    if not isinstance(last, str):
        return False
    # Naive ISO 8601 parser -- avoids importing datetime.fromisoformat()
    # quirks across CPython versions. We just need a millisecond delta.
    try:
        # Python 3.11+: fromisoformat handles trailing 'Z'.
        from datetime import datetime
        ts = last.replace("Z", "+00:00")
        t_ms = int(datetime.fromisoformat(ts).timestamp() * 1000)
    except (ValueError, ImportError):
        return False
    age = int(time.time() * 1000) - t_ms
    if age < 0:
        return False
    return age < _cooldown_ms()


def trigger_dream(project_root, host="unknown", session_id=None):
    """Fire-and-forget D3 dream-cycle trigger. Returns dict for tests.

    Returns:
      {"spawned": True,  "pid": int}                 on successful spawn
      {"spawned": False, "reason": "cooldown"}       within 4h window
      {"spawned": False, "reason": "legacy_path"}    when IJFW_DREAM_LEGACY=1
      {"spawned": False, "reason": <other>}          all silent-skip paths
    """
    try:
        if not project_root:
            return {"spawned": False, "reason": "project root absent"}
        root = pathlib.Path(str(project_root))
        if not root.is_dir():
            return {"spawned": False, "reason": "project root not present"}

        ijfw_dir = root / ".ijfw"

        # Rollback path -- preserves prior behaviour exactly.
        if os.environ.get("IJFW_DREAM_LEGACY", "0") == "1":
            return _legacy_path(ijfw_dir)

        state_file = ijfw_dir / ".dream-state.json"
        if _on_cooldown(state_file):
            return {"spawned": False, "reason": "cooldown"}

        node_bin = _resolve_node()
        if not node_bin:
            return {"spawned": False, "reason": "node not present"}
        runner = _resolve_runner(str(root))
        if not runner:
            return {"spawned": False, "reason": "runner not present"}

        try:
            ijfw_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return {"spawned": False, "reason": "ijfw dir not writable"}

        trigger_lock = ijfw_dir / ".dream-trigger.lock"
        try:
            trigger_lock.mkdir()
        except FileExistsError:
            return {"spawned": False, "reason": "trigger lock held"}
        except OSError:
            return {"spawned": False, "reason": "trigger lock not writable"}

        log_dir = ijfw_dir / "logs"
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            log_dir = None

        argv = [node_bin, runner, "--project-root", str(root), "--host", str(host), "--reason", "session_end"]
        sid = session_id or os.environ.get("IJFW_SESSION_ID")
        if sid:
            argv.extend(["--session-id", str(sid)])

        try:
            if log_dir is not None:
                with open(log_dir / "dream-trigger.log", "a", encoding="utf-8") as log_fh:
                    proc = subprocess.Popen(
                        argv,
                        stdout=log_fh,
                        stderr=log_fh,
                        stdin=subprocess.DEVNULL,
                        close_fds=True,
                        start_new_session=True,
                    )
            else:
                proc = subprocess.Popen(
                    argv,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    close_fds=True,
                    start_new_session=True,
                )
        except (OSError, ValueError) as exc:
            try:
                trigger_lock.rmdir()
            except OSError:
                pass
            return {"spawned": False, "reason": "spawn rejected: {0}".format(exc)}
        finally:
            # Release the trigger-lock immediately after spawn -- the
            # runner enforces its own cooldown gate (cooldown.js).
            try:
                trigger_lock.rmdir()
            except OSError:
                pass

        return {"spawned": True, "pid": proc.pid}
    except Exception as exc:  # noqa: BLE001 -- hook must never crash
        return {"spawned": False, "reason": "internal: {0}".format(exc)}
