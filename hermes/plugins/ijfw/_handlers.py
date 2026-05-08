# _handlers.py -- hook and command implementations for the IJFW Hermes plugin.
# build_register_fn(host) is the factory used by both Hermes and the Wayland shim.

import json
import os
import re
import subprocess
import pathlib

from _strings import STRINGS
import _mcp as mcp
from _context_engine import IJFWContextEngine, _HAS_HERMES_CE
from _manifest import verify_manifest, render_verification_summary


# ---------------------------------------------------------------------------
# Hermes profile resolver (mirrors V3-B3 Wayland invariant)
# ---------------------------------------------------------------------------
# Hermes inherits the same profile-aware path discipline -- never hardcode
# ~/.hermes/. Resolve through the live ctx when available.

def _resolve_profile_home(ctx):
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
    env_override = os.environ.get("IJFW_HERMES_PROFILE_HOME")
    if env_override:
        return pathlib.Path(env_override)
    return None


def _agents_md_scripts_dir(ctx):
    """Locate the ijfw-agents-md scripts dir under the resolved Hermes profile.

    Mirrors the Wayland resolver -- same V3-B3 search order. Returns the
    dir path containing lock.sh + build-blocks.sh + hoist-frontmatter.sh.
    """
    candidates = []
    profile_root = _resolve_profile_home(ctx)
    if profile_root is not None:
        candidates.append(profile_root / "plugins" / "ijfw" / "skills" / "ijfw-agents-md" / "scripts")
    candidates.append(pathlib.Path(os.path.expanduser("~/.ijfw/claude/skills/ijfw-agents-md/scripts")))
    repo_local = pathlib.Path(__file__).parent.parent.parent.parent / "claude" / "skills" / "ijfw-agents-md" / "scripts"
    candidates.append(repo_local)
    for c in candidates:
        if (c / "lock.sh").is_file() and (c / "build-blocks.sh").is_file():
            return c
    return None


def _build_agents_md_blocks(project_root):
    """Construct (memory_block, agents_block) via the shared build_blocks.py.

    P2-M1: single point of maintenance shared with Wayland + sh hooks.
    """
    import sys
    scripts_dir = pathlib.Path(__file__).parent.parent.parent.parent / "claude" / "skills" / "ijfw-agents-md" / "scripts"
    candidates = [
        scripts_dir,
        pathlib.Path(os.path.expanduser("~/.ijfw/claude/skills/ijfw-agents-md/scripts")),
    ]
    for cand in candidates:
        if (cand / "build_blocks.py").is_file():
            sys_path_added = False
            try:
                if str(cand) not in sys.path:
                    sys.path.insert(0, str(cand))
                    sys_path_added = True
                from build_blocks import build_blocks as _bb
                return _bb(project_root)
            except (ImportError, OSError):
                pass
            finally:
                if sys_path_added:
                    try:
                        sys.path.remove(str(cand))
                    except ValueError:
                        pass
    # Minimal inline fallback.
    pr = pathlib.Path(project_root)
    memory_block = STRINGS["agents_md_memory_fallback"]
    agents_block = STRINGS["agents_md_agents_fallback"]
    return memory_block, agents_block


def _trigger_cold_scan(ctx, project_root):
    """P3-B1: A3 cold-scan trigger via the shared cold_scan_trigger.py helper.

    Mirrors cold-scan-trigger.sh wiring in the shell hooks. Imports the
    shared module from the resolved scripts dir so Hermes never duplicates
    the trigger logic inline (matches the build_blocks.py shared-lib pattern).
    Fire-and-forget; never blocks the on_session_start hook.
    """
    import sys
    scripts_dir = _agents_md_scripts_dir(ctx)
    if scripts_dir is None:
        return
    if not (scripts_dir / "cold_scan_trigger.py").is_file():
        return
    sys_path_added = False
    try:
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
            sys_path_added = True
        from cold_scan_trigger import trigger_cold_scan as _tcs
        _tcs(project_root)
    except (ImportError, OSError):
        pass
    finally:
        if sys_path_added:
            try:
                sys.path.remove(str(scripts_dir))
            except ValueError:
                pass


