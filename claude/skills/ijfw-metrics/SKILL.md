---
name: ijfw-metrics
description: "Internal session metrics tracking. Auto-triggered at session boundaries. Tracks tokens, agent usage, efficiency gains. View with /ijfw-status."
---

# IJFW Metrics -- Internal Tracking

Lightweight metrics captured at session boundaries via hooks.
Zero per-turn cost. All tracking happens in the Stop hook.

## What We Track

At each session end, append to `.ijfw/metrics/sessions.jsonl`:

```json
{
  "timestamp": "2026-04-13T14:30:00Z",
  "session_id": "<session-id>",
  "duration_minutes": 45,
  "turns": 23,
  "mode": "smart",
  "effort": "high",
  "agents_dispatched": {
    "scout": 8,
    "builder": 12,
    "architect": 3
  },
  "memory_ops": {
    "stores": 5,
    "recalls": 2,
    "searches": 1
  },
  "skills_loaded": ["ijfw-core", "ijfw-commit", "ijfw-review"],
  "compactions": 1,
  "handoff_generated": true,
  "routing": "OpenRouter + local model"
}
```

## Derived Metrics (calculated on /ijfw-status)

From the JSONL log, compute:

**Efficiency:**
- Average turns per session
- Agent distribution (% scout vs builder vs architect)
- Estimated token savings from model routing:
  - scout turns x (opus_price - haiku_price) = routing savings
  - builder turns x (opus_price - sonnet_price) = routing savings

**Quality:**
- Sessions with handoff generated (continuity metric)
- Memory operations per session (knowledge accumulation)
- Compaction count (context pressure indicator)
- Skills loaded per session (specialisation usage)

**Cost Projection:**
Using Anthropic pricing (per 1M tokens):
- Haiku: $0.25 input / $1.25 output
- Sonnet: $3 input / $15 output
- Opus: $15 input / $75 output

If smart routing sent 40% of turns to Haiku instead of Opus:
- Savings per 1K output tokens: $73.75 (Opus→Haiku)
- At 50 turns/session, ~500 output tokens/turn average:
- Per session: ~$0.92 saved on routed turns alone

## Status Display Format

When user runs `/ijfw-status` or asks about performance:

```
IJFW Status
Mode: smart | Effort: high | OpenRouter

This Session:
  12 turns | 3 agents dispatched | 2 decisions stored

All Time (47 sessions):
  Smart routing: 340 turns -> scout, 580 -> builder, 127 -> architect
  Estimated savings: ~$43 in model routing
  Memory: 89 decisions, 12 patterns, 4 consolidations
  Continuity: 94% sessions with handoff

Context health: 34% used | Next compact: ~66% threshold
---------------------------------------
```

Positive framing. Show what IJFW has done for you.
Never show negatives or waste metrics.
