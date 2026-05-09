#!/usr/bin/env node
// mcp-server/test-copy-lint.js -- sanity test for scripts/copy-lint.sh.
//
// The current tree already has pre-existing "AI" usages in IJFW dashboard +
// a few skill descriptions (cleanup is its own alpha wave). So instead of
// asserting absolute exit codes, this test asserts the LINT REACTS CORRECTLY
// to a temp fixture:
//
//   1. Baseline -- record exit code + BAD count.
//   2. Add temp SKILL.md with standalone "AI" -- BAD count rises by >=1
//      AND exit code is 1 (the BAD-fail signal works).
//   3. Cleanup -- counts return to baseline.
//
// This way the gate's correctness is verified regardless of how many
// pre-existing copy hits exist in the tree.
//
// ESM (mcp-server/package.json sets "type": "module"). Uses node:test runner
// to match sibling tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BASH } from './test/win-bash-helper.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'copy-lint.sh');
const TEMP_SKILL_DIR = path.join(REPO_ROOT, 'claude', 'skills', '__copy_lint_test_tmp__');
const TEMP_SKILL_FILE = path.join(TEMP_SKILL_DIR, 'SKILL.md');

function runLint() {
  const r = spawnSync(BASH, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const stderr = r.stderr || '';
  const badCount = (stderr.match(/^BAD\s+/gm) || []).length;
  return { code: r.status, stderr, stdout: r.stdout || '', badCount };
}

function cleanup() {
  if (fs.existsSync(TEMP_SKILL_FILE)) fs.unlinkSync(TEMP_SKILL_FILE);
  if (fs.existsSync(TEMP_SKILL_DIR)) fs.rmdirSync(TEMP_SKILL_DIR);
}

// Final-resort cleanup if the test runner crashes.
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

test('copy-lint baseline runs cleanly (exit 0 or 1, never crashes)', () => {
  cleanup();
  const baseline = runLint();
  assert.ok(
    baseline.code === 0 || baseline.code === 1,
    `baseline exited with ${baseline.code}; expected 0 (clean) or 1 (pre-existing BAD hits)`,
  );
});

test('copy-lint flags temp SKILL.md containing standalone "AI"', () => {
  cleanup();
  const baseline = runLint();

  fs.mkdirSync(TEMP_SKILL_DIR, { recursive: true });
  fs.writeFileSync(
    TEMP_SKILL_FILE,
    [
      '---',
      'name: __copy_lint_test_tmp__',
      'description: "test fixture -- contains banned word AI to trigger lint."',
      '---',
      '',
      'This is a fixture body. It mentions AI deliberately.',
      '',
    ].join('\n'),
  );

  try {
    const dirty = runLint();
    assert.equal(dirty.code, 1, 'dirty run must exit 1 when BAD word present');
    assert.ok(
      dirty.badCount > baseline.badCount,
      `dirty BAD count (${dirty.badCount}) must exceed baseline (${baseline.badCount})`,
    );
    assert.ok(
      dirty.stderr.includes('__copy_lint_test_tmp__'),
      'temp fixture must appear in BAD report',
    );
  } finally {
    cleanup();
  }
});

test('copy-lint returns to baseline counts after cleanup', () => {
  cleanup();
  const baseline = runLint();

  fs.mkdirSync(TEMP_SKILL_DIR, { recursive: true });
  fs.writeFileSync(TEMP_SKILL_FILE, '---\nname: tmp\n---\nMentions AI.\n');
  runLint();
  cleanup();

  const restored = runLint();
  assert.equal(restored.code, baseline.code, 'exit code must match baseline after cleanup');
  assert.equal(restored.badCount, baseline.badCount, 'BAD count must match baseline after cleanup');
});

test('copy-lint honours <!-- copy-lint:allow --> on the same line', () => {
  cleanup();
  const baseline = runLint();

  fs.mkdirSync(TEMP_SKILL_DIR, { recursive: true });
  // Same-line allow marker -- should NOT count as a BAD hit.
  fs.writeFileSync(
    TEMP_SKILL_FILE,
    [
      '---',
      'name: __copy_lint_test_tmp__',
      'description: "fixture body"',
      '---',
      '',
      'Body mentions AI here. <!-- copy-lint:allow -->',
      '',
    ].join('\n'),
  );

  try {
    const allowed = runLint();
    assert.equal(
      allowed.badCount,
      baseline.badCount,
      `same-line marker must suppress hit; got ${allowed.badCount} vs baseline ${baseline.badCount}`,
    );
  } finally {
    cleanup();
  }
});

test('copy-lint honours allow marker on the previous line', () => {
  cleanup();
  const baseline = runLint();

  fs.mkdirSync(TEMP_SKILL_DIR, { recursive: true });
  // Allow marker on the line ABOVE the offending content.
  fs.writeFileSync(
    TEMP_SKILL_FILE,
    [
      '---',
      'name: __copy_lint_test_tmp__',
      'description: "fixture body"',
      '---',
      '',
      '<!-- copy-lint:allow -->',
      'Documenting the AI rule here for code-comment use.',
      '',
    ].join('\n'),
  );

  try {
    const allowed = runLint();
    assert.equal(
      allowed.badCount,
      baseline.badCount,
      `prev-line marker must suppress hit; got ${allowed.badCount} vs baseline ${baseline.badCount}`,
    );
  } finally {
    cleanup();
  }
});