def _merge_agents_md(ctx, project_root):
    """Background-safe AGENTS.md merge for the Hermes session-start path.

    P2-M2: single multi-pair lock invocation (one backup, one rename).
    P2-B2: hoist-frontmatter runs after the merge.
    P2-M4: log file open via `with` block; Popen dups the fd, parent closes.
    """
    scripts_dir = _agents_md_scripts_dir(ctx)
    if scripts_dir is None:
        return
    lock_sh = scripts_dir / "lock.sh"
    hoist_sh = scripts_dir / "hoist-frontmatter.sh"
    target = pathlib.Path(project_root) / "AGENTS.md"
    memory_block, agents_block = _build_agents_md_blocks(project_root)
    log_path = pathlib.Path(os.path.expanduser("~/.ijfw/logs/agents-md.log"))

    import tempfile
    try:
        tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="ijfw-agents-md-build-"))
    except (OSError, ValueError):
        return
    try:
        mem_file = tmp_dir / "memory.txt"
        ag_file = tmp_dir / "agents.txt"
        try:
            mem_file.write_text(memory_block, encoding="utf-8")
            ag_file.write_text(agents_block, encoding="utf-8")
        except OSError:
            return

        hoist_cmd = (
            f' && bash {str(hoist_sh).replace(chr(34), chr(92)+chr(34))} '
            f'{str(target).replace(chr(34), chr(92)+chr(34))}'
        ) if hoist_sh.is_file() else ''
        chained = (
            f'bash "{lock_sh}" "{target}" '
            f'"MEMORY:{mem_file}" "AGENTS:{ag_file}"'
            f'{hoist_cmd}; rm -rf "{tmp_dir}" 2>/dev/null || true'
        )

        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as log_fh:
                subprocess.Popen(
                    ["bash", "-c", chained],
                    stdout=log_fh,
                    stderr=log_fh,
                    stdin=subprocess.DEVNULL,
                    close_fds=True,
                )
        except OSError:
            try:
                subprocess.Popen(
                    ["bash", "-c", chained],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    close_fds=True,
                )
            except (OSError, ValueError):
                return
    finally:
        pass

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
    """Load patterns.json. Try post-install path first, fall back to repo-local.
    On parse failure or missing-file, write a sentinel and warn so /ijfw doctor
    can surface the silent-fallback regression. Per-iteration parse failures
    continue the loop -- a corrupt post-install copy should not block the
    repo-local fallback from loading."""
    candidates = [
        pathlib.Path(os.path.expanduser("~/.ijfw/shared/lib/patterns.json")),
        pathlib.Path(__file__).parent.parent.parent.parent / "shared" / "lib" / "patterns.json",
    ]
    sentinel = pathlib.Path(os.path.expanduser("~/.ijfw/.patterns-fallback-active"))
    for path in candidates:
        if path.is_file():
            try:
                with open(path, encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, ValueError) as err:
                try:
                    sentinel.parent.mkdir(parents=True, exist_ok=True)
                    sentinel.write_text(STRINGS["patterns_sentinel_parse_error"].format(path=path, err=err), encoding="utf-8")
                except OSError:
                    pass
                print(STRINGS["patterns_parse_failed"].format(path=path))
    # No parseable file found at any candidate path.
    try:
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text(STRINGS["patterns_sentinel_missing"], encoding="utf-8")
    except OSError:
        pass
    print(STRINGS["patterns_missing"])
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
# C6: peek helper for context-engine slot detection (V3-F9 alpha bridge)
# ---------------------------------------------------------------------------
# Hermes' PluginContext doesn't expose a public "is the slot held?" reader
# yet (V3-F9 queues an upstream PR for beta). We best-effort sniff the
# private _manager._context_engine attribute that Hermes uses internally
# so the plugin can give the user a clear "slot taken" message instead of
# a silent no-op when it loses the race.
#
# Failure mode: any introspection error returns None so callers fall
# through to the "host API not detected" message. This is a soft probe
# only; never raises.

