# Privacy & control

IJFW does not promise your data "never leaves your machine." It promises something you can actually verify: your memory and profile are **stored locally** as plain text, every disclosure to a cloud is **logged**, and everything is **forgettable**. This page is the full accounting behind the README's "It's yours" pillar.

The honest framing: nothing here phones home on its own. But the whole point of IJFW is to feed context to AI agents, and some of those agents are cloud models. So the rule is not "bytes never leave": it's that bytes leave only when **you** point a tool at a cloud, that disclosure is recorded in a log you can read, and the record can be purged.

---

## Where your data lives

Everything IJFW knows about you is a file on your disk. No database server, no account, no remote sync.

| What | Where | Format |
|---|---|---|
| Project memory | `<project>/CLAUDE.md` / `AGENTS.md` managed block, and `<project>/.ijfw/` | plain markdown |
| Global memory | `~/.ijfw/memory/` | plain markdown |
| Your learned profile | `~/.ijfw/profile/user-profile.md` | plain markdown |
| Disclosure log (egress) | `~/.ijfw/profile/egress.log` | JSONL, one line per disclosure |
| Cross-AI audit receipts | `<project>/.ijfw/receipts/cross-runs.jsonl` | JSONL |

The profile is the one deliberate exception to per-project scoping: it is about *you*, not a repo, so it is homedir-rooted (`~/.ijfw/profile/`) and shared across every project. It is written atomically with a `.bak` copy and a symlink guard, and capped/decayed so it never grows unbounded.

You can read any of these files in a text editor right now. There is nothing encrypted, obfuscated, or remote to inspect.

---

## Capture and disclosure are separate consents

IJFW draws a hard line between **learning** something locally and **disclosing** it to an agent.

- **Capture** writes to your local profile/memory. It happens on-device with no LLM call and no network.
- **Injection** (disclosure) is what puts a learned style brief into an AI's context. This is **off by default**: the `inject` setting starts at `ask`, which means *nothing is injected* until you opt in with `ijfw personalize on`.

Turning injection off does not stop local capture: `ijfw personalize off` disables disclosure while learning continues on disk. The two are independent switches on purpose, so "stop telling agents about me" and "stop learning" are different decisions you make separately.

---

## The egress log: every disclosure is recorded

Every time your profile leaves the machine (a brief rendered for a host, or a direct `profile.get`) exactly what left is appended to `~/.ijfw/profile/egress.log` as one JSON line:

```json
{ "ts": "...", "host": "...", "session": "...", "fields": ["preference::tests-pass-before-commit", "style:formality"] }
```

`fields[]` lists the precise inference and style/expertise tags that were disclosed. This is the audit trail that answers *"what has any agent ever seen about me?"* Disclosures bound for a **cloud** host carry an explicit `cloud: true` flag on the line, so cloud-bound leaks are distinguishable from local ones at a glance.

The log is append-only and written with `O_NOFOLLOW` + owner-only (`0600`) permissions so it can't be redirected through a planted symlink. It is honest about its own limits: it is **advisory, not tamper-proof**. It is not hash-chained, so a local process with write access to the file could rewrite prior lines. The guarantee is that IJFW itself never writes through a symlink and records every disclosure it makes, not that the file is cryptographically sealed against you or anything else running as your user.

---

## Opt-outs and kill switches

Several independent off-ramps, from "this one project" to "all of it, now":

- **`.ijfw/no-inject`**: drop an empty file at `<project>/.ijfw/no-inject` (or set `IJFW_NO_INJECT`) and IJFW will not author its managed block into that project's `CLAUDE.md` / `AGENTS.md` and will not inject the profile there. Per-project, surgical.
- **`ijfw personalize off`**: stop injecting the learned profile everywhere. Local capture continues.
- **`IJFW_PROFILE_KILL`**: the hard kill switch. Set it truthy (`IJFW_PROFILE_KILL=1`) and it **always wins**: it forces injection off across every surface and every host, regardless of any other setting. A bare `*` or `KILL` line in `~/.ijfw/profile/redact.txt` does the same. This is the panic button.
- **`ijfw personalize share-sensitive off`**: keep low-sensitivity fields flowing but withhold medium/high-sensitivity ones. Sensitivity gating is on by default; only low-sensitivity fields are eligible for disclosure unless you widen this.
- **Tenant isolation**: declare a tenant in `<project>/.ijfw/tenant` (first line) or via `IJFW_TENANT`. Cross-project memory search then only surfaces projects in the same tenant, so one client's memory never bleeds into another's session. Opt-in and migration-free: absent a declaration, everything is one default tenant and nothing changes.
- **No-import**: IJFW never ingests your existing memory from other tools unless you explicitly run an import (e.g. `ijfw import claude-mem`, which is idempotent and supports `--dry-run`). Nothing is imported behind your back.
- **`--no-marketplace`**: at install or uninstall time, skip touching `~/.claude/settings.json` entirely.

---

## Audit and one-command forget

Two commands cover the whole "what do you know, and delete it" loop:

```bash
ijfw personalize status            # show current flags + a summary of what was inferred
ijfw personalize forget [pattern]  # delete inferences; no pattern = forget EVERYTHING
```

`forget` is not cosmetic. It deletes the matching inferences from your profile **and** purges the egress log of every entry that referenced them, under the global profile lock, with an atomic rewrite. Dropping the whole egress entry (rather than scrubbing one field) is the privacy-conservative choice: if a now-forgotten inference was ever disclosed, the record of that disclosure is expunged too, so a deleted fact can't be resurrected from the audit trail.

`forget` with no pattern wipes the entire learned profile. Patterns must match an inference id or tag (bare-substring deletion is rejected as an over-deletion foot-gun). Cross-AI audit receipts have their own purge: `ijfw --purge-receipts`.

---

## Honest uninstall

One command reverses the install across every configured platform, and it tells you the truth about what it did.

```bash
ijfw-install --uninstall       # or: ijfw uninstall  /  ijfw off
ijfw uninstall --purge         # also delete ~/.ijfw/memory/ (destructive, unrecoverable)
```

What it does:

- **Every modified file is backed up first** with a timestamped `.bak.<timestamp>` copy before any edit.
- It strips IJFW's managed marker regions out of every project `CLAUDE.md` / `AGENTS.md` it ever touched, and **preserves every user-authored line** in those files.
- It removes IJFW's MCP-server entries, platform configs (Codex / Gemini / Cursor / Windsurf / Copilot / Hermes / Wayland and the rest), the `~/.ijfw/claude` and `~/.ijfw/mcp-server` directories, the `ijfw*` binaries, and the plugin cache.
- **Your other plugins, MCP servers, and per-project trust settings are left untouched.** It only removes what it can prove it authored; files it can't prove are IJFW's (e.g. hand-edited Aider rules) are left in place and called out so you can remove them yourself.
- **Your memory is preserved by default.** `~/.ijfw/memory/` survives a plain uninstall and is recoverable on reinstall. Only `--purge` deletes it, and only after a printed warning.

You walk away with your data: memory is markdown in your repo, receipts are JSONL on your disk, and every config edit left a backup. Nothing is held hostage.

---

## What this means in one line

Not "your data never leaves." Rather: **it lives on your disk as plain text, it moves only when you send it, every send is logged, and you can forget all of it with one command.**

Back to the [README](../README.md).
