# _context_engine.py -- IJFWContextEngine for Wayland singleton slot (C6).
#
# Replaces Wayland's default ContextCompressor. Backed by IJFW's memory
# tiers (working/project/global) + FTS5 warm layer via the mcp-server
# colon-syntax dispatcher. Owns the singleton slot for B1 (blackboard)
# to compose into via attach_blackboard_extension() -- B1 NEVER calls
# register_context_engine() itself (composition contract pinned in
# PLAN-alpha.md section 6 F10).
#
# Profile invariant (V3-B3): every path resolves through
# profileHome(getActiveProfile()) via the live ctx -- never hardcoded
# ~/.wayland/.
#
# Lifecycle (per agent/context_engine.py:ContextEngine):
#   - update_from_response(usage)  -- track prompt/completion/total tokens
#   - should_compress()            -- threshold gate (default 75% of context)
#   - compress(messages, ...)      -- IJFW memory recall + retain protected
#                                     N-first / N-last messages
#   - on_session_start(session_id) -- hydrate prelude into engine state
#   - on_session_end(session_id)   -- flush receipts to mcp-server
#
# Compose hook (B1):
#   attach_blackboard_extension(ext) -- ext.transform(messages) is layered
#                                       inside compress() AFTER the IJFW
#                                       memory recall step, BEFORE return.
#
# Failure mode: any internal error during compress() degrades to a
# tail-protect strategy (return last protect_last_n + first protect_first_n
# messages). Never crashes the agent -- a context engine that blocks
# the conversation is worse than one that compacts conservatively.

import os
import json
import pathlib
import subprocess

# Late-binding import: ContextEngine ABC lives in agent.context_engine.
# When this module is imported in a non-Wayland test environment the
# import will fail. The plugin's register() path catches that and skips
# context-engine registration with a safe-default warning -- the rest of
# the plugin (hooks, commands, MCP tools) keeps working.
try:
    from agent.context_engine import ContextEngine
    _HAS_WAYLAND_CE = True
except ImportError:  # pragma: no cover - exercised in test envs
    _HAS_WAYLAND_CE = False

    class ContextEngine:  # minimal stand-in so the class definition below loads.
        """Stand-in for non-Wayland environments. Keeps shape compatible."""

        last_prompt_tokens = 0
        last_completion_tokens = 0
        last_total_tokens = 0
        threshold_tokens = 0
        context_length = 0
        compression_count = 0
        threshold_percent = 0.75
        protect_first_n = 3
        protect_last_n = 6


def _resolve_profile_home(ctx):
    """Mirror _handlers._resolve_profile_home -- profile-aware path root."""
    for attr in ("profile_home", "profileHome", "get_profile_home"):
        fn = getattr(ctx, attr, None)
        if callable(fn):
            try:
                return pathlib.Path(fn())
            except (TypeError, ValueError, OSError):
                pass
    get_profile = getattr(ctx, "get_active_profile", None) or getattr(ctx, "getActiveProfile", None)
    profile_home = getattr(ctx, "profile_home_for", None) or getattr(ctx, "profileHomeFor", None)
    if callable(get_profile) and callable(profile_home):
        try:
            return pathlib.Path(profile_home(get_profile()))
        except (TypeError, ValueError, OSError):
            pass
    env_override = os.environ.get("IJFW_WAYLAND_PROFILE_HOME")
    if env_override:
        return pathlib.Path(env_override)
    return None


