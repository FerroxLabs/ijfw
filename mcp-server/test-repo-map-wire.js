#!/usr/bin/env node
/**
 * test-repo-map-wire.js -- v1.5.0 wire-W1.A.
 *
 * Validates that `mcp-server/src/lib/repo-map.js` is wired into the
 * orchestrator subagent (re)dispatch path. Before W1.A this lib had 23
 * isolated tests but zero production callers — a v1.5.0 user gained nothing
 * from it. These tests prove the wire is live:
 *
 *   1. buildSubagentRepoMapPrefix returns '' when env opt-in is missing.
 *   2. buildSubagentRepoMapPrefix returns '' when projectRoot is missing.
 *   3. buildSubagentRepoMapPrefix returns a non-empty header-wrapped block
 *      when IJFW_REPO_MAP=1 + a valid projectRoot.
 *   4. reviewSubagentReportWithRepoMap attaches repoMapPrefix to a
 *      redispatch_needs_context decision (the truncation/violation path).
 *   5. reviewSubagentReportWithRepoMap does NOT attach repoMapPrefix to a
 *      proceed_to_review decision (no redispatch == no prefix needed).
 *   6. handleTruncationWithRepoMap prepends the prefix to the resume brief
 *      for a cross-AI handoff (selectResumeAI's resume_with_alt_ai path).
 *
 * Each test sets env locally and restores it in finally so the suite stays
 * deterministic across runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSubagentRepoMapPrefix,
  reviewSubagentReportWithRepoMap,
  handleTruncationWithRepoMap,
} from './src/orchestrator/runtime-loop.js';

const ORIG_REPO_MAP_ENV = process.env.IJFW_REPO_MAP;

function makeTinyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-w1a-'));
  // A handful of files so buildRepoMap has something to rank.
  writeFileSync(join(dir, 'index.js'), 'export function alpha(){ return 1; }\nexport function beta(){ return 2; }\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n\n## Build\nrun npm test\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'core.js'), 'export class Core {}\nexport function helper(){}\n');
  return dir;
}

function restoreEnv() {
  if (ORIG_REPO_MAP_ENV === undefined) delete process.env.IJFW_REPO_MAP;
  else process.env.IJFW_REPO_MAP = ORIG_REPO_MAP_ENV;
}

// ---------------------------------------------------------------------------
// 1 + 2: defaults to no-op
// ---------------------------------------------------------------------------

test('wire-W1.A: prefix is empty when env opt-in missing', async () => {
  // env unset — explicit pass-through env arg
  const r = await buildSubagentRepoMapPrefix({
    projectRoot: process.cwd(),
    env: {}, // no IJFW_REPO_MAP key
  });
  assert.equal(r, '');
});

test('wire-W1.A: prefix is empty when projectRoot missing', async () => {
  const r = await buildSubagentRepoMapPrefix({
    env: { IJFW_REPO_MAP: '1' },
  });
  assert.equal(r, '');
});

test('wire-W1.A: prefix is empty when projectRoot is non-existent path', async () => {
  // buildRepoMap throws on missing rootDir; the wrapper must swallow.
  const r = await buildSubagentRepoMapPrefix({
    projectRoot: '/definitely/does/not/exist/ijfw-w1a',
    env: { IJFW_REPO_MAP: '1' },
  });
  assert.equal(r, '');
});

// ---------------------------------------------------------------------------
// 3: opt-in produces a real prefix
// ---------------------------------------------------------------------------

test('wire-W1.A: opt-in env + valid projectRoot produces non-empty prefix block', async () => {
  const dir = makeTinyRepo();
  try {
    const prefix = await buildSubagentRepoMapPrefix({
      projectRoot: dir,
      env: { IJFW_REPO_MAP: '1' },
      budgetTokens: 500,
    });
    assert.ok(prefix.length > 0, 'prefix must be non-empty when wired');
    assert.match(prefix, /REPO MAP/);
    assert.match(prefix, /END REPO MAP/);
    // The map should mention at least one file by path.
    assert.ok(
      prefix.includes('index.js') || prefix.includes('core.js') || prefix.includes('README.md'),
      'prefix must include at least one file path from the test repo',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4 + 5: reviewSubagentReportWithRepoMap surfaces prefix on redispatch only
// ---------------------------------------------------------------------------

test('wire-W1.A: reviewSubagentReportWithRepoMap attaches repoMapPrefix on redispatch', async () => {
  const dir = makeTinyRepo();
  try {
    // Empty report → parseAgentReport throws ProtocolViolation →
    // reviewSubagentReport returns { action: 'redispatch_needs_context', ... }
    // which is the trigger for the prefix injection.
    const decision = await reviewSubagentReportWithRepoMap(
      '',
      { dispatchTimestamp: Math.floor(Date.now() / 1000), projectRoot: dir },
      { IJFW_REPO_MAP: '1' },
    );
    assert.equal(decision.action, 'redispatch_needs_context');
    assert.equal(typeof decision.repoMapPrefix, 'string');
    assert.ok(decision.repoMapPrefix.length > 0, 'redispatch must carry non-empty prefix when opt-in');
    assert.match(decision.repoMapPrefix, /REPO MAP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wire-W1.A: reviewSubagentReportWithRepoMap omits prefix when env opt-in absent', async () => {
  const dir = makeTinyRepo();
  try {
    const decision = await reviewSubagentReportWithRepoMap(
      '',
      { dispatchTimestamp: Math.floor(Date.now() / 1000), projectRoot: dir },
      {}, // no IJFW_REPO_MAP
    );
    assert.equal(decision.action, 'redispatch_needs_context');
    // Prefix field is still set (to '') because the wire fires on redispatch,
    // but the string is empty — wire active, but no payload.
    assert.equal(decision.repoMapPrefix, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6: handleTruncationWithRepoMap prepends to resume brief
// ---------------------------------------------------------------------------

test('wire-W1.A: handleTruncationWithRepoMap prepends prefix to resume_with_alt_ai brief', async () => {
  const dir = makeTinyRepo();
  try {
    const decision = await handleTruncationWithRepoMap({
      parsed: { ai: 'claude', reason: 'truncated_mid_turn' },
      ctx: {
        projectRoot: dir,
        originalSpec: 'do the thing',
        checkpoint: { filesWritten: ['x.js'], commitSha: 'abc', partialProgress: 'half done' },
      },
      available: ['claude', 'gemini', 'codex'],
      env: { IJFW_REPO_MAP: '1' },
    });
    assert.equal(decision.action, 'resume_with_alt_ai');
    // Brief now starts with the REPO MAP block.
    assert.match(decision.brief.slice(0, 200), /REPO MAP/);
    // Original brief content still present after the prefix.
    assert.match(decision.brief, /do the thing/);
    assert.equal(decision.repoMapApplied, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wire-W1.A: handleTruncationWithRepoMap is byte-identical to handleTruncation when opt-in off', async () => {
  const dir = makeTinyRepo();
  try {
    const decision = await handleTruncationWithRepoMap({
      parsed: { ai: 'claude' },
      ctx: { projectRoot: dir, originalSpec: 'do the thing', checkpoint: {} },
      available: ['claude', 'gemini', 'codex'],
      env: {}, // opt-in off
    });
    assert.equal(decision.action, 'resume_with_alt_ai');
    // Original brief untouched: starts with the spec, no prefix.
    assert.equal(decision.brief.slice(0, 'do the thing'.length), 'do the thing');
    assert.equal(decision.repoMapApplied, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv();
  }
});
