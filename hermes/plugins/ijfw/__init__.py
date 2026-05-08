# IJFW Hermes Plugin -- sys.path shim
# Resolves the bundled Hermes plugin source. Phase 4 made Hermes self-contained
# (its own _context_engine.py + _manifest.py); the historical Wayland fallback
# was retired to keep Hermes profile-invariant clean -- Hermes never reads from
# ~/.wayland/ at runtime. Repo-local Wayland sibling stays as a development-time
# escape hatch only (gated behind IJFW_HERMES_ALLOW_DEV_SIBLING=1).

import sys
import os
import importlib.util

_SELF_DIR = os.path.dirname(os.path.abspath(__file__))

_CANDIDATES = [_SELF_DIR]
if os.environ.get("IJFW_HERMES_ALLOW_DEV_SIBLING") == "1":
    # Dev-only escape hatch -- monorepo workflow where the Hermes bundled
    # plugin is intentionally absent and the developer wants to load from the
    # repo-local Wayland sibling. Never fires in shipped installs.
    _CANDIDATES.append(
        os.path.normpath(os.path.join(_SELF_DIR, "..", "..", "..", "wayland", "plugins", "ijfw"))
    )
WAYLAND_PLUGIN = next((p for p in _CANDIDATES if os.path.isdir(p)), None)
if WAYLAND_PLUGIN is None:
    # Late-resolve the message via the bundled _strings.py to keep all
    # user-facing copy in the strings registry (snapshot-tested).
    _SHIM_ERR_MSG = (
        "IJFW Hermes shim cannot find plugin source. "
        "Expected at ~/.wayland/plugins/ijfw, repo-local sibling, or bundled in this dir."
    )
    try:
        # Best-effort: the bundled _strings.py sits next to this file.
        import importlib.util as _ilu
        _strspec = _ilu.spec_from_file_location(
            "ijfw_hermes_shim_strings",
            os.path.join(_SELF_DIR, "_strings.py"),
        )
        if _strspec is not None and _strspec.loader is not None:
            _strmod = _ilu.module_from_spec(_strspec)
            _strspec.loader.exec_module(_strmod)
            _SHIM_ERR_MSG = _strmod.STRINGS.get("shim_plugin_source_missing", _SHIM_ERR_MSG)
    except Exception:
        pass
    raise RuntimeError(_SHIM_ERR_MSG)

if WAYLAND_PLUGIN not in sys.path:
    sys.path.insert(0, WAYLAND_PLUGIN)

# Alias hermes_cli -> wayland_cli so Wayland's internal imports resolve
# (only needed when resolving from the Wayland tree, harmless otherwise).
try:
    sys.modules["wayland_cli"] = importlib.import_module("hermes_cli")
except ModuleNotFoundError:
    # Test environment: neither CLI module is importable. Safe to skip.
    pass

# Load _handlers under a unique top-level name to avoid collision with
# any other plugin that ships _handlers.py.
_handlers_path = os.path.join(WAYLAND_PLUGIN, "_handlers.py")
spec = importlib.util.spec_from_file_location("ijfw_wayland_handlers", _handlers_path)
_handlers = importlib.util.module_from_spec(spec)
sys.modules["ijfw_wayland_handlers"] = _handlers
spec.loader.exec_module(_handlers)

register = _handlers.build_register_fn(host="hermes")
