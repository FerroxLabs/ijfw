# _mcp.py -- thin wrapper around ctx.dispatch_tool for IJFW MCP tools.
# All MCP calls go through call() so tests can mock at a single seam.
# Tool naming: server "ijfw-memory" sanitizes to "ijfw_memory", so:
#   mcp_ijfw_memory_ijfw_memory_prelude
#   mcp_ijfw_memory_ijfw_prompt_check
#   mcp_ijfw_memory_ijfw_run
#   mcp_ijfw_memory_ijfw_memory_store
#   mcp_ijfw_memory_ijfw_memory_status

import json

MCP_PREFIX = "mcp_ijfw_memory_"


def call(ctx, tool_short_name, args):
    """Dispatch an IJFW MCP tool. Returns parsed dict or None on failure."""
    full_name = MCP_PREFIX + tool_short_name
    try:
        raw = ctx.dispatch_tool(full_name, args)
        if raw is None:
            return None
        if isinstance(raw, dict):
            return raw
        return json.loads(raw)
    except Exception:
        return None


def memory_prelude(ctx, session_id=None):
    args = {}
    if session_id:
        args["session_id"] = session_id
    return call(ctx, "ijfw_memory_prelude", args)


def prompt_check(ctx, prompt, session_id=None):
    args = {"prompt": prompt}
    if session_id:
        args["session_id"] = session_id
    return call(ctx, "ijfw_prompt_check", args)


def run(ctx, command, args=None, session_id=None):
    payload = {"command": command}
    if args:
        payload["args"] = args
    if session_id:
        payload["session_id"] = session_id
    return call(ctx, "ijfw_run", payload)


def memory_store(ctx, content, category=None, session_id=None):
    payload = {"content": content}
    if category:
        payload["category"] = category
    if session_id:
        payload["session_id"] = session_id
    return call(ctx, "ijfw_memory_store", payload)


def memory_status(ctx, session_id=None):
    args = {}
    if session_id:
        args["session_id"] = session_id
    return call(ctx, "ijfw_memory_status", args)
