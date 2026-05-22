# _mcp.py -- thin wrapper around ctx.dispatch_tool for IJFW MCP tools.
# All MCP calls go through call() so tests can mock at a single seam.
# Tool naming: server "ijfw-memory" sanitizes to "ijfw_memory", so:
#   mcp_ijfw_memory_ijfw_memory_prelude
#   mcp_ijfw_memory_ijfw_prompt_check
#   mcp_ijfw_memory_ijfw_run
#   mcp_ijfw_memory_ijfw_memory_store
#   mcp_ijfw_memory_ijfw_metrics

import json

MCP_PREFIX = "mcp_ijfw_memory_"


def call(ctx, tool_short_name, args):
    """Dispatch an IJFW MCP tool. Returns parsed dict or None on failure.

    Wayland/Hermes MCP dispatch wraps every tool response as
    {"result": <text-or-struct>} or {"error": "<msg>"}. This unwraps the
    envelope so callers see the inner payload directly.

    Inner payload handling:
      - dict with structured fields  -> returned as-is
      - JSON-stringified dict        -> parsed and returned
      - plain text string            -> wrapped as {"text": <string>}
      - None / empty                 -> {}
    """
    full_name = MCP_PREFIX + tool_short_name
    try:
        raw = ctx.dispatch_tool(full_name, args)
        if raw is None:
            return None
        envelope = raw if isinstance(raw, dict) else json.loads(raw)
        if not isinstance(envelope, dict):
            return None
        if "error" in envelope:
            return {"error": envelope["error"]}
        # Unwrap {"result": ...}; fall back to envelope itself when no
        # "result" key (some test paths may pre-unwrap).
        inner = envelope["result"] if "result" in envelope else envelope
        if isinstance(inner, dict):
            return inner
        if isinstance(inner, str):
            try:
                parsed = json.loads(inner)
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
            return {"text": inner}
        return {}
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


def memory_store(ctx, content, type=None, session_id=None):
    """Persist a memory entry.

    `type` maps to ijfw_memory_store's required schema field
    (mcp-server/src/server.js:640). Valid values: decision, observation,
    pattern, handoff, preference. Defaults to "observation" when omitted
    so the call always satisfies the required schema.
    """
    payload = {"content": content, "type": type or "observation"}
    if session_id:
        payload["session_id"] = session_id
    return call(ctx, "ijfw_memory_store", payload)


def metrics(ctx, period=None, metric=None, session_id=None):
    """Fetch the IJFW session metrics receipt.

    Dispatches the real `ijfw_metrics` MCP tool (server.js:1048). Returns a
    rendered `{"text": ...}` payload -- tokens/spend/session totals from
    .ijfw/metrics/sessions.jsonl.
    """
    args = {}
    if period:
        args["period"] = period
    if metric:
        args["metric"] = metric
    if session_id:
        args["session_id"] = session_id
    return call(ctx, "ijfw_metrics", args)
