# Memory Moat Progress

[2026-05-21T00:07Z] M5.1 ✅ — memory-facts-handler.js + test-memory-facts-mcp.js; 3/3 tests pass; plan seed timestamps fixed (Date not number)
[2026-05-21T00:09Z] M3.1 ✅ b917475 — migration 007 creates skill_telemetry table; 1/1 test pass
[2026-05-21T00:10Z] M3.2 ✅ 87c8ae5 — skill-telemetry recorder + topKSuccessfulSkills; 4/4 tests pass
[2026-05-21T00:11Z] M3.3 ✅ 5000b0f — skill-telemetry-sink state-SDK verb shim; 5/5 tests pass
[2026-05-21T00:25Z] M1.1+1.2+1.3 ✅ — migration 006 + obsidian-parser (parse + indexObsidianRelations); 3/3 indexing tests + 6/6 parser tests
[2026-05-21T00:45Z] M1.4+1.5 ✅ — query-dataview parser+executor + grammar doc; 10/10 tests pass; schema-fit fix (production memory_entries has integer id, no title)
[2026-05-21T01:10Z] M2.2+2.3 ✅ — auto-linker (A-Mem) + budget integration; 7/7 tests pass; tokenized body LIKE, production-schema-fit
[2026-05-21T01:30Z] M4.1+4.2+4.3 ✅ — migration 008 (origin) + dream/state-file + dream/stage-runner; 13/13 tests pass
[2026-05-21T01:55Z] M4.4 ✅ — dream/runner.mjs wired (idle gate + per-stage isolation); 4/4 e2e tests pass; legacy cooldown preserved as final stage
[2026-05-21T02:10Z] INT.1 ✅ — fts5.indexEntry calls indexObsidianRelations; 2/2 e2e tests pass against real openDb path
