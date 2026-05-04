# _handlers.py -- hook and command implementations for the IJFW Wayland plugin.
# build_register_fn(host) is the factory used by both Wayland and the Hermes shim.

import json
import os
import re
import subprocess
import pathlib

from _strings import STRINGS
import _mcp as mcp

# ---------------------------------------------------------------------------
# patterns.json loader
# ---------------------------------------------------------------------------

def _posix_to_python_re(pattern):
    """Translate POSIX ERE character class names to Python re equivalents."""
    return (
        pattern
        .replace("[[:space:]]", r"\s")
        .replace("[[:alpha:]]", r"[a-zA-Z]")
        .replace("[[:digit:]]", r"[0-9]")
        .replace("[[:alnum:]]", r"[a-zA-Z0-9]")
        .replace("[[:lower:]]", r"[a-z]")
        .replace("[[:upper:]]", r"[A-Z]")
    )


def _load_patterns():
    """Load patterns.json. Try post-install path first, fall back to repo-local."""
    candidates = [
        pathlib.Path(os.path.expanduser("~/.ijfw/shared/lib/patterns.json")),
        pathlib.Path(__file__).parent.parent.parent.parent / "shared" / "lib" / "patterns.json",
    ]
    for path in candidates:
        if path.is_file():
            try:
                with open(path, encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                pass
    return {}


def _compile_patterns(raw_list, flags=0):
    compiled = []
    for p in raw_list:
        try:
            compiled.append(re.compile(_posix_to_python_re(p), flags))
        except re.error:
            pass
    return compiled


_PATTERNS = _load_patterns()
DESTRUCTIVE_PATTERNS = _compile_patterns(_PATTERNS.get("destructive_commands", []))
VAGUE_PATTERNS = _compile_patterns(_PATTERNS.get("vague_prompt_signals", []), re.IGNORECASE)


# ---------------------------------------------------------------------------
# build_register_fn factory
# ---------------------------------------------------------------------------

def build_register_fn(host="wayland"):
    """Return a register(ctx) function parameterised by host name."""

    def register(ctx):
        # Shared state across hooks within this session.
        state = {
            "prelude_loaded": False,
            "prelude_text": "",
            "memories_loaded": 0,
        }

        # Helper: register command with optional args_hint for Hermes.
        def reg_cmd(name, handler, description="", args_hint=""):
            if host == "hermes":
                ctx.register_command(name, handler, description, args_hint)
            else:
                ctx.register_command(name, handler, description)

        # ----------------------------------------------------------------
        # Hook: on_session_start
        # ----------------------------------------------------------------
        def on_session_start(**kwargs):
            session_id = kwargs.get("session_id")
            result = mcp.memory_prelude(ctx, session_id=session_id)
            if result:
                state["prelude_loaded"] = True
                state["prelude_text"] = result.get("text", "")
                n = result.get("memories_loaded", 0)
                state["memories_loaded"] = n
                pct = result.get("token_savings_pct", 0)
                banner = STRINGS["session_start_banner"].format(
                    host=host, n=n, pct=pct
                )
            else:
                banner = STRINGS["session_start_banner_no_memories"].format(host=host)
            # Banner is informational; return value ignored by Wayland.
            return banner

        ctx.register_hook("on_session_start", on_session_start)

        # ----------------------------------------------------------------
        # Hook: pre_llm_call
        # ----------------------------------------------------------------
        def pre_llm_call(**kwargs):
            session_id = kwargs.get("session_id")
            user_message = kwargs.get("user_message", "")
            is_first_turn = kwargs.get("is_first_turn", False)

            injected = []

            # First-turn memory hydration if on_session_start missed it.
            if is_first_turn and not state["prelude_loaded"]:
                result = mcp.memory_prelude(ctx, session_id=session_id)
                if result:
                    state["prelude_loaded"] = True
                    state["prelude_text"] = result.get("text", "")
                    state["memories_loaded"] = result.get("memories_loaded", 0)

            if state["prelude_text"]:
                injected.append(
                    STRINGS["memory_hydration_context"].format(
                        n=state["memories_loaded"],
                        content=state["prelude_text"],
                    )
                )

            # Vague-prompt nudge via MCP prompt_check.
            if user_message:
                check = mcp.prompt_check(ctx, user_message, session_id=session_id)
                if check and check.get("vague"):
                    suggestion = check.get("suggestion", "")
                    injected.append(
                        STRINGS["vague_prompt_nudge"].format(suggestion=suggestion)
                    )

            if injected:
                return {"context": "\n\n".join(injected)}
            return None

        ctx.register_hook("pre_llm_call", pre_llm_call)

        # ----------------------------------------------------------------
        # Hook: pre_tool_call -- destructive-command guard
        # ----------------------------------------------------------------
        def pre_tool_call(**kwargs):
            tool_name = kwargs.get("tool_name", "")
            args = kwargs.get("args", {})

            if tool_name == "terminal":
                cmd = args.get("command", "") if isinstance(args, dict) else ""
                for pattern in DESTRUCTIVE_PATTERNS:
                    if pattern.search(cmd):
                        return {
                            "action": "block",
                            "message": STRINGS["destructive_blocked"].format(
                                cmd=cmd[:80]
                            ),
                        }
            return None

        ctx.register_hook("pre_tool_call", pre_tool_call)

        # ----------------------------------------------------------------
        # Hook: post_tool_call -- observation ledger
        # ----------------------------------------------------------------
        def post_tool_call(**kwargs):
            session_id = kwargs.get("session_id")
            tool_name = kwargs.get("tool_name", "")
            result = kwargs.get("result", "")
            # Trim + emit JSONL observation (3-line inline per-platform convention).
            observation = {
                "tool": tool_name,
                "session_id": session_id,
                "result_chars": len(str(result)),
            }
            _append_observation(observation)
            return None

        ctx.register_hook("post_tool_call", post_tool_call)

        # ----------------------------------------------------------------
        # Hook: post_llm_call -- auto-memorize signal capture
        # ----------------------------------------------------------------
        def post_llm_call(**kwargs):
            session_id = kwargs.get("session_id")
            response = kwargs.get("response", "")
            # Look for decision/conclusion signals and store.
            if response and _is_memorable(response):
                mcp.memory_store(
                    ctx,
                    content=str(response)[:500],
                    category="auto",
                    session_id=session_id,
                )
            return None

        ctx.register_hook("post_llm_call", post_llm_call)

        # ----------------------------------------------------------------
        # Hook: on_session_end -- savings receipt
        # ----------------------------------------------------------------
        def on_session_end(**kwargs):
            session_id = kwargs.get("session_id")
            status = mcp.memory_status(ctx, session_id=session_id)
            if status:
                tokens_saved = status.get("tokens_saved", 0)
                cost_saved = status.get("cost_saved_usd", "0.00")
                decisions = status.get("decisions_stored", 0)
                receipt = STRINGS["session_end_receipt"].format(
                    tokens_saved=tokens_saved,
                    cost_saved=cost_saved,
                    decisions=decisions,
                )
            else:
                receipt = STRINGS["session_end_receipt_no_data"]
            mcp.memory_store(
                ctx,
                content=f"session_end receipt: {receipt}",
                category="session",
                session_id=session_id,
            )
            return None

        ctx.register_hook("on_session_end", on_session_end)

        # ----------------------------------------------------------------
        # Commands: cross-audit / cross-research / cross-critique
        # ----------------------------------------------------------------
        def _cross_cmd(mode):
            def handler(raw_args):
                target = (raw_args or "").strip()
                launched_key = f"cross_{mode.replace('-', '_')}_launched"
                msg = STRINGS[launched_key].format(target=target or "current context")
                try:
                    subprocess.Popen(
                        ["ijfw", "cross", mode, target],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                except FileNotFoundError:
                    pass
                return msg
            return handler

        reg_cmd(
            "cross-audit",
            _cross_cmd("audit"),
            STRINGS["cmd_desc_cross_audit"],
            args_hint="[target]",
        )
        reg_cmd(
            "cross-research",
            _cross_cmd("research"),
            STRINGS["cmd_desc_cross_research"],
            args_hint="[topic]",
        )
        reg_cmd(
            "cross-critique",
            _cross_cmd("critique"),
            STRINGS["cmd_desc_cross_critique"],
            args_hint="[target]",
        )

        # ----------------------------------------------------------------
        # Commands: workflow / handoff / compress (skill-load instructions)
        # ----------------------------------------------------------------
        def cmd_workflow(raw_args):
            return STRINGS["skill_load_prompt_workflow"]

        def cmd_handoff(raw_args):
            return STRINGS["skill_load_prompt_handoff"]

        def cmd_compress(raw_args):
            return STRINGS["skill_load_prompt_compress"]

        reg_cmd("workflow", cmd_workflow, STRINGS["cmd_desc_workflow"])
        reg_cmd("handoff", cmd_handoff, STRINGS["cmd_desc_handoff"])
        reg_cmd("compress", cmd_compress, STRINGS["cmd_desc_compress"])

    return register


# Module-level register for Wayland direct load.
register = build_register_fn("wayland")


# ---------------------------------------------------------------------------
# Internal helpers (not part of the public hook surface)
# ---------------------------------------------------------------------------

_MEMORABLE_SIGNALS = [
    re.compile(r"\b(decided|decision|conclusion|approach|architecture|design)\b", re.IGNORECASE),
    re.compile(r"\b(chosen|going with|we will|we are using|confirmed)\b", re.IGNORECASE),
]


def _is_memorable(text):
    for pat in _MEMORABLE_SIGNALS:
        if pat.search(text):
            return True
    return False


def _append_observation(obs):
    """Append a JSONL observation entry to ~/.ijfw/observations.jsonl."""
    try:
        path = pathlib.Path(os.path.expanduser("~/.ijfw/observations.jsonl"))
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obs) + "\n")
    except Exception:
        pass
