---
name: ijfw-preflight
description: "Run the IJFW preflight pipeline (12 gates, fail-fast). Trigger: 'ijfw preflight', 'run preflight', 'check before ship', 'preflight gates', 'validate before release'."
---

# IJFW Preflight

Runs 11 deterministic quality gates locally. Ordered fast-to-slow, fail-fast on blockers. Returns exit 0 on clean, exit 1 on findings.

## Usage

```
ijfw preflight
```

## What it checks

1. shellcheck -- shell script correctness
2. oxlint -- fast JS/TS linting
3. eslint-security -- high-signal JS security rules
4. psscriptanalyzer -- PowerShell scripts, with static fallback when pwsh is absent
5. publint -- package.json publish hygiene
6. gitleaks -- secret / credential scan
7. audit-ci -- npm dependency vulnerability check
8. knip -- dead code and unused exports
9. license-check -- dependency license compatibility
10. pack-smoke -- `npm pack` roundtrip + `ijfw --help` assert
11. upgrade-smoke -- upgrade from floor version, assert settings key survives
12. stale platform count -- runs `scripts/preflight-stale-count.sh`; fails if any shippable surface still contains the old "8 platforms" string
13. unresolved execute-issues -- reads `.ijfw/state/execute-issues.json`; refuses preflight if any entry has `status: unresolved`. Missing file treated as zero issues (day-1 fresh-install protection). Canonical read stub: `[ -f ".ijfw/state/execute-issues.json" ] || printf '{"issues":[]}'`

## Behavior

- Each gate degrades gracefully to "skipped: tool not installed" when its CLI is absent (except blockers, which print actionable install hints).
- All output uses positive framing. No "failed" headers -- findings are reported as "surfaced N points".
- Runs under 90s on M-series laptop with warm caches.
- Pinned tool versions tracked in `.ijfw/preflight-versions.json`.

## When to run

- Before every `git tag` / release.
- After any change to shell scripts, package.json, or dependency list.
- In CI (`.github/workflows/ci.yml` runs `ijfw preflight` on every push).
