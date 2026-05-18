/**
 * test-cross-ai-resume.js — v1.5.0 W12-C N02
 *
 * Cross-AI checkpoint resume routing: when a subagent truncates, the
 * orchestrator should pick a different AI for the resume attempt and
 * compose a brief that carries forward the checkpoint state instead of
 * redoing completed work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectResumeAI,
  buildResumeBrief,
  handleTruncation,
} from './src/orchestrator/runtime-loop.js';

test('selectResumeAI: claude truncation routes to gemini', () => {
  const target = selectResumeAI({ truncatedAI: 'claude' });
  assert.equal(target, 'gemini');
});

test('selectResumeAI: gemini truncation routes to claude', () => {
  const target = selectResumeAI({ truncatedAI: 'gemini' });
  assert.equal(target, 'claude');
});

test('selectResumeAI: codex truncation routes to claude', () => {
  const target = selectResumeAI({ truncatedAI: 'codex' });
  assert.equal(target, 'claude');
});

test('selectResumeAI: gemini + context_window reason returns null (no larger window)', () => {
  const target = selectResumeAI({
    truncatedAI: 'gemini',
    lastFailureReason: 'context_window',
  });
  assert.equal(target, null);
});

test('selectResumeAI: only truncated AI available returns null (never reselect self)', () => {
  const target = selectResumeAI({
    truncatedAI: 'claude',
    available: ['claude'],
  });
  assert.equal(target, null);
});

test('buildResumeBrief includes filesWritten + commitSha + partialProgress from checkpoint', () => {
  const brief = buildResumeBrief({
    originalSpec: 'Build feature X with tests',
    checkpoint: {
      filesWritten: ['src/foo.js', 'test/foo.test.js'],
      commitSha: 'abc1234',
      partialProgress: 'wrote module + 3 of 7 tests',
    },
    fromAI: 'claude',
    toAI: 'gemini',
  });

  assert.match(brief, /Build feature X with tests/);
  assert.match(brief, /RESUME CONTEXT/);
  assert.match(brief, /Prior agent \(claude\) truncated/);
  assert.match(brief, /src\/foo\.js/);
  assert.match(brief, /test\/foo\.test\.js/);
  assert.match(brief, /abc1234/);
  assert.match(brief, /wrote module \+ 3 of 7 tests/);
  assert.match(brief, /You are gemini/);
  // Resume brief must instruct skipping setup, not re-run it
  assert.match(brief, /Skip workspace setup/);
  assert.doesNotMatch(brief, /git checkout -b/);
  assert.doesNotMatch(brief, /git read-tree HEAD/);
});

test('handleTruncation returns escalate when selectResumeAI returns null', () => {
  const result = handleTruncation({
    parsed: { ai: 'gemini', reason: 'context_window' },
    ctx: { checkpoint: { filesWritten: ['a.js'] }, originalSpec: 'spec' },
    available: ['claude', 'gemini', 'codex'],
  });

  assert.equal(result.action, 'escalate_to_user');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});
