# Multi-Machine Wave Coordination — Design Sketch (v1.6.0+)

**Status:** DEFERRED from v1.5.0 with structural rationale. This document is the v1.5.0 commitment artifact for the only item that didn't fold into the milestone.

## Why deferred

`withFsLock` (mcp-server/src/fs-lock.js) is single-machine by contract — it uses POSIX `mkdir(recursive:false)` atomicity, which is local-filesystem-scoped. Cross-machine wave coordination requires:

1. **Distributed lock backend** — Redis SETNX, Postgres advisory locks, or DynamoDB conditional writes. Each adds a hard dependency the current "zero-deps mcp-server" rule rejects.
2. **Signed checkpoints** — when agents on different machines write to a shared wave, mTLS or HMAC signing prevents one machine from forging another's progress.
3. **Cluster-mode orchestrator** — leader election, split-brain detection, eventual-consistency-aware merge logic.
4. **Network failure recovery** — partition handling that the single-machine model doesn't need.

Combined surface: ~3 weeks of dedicated design + implementation. v1.5.0's bundled scope (16 items, ~16 dev-days) cannot absorb this without dropping something else.

## What v1.5.0 ships instead

Single-machine wave coordination, fully honored:

- `withFsLock` serialises concurrent local writers atomically.
- `subagent-telemetry.js` (S1) records per-subagent checkpoints under `.ijfw/wave-<id>/`.
- `checkpointWave` (S5) reads the local blackboard + writes STATE.md frontmatter.
- `populateBlackboardBlock` (S4) keeps `AGENTS.md` in sync with the local wave.

Every primitive assumes a single filesystem root. Multi-process is supported within a host; multi-host is not.

## What v1.6.0 would add

### Phase 1: distributed-lock pluggable backend (~5 days)
Lift `withFsLock` to a `withLock(backend, ...)` abstraction. Implementations:
- `FsLockBackend` (current behaviour, default for single-machine)
- `RedisLockBackend` (SET NX EX with leader-election TTL)
- `PostgresAdvisoryLockBackend` (pg_advisory_lock; works on Supabase / RDS)

Selection via `.ijfw/cluster.json`:
```json
{ "lock_backend": "redis", "redis_url": "..." }
```

### Phase 2: signed checkpoints (~5 days)
Each subagent gets a per-host Ed25519 keypair (reuse v1.4.1 W7-B1 publisher key infrastructure). Checkpoint JSON includes `signature` + `host_id`. Verifier on every read; reject unsigned or bad-sig checkpoints unless `cluster.trust_local_unsigned: true` (single-machine fallback).

### Phase 3: STATE.md merge semantics (~5 days)
Last-writer-wins is fine for single-machine but unsafe across hosts. Switch STATE.md to JSONL-of-events + materialised view, with CRDT semantics on `claims_active`, `agents`, `blockers_open`. Materialised view recomputable from events.

### Phase 4: cluster-mode CLI (~2 days)
`ijfw cluster status`, `ijfw cluster join <wave-id>`, `ijfw cluster leave`. Each command writes a join/leave event to the shared lock backend.

## v1.5.0 → v1.6.0 commitment

This file IS the commitment. v1.6.0 milestone planning MUST start with this design as the baseline scope. If the milestone fails to deliver multi-machine in v1.6.0, this file gets a revision noting the new target version + the structural blocker that pushed it further.

Tracked at: `docs/MULTI-MACHINE-DESIGN.md` (this file).

## Out of scope even at v1.6.0

- **Globally distributed (cross-region) wave coordination** — would require eventual-consistency model + conflict resolution UX. Single-region cluster is the v1.6.0 ceiling.
- **Cross-IJFW-installation coordination** — i.e., agents from two operators' separate IJFW installs collaborating on the same wave. Requires identity federation outside the scope.

## Verification gate (for v1.6.0 planning)

When v1.6.0 starts:
1. Read this file as the design baseline.
2. Confirm `fs-lock.js` is still single-machine-only (no leaked multi-host assumptions in the interim).
3. Pick lock backend(s) to ship in v1.6.0 prelude.
4. Begin Phase 1 of the plan above.
