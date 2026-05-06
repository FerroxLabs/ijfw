# IJFW Hermes Plugin -- sys.path shim
# Delegates entirely to the Wayland plugin source (one Python file for both platforms).
# Resolves Wayland plugin from installed path or repo-local sibling.

import sys
import os
import importlib.util

_SELF_DIR = os.path.dirname(os.path.abspath(__file__))

_CANDIDATES = [
    # Bundled Hermes modules win. Wayland paths are fallbacks for hosts without
    # a bundled install (rare; avoids stale Wayland code loading under Hermes).
    _SELF_DIR,
    os.path.expanduser("~/.wayland/plugins/ijfw"),
    os.path.normpath(os.path.join(_SELF_DIR, "..", "..", "..", "wayland", "plugins", "ijfw")),
]
WAYLAND_PLUGIN = next((p for p in _CANDIDATES if os.path.isdir(p)), None)
if WAYLAND_PLUGIN is None:
    raise RuntimeError(
        "IJFW Hermes shim cannot find plugin source. "
        "Expected at ~/.wayland/plugins/ijfw, repo-local sibling, or bundled in this dir."
    )

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
