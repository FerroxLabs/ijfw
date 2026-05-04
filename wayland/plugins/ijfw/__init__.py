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
import sys
import os

# Ensure the plugin directory is importable as a package root.
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

# Import _handlers under a unique top-level alias so the Hermes shim
# can locate it without name-collision risk.
_handlers = importlib.import_module("_handlers")
sys.modules.setdefault("ijfw_wayland_handlers", _handlers)

# Module-level register fn -- Wayland calls register(ctx) directly.
register = _handlers.build_register_fn("wayland")
