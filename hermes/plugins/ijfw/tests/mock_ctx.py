# mock_ctx.py -- MockPluginContext for all IJFW Hermes plugin tests.
# Mirrors wayland/plugins/ijfw/tests/mock_ctx.py with one additional knob:
# register_command captures args_hint as Hermes' contract requires.

import json


class MockPluginContext:
    def __init__(self):
        self.hooks = {}        # hook_name -> [callback, ...]
        self.commands = {}     # name -> (handler, description, args_hint)
        self._dispatch_log = []

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = (handler, description, args_hint)

    def dispatch_tool(self, name, args):
        self._dispatch_log.append((name, args))
        # Hermes wraps every MCP response as {"result": <text-or-struct>}
        # or {"error": "<msg>"}. The mock mirrors that envelope so the
        # plugin's _mcp.call() unwrapping is exercised by tests.
        def env(payload):
            return json.dumps({"result": json.dumps(payload)})
        if "ijfw_memory_prelude" in name:
            return env({
                "text": "<canned prelude: 3 active decisions>",
                "memories_loaded": 5,
                "token_savings_pct": 12,
            })
        if "ijfw_prompt_check" in name:
            return env({"text": "vague: no"})
        if "ijfw_run" in name:
            return env({"text": "ok"})
        if "ijfw_memory_store" in name:
            return env({"text": "stored"})
        if "ijfw_metrics" in name:
            return env({
                "text": "1200 tokens (~$0.04), 3 sessions logged.",
            })
        return env({"text": "ok"})

    # Convenience: invoke a registered hook by name.
    def invoke_hook(self, hook_name, **kwargs):
        results = []
        for cb in self.hooks.get(hook_name, []):
            r = cb(**kwargs)
            if r is not None:
                results.append(r)
        return results
