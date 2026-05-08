# build_blocks.py -- shared builder for AGENTS.md MEMORY + AGENTS blocks
# (P2-M1 -- byte-equivalent Python port of build-blocks.sh used by Wayland
# and Hermes handlers).
#
# Public API:
#   build_blocks(project_root) -> (memory_text, agents_text)
#
# ASCII only. No emojis.

import pathlib


def build_blocks(project_root):
    """Return (memory_text, agents_text) for the AGENTS.md merge.

    project_root: path-like; the user's project directory (the one that
    contains .ijfw/).
    """
    pr = pathlib.Path(project_root)

    # --- MEMORY block ---
    memory_text = (
        "Project memory at .ijfw/memory/. "
        "Call `ijfw_memory_prelude` for full context."
    )
    handoff = pr / ".ijfw" / "memory" / "handoff.md"
    if handoff.is_file():
        try:
            lines = [
                ln for ln in handoff.read_text(encoding="utf-8", errors="ignore").splitlines()
                if ln.strip() and not ln.startswith("<!-- ijfw")
            ][:2]
            if lines:
                memory_text = memory_text + "\n\nLast handoff: " + " ".join(lines)
        except OSError:
            pass

    # --- AGENTS block ---
    agents_dir = pr / ".ijfw" / "agents"
    rows = []
    if agents_dir.is_dir():
        for f in sorted(agents_dir.glob("*.md")):
            name = f.stem
            desc = ""
            try:
                for ln in f.read_text(encoding="utf-8", errors="ignore").splitlines():
                    if ln.startswith("description:"):
                        desc = ln.split(":", 1)[1].strip()
                        break
            except OSError:
                pass
            rows.append(f"- **{name}** -- {desc}" if desc else f"- **{name}**")
    agents_text = (
        "\n".join(rows) if rows
        else "No project agents yet. Run `ijfw team` to set them up."
    )

    return memory_text, agents_text
