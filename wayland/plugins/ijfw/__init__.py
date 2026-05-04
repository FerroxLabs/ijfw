# IJFW Wayland Plugin
# Entry point: register(ctx) -> None
# Wayland discovers this via plugin.yaml + this module.
# The Hermes shim (hermes/plugins/ijfw/__init__.py) imports
# _handlers.build_register_fn("hermes") from this plugin's directory.
#
# Unique module alias exposed for Hermes sys.path shim:
#   import ijfw_wayland_handlers  ->  this package's _handlers module
# (avoids collision with any other plugin shipping _handlers.py)

import importlib
import importlib.util
import sys
import os

# Ensure the plugin directory is importable as a package root for our
# own peer modules (_mcp, _strings) that _handlers imports.
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

# Load _handlers via importlib.util with a UNIQUE module name. Using
# importlib.import_module("_handlers") would resolve sys.modules first --
# if another plugin already imported its own _handlers.py, we'd silently
# use theirs. Loading by file path with a unique sys.modules key
# prevents this.
_HANDLERS_PATH = os.path.join(_PLUGIN_DIR, "_handlers.py")
_spec = importlib.util.spec_from_file_location(
    "ijfw_wayland_handlers", _HANDLERS_PATH
)
_handlers = importlib.util.module_from_spec(_spec)
sys.modules["ijfw_wayland_handlers"] = _handlers
_spec.loader.exec_module(_handlers)

# Module-level register fn -- Wayland calls register(ctx) directly.
register = _handlers.build_register_fn("wayland")
