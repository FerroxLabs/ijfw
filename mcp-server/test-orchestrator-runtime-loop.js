import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewSubagentReport } from './src/orchestrator/runtime-loop.js';

function gitInit(root) {
  // Use execFileSync (not exec) — no shell, no injection surface. Args are literal.
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-loop-'));
  gitInit(root);
  return root;
}

test('valid DONE report on dispatched branch + fresh commit → proceed_to_review', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'b.txt'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'b'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const now = Math.floor(Date.now() / 1000);
    const report = `Status: DONE\nBranch: main\nCommit: ${sha}\nTests: 5/5 pass`;
    const r = reviewSubagentReport(report, { dispatchTimestamp: now - 1, branch: 'main', projectRoot: root });
    assert.equal(r.action, 'proceed_to_review');
    assert.equal(r.parsed.status, 'DONE');
    assert.equal(r.commit_sha, sha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing Status: line → redispatch_needs_context with protocol-violation', () => {
  const r = reviewSubagentReport('I did the thing.', { dispatchTimestamp: 0, branch: '', projectRoot: '/tmp' });
  assert.equal(r.action, 'redispatch_needs_context');
  assert.equal(r.missing, 'protocol-violation');
});

test('BLOCKED report → escalate_to_user', () => {
  const r = reviewSubagentReport('Status: BLOCKED\nReason: ambiguous spec\nTried: read 3 files', {
    dispatchTimestamp: 0, branch: 'main', projectRoot: '/tmp',
  });
  assert.equal(r.action, 'escalate_to_user');
  assert.equal(r.reason, 'ambiguous spec');
});

test('NEEDS_CONTEXT report → redispatch_with_context', () => {
  const r = reviewSubagentReport('Status: NEEDS_CONTEXT\nMissing: prod db schema', {
    dispatchTimestamp: 0, branch: 'main', projectRoot: '/tmp',
  });
  assert.equal(r.action, 'redispatch_with_context');
  assert.equal(r.missing, 'prod db schema');
});

test('DONE_WITH_CONCERNS report → proceed_with_flag', () => {
  const r = reviewSubagentReport('Status: DONE_WITH_CONCERNS\nConcerns: file is getting large', {
    dispatchTimestamp: 0, branch: 'main', projectRoot: '/tmp',
  });
  assert.equal(r.action, 'proceed_with_flag');
  assert.equal(r.concerns, 'file is getting large');
});