class IJFWContextEngine(ContextEngine):
    """IJFW-backed Wayland context engine.

    Routes compression through IJFW's memory layer. The agent's recent
    turns get summarized into a single "context recall" message that
    references the live IJFW project memory, while protected first-N
    and last-N messages stay verbatim.

    The actual recall payload is fetched via the IJFW MCP server
    (ijfw_memory_prelude tool) when the live ctx is available. Falls
    back to a tail-protect strategy when MCP is unavailable.

    PRAGMA quick_check (V3-F8) is owned by the mcp-server side (writes
    into compute.db go through safeWrite which runs quick_check after
    every insert). The engine's compress() does not write to FTS5
    directly -- it dispatches to mcp-server which enforces the gate.
    """

    @property
    def name(self):
        return "ijfw"

    def __init__(self, ctx=None, project_root=None):
        # ctx is the live PluginContext (provided at register-time);
        # project_root falls back to cwd. Both nullable so the engine
        # is independently testable.
        self._ctx = ctx
        self._project_root = pathlib.Path(project_root or os.getcwd())
        self._session_id = None
        self._prelude_text = ""
        self._memories_loaded = 0
        # B1 composition slot -- empty by default. attach_blackboard_extension
        # populates it. Each extension exposes .transform(messages) -> messages.
        self._extensions = []
        # Sane defaults (run_agent.py reads these for preflight display).
        self.threshold_percent = 0.75
        self.protect_first_n = 3
        self.protect_last_n = 6

    # -- B1 composition hook (F10 pin) -------------------------------------

    def attach_blackboard_extension(self, extension):
        """Layer a B1-style transform inside compress() AFTER recall.

        F10 pin: B1 NEVER calls register_context_engine() itself. It
        attaches here. Order is preserved (FIFO). Extensions are free to
        be a no-op when the blackboard channel is empty.
        """
        if extension is None:
            return
        if not hasattr(extension, "transform"):
            raise TypeError("blackboard extension must expose .transform(messages)")
        self._extensions.append(extension)

    # -- token state -------------------------------------------------------

    def update_from_response(self, usage):
        if not isinstance(usage, dict):
            return
        # OpenAI-style usage block: {prompt_tokens, completion_tokens, total_tokens}
        # or Anthropic {input_tokens, output_tokens}. Cover both.
        prompt = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        completion = usage.get("completion_tokens") or usage.get("output_tokens") or 0
        total = usage.get("total_tokens") or (prompt + completion)
        self.last_prompt_tokens = int(prompt)
        self.last_completion_tokens = int(completion)
        self.last_total_tokens = int(total)

    def should_compress(self, prompt_tokens=None):
        budget = self.threshold_tokens or int((self.context_length or 0) * self.threshold_percent)
        used = prompt_tokens if prompt_tokens is not None else self.last_prompt_tokens
        if not budget:
            return False
        return used >= budget

    # -- main compaction --------------------------------------------------

    def compress(self, messages, current_tokens=None):
        if not isinstance(messages, list) or not messages:
            return messages or []
        try:
            # 1. Recall block from IJFW memory -- single synthesized message.
            recall_message = self._build_recall_message()

            # 2. Protect first-N (system + early anchors) and last-N (recent turns).
            first_n = max(0, int(self.protect_first_n))
            last_n = max(0, int(self.protect_last_n))
            head = messages[:first_n]
            tail = messages[-last_n:] if last_n else []
            # Avoid double-counting when first_n + last_n > total length.
            if first_n + last_n >= len(messages):
                head = messages[:first_n]
                tail = messages[first_n:]

            compacted = list(head)
            if recall_message is not None:
                compacted.append(recall_message)
            compacted.extend(tail)

            # 3. Layer B1 (and any future) extensions.
            for ext in self._extensions:
                try:
                    transformed = ext.transform(compacted)
                    if isinstance(transformed, list) and transformed:
                        compacted = transformed
                except Exception:
                    # Extensions never block compaction.
                    continue

            self.compression_count += 1
            return compacted
        except Exception:
            # Conservative fallback: return tail-protect slice. The
            # agent keeps running; no message is lost mid-conversation.
            return self._safe_tail(messages)

    # -- session lifecycle ------------------------------------------------

    def on_session_start(self, session_id, **kwargs):
        self._session_id = session_id
        # Hydrate prelude best-effort. Failure is silent -- compress()
        # will still operate, just without a recall block on first call.
        prelude = self._mcp_call("ijfw_memory_prelude", {"session_id": session_id})
        if isinstance(prelude, dict):
            self._prelude_text = prelude.get("text", "") or ""
            self._memories_loaded = int(prelude.get("memories_loaded", 0) or 0)

    def on_session_end(self, session_id, messages):
        # Flush a receipt entry. Best-effort -- never raise.
        try:
            self._mcp_call(
                "ijfw_memory_store",
                {
                    "content": (
                        "session_end -- IJFWContextEngine compression_count="
                        f"{self.compression_count}"
                    ),
                    "type": "observation",
                    "session_id": session_id,
                },
            )
        except Exception:
            pass

    # -- internal helpers --------------------------------------------------

    def _build_recall_message(self):
        """Return a single OpenAI-format message that anchors IJFW memory.

        Uses cached prelude when available; otherwise pulls fresh.
        Returns None when no recall content -- callers omit the slot
        rather than inserting an empty message.
        """
        text = self._prelude_text
        if not text:
            prelude = self._mcp_call(
                "ijfw_memory_prelude",
                {"session_id": self._session_id} if self._session_id else {},
            )
            if isinstance(prelude, dict):
                text = prelude.get("text", "") or ""
                self._prelude_text = text
                self._memories_loaded = int(prelude.get("memories_loaded", 0) or 0)
        if not text:
            return None
        return {
            "role": "system",
            "content": (
                "[IJFW context engine -- recalled project memory "
                f"({self._memories_loaded} items)]\n{text}"
            ),
        }

    def _safe_tail(self, messages):
        first_n = max(0, int(self.protect_first_n))
        last_n = max(0, int(self.protect_last_n))
        if first_n + last_n >= len(messages):
            return list(messages)
        return list(messages[:first_n]) + list(messages[-last_n:])

    def _mcp_call(self, tool_short_name, args):
        """Dispatch via the live ctx (preferred) or fall back to ijfw CLI.

        ctx-route mirrors _mcp.call() in this same plugin. Never raises;
        returns None on any failure so compress() degrades gracefully.
        """
        full_name = "mcp_ijfw_memory_" + tool_short_name
        # Path 1: live ctx (Wayland register-time path).
        if self._ctx is not None and hasattr(self._ctx, "dispatch_tool"):
            try:
                raw = self._ctx.dispatch_tool(full_name, args)
                return _unwrap_envelope(raw)
            except Exception:
                pass
        # Path 2: ijfw CLI subprocess (test or out-of-band path). Best-effort.
        try:
            result = subprocess.run(
                ["ijfw", "mcp", tool_short_name, json.dumps(args or {})],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout:
                return _unwrap_envelope(result.stdout)
        except (subprocess.SubprocessError, FileNotFoundError, OSError):
            pass
        return None


def _unwrap_envelope(raw):
    """Normalize {"result": <text-or-struct>} | dict | str into a dict.

    Mirrors _mcp.call() so behaviour stays consistent across both the
    hook surface and the context engine.
    """
    if raw is None:
        return None
    try:
        envelope = raw if isinstance(raw, dict) else json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(envelope, dict):
        return None
    if "error" in envelope:
        return {"error": envelope["error"]}
    inner = envelope["result"] if "result" in envelope else envelope
    if isinstance(inner, dict):
        return inner
    if isinstance(inner, str):
        try:
            parsed = json.loads(inner)
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError):
            pass
        return {"text": inner}
    return {}


# Public symbol for both Wayland and Hermes hosts. The flag exposes
# whether the real Wayland ContextEngine ABC was found at import time
# -- callers can short-circuit registration when False.
__all__ = ["IJFWContextEngine", "_HAS_WAYLAND_CE"]
