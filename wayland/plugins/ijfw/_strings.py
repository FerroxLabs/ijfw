# _strings.py -- registry of every user-facing string emitted by the IJFW plugin.
# ALL user-facing output MUST come from this dict.
# Sutherland rule: lead with value, never with "Error/Failed/Cannot".
# Snapshot test: tests/test_strings_snapshot.py diffs this against strings-fixture.json.

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
        "Load IJFW workflow skill from ~/.wayland/skills/ijfw-workflow/SKILL.md and begin."
    ),
    "skill_load_prompt_handoff": (
        "Load IJFW handoff skill from ~/.wayland/skills/ijfw-handoff/SKILL.md and begin."
    ),
    "skill_load_prompt_compress": (
        "Load IJFW compress skill from ~/.wayland/skills/ijfw-compress/SKILL.md and begin."
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
        "Wayland context engine slot already claimed by another plugin. "
        "IJFW memory keeps running via hooks; the singleton stays with the prior plugin."
    ),
    "context_engine_unavailable": (
        "Wayland context-engine API not detected this session. "
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
