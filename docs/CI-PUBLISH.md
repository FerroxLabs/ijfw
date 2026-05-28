# CI Publish via OIDC + Provenance (v1.5.0 S8)

> **Legacy doc — kept for historical reference.** This describes the GitLab CI publish flow that IJFW used through v1.5.4. As of v1.5.5 the canonical home moved to `github.com/FerroxLabs/ijfw` and the publish pipeline is GitHub Actions (`.github/workflows/publish.yml`). `.gitlab-ci.yml` has been removed. A current GitHub-Actions publish runbook will replace this doc in a future minor; the security model (OIDC + provenance, no long-lived secrets) carries over unchanged.

**Status:** Legacy. Active publish flow: GitHub Actions. See `.github/workflows/publish.yml`.

## How it works

On `git push` of a tag matching `^v\d+\.\d+\.\d+$`, GitLab CI's `publish` stage runs two jobs in parallel — `publish:mcp-server` and `publish:installer`. Each job:

1. Requests an OIDC `NPM_ID_TOKEN` from GitLab scoped to `https://registry.npmjs.org`.
2. Runs `npm publish --provenance --access public` from the package directory.
3. npm CLI exchanges the OIDC token for a publish credential via the npmjs trusted-publisher integration.
4. Both packages are published with [SLSA provenance attestations](https://docs.npmjs.com/generating-provenance-statements) signed by the gitlab.com OIDC issuer.

No long-lived secret lives in the repo or CI variables. Tokens are minutes-long and single-use.

## One-time operator setup (do this BEFORE the first v1.5.0 publish)

At `https://www.npmjs.com/package/@ijfw/install/access` (then same for `@ijfw/memory-server`):

1. Sign in as the package owner.
2. Click **Trusted Publisher → Add**.
3. Provider: **GitLab**.
4. Organization/User: `therealseandonahoe`.
5. Project name: `ijfw`.
6. Workflow path: `.gitlab-ci.yml`.
7. Environment: `production`.
8. Save.

Repeat for `@ijfw/memory-server`. Total time: ~5 minutes.

## Ship runbook (v1.5.0+)

```bash
# 1. Bump versions (both packages + claude plugin manifest)
sed -i.bak 's/"version": "1.4.4"/"version": "1.5.0"/' \
  mcp-server/package.json installer/package.json claude/.claude-plugin/plugin.json
rm -f mcp-server/package.json.bak installer/package.json.bak claude/.claude-plugin/plugin.json.bak
git add . && git commit -m "release(1.5.0): bump version"

# 2. Tag annotated
git tag -a v1.5.0 -m "v1.5.0 — Runtime Honesty + Pluggability Completion"

# 3. Push tag — triggers CI publish: stage
git push gitlab v1.5.0

# 4. Watch the publish: stage in the gitlab UI
glab pipeline status

# 5. Verify on npm (both packages live)
npm view @ijfw/install@1.5.0 dist.shasum
npm view @ijfw/memory-server@1.5.0 dist.shasum
npm view @ijfw/install@1.5.0 dist.attestations   # confirms provenance ✓
```

## Rollback / emergency local publish

If the CI publish stage fails persistently and you need to ship in the next 30 min:

```bash
cd mcp-server
npm publish --access public --no-provenance --otp <2FA-code>
cd ../installer
npm run build
npm publish --access public --no-provenance --otp <2FA-code>
```

The `--no-provenance` flag skips the OIDC dance entirely. Attestation is lost for that release; document in CHANGELOG.md that the release was emergency-published.

## Failure modes

| Failure | Likely cause | Recovery |
|---|---|---|
| `EUNAUTHORIZED` | Trusted publisher not configured at npmjs.com | Complete the one-time setup above, click **Retry** on the failed gitlab job |
| `EUSAGE provider: null` | `id_tokens:` block missing or misnamed in `.gitlab-ci.yml` | Fix gitlab-ci.yml, push fix-commit, re-tag (or delete + re-push the same tag) |
| `EOTP` | Account-level 2FA requirement not bypassed for trusted publishers | Verify trusted publisher is on the `auth-and-writes` 2FA-bypass list at npmjs |
| Network timeout to `registry.npmjs.org` | Registry hiccup | Click **Retry** in gitlab pipeline UI |
| Partial publish (one succeeded, one failed) | Independent jobs by design | Retry only the failing job — no risk of double-publish |

## Security model

- **OIDC token scope:** `id_tokens` are short-lived (minutes), single-use, scoped to `https://registry.npmjs.org`. Cannot be replayed against other services.
- **Tag pattern lockdown:** `if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/` means malicious branch pushes CANNOT trigger publish. Only annotated/lightweight tags matching the strict pattern fire. Pre-release tags like `v1.5.0-rc1` do NOT match.
- **`environment: production`:** pairs with the npmjs trusted-publisher environment field — extra defense-in-depth.
- **No NPM_TOKEN secret in CI variables.** Nothing to leak; nothing to rotate.
- **Provenance attestation:** every published artifact carries a signed statement of where/how it was built. Downstream users verify with `npm audit signatures`.

## Verification gate (pre-tag checklist)

Before pushing `v1.5.0` (or any future tag), confirm:

```bash
# 1. Both publish jobs are wired in gitlab-ci.yml
grep -c "^publish:" .gitlab-ci.yml   # expect 2

# 2. Tag pattern is strict (no rc/beta slip-through)
grep -A1 "publish:" .gitlab-ci.yml | grep '^\\d\+\\.\\d\+\\.\\d\+'

# 3. Both package.json repositories point at the live URL
grep -A1 '"repository"' installer/package.json mcp-server/package.json

# 4. npmjs trusted-publisher is configured (manual; check at npmjs.com/package/@ijfw/install/access)
```

## Out of scope

- **GitHub mirror publish** — separate pipeline, not v1.5.0 work.
- **Sigstore Rekor verification UI** — end-user concern, not ship-side.
- **npm 2FA-bypass profile for the IJFW org account** — user account-level concern, not project.
