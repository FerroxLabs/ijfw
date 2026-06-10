# IJFW — README comparison source (feed to ChatGPT or use as-is)

> **The positioning correction:** IJFW does **not** compete with coding tools (Claude Code, Cursor, Copilot, Hermes, OpenClaw…). It **sits on top of all of them at the MCP level and gives them one shared brain.** Its actual category is the **memory / personalization layer** (Mem0, Letta, Zep…). So this comes in two parts: (1) the tools IJFW *unifies*, (2) IJFW *vs* the memory layer.
>
> **Provenance:** research scan 2026-06-09 (live web + docs); verify before publishing. IJFW rows = built & tested on the v1.6 branch (unreleased). "Roadmap" = not shipped.

---

## PART 1 — The tools IJFW unifies (works-*with*, not vs)

Every developer juggles several of these; each has its own siloed memory (or none). **IJFW puts one shared, learned-from-you brain underneath all of them at once.** Do not present these as competitors.

**Dedicated coding agents:** Claude Code · Codex CLI · Gemini CLI · Cursor · Windsurf · GitHub Copilot · Aider · Cline · OpenCode · Qwen Code · Kimi CLI · Wayland · Antigravity
**General agents with strong coding:** OpenClaw · Hermes (Nous Research) · Pi

> Takeaway: No tool on this list shares its memory with the others. Even Hermes (which has its *own* learning loop) keeps it locked inside Hermes. **IJFW is the only layer that gives you one brain across all 16.**

---

## PART 2 — The real comparison: the memory / personalization layer

IJFW's actual category. The pattern is stark: **every one is something you wire into a single app, one integration at a time, usually cloud-default** — built for app developers bolting memory into *their* product, not for the developer who already uses five tools and wants one memory under all of them.

| Product | How you install it | Auto across all your tools | Learns from your corrections | Local-first (default) | Built for |
|---|---|---|---|---|---|
| **IJFW** | **Zero-config** (install once, sits under existing tools) | **Yes** (no per-app code) | **Yes** (your edit diffs: proposed vs committed) | **Yes** (local-only) | **You** (the individual dev) |
| Mem0 | Per-app SDK (`client.add()`) | No | Extraction (LLM/record + explicit add) | Cloud (self-host avail) | App developers |
| Letta (MemGPT) | Build agents *on* Letta (replaces your tool) | No (Letta-native) | Agent-internal | Both | Agent builders |
| Zep | Per-app SDK → cloud API | No | Graph extraction | Cloud (CE deprecated; Graphiti = your own Neo4j) | App developers |
| Cognee | SDK / MCP server (per-tool MCP config) | Partial (MCP, manual per tool) | LLM extraction | Local | App devs + power users |
| Honcho | Per-integration plugin (per tool) | No | Auto reasoning (once integrated) | Cloud | App developers |
| MemMachine | Deploy middleware + wire (MCP) | Partial (explicit wiring) | Store-after-turn | Both | Agent builders |
| Memori | Per-app SDK (wraps your LLM client) | No | Auto-classify turns | Hybrid | App developers |
| Hindsight (Vectorize) | Per-integration (40+) | No | Explicit retain/recall | Both | App developers |

> Takeaway: they're all **"bolt memory into one app."** IJFW is **"one memory under every app you already use."** The quadrant { local + zero-per-app-code + learns-from-your-corrections + across-all-your-tools } is empty except for IJFW. *(Closest adjacent: BuildBetter CLI syncs team coding context across Claude Code/Cursor/Codex — but it's a team knowledge layer, not a personal learned user-model.)*

---

## PART 3 — Measured against the memory layer (internal lab study — caveat)

> **Standing limitation:** Ferrox Labs authored this benchmark *and* competes in it; LoCoMo is hash-only (replication leg). Directional, not peer-reviewed.

| Claim | Result | Benchmark |
|---|---|---|
| Memory beats no-memory | **0.609** vs **0.058** closed-book ceiling (+55 pts) | longmemeval (MIT), n=138, panel-graded |
| Temporal recall = the moat | Mem0 / Letta / Zep all **0.000** · IJFW **0.676** | LoCoMo temporal split |
| Head-to-head accuracy | IJFW **0.377** > Letta 0.276 > Mem0 0.111 > Zep 0.055 | LoCoMo, matched models, paired McNemar |
| Ingest cost | IJFW ≈ free FTS · Mem0 = 1 LLM call *per record* (~13 min/conv) | cost frontier |

---

## PART 4 — IJFW capability inventory

| Area | Capability | State |
|---|---|---|
| Personalization | Learns what you correct (edit-diff), evidence-gated (cite-or-drop) | Built |
| | On-by-default, flick-to-off; auto-acts high-confidence, else show-and-confirm | Built |
| | Communication-style fingerprint + expertise bands | Built |
| | Drafts in your voice (few-shots your own writing; default-off, forgettable) | Built |
| Cross-tool reach | One profile into 16 tools via MCP + rules-file fallback; zero per-app code | Built |
| | Per-client injection verification (only claims tools it proves) | Built |
| Memory engine | Hybrid retrieval (BM25 + dense, RRF) + multi-hop | Built |
| | Time-aware recall + cross-session round indexing | Built |
| Privacy / control | Local-only; every disclosure logged; one-command forget | Built |
| | Opt-outs (no-inject/no-registry/tenant/no-import); honest uninstall | Built |

---

## PROMPT BLOCK (paste into ChatGPT)

> "Turn the following into a clean developer-tool README section. Keep two distinct framings: PART 1 is the tools IJFW *unifies* (works-with, never 'vs') — render as a logo/chip row. PART 2 is IJFW *vs* the memory layer — render as a comparison table, bold IJFW, lead with 'how you install it' and 'auto across all your tools'. Then the benchmark + capability tables. Keep 'Roadmap' as Roadmap. Tone: confident, not hypey — 'smarter, not cheaper.'"

## HONESTY GUARDRAILS
- Hosts (Part 1) are **"works with," never "vs."**
- **Voice: claim "drafts in your voice using your own writing", NOT "indistinguishable."** IJFW few-shots samples of your own real writing; it does not pass an authorship-verification bar and must never imply it does.
- **Not "never leaves the machine"** → "stored locally, every disclosure logged, forgettable."
- Only list cross-tool clients we verified inject; benchmark numbers carry the standing-limitation caveat.
