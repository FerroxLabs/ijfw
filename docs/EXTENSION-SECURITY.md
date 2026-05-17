# IJFW Extension Security Model

**Applies to:** IJFW v1.4.3+. Replaces and extends the security notes inlined in v1.4.1's HARDWARE-KEY-SIGNING.md and W7/B2 W7.1 commit messages.

## Trust hierarchy

```
┌──────────────────────────────────────────────────────────────┐
│  IJFW_REGISTRY_META_KEY_PEM (compiled into mcp-server)       │
│        ↓ signs                                                │
│  Federated registries (~/.ijfw/registries.json — N sources)  │
│        ↓ list                                                 │
│  Publishers (Ed25519 public keys)                             │
│        ↓ sign                                                 │
│  Extension manifests + rotation tokens                        │
└──────────────────────────────────────────────────────────────┘
```

Each layer is verifiable from the layer above. The meta-key is the root of trust and lives in source code — rotation requires a new IJFW release.

## Defense layers per extension

When an extension is installed and activated, FIVE layers gate what it can do:

1. **Publisher trust** — manifest signed by a publisher in the trusted set (one or more federated registries).
2. **Revocation** — neither the publisher keyId nor the manifest hash appears in any source's `revoked[]` list (defense-in-depth: ANY source revoking blocks globally).
3. **Tier-1 runtime permission check** — `server.js::gatePermissionAndQuota` validates each MCP tool call against the extension's declared `permissions.reads` / `permissions.writes`. Fail-closed if the active state is malformed.
4. **Tier-2 platform hook permission check** — the AI coding agent's platform-native hook (e.g., Claude Code, Codex, Gemini-CLI tier-2 hooks per W7/B2 + W8-A2) re-checks permissions for write/edit/bash operations BEFORE the tool body executes. Independent of tier-1, so a misconfigured MCP server cannot remove the gate.
5. **Resource quotas (v1.4.3 NEW)** — declared in the manifest's `quotas` object. Counters tracked per activation and serialized across processes via `withFsLock`.

## Resource quotas — threat boundary (READ THIS)

**Quotas are API-level accounting, NOT OS-level resource limits.**

### What quotas DO gate

The DOCUMENTED MCP and tier-2 tool surface — every call that goes through `gatePermissionAndQuota` in `server.js` or the tier-2 hook in `extension-permission-check.mjs`:

- `ijfw_run` with `tool:write`, `tool:edit`, `tool:bash` permissions → counts toward `files_written` (one count per distinct absolute path) and `bytes_written` (sum of payload sizes the IJFW dispatcher sees)
- `ijfw_memory_store` → counts toward `bytes_written`
- All tool calls also check `wall_clock_ms` as `Date.now() - active.activated_at`

### What quotas DO NOT gate

**Subprocess content.** A single `tool:bash` call running:

```bash
bash -c "dd if=/dev/zero of=/tmp/huge bs=1M count=10000"
```

is **one tool call**. It counts as **one** toward `files_written` and **zero bytes** toward `bytes_written` — IJFW only sees the command string, not the gigabytes written by `dd`.

Likewise:
- A `node` script invoked through `tool:bash` can write arbitrary files OS-level — IJFW doesn't see them.
- Subprocess fork/exec chains compound this: `tool:bash → npm install` runs a tree of subprocesses, all invisible to the IJFW quota tracker.

### Why this is acceptable for v1.4.3

OS-level enforcement (cgroups on Linux, JobObjects on Windows, sandbox-exec on macOS) requires:
- Native OS bindings → **first native production dep**, which is a v1.5.0 architectural conversation.
- Platform-specific code paths for at least 3 OSes.
- Significantly higher integration cost for a defensive feature whose primary threat model is buggy/curious extensions, not adversarial ones.

The v1.4.3 quota system addresses the **observable** API-level threat model:
- Detecting runaway extensions (memory writes, file fan-out) before they exhaust dashboard memory or fill `~/.ijfw/state/`.
- Surfacing per-extension footprint in the dashboard (B19 charts).
- Providing a `quota-reset` admin path for recovery.

If your threat model includes adversarial extensions running unrestricted bash, **do not rely on quotas alone** — combine with:
- Restricted `permissions.writes` (omit `tool:bash` for extensions that don't need it).
- Sandboxed install (run IJFW with limited home-dir permissions; the rest of the OS-level work is on you).
- Network egress filtering at the OS / container layer.

### Dashboard warning

When an active extension declares BOTH `tool:bash` (or `tool:exec`) write permission AND a strict `files_written` / `bytes_written` quota, the B19 dashboard tile renders a warning chip:

> ⚠ This extension has `tool:bash` and a strict files_written quota. Bash content bypasses per-file accounting. Quotas measure IJFW tool-call surface only, not OS-level resource usage.

Operators acknowledging the trade-off can dismiss the chip; it reappears on next activation if the configuration persists.

## Cross-IDE divergence (B18)

`active-extension.json` is stamped with `activated_by_ide`, `activated_at`, and `activated_by_pid`. When a different IDE last activated the extension than the current one, `runtime-mediator.js` emits a stderr warning AND a permission event:

```
[ijfw] active extension last activated by 'codex' 47s ago; this IDE is 'claude'
```

This is a **warning, not a block** (default) — legitimate multi-IDE workflows are common. `--strict-ide` opt-in flag refuses activation when the current owner is a different IDE.

## Quota state lifetime

- **Session = one activation.** Counters initialize on `activate <name>` and persist across multiple tool calls within that activation.
- Counters reset on `deactivate` AND on a subsequent `activate` of the same extension.
- NO cross-activation cumulation — a re-activated extension gets a clean quota window.
- Wall-clock counter is computed on every check as `Date.now() - active.activated_at`, not incremented per call.

## Concurrency

All quota state mutations and all federated-registry cache writes pass through `withFsLock(lockPath, fn, { staleMs: 30000 })` from `mcp-server/src/fs-lock.js`:

- Uses `mkdir(lockPath, { recursive: false })` — atomic on POSIX and Windows.
- 25→250ms exponential backoff up to a 5s acquire timeout.
- 30s stale-lock recovery (one-shot retry).
- Cross-process safe — proven via `child_process.fork` race tests in `test-fs-lock.js::#6` and `test-server-quota-integration.js`.

If two MCP servers (e.g., one Claude Code session + one Codex session) target the same `~/.ijfw/state/extension-quotas.json`, the lock serializes their read-modify-write cycles. The slowest wins — no lost updates.

## Audit trail

Every permission decision (allow or deny) is logged to `~/.ijfw/state/permission-events.jsonl`. Quota denials include `reason: 'quota:files_written:51/50'` (dimension, current, limit). The B19 dashboard surfaces these as time-bucketed charts.

## Reporting issues

If you discover a way to escape the threat boundary documented here (e.g., a path through the runtime-mediator that bypasses the gate, a race that bypasses `withFsLock`, a signature forgery), do NOT open a public issue. Email the author (see `package.json`) with reproduction steps.

## See also

- `docs/HARDWARE-KEY-SIGNING.md` — publisher key backends (software + ssh-agent)
- `docs/REGISTRY-MAINTAINER.md` — federation rules + WS revocation protocol
- `.planning/1.4.3/HANDOFF-1.4.3.md` — full design rationale and threat-model upgrades
