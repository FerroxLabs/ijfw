# Personalization

IJFW learns how you work from the edits you make and the corrections you give (locally, from your own changes, never from profiling or telemetry) and carries one shared profile across every coding tool you use.

This page explains what that means precisely: what gets captured, what gets injected, how the two are separated, and the exact commands to inspect, disable, or wipe everything. For the underlying data-flow model, see [privacy.md](privacy.md). For where this sits in the product, see the [README](../README.md).

---

## The correction loop

The core mechanism is the **correction loop**, and it is deliberately narrow. IJFW does not try to model "you." It models the *gap between what the AI proposed and what you actually shipped.*

When an agent proposes a change and you edit it before committing (delete the try-catch it added, rename the variable, swap `requests` for `httpx`, tighten a verbose comment) that delta is the signal: `diff(proposed, committed)`. What you *reject* is a far cleaner signal than what you *write*, because what you write is contaminated by deadlines, legacy code, and copy-paste. What you correct is intentional.

The goal is concrete and falsifiable: **stop making you repeat the same correction.** If you remove an AI-added wrapper in a given context and it never re-adds it there, the loop worked. That is the whole bar: not "sounds like you," just "stops doing the thing you already told it not to do."

Three properties keep the loop honest:

- **Evidence-gated (cite-or-drop).** Nothing becomes part of your profile unless it cites something you actually said, edited, rejected, or repeated. A preference with no verbatim evidence span is dropped, not guessed. This is an evidence-admission system, not a personality engine: it prefers *under*-learning to mis-learning.
- **Corroboration before it counts.** A candidate preference stays *unconfirmed* until it has been observed enough times across separate, non-adjacent sessions. One-off edits don't graduate to durable preferences. A later contradicting edit flips the sign and is recorded with history, never silently overwritten.
- **Self-influence excluded.** If IJFW already injected "be terse" and the model then writes tersely, that output is *not* counted as fresh evidence of your terseness. Confidence can't be manufactured from the system's own suggestions.

The loop is **cross-tool**: a correction captured while you're in one agent informs the profile that every other agent consults. One profile, every tool, via the local MCP server, with a rules-file fallback for tools that don't speak MCP.

### Lifecycle of a learned preference

Every candidate moves through a conservative gate before it can influence anything, and can always move back out:

```
observed → candidate → corroborated → active → decayed/forgotten
```

An `observed` signal is a single edit or rejection with its cite span. It becomes a `candidate` once slugged and PII-scrubbed, stays unconfirmed until it's `corroborated` by repeated, non-adjacent observations, and only then goes `active` (injection-eligible). Preferences carry a half-life: one you stop reinforcing decays toward an archive tier rather than lingering forever, and a contradicting edit invalidates the old value with history kept (bi-temporal: the system remembers what it used to believe and when that stopped being true). Nothing is hard-deleted by decay; only you delete, via `forget`.

---

## What's captured

Capture runs locally and is on by default. It is metadata-and-citation only: it does not ship your code or your conversations anywhere (see [privacy.md](privacy.md)). Three things are derived:

### Corrections and preferences

The edit-diffs and explicit "no, do it this way" signals described above, each stored as a short slug plus the verbatim span that justifies it, scoped to global / repo / language as appropriate. PII is scrubbed before a slug is formed.

### Communication-style fingerprint

A small numeric fingerprint along four axes (**formality, energy, terseness, emoji use**) maintained as a running average. This is derived from *message metadata*, not from reading the content of what you wrote: lengths, structure, and surface signals, not semantics. It is used as a **dial** that nudges how an agent addresses you, never as a generator of text.

### Expertise bands

A per-area confidence band ("assume this level, skip the basics") computed as a conservative lower-bound over how often you accept versus rewrite the AI's output in that area. More rewrites lower the band; consistent acceptance raises it. Again: derived from accept/edit *counts*, not from the content of your messages.