def _peek_context_engine_held(ctx, expect=None):
    try:
        manager = getattr(ctx, "_manager", None)
        if manager is None:
            return None
        held = getattr(manager, "_context_engine", None)
        if expect is not None:
            return held is expect
        return held is not None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# build_register_fn factory
# ---------------------------------------------------------------------------

def build_register_fn(host="hermes"):
    """Return a register(ctx) function parameterised by host name."""

    def register(ctx):
        # Shared state across hooks within this session.
        state = {
            "prelude_loaded": False,
            "prelude_text": "",
            "memories_loaded": 0,
            "context_engine": None,
            "context_engine_status": None,
        }

        # ----------------------------------------------------------------
        # C6 (Phase 4): IJFWContextEngine + signing chain
        # ----------------------------------------------------------------
        # Order is load-bearing:
        #   1. Verify manifest checksums first -- a tampered plugin must NOT
        #      be allowed to claim the singleton context engine slot.
        #   2. Confirm Hermes' ContextEngine ABC is reachable (Wayland hosts
        #      may resolve the same shim path; both behave identically).
        #   3. Attempt singleton claim. If another plugin already holds the
        #      slot, Hermes logs a warning and returns silently -- we mirror
        #      that with a positive-framed safe-default and keep all hooks/
        #      commands wired so the rest of IJFW works.
        try:
            integrity = verify_manifest()
        except Exception:
            integrity = {"verified": False, "manifest_present": False, "mismatched": [], "missing": []}

        if not _HAS_HERMES_CE:
            state["context_engine_status"] = STRINGS["context_engine_unavailable"]
        elif not integrity.get("manifest_present"):
            state["context_engine_status"] = STRINGS["context_engine_integrity_skipped"]
        elif not integrity.get("verified"):
            summary = render_verification_summary(integrity)
            state["context_engine_status"] = STRINGS["context_engine_integrity_failed"].format(summary=summary)
        else:
            engine = IJFWContextEngine(ctx=ctx, project_root=os.getcwd())
            state["context_engine"] = engine
            register_ce = getattr(ctx, "register_context_engine", None)
            if not callable(register_ce):
                state["context_engine_status"] = STRINGS["context_engine_unavailable"]
            else:
                slot_taken_before = bool(_peek_context_engine_held(ctx))
                try:
                    register_ce(engine)
                except Exception:
                    state["context_engine_status"] = STRINGS["context_engine_slot_taken"]
                else:
                    slot_taken_after = bool(_peek_context_engine_held(ctx, expect=engine))
                    if slot_taken_before and not slot_taken_after:
                        state["context_engine_status"] = STRINGS["context_engine_slot_taken"]
                    else:
                        state["context_engine_status"] = STRINGS["context_engine_claimed"].format(host=host)

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
            # AGENTS.md cross-platform merge (Phase 2 / A1). lock.sh is
            # resolved via the Hermes profile-home resolver (mirrors V3-B3).
            try:
                _merge_agents_md(ctx, os.getcwd())
            except Exception:
                pass
            # P3-B1: A3 cold-scan trigger -- fire-and-forget detached spawn
            # that lands .ijfw/project.type for the next session. Shared
            # helper (no inline duplicate per P3-M8).
            try:
                _trigger_cold_scan(ctx, os.getcwd())
            except Exception:
                pass
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
            if response and _is_memorable(response):
                mcp.memory_store(
                    ctx,
                    content=str(response)[:500],
                    type="observation",
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
                type="observation",
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
                try:
                    subprocess.Popen(
                        ["ijfw", "cross", mode, target],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    launched_key = f"cross_{mode.replace('-', '_')}_launched"
                    return STRINGS[launched_key].format(target=target or "current context")
                except FileNotFoundError:
                    return f"[ijfw] `ijfw` not found in PATH — install IJFW CLI to use cross-{mode}."
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


# Module-level register for Hermes direct load.
register = build_register_fn("hermes")


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
    except (OSError, PermissionError) as exc:
        log_path = pathlib.Path(os.path.expanduser("~/.ijfw/logs/hermes-handlers.log"))
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as lf:
                lf.write(f"observation write failed: {exc}\n")
        except OSError:
            pass
