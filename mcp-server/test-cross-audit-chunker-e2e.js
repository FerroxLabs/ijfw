// v1.5.0 audit-MED-tok-M5 — End-to-end chunker integration test.
//
// The existing test-cross-audit-chunker.js exercises chunkText() and
// mergeFindings() in isolation. This file wires them together in the same
// shape the real cross-audit pipeline uses:
//
//     chunkText(largeTarget)
//         → audit each chunk through a stubbed auditor that returns
//           realistic { severity, target, finding, action } objects
//         → mergeFindings(perChunkResults)
//         → assert the merged output is what an operator would actually
//           see after running `ijfw cross-audit` on a chunk-sized diff.
//
// The auditor is stubbed so the test stays hermetic + deterministic — we
// are testing PIPELINE GLUE, not the auditor CLIs. CLI / API integration is
// covered separately in the orchestrator suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkText,
  mergeFindings,
  CHUNKER_DEFAULTS,
} from './src/cross-audit-chunker.js';

// ---------------------------------------------------------------------------
// Fixture: a synthetic "diff-like" file with three deliberately-planted issues
// that should survive chunk-split + merge as distinct findings.
//
// The issues are placed at the START, MIDDLE, and END of the fixture so the
// chunker is forced to split across them. The same issue is also duplicated
// near a chunk boundary so we can verify dedupe collapses the duplicate.
// ---------------------------------------------------------------------------
function buildFixture() {
  // Each "block" is ~1.4 KB of plausible-but-boring diff context.
  const filler = (label, n) =>
    Array.from({ length: n }, (_, i) =>
      `+ // ${label} line ${i}: legitimate refactor, no security or correctness concern.`
    ).join('\n') + '\n\n';

  const issueA =
    '+ // src/api.js:42 introduces null-pointer on unauthenticated request handler.\n' +
    '+ function getUser(req) { return req.user.id; }\n\n';

  const issueB =
    '+ // src/db.js:117 unbounded loop reads every row into memory; DoS risk.\n' +
    '+ for (const row of db.allSync()) { results.push(row); }\n\n';

  const issueC =
    '+ // src/auth.js:9 stores raw password in audit log.\n' +
    '+ log.info("login", { user, password });\n\n';

  // 50 KB-ish fixture: front filler, issueA, middle filler, issueB, more filler,
  // duplicate-near-boundary of issueA, more filler, issueC, tail filler.
  return (
    filler('intro', 80) +
    issueA +
    filler('middle-1', 80) +
    issueB +
    filler('middle-2', 80) +
    // Duplicate of issueA in different wording — should cluster with issueA.
    '+ // src/api.js:42 null pointer on unauthenticated request handler — same bug.\n' +
    '+ function getUser(req) { return req.user.id; }\n\n' +
    filler('middle-3', 80) +
    issueC +
    filler('tail', 80)
  );
}

// Stubbed auditor: scans a chunk for the planted keywords and emits findings
// in the orchestrator's existing shape.
function fakeAuditChunk(chunk) {
  const findings = [];
  if (/null-pointer on unauthenticated|null pointer on unauthenticated/i.test(chunk.text)) {
    findings.push({
      severity: 'high',
      target: 'src/api.js:42',
      finding: 'null pointer on unauthenticated request handler',
      action: 'guard req.user before deref',
    });
  }
  if (/unbounded loop|DoS risk/i.test(chunk.text)) {
    findings.push({
      severity: 'medium',
      target: 'src/db.js:117',
      finding: 'unbounded loop reads every row into memory DoS risk',
      action: 'stream via cursor or LIMIT',
    });
  }
  if (/raw password in audit log/i.test(chunk.text)) {
    findings.push({
      severity: 'high',
      target: 'src/auth.js:9',
      finding: 'stores raw password in audit log',
      action: 'redact password before logging',
    });
  }
  return { chunkIndex: chunk.index, findings };
}

test('e2e: chunk → audit-each → merge produces deduped + severity-sorted findings', () => {
  const fixture = buildFixture();
  // Force multiple chunks: use a much smaller chunkSize than the production
  // default so the fixture splits across the planted issues.
  const chunks = chunkText(fixture, { chunkSize: 8_000, overlap: 800 });
  assert.ok(chunks.length >= 3, `fixture must split into 3+ chunks, got ${chunks.length}`);

  // Audit each chunk in parallel (real pipeline shape).
  const perChunkResults = chunks.map(fakeAuditChunk);

  // Merge.
  const merged = mergeFindings(perChunkResults);

  // Three distinct planted issues — issueA + duplicate must collapse to one.
  assert.equal(merged.length, 3, `expected 3 distinct findings after dedupe, got ${merged.length}: ${JSON.stringify(merged.map(m => m.target))}`);

  // Severity-desc sort: highs first.
  assert.equal(merged[0].severity, 'high');
  assert.equal(merged[1].severity, 'high');
  assert.equal(merged[2].severity, 'medium');

  // Issue A should carry clusterSize >= 2 (original + duplicate-near-boundary).
  const issueA = merged.find(m => m.target === 'src/api.js:42');
  assert.ok(issueA, 'issueA must survive merge');
  assert.ok(issueA.clusterSize >= 2, `issueA clusterSize must reflect duplicate (got ${issueA.clusterSize})`);

  // Every finding must carry the orchestrator shape downstream printers expect.
  for (const f of merged) {
    assert.ok(['high', 'medium', 'low'].includes(f.severity));
    assert.equal(typeof f.target, 'string');
    assert.equal(typeof f.finding, 'string');
    assert.equal(typeof f.action, 'string');
    assert.ok(Array.isArray(f.clusterChunks));
  }
});

test('e2e: chunker honors the CHUNKER_DEFAULTS contract end-to-end', () => {
  // Build a fixture bigger than CHUNKER_DEFAULTS.chunkSize to force a real
  // default-path split; assert chunks cover [0, text.length] with overlap.
  const block = 'lorem ipsum dolor sit amet. '.repeat(2_000); // ~54 KB
  const fixture = block + '\n\n' + block; // ~108 KB
  const chunks = chunkText(fixture); // no opts -> defaults
  assert.ok(chunks.length >= 2, 'large fixture must split under defaults');
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, fixture.length);

  // Overlap stays within the documented default.
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1].end;
    const curStart = chunks[i].start;
    assert.ok(curStart < prevEnd, 'chunks must overlap');
    assert.ok(prevEnd - curStart <= CHUNKER_DEFAULTS.overlap, 'overlap within default budget');
  }
});

test('e2e: empty / no-finding pipeline returns empty merged array', () => {
  const benign = 'lorem ipsum '.repeat(4_000);
  const chunks = chunkText(benign, { chunkSize: 6_000, overlap: 500 });
  const perChunkResults = chunks.map(fakeAuditChunk); // no keywords match
  const merged = mergeFindings(perChunkResults);
  assert.deepEqual(merged, [], 'no findings → empty merge');
});

test('e2e: distinct findings at different chunk indices retain clusterChunks provenance', () => {
  const fixture = buildFixture();
  const chunks = chunkText(fixture, { chunkSize: 8_000, overlap: 800 });
  const perChunkResults = chunks.map(fakeAuditChunk);
  const merged = mergeFindings(perChunkResults);
  // Every cluster's clusterChunks entries must be valid chunk indices.
  const validIndices = new Set(chunks.map(c => c.index));
  for (const c of merged) {
    for (const idx of c.clusterChunks) {
      assert.ok(validIndices.has(idx), `clusterChunks index ${idx} must reference a real chunk`);
    }
  }
});
