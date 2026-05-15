# ijfw preflight

The `ijfw preflight` command runs an 11-gate quality pipeline before publishing. It catches the class of bugs that caused every v1.0.x release incident.

## Usage

```
ijfw preflight [options]
```

Options:
- `--json`       Emit machine-readable JSON (for CI)
- `--fail-fast`  Stop after the first blocking gate failure
- `--help`       Show help

## Gates

| # | Name | Severity | Budget |
|---|------|----------|--------|
| 1 | shellcheck | blocking | 2s |
| 2 | oxlint | blocking | 3s |
| 3 | eslint-security | blocking | 5s |
| 4 | psscriptanalyzer | blocking | 5s |
| 5 | publint | blocking | 2s |
| 6 | gitleaks | blocking | 3s |
| 7 | audit-ci | blocking | 5s |
| 8 | knip | advisory | 10s |
| 9 | license-check | advisory | 5s |
| 10 | pack-smoke | blocking | 20s |
| 11 | upgrade-smoke | blocking | 30s |

**Blocking gates** -- a FAIL causes exit 1. All blocking gates must pass for a green run.

**Advisory gates** (knip, license-check) -- WARN is printed but does not affect the exit code.

## SLO

- Warm cache (npx cache warm): <=90s
- Cold cache (first run, downloading tools): <=240s

Both limits are printed at the end of each run.

## shellcheck

Requires system `shellcheck`. If absent, the gate is skipped with an install hint:

- macOS: `brew install shellcheck`
- Linux: `apt install shellcheck`

The gate runs `shellcheck --enable=all --disable=SC2312` on all `.sh` files. Catches SC2154 (unbound variable), unquoted expansions, POSIX violations.

## gitleaks

Requires system `gitleaks`. If absent, the gate downgrades to WARN with an install hint.

False-positive patterns are listed in `.gitleaksignore`. The cross-audit stderr captures under `.ijfw/cross-audit/` contain synthetic webhook URLs used as test fixtures -- these are listed as known-safe fingerprints.

## PSScriptAnalyzer

When `pwsh` and PSScriptAnalyzer are available, this gate runs PSScriptAnalyzer. When they are unavailable, it runs a deterministic static fallback that checks PowerShell parser balance and high-risk execution patterns. The check covers `installer/src/install.ps1` and remains blocking on every platform.

## pack-smoke

Builds a tarball via `npm pack`, installs it into an isolated tmp directory with a separate HOME (no user state polluted), invokes the `ijfw-install` binary with `--help`, and asserts exit 0.

This gate catches:
- Missing exec bit on dist files
- Broken bin field in package.json
- Build errors that esbuild did not report

## upgrade-smoke

Verifies the marketplace.js plugin key registration:
- Asserts `enabledPlugins['ijfw@ijfw'] = true` is present
- Asserts `enabledPlugins['ijfw-core@ijfw'] = true` is NOT the active key (legacy cleanup code is allowed)

This gate catches the plugin-key mismatch bug from v1.0.0-1.0.2.

## JSON output

`ijfw preflight --json` emits a `PreflightReport` object:

```json
{
  "version": "1.1.0",
  "timestamp": "2026-04-16T18:00:00.000Z",
  "outcome": "pass",
  "totalMs": 7500,
  "gates": [
    {
      "name": "shellcheck",
      "status": "SKIP",
      "message": "shellcheck not installed",
      "details": [],
      "durationMs": 1
    }
  ]
}
```

`outcome` is `"pass"` or `"fail"`. Exit code 0 = pass, 1 = fail.

## Pinned versions

Tool versions are pinned in `.ijfw/preflight-versions.json`. Update this file when bumping tool versions.

## CI integration

Add to your CI pipeline:

```yaml
- run: node installer/dist/ijfw.js preflight
```

Or via npm script:

```yaml
- run: npm run preflight
  working-directory: installer
```
