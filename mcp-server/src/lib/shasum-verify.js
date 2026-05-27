// shasum-verify.js -- cross-verify a target npm release against the GitHub
// release asset shasum. Second-factor integrity check on top of
// `npm audit signatures` (F-SEC-7, v1.5.0 audit-H2.2).
//
// THREAT MODEL
//   `npm audit signatures` proves the tarball was signed by the package's
//   npm registry signing keys. This module independently fetches the
//   shasum the publisher recorded on the GitHub release page and compares
//   it against the npm-reported tarball shasum. A divergence means either
//   the npm registry is serving a tampered tarball, OR the GitHub release
//   was tampered with, OR the publisher made an inconsistent release.
//   In all cases: refuse to install.
//
// MODES
//   verified -- npm and GitHub shasums both available and match.
//   mismatch -- both available but DIFFER. Fail closed.
//   advisory -- GitHub side missing (older release, no shasum published,
//               or transient fetch failure). Caller decides whether to
//               proceed: interactive prompts for confirmation, non-
//               interactive must abort.
//   error    -- npm side missing (no shasum reported by `npm view`).
//               This indicates a deeper problem; refuse to install.
//
// CALLER CONTRACT
//   verifyShasumCrossSource(version, opts, deps) returns
//     { ok: boolean, mode, npmShasum, releaseShasum, message }
//   The orchestrator MUST refuse to install when ok === false.
//   advisory mode returns ok: true with a `requiresConfirmation: true`
//   flag so the orchestrator can prompt or fail-closed in non-interactive.

import { spawnSync } from 'node:child_process';

// Default GitHub repo (owner/name). Kept here so tests can override.
// NOTE: GitHub Releases API uses an owner/repo path -- NOT URL-encoded
// like the GitLab equivalent. Old name kept as an alias for backwards
// compatibility with any external callers that still pass a `project` opt.
export const DEFAULT_GITHUB_REPO = 'FerroxLabs/ijfw';
// Back-compat alias: callers passing `project` still resolve via the same
// option key path; the value semantics changed from URL-encoded
// "therealseandonahoe%2Fijfw" to "FerroxLabs/ijfw".
export const DEFAULT_GITLAB_PROJECT = DEFAULT_GITHUB_REPO;

// Hex shasum extractor. Accepts standalone hex lines (sha1=40 hex, sha256=64
// hex) or the common labelled forms used in release notes:
//   shasum: <hex>
//   sha1:   <hex>
//   sha256: <hex>
//   sha512: <hex>
// Returns the first 40-or-more hex run that looks like a shasum.
// Case-insensitive comparison happens at compare time.
const SHASUM_LABEL_RE = /(?:shasum|sha-?(?:1|256|512))\s*[:=]\s*([a-f0-9]{40,128})/i;
const SHASUM_BARE_RE = /\b([a-f0-9]{40})\b/i; // sha1 length is what npm publishes
const SHASUM256_BARE_RE = /\b([a-f0-9]{64})\b/i;

export function extractShasumFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const labelMatch = text.match(SHASUM_LABEL_RE);
  if (labelMatch) return labelMatch[1].toLowerCase();
  // Fall back to bare hex runs only if a label wasn't found. Prefer sha256
  // first because sha1 has higher false-positive risk in narrative text.
  const m256 = text.match(SHASUM256_BARE_RE);
  if (m256) return m256[1].toLowerCase();
  const m1 = text.match(SHASUM_BARE_RE);
  if (m1) return m1[1].toLowerCase();
  return null;
}

