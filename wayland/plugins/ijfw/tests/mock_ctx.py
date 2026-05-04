# mock_ctx.py -- MockPluginContext for all IJFW plugin tests.

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
        # Canned responses keyed by tool suffix.
        if "ijfw_memory_prelude" in name:
            return json.dumps({
                "text": "<canned prelude: 3 active decisions>",
                "memories_loaded": 5,
                "token_savings_pct": 12,
            })
        if "ijfw_prompt_check" in name:
            return json.dumps({"vague": False})
        if "ijfw_run" in name:
            return json.dumps({"ok": True})
        if "ijfw_memory_store" in name:
            return json.dumps({"stored": True})
        if "ijfw_memory_status" in name:
            return json.dumps({
                "tokens_saved": 1200,
                "cost_saved_usd": "0.04",
                "decisions_stored": 3,
            })
        return json.dumps({"ok": True})

    # Convenience: invoke a registered hook by name.
    def invoke_hook(self, hook_name, **kwargs):
        results = []
        for cb in self.hooks.get(hook_name, []):
            r = cb(**kwargs)
            if r is not None:
                results.append(r)
        return results
