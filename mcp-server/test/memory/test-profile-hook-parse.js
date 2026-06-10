// Glob-runner shim. Real body: test/hook-pre-prompt-parse.test.mjs.
// Regression for DEFECT 2 — the pre-prompt feedback-capture hook must PARSE +
// RUN with intent-router.js present (no `intent` redeclaration collision) and
// write a .session-feedback.jsonl correction row. Named test-profile-* so the
// profile suite glob (test-profile-*.js) covers it.
import '../hook-pre-prompt-parse.test.mjs';