These three are the durable, minimized tier: numbers, slugs, and counts. That is the only material ever eligible to travel into a prompt.

---

## Voice exemplars (opt-in, default-off)

IJFW can draft **in your voice** by few-shotting **samples of your own writing** (your prompt text and your git commit messages) so a generated commit message or doc paragraph *sounds like you*.

Be precise about what this is and isn't:

- It uses **your own real writing** as few-shot examples. It is a rendering aid, not an identity model.
- It **does not** claim to be statistically indistinguishable from you, and there is **no authorship-proof** behind it. An authorship-verification effort was evaluated and **deliberately cut**: the instrument couldn't clear an honest bar, so we don't ship the claim. "Drafts in your voice, sounds like you" is the honest framing. Anything stronger would be marketing, not measurement.
- It is **default-off and opt-in.** Nothing about your prose is used to draft for you unless you turn voice on.
- It is **visible and forgettable.** The exemplar set is your own text, stored locally in a transient tier, never promoted into the durable profile, and wiped by `forget` like everything else.

Capture is also conservative about what counts as "your writing": it skips control prompts, slash-commands, and pasted machine output (code blocks, stack traces, diffs, logs), so the voice set stays natural language you actually authored.

---

## Captured vs injected: two separate switches

This distinction is the heart of the design. **Capturing** a profile and **injecting** it into a prompt are different actions with different owners.

| | Capture | Inject |
|---|---|---|
| What it does | Derives the local profile from your edits | Adds the profile to an agent's context |
| Default | On (local only) | You own the switch (`ask` by default) |
| Leaves your machine? | No | Only when *you* send a prompt to a cloud host, and only the minimized tier |
| Logged | (n/a) | Every disclosure is appended to `~/.ijfw/profile/egress.log` |

Capturing locally costs you nothing and discloses nothing. Injection is the moment a profile could ride into a cloud model's context, so injection is the switch you control. When it's on, only the minimized tier travels (the numeric fingerprint, preference slugs, and counts), never your raw text, and never (in this release) verbatim prose. Every injection is written to the local egress log so you can audit exactly what was disclosed and when.

We do **not** claim your profile "never leaves the machine." The honest line is: **it is stored locally, you control and audit every disclosure, every disclosure is logged, and you can forget any of it.**

---

## Commands

Real CLI, available wherever IJFW is installed:

```
ijfw personalize status     # show what's been learned + current flags
ijfw personalize on         # allow the learned profile into prompts
ijfw personalize off        # stop injecting: instant kill-switch
ijfw personalize forget     # delete the learned profile (right to be forgotten)
```

- **`status`**: prints the current capture/inject flags and a summary of what has been inferred so far: the style fingerprint, expertise bands, and any corroborated preferences. Start here.
- **`on` / `off`**: toggle whether the profile is injected into prompts. `off` is an immediate kill-switch; capture continues locally but nothing is disclosed. Injection defaults to `ask`.
- **`forget`**: wipes the inferred profile, including voice exemplars. This is the hard reset.

To review individual learned entries and remove them one at a time rather than wiping everything, use the memory-audit surface:

```
ijfw memory forget <pattern>   # remove a specific learned entry
```

The profile lives in plain files under `~/.ijfw/profile/`. You can read it, diff it, back it up, or delete the directory by hand. There is no account and no server-side copy.

---

## What this is not

- **Not profiling or telemetry.** Nothing about you is sent to IJFW or any third party. There is no IJFW account and nothing phones home.
- **Not learning from your private data.** It learns from your *edits and corrections* (actions you take in your own tooling), not from scanning your files or your history.
- **Not an authorship model.** Voice drafting uses your own samples as examples; it makes no statistical claim to be you.
- **Not on for injection by default.** Local capture is on; putting the profile into a prompt is a switch you own and can revoke instantly.

---

See [privacy.md](privacy.md) for the full data-flow and disclosure model, and the [README](../README.md) for how personalization fits alongside memory and the cross-tool layer.
