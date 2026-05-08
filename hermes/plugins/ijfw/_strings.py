# _strings.py -- registry of every user-facing string emitted by the IJFW plugin.
# ALL user-facing output MUST come from this dict.
# Sutherland rule: lead with value, never with "Error/Failed/Cannot".
#
# P5-L1: skill-load prompts now template `{profile_home}` instead of hard-
# coding `~/.hermes/skills/...`. format_string(key, ctx, **kwargs) resolves
# the placeholder via profile_home_for(active_profile) (see _handlers.py
# _resolve_profile_home). When ctx is unavailable the helper falls back to
# the legacy `~/.hermes/skills/...` literal so no surface ever ships an
# unrendered `{profile_home}` token.

STRINGS = {
    "session_start_banner": (
        "IJFW ready ({host} session). {n} memories loaded, {pct}% token savings this project."
    ),
    "session_start_banner_no_memories": (
        "IJFW ready ({host} session). Building memory as you work."
    ),
    "destructive_blocked": (
        "IJFW caught a high-impact command -- confirm by typing it literally if intended: {cmd}"
    ),
    "vague_prompt_nudge": (
        "Sharper prompt, better result. Consider adding a specific target or outcome: {suggestion}"
    ),
    "session_end_receipt": (
        "Session complete. {tokens_saved} tokens saved (~${cost_saved}). {decisions} decisions stored."
    ),
    "session_end_receipt_no_data": (
        "Session complete. Memory updated."
    ),
    "memory_hydration_context": (
        "IJFW project memory ({n} items):\n{content}"
    ),
    "cross_audit_launched": (
        "Cross-audit running against {target}. Results appear inline."
    ),
    "cross_research_launched": (
        "Cross-research running on {target}. Synthesis incoming."
    ),
    "cross_critique_launched": (
        "Cross-critique running on {target}. Independent perspective incoming."
    ),
    "skill_load_prompt_workflow": (
        "Load IJFW workflow skill from {profile_home}/skills/ijfw-workflow/SKILL.md and begin."
    ),
    "skill_load_prompt_handoff": (
        "Load IJFW handoff skill from {profile_home}/skills/ijfw-handoff/SKILL.md and begin."
    ),
    "skill_load_prompt_compress": (
        "Load IJFW compress skill from {profile_home}/skills/ijfw-compress/SKILL.md and begin."
    ),
    "mcp_unavailable": (
        "IJFW memory tools unavailable this session -- proceeding without memory hydration."
    ),
    "observation_stored": (
        "Observation recorded."
    ),
    "auto_memorize_stored": (
        "Decision captured to project memory."
    ),
    "patterns_parse_failed": (
        "IJFW pattern defaults active; checking the next patterns source ({path})."
    ),
    "patterns_sentinel_parse_error": (
        "parse-error at {path}: {err}\n"
    ),
    "patterns_sentinel_missing": (
        "patterns.json not found or unparseable in any candidate path.\n"
    ),
    "patterns_missing": (
        "IJFW pattern defaults active; custom pattern guard is paused until patterns.json is restored."
    ),
    # Hermes shim install-time error (raised when WAYLAND_PLUGIN unresolved).
    "shim_plugin_source_missing": (
        "IJFW Hermes shim cannot find plugin source. "
        "Expected at ~/.wayland/plugins/ijfw, repo-local sibling, or bundled in this dir."
    ),
    # AGENTS.md fallback blocks (P2-M1 inline minimal builder path).
    "agents_md_memory_fallback": (
        "Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context."
    ),
    "agents_md_agents_fallback": (
        "No project agents yet. Run `ijfw team` to set them up."
    ),
    # C6 (Phase 4): IJFWContextEngine + manifest signing chain surfaces.
    "context_engine_claimed": (
        "IJFW memory backbone active -- context engine claimed for {host} session."
    ),
    "context_engine_slot_taken": (
        "Hermes context engine slot already claimed by another plugin. "
        "IJFW memory keeps running via hooks; the singleton stays with the prior plugin."
    ),
    "context_engine_unavailable": (
        "Hermes context-engine API not detected this session. "
        "IJFW memory keeps running via hooks; the singleton stays free for the host's default."
    ),
    "context_engine_integrity_skipped": (
        "IJFW context engine ready (dev mode -- integrity manifest not present)."
    ),
    "context_engine_integrity_failed": (
        "IJFW context engine kept on standby until integrity check clears: {summary}"
    ),
    # Command descriptions (shown in tab-completion + gateway menus).
    "cmd_desc_cross_audit": "Run IJFW cross-audit via Second Opinion (Trident)",
    "cmd_desc_cross_research": "Run IJFW cross-research across model lineages",
    "cmd_desc_cross_critique": "Run IJFW cross-critique for independent perspective",
    "cmd_desc_workflow": "Start the IJFW workflow skill",
    "cmd_desc_handoff": "Run IJFW handoff skill",
    "cmd_desc_compress": "Run IJFW compress skill",
}


# P5-L1: profile-home-aware string formatter (Hermes side).
#
# Templates that include `{profile_home}` (currently the three skill-load
# prompts) need the active Hermes profile resolved at format time so a
# user with a non-default profile sees the right skills path. Direct
# `STRINGS[key].format(...)` callers cannot do that; they call
# `format_string(key, ctx, **kwargs)` instead.
#
# Resolution order (mirrors _handlers._resolve_profile_home):
#   1. ctx.profile_home / ctx.profileHome / ctx.get_profile_home (callable)
#   2. ctx.profile_home_for(ctx.get_active_profile())
#   3. env IJFW_HERMES_PROFILE_HOME (Hermes uses its own override env)
#   4. legacy `~/.hermes` literal (last-resort fallback so no surface
#      ever ships an unrendered `{profile_home}` token)
#
# The function is intentionally tolerant: any introspection error returns
# the legacy literal. Hermes hooks must never crash the host.
import os as _os

_LEGACY_PROFILE_HOME = "~/.hermes"


def _resolve_profile_home_for_strings(ctx):
    """Best-effort profile-home resolver for string formatting.

    Mirrors _handlers._resolve_profile_home but lives in _strings.py so
    `format_string()` stays self-contained (no circular import). Returns a
    POSIX-style string path; never raises.
    """
    if ctx is None:
        return _os.environ.get("IJFW_HERMES_PROFILE_HOME") or _LEGACY_PROFILE_HOME
    for attr in ("profile_home", "profileHome", "get_profile_home"):
        fn = getattr(ctx, attr, None)
        if callable(fn):
            try:
                value = fn()
                if value:
                    return str(value)
            except (TypeError, ValueError, OSError):
                pass
    get_profile = getattr(ctx, "get_active_profile", None) or getattr(ctx, "getActiveProfile", None)
    profile_home = getattr(ctx, "profile_home_for", None) or getattr(ctx, "profileHomeFor", None)
    if callable(get_profile) and callable(profile_home):
        try:
            value = profile_home(get_profile())
            if value:
                return str(value)
        except (TypeError, ValueError, OSError):
            pass
    env_override = _os.environ.get("IJFW_HERMES_PROFILE_HOME")
    if env_override:
        return env_override
    return _LEGACY_PROFILE_HOME


def format_string(key, ctx=None, **kwargs):
    """Render STRINGS[key] with profile_home auto-resolved.

    Use this whenever a string MAY contain `{profile_home}`. For other
    placeholders pass them as kwargs the same way you would with `.format`.
    """
    template = STRINGS[key]
    if "{profile_home}" in template and "profile_home" not in kwargs:
        kwargs["profile_home"] = _resolve_profile_home_for_strings(ctx)
    return template.format(**kwargs)

