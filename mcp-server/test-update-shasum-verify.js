// F-SEC-7 (v1.5.0 audit-H2.2): update-apply shasum cross-verify.
//
// docs/SECURITY.md claims the update flow cross-verifies the npm tarball
// shasum against the GitLab release asset shasum. Before this commit the
// claim was documentation-only -- no code did the comparison. These tests
// pin the new shasum-verify module's contract via pure dependency
// injection (no real npm / network calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyShasumCrossSource,
  extractShasumFromText,
} from './src/lib/shasum-verify.js';

const FAKE_SHA = 'a'.repeat(40); // valid-looking sha1
const OTHER_SHA = 'b'.repeat(40);

function makeDeps({ npm, release }) {
  return {
    fetchNpmShasum: () => npm,
    fetchGitlabReleaseBody: () => release,
  };
}

// ----- Case 1: matching shasum -> install proceeds (ok:true, verified) -----
test('matching npm + release shasum -> verified, ok:true', () => {
  const deps = makeDeps({
    npm: { ok: true, shasum: FAKE_SHA },
    release: { ok: true, body: `Release notes...\n\nshasum: ${FAKE_SHA}\n` },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'verified');
  assert.equal(r.npmShasum, FAKE_SHA);
  assert.equal(r.releaseShasum, FAKE_SHA);
});

// ----- Case 2: mismatching shasum -> install refused (ok:false, mismatch) -----
test('mismatching npm + release shasum -> mismatch, ok:false (refuse install)', () => {
  const deps = makeDeps({
    npm: { ok: true, shasum: FAKE_SHA },
    release: { ok: true, body: `shasum: ${OTHER_SHA}` },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'mismatch');
  assert.equal(r.npmShasum, FAKE_SHA);
  assert.equal(r.releaseShasum, OTHER_SHA);
  assert.match(r.message, /mismatch/i);
});

// ----- Case 3: release has no shasum (advisory) -> requiresConfirmation:true -----
test('release without listed shasum -> advisory + requiresConfirmation:true', () => {
  const deps = makeDeps({
    npm: { ok: true, shasum: FAKE_SHA },
    release: { ok: true, body: 'Release notes with no shasum mentioned.' },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'advisory');
  assert.equal(r.requiresConfirmation, true);
  assert.equal(r.npmShasum, FAKE_SHA);
  assert.equal(r.releaseShasum, null);
});

// ----- Case 3b: release fetch failed entirely -> advisory -----
test('release fetch failure -> advisory + requiresConfirmation:true', () => {
  const deps = makeDeps({
    npm: { ok: true, shasum: FAKE_SHA },
    release: { ok: false, message: 'curl exited 22' },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'advisory');
  assert.equal(r.requiresConfirmation, true);
  assert.match(r.message, /curl exited/);
});

// ----- Case 4: npm side missing -> error, ok:false (refuse install) -----
test('npm shasum lookup failed -> error mode, ok:false', () => {
  const deps = makeDeps({
    npm: { ok: false, message: 'npm view exited 1' },
    release: { ok: true, body: `shasum: ${FAKE_SHA}` },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'error');
  assert.equal(r.npmShasum, null);
  assert.equal(r.releaseShasum, null);
});

// ----- Case 5: case-insensitive shasum compare -----
test('shasum comparison is case-insensitive', () => {
  const deps = makeDeps({
    npm: { ok: true, shasum: FAKE_SHA.toLowerCase() },
    release: { ok: true, body: `shasum: ${FAKE_SHA.toUpperCase()}` },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'verified');
});

// ----- Case 6: extractor labelled forms -----
test('extractShasumFromText: parses labelled forms', () => {
  assert.equal(extractShasumFromText(`shasum: ${FAKE_SHA}`), FAKE_SHA);
  assert.equal(extractShasumFromText(`sha1=${FAKE_SHA}`), FAKE_SHA);
  const sha256 = 'c'.repeat(64);
  assert.equal(extractShasumFromText(`sha256: ${sha256}`), sha256);
});

// ----- Case 7: extractor handles bare hex when no label -----
test('extractShasumFromText: falls back to bare hex run', () => {
  const text = `Some release body with a hash ${FAKE_SHA} in the middle.`;
  assert.equal(extractShasumFromText(text), FAKE_SHA);
});

// ----- Case 8: extractor rejects garbage -----
test('extractShasumFromText: returns null for text without a hash', () => {
  assert.equal(extractShasumFromText('No hash here just words.'), null);
  assert.equal(extractShasumFromText(''), null);
  assert.equal(extractShasumFromText(null), null);
});

// ----- Case 9: sha256 extractor case (different length than sha1) -----
test('verifyShasumCrossSource: sha256-length match works', () => {
  const sha256 = 'd'.repeat(64);
  // npm returns sha1 (40-hex). If release publishes sha256 but npm publishes
  // sha1, the bytes won't match. This test is the documented expectation:
  // mismatch when the algos differ. The compare is byte-for-byte equality.
  const deps = makeDeps({
    npm: { ok: true, shasum: 'a'.repeat(40) },
    release: { ok: true, body: `sha256: ${sha256}` },
  });
  const r = verifyShasumCrossSource('1.2.3', {}, deps);
  // Algos differ -> hex strings differ -> mismatch. Documented behavior.
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'mismatch');
});

// ----- Case 10: package + project options pass through -----
test('verifyShasumCrossSource: forwards pkg + project to deps', () => {
  let capturedPkg = null;
  let capturedProject = null;
  const deps = {
    fetchNpmShasum: (pkg, version) => {
      capturedPkg = pkg;
      assert.equal(version, '9.9.9');
      return { ok: true, shasum: FAKE_SHA };
    },
    fetchGitlabReleaseBody: (project, version) => {
      capturedProject = project;
      assert.equal(version, '9.9.9');
      return { ok: true, body: `shasum: ${FAKE_SHA}` };
    },
  };
  const r = verifyShasumCrossSource(
    '9.9.9',
    { pkg: '@scope/pkg', project: 'org%2Fproj' },
    deps,
  );
  assert.equal(r.ok, true);
  assert.equal(capturedPkg, '@scope/pkg');
  assert.equal(capturedProject, 'org%2Fproj');
});
