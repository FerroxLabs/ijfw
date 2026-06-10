// Glob-runner shim: npm test globs `test/memory/test-*.js`. Real body lives in
// test/profile-path-policy.test.mjs (TEST-ISOLATION LEAK FIX — auto-tmpdir
// real-homedir default isolation under a test context).
import '../profile-path-policy.test.mjs';