// Default deps: real npm + real curl. Tests inject pure-JS mocks.
const DEFAULT_DEPS = Object.freeze({
  // (pkg, version) -> { ok, shasum, message }
  fetchNpmShasum(pkg, version) {
    const ref = `${pkg}@${version}`;
    const r = spawnSync('npm', ['view', ref, 'dist.shasum', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      shell: process.platform === 'win32',
    });
    if (r.error) return { ok: false, message: `spawn-${r.error.code || 'unknown'}` };
    if (r.signal) return { ok: false, message: `killed by ${r.signal}` };
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim();
      return { ok: false, message: stderr || `npm view exited ${r.status}` };
    }
    // npm view ... --json returns the string wrapped in quotes
    const raw = (r.stdout || '').trim().replace(/^"|"$/g, '');
    if (!/^[a-f0-9]{40}$/i.test(raw)) {
      return { ok: false, message: `npm returned non-shasum: ${raw.slice(0, 80)}` };
    }
    return { ok: true, shasum: raw.toLowerCase() };
  },
  // (repo, version) -> { ok, body, message }
  fetchGithubReleaseBody(repo, version) {
    const url = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
    const r = spawnSync(
      'curl',
      [
        '-fsSL',
        '-H',
        'User-Agent: ijfw',
        '-H',
        'Accept: application/vnd.github+json',
        url,
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    if (r.error) return { ok: false, message: `spawn-${r.error.code || 'unknown'}` };
    if (r.signal) return { ok: false, message: `killed by ${r.signal}` };
    if (r.status !== 0) {
      return { ok: false, message: `curl exited ${r.status}` };
    }
    try {
      const data = JSON.parse(r.stdout || '{}');
      // GitHub release schema uses `body` (GitLab used `description`).
      return { ok: true, body: data.body || '' };
    } catch {
      return { ok: false, message: 'release JSON parse failed' };
    }
  },
});

// version: semver string (validated by caller)
// opts: { pkg = '@ijfw/install', repo = DEFAULT_GITHUB_REPO }
//   `project` is honored as a back-compat alias for `repo`.
// deps: optional mock injection. Accepts either `fetchGithubReleaseBody`
//   (preferred) or the legacy `fetchGitlabReleaseBody` key.
export function verifyShasumCrossSource(version, opts = {}, deps = DEFAULT_DEPS) {
  const pkg = opts.pkg || '@ijfw/install';
  const repo = opts.repo || opts.project || DEFAULT_GITHUB_REPO;
  const fetchNpm = deps.fetchNpmShasum || DEFAULT_DEPS.fetchNpmShasum;
  const fetchRelease =
    deps.fetchGithubReleaseBody ||
    deps.fetchGitlabReleaseBody || // back-compat: tests written against the old key still work
    DEFAULT_DEPS.fetchGithubReleaseBody;

  const npmRes = fetchNpm(pkg, version);
  if (!npmRes.ok) {
    return {
      ok: false,
      mode: 'error',
      npmShasum: null,
      releaseShasum: null,
      message: `npm shasum lookup failed: ${npmRes.message}`,
    };
  }
  const npmShasum = String(npmRes.shasum || '').toLowerCase();

  const releaseRes = fetchRelease(repo, version);
  if (!releaseRes.ok) {
    return {
      ok: true,
      mode: 'advisory',
      requiresConfirmation: true,
      npmShasum,
      releaseShasum: null,
      message: `release shasum unavailable (${releaseRes.message}); proceed only with explicit confirmation`,
    };
  }
  const releaseShasum = extractShasumFromText(releaseRes.body);
  if (!releaseShasum) {
    return {
      ok: true,
      mode: 'advisory',
      requiresConfirmation: true,
      npmShasum,
      releaseShasum: null,
      message: 'GitHub release does not list a shasum for this version; proceed only with explicit confirmation',
    };
  }
  if (releaseShasum.toLowerCase() !== npmShasum) {
    return {
      ok: false,
      mode: 'mismatch',
      npmShasum,
      releaseShasum: releaseShasum.toLowerCase(),
      message: `shasum mismatch: npm=${npmShasum} release=${releaseShasum.toLowerCase()}`,
    };
  }
  return {
    ok: true,
    mode: 'verified',
    npmShasum,
    releaseShasum: releaseShasum.toLowerCase(),
    message: 'shasum cross-verified (npm dist.shasum matches GitHub release asset)',
  };
}
