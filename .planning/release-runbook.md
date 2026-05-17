# IJFW Release Runbook

## macOS CI Runner Fallback Drill

### Normal state
`macos:test` runs on `saas-macos-medium-m1` (Apple Silicon). This is the required
gate from v1.4.1 (`allow_failure: false`).

### If M1 minutes exhaust mid-release

1. Edit `.gitlab-ci.yml` — find the `macos:test` job's `tags:` block and change:
   ```yaml
   tags:
     - saas-macos-medium-m1
   ```
   to:
   ```yaml
   tags:
     - saas-macos-medium
   ```
2. Commit and push:
   ```bash
   git add .gitlab-ci.yml
   git commit -m "chore(ci): fall back to intel macOS runner (M1 minutes exhausted)"
   git push gitlab main
   ```
3. The next pipeline's macOS leg will run on the intel-shared runner (`saas-macos-medium`).
   Same image catalogue, slightly cheaper per-minute rate.
4. When M1 minutes are replenished (Settings → Usage Quotas → CI/CD), revert the tag.

### Verifying the macOS gate after enabling the runner

After enabling `saas-macos-medium-m1` at
`gitlab.com/TheRealSeanDonahoe/ijfw → Settings → CI/CD → Runners`:

1. Push a no-op commit (e.g. a comment tweak in CHANGELOG.md):
   ```bash
   git commit --allow-empty -m "chore(ci): verify macOS gate"
   git push gitlab main
   ```
2. Watch the pipeline in the GitLab UI. The `macos:test` job should move from
   "pending" → "running" → "passed" within ~5 minutes.
3. If it reports `no_matching_runner`, the runner is not yet enabled at the
   project level — check Settings → CI/CD → Runners again.

### Failure mode test (optional but recommended before shipping)

1. Temporarily disable the runner in GitLab Settings → CI/CD → Runners.
2. Push a no-op commit.
3. Confirm the pipeline goes **red** (proves the gate is real, not silently skipping).
4. Re-enable the runner.
5. Retry the pipeline (Web UI → Pipelines → Retry).
