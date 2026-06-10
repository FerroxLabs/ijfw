// Glob-runner shim. Real body: test/profile-derive-env-default.test.mjs.
// Live-path regression for DEFECT 1 (derive with no injected env must admit
// same-machine rows and write the profile; foreign-identity rows still excluded).
import '../profile-derive-env-default.test.mjs';
