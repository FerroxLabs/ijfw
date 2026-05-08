# cold_scan_trigger.py -- shared A3 cold-scan trigger (V3-F3, P3-B1).
#
# Python sibling of cold-scan-trigger.sh. Fired from Wayland/Hermes plugin
# on_session_start hooks. When the project has not yet been classified
# (no .ijfw/project.type) AND no other scan is currently in progress (no
# scan-state.json owner), spawns the Node runner detached so the hook
# returns within ~50ms and the actual scan completes async.
#
# Usage (from a Wayland/Hermes hook):
#   from cold_scan_trigger import trigger_cold_scan
#   trigger_cold_scan(os.getcwd())
#
# Discipline:
#   - ASCII only.
#   - No exception ever escapes -- a session-start hook must never crash.
#   - Silent skip when node is missing, runner is missing, or a scan is
#     already in progress.

import os
import pathlib
import shutil
import subprocess


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
    """Return absolute path to cold-scan-runner.mjs, or None.

    Search candidates mirror cold-scan-trigger.sh so the two stay in sync.
    """
    here = pathlib.Path(__file__).resolve().parent
    ijfw_home_env = os.environ.get("IJFW_HOME")
    candidates = [
        pathlib.Path(os.path.expanduser("~/.ijfw/mcp-server/src/cold-scan-runner.mjs")),
    ]
    if ijfw_home_env:
        candidates.append(pathlib.Path(ijfw_home_env) / "mcp-server" / "src" / "cold-scan-runner.mjs")
    candidates.append(pathlib.Path(project_root) / "mcp-server" / "src" / "cold-scan-runner.mjs")
    # scripts/ -> ijfw-agents-md/ -> skills/ -> claude/ -> repo root
    candidates.append(here.parent.parent.parent.parent / "mcp-server" / "src" / "cold-scan-runner.mjs")
    for c in candidates:
        try:
            if c and c.is_file():
                return str(c)
        except OSError:
            continue
    return None


def trigger_cold_scan(project_root):
    """Fire-and-forget A3 cold-scan trigger. Returns dict with debug info.

    Returns:
      {"spawned": True,  "pid": int}  on successful spawn
      {"spawned": False, "reason": str} on every silent-skip path
    """
    try:
        if not project_root:
            return {"spawned": False, "reason": "project root absent"}
        root = pathlib.Path(str(project_root))
        if not root.is_dir():
            return {"spawned": False, "reason": "project root not present"}

        ijfw_dir = root / ".ijfw"
        if (ijfw_dir / "project.type").is_file():
            # Already classified; cache invalidation lives in the detector.
            return {"spawned": False, "reason": "already classified"}
        if (ijfw_dir / "scan-state.json").is_file():
            # Another scan is in progress; skip rather than race.
            return {"spawned": False, "reason": "scan in progress"}

        node_bin = _resolve_node()
        if not node_bin:
            return {"spawned": False, "reason": "node not present"}
        runner = _resolve_runner(str(root))
        if not runner:
            return {"spawned": False, "reason": "runner not present"}

        # Atomic mkdir lock -- prevents parallel hooks from racing the spawn.
        try:
            ijfw_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return {"spawned": False, "reason": "ijfw dir not writable"}
        trigger_lock = ijfw_dir / ".cold-scan-trigger.lock"
        try:
            trigger_lock.mkdir()
        except FileExistsError:
            return {"spawned": False, "reason": "trigger lock held"}
        except OSError:
            return {"spawned": False, "reason": "trigger lock not writable"}

        log_dir = pathlib.Path(os.path.expanduser("~/.ijfw/logs"))
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            log_dir = None

        try:
            if log_dir is not None:
                with open(log_dir / "cold-scan.log", "a", encoding="utf-8") as log_fh:
                    proc = subprocess.Popen(
                        [node_bin, runner, "--project-root", str(root)],
                        stdout=log_fh,
                        stderr=log_fh,
                        stdin=subprocess.DEVNULL,
                        close_fds=True,
                        start_new_session=True,
                    )
            else:
                proc = subprocess.Popen(
                    [node_bin, runner, "--project-root", str(root)],
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
            # Release the trigger-lock immediately after spawn -- the runner
            # itself takes a deeper lock on scan-state.json (P3-M6).
            try:
                trigger_lock.rmdir()
            except OSError:
                pass

        return {"spawned": True, "pid": proc.pid}
    except Exception as exc:  # noqa: BLE001 -- hook must never crash
        return {"spawned": False, "reason": "internal: {0}".format(exc)}
