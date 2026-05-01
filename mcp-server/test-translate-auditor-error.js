// test-translate-auditor-error.js
// Tests for the 1.2.5 actionable-error translator that turns raw auditor
// stderr into one user-readable line with concrete next steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateAuditorError } from './src/cross-orchestrator-cli.js';

// ---------------------------------------------------------------------------
// Tool-specific re-auth signatures
// ---------------------------------------------------------------------------

test('codex auth refresh failure -> codex login instruction', () => {
  const stderr = '2026-04-30T23:59:04.989317Z ERROR codex_models_manager::manager: failed to refresh model';
  const out = translateAuditorError('codex', 'failed', stderr, 1);
  assert.match(out, /codex login/i, 'should suggest codex login');
  assert.match(out, /token expired|stale/i, 'should explain why');
});

test('codex generic 401 -> codex login instruction', () => {
  const out = translateAuditorError('codex', 'failed', 'HTTP 401 Unauthorized', 1);
  assert.match(out, /401/, 'should mention status code');
  assert.match(out, /key for codex|re-?check/i, 'should point at key');
});

test('qwen no auth selected -> qwen auth instruction', () => {
  const out = translateAuditorError('qwen', 'failed', 'No auth type is selected. Please configure an auth type', 1);
  assert.match(out, /qwen auth/i, 'should suggest qwen auth');
});

test('gemini safety block -> false-negative warning', () => {
  const out = translateAuditorError('gemini', 'empty', 'BLOCKED_BY_SAFETY', 0);
  assert.match(out, /safety/i, 'should mention safety filter');
  assert.match(out, /false negative/i, 'should warn about false negative');
});

test('claude credit balance low -> top-up instruction', () => {
  const out = translateAuditorError('claude', 'failed', 'Your credit balance is too low to make this request', 1);
  assert.match(out, /credit/i, 'should mention credit');
  assert.match(out, /console\.anthropic\.com/i, 'should point at console');
});

// ---------------------------------------------------------------------------
// Generic patterns
// ---------------------------------------------------------------------------

test('timeout -> retry / drop suggestion', () => {
  const out = translateAuditorError('deepseek', 'timeout', 'The operation was aborted due to timeout', null);
  assert.match(out, /timed out/i);
  assert.match(out, /--with/, 'should mention --with option');
});

test('rate-limit / 429 -> wait or top up', () => {
  const out = translateAuditorError('deepseek', 'failed', 'HTTP 429 rate limit exceeded', 1);
  assert.match(out, /rate-limited|quota/i);
});

test('ENOTFOUND / network -> connectivity hint', () => {
  const out = translateAuditorError('gemini', 'failed', 'fetch failed: getaddrinfo ENOTFOUND api.example.com', 1);
  assert.match(out, /network|connectivity/i);
});

test('missing API key -> set env var hint', () => {
  const out = translateAuditorError('deepseek', 'failed', 'DEEPSEEK_API_KEY not set', 1);
  assert.match(out, /api key|auth env/i);
  assert.match(out, /deepseek/, 'should name the auditor');
});

test('spawn ENOENT -> install hint', () => {
  const out = translateAuditorError('codex', 'failed', 'spawn codex ENOENT', null);
  assert.match(out, /install codex|cli binary/i);
});

test('empty status without specific signature -> JSON fence advisory', () => {
  const out = translateAuditorError('opencode', 'empty', 'something irrelevant', 0);
  assert.match(out, /no parseable findings|JSON fence/i);
});

test('catch-all preserves first line of raw error', () => {
  const out = translateAuditorError('opencode', 'failed', 'Unrecognized error frob splat\nstack trace here', 7);
  assert.match(out, /Unrecognized error/);
  assert.match(out, /ijfw doctor/, 'should suggest doctor');
});

test('catch-all uses exit code when stderr empty', () => {
  const out = translateAuditorError('opencode', 'failed', '', 17);
  assert.match(out, /exit 17/);
});
