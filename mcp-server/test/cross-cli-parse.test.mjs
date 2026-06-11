// Regression tests for the `ijfw cross <mode>` argv grammar.
//
// Audit finding: the namespaced form (`ijfw cross audit ...`) used a
// position-rigid parser (target = args[2], space-separated --with only) while
// the alias form (`ijfw cross-audit ...`) used parseCrossAlias. Result:
// `ijfw cross audit f --with=codex` silently dropped the roster restriction
// and dispatched every paid auditor, and `ijfw cross audit --with codex f`
// consumed the flag as the target. Both forms now share parseCrossAlias.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cross-orchestrator-cli.js';

function parse(...cliArgs) {
  return parseArgs(['node', 'cli', ...cliArgs]);
}

test('cross audit honors --with=<id> (equals form)', () => {
  const p = parse('cross', 'audit', 'file.js', '--with=codex');
  assert.equal(p.cmd, 'cross');
  assert.equal(p.mode, 'audit');
  assert.equal(p.target, 'file.js');
  assert.equal(p.only, 'codex');
});

test('cross audit honors space-separated --with', () => {
  const p = parse('cross', 'audit', 'file.js', '--with', 'gemini');
  assert.equal(p.target, 'file.js');
  assert.equal(p.only, 'gemini');
});

test('cross audit with flags before the target never treats a flag as target', () => {
  const p = parse('cross', 'audit', '--with', 'codex', 'file.js');
  assert.equal(p.target, 'file.js');
  assert.equal(p.only, 'codex');
});

test('cross audit --confirm/--expand/--chunk parse regardless of position', () => {
  const p = parse('cross', 'audit', '--confirm', 'file.js', '--chunk', '--expand');
  assert.equal(p.target, 'file.js');
  assert.equal(p.confirm, true);
  assert.equal(p.expand, true);
  assert.equal(p.chunk, true);
});

test('namespaced form and alias form parse identically', () => {
  const a = parse('cross', 'audit', 'file.js', '--with=codex', '--confirm');
  const b = parse('cross-audit', 'file.js', '--with=codex', '--confirm');
  assert.deepEqual(a, b);
});

test('cross research joins multi-word positional topic', () => {
  const p = parse('cross', 'research', 'memory', 'benchmark', 'design');
  assert.equal(p.mode, 'research');
  assert.equal(p.target, 'memory benchmark design');
});

test('cross project-audit special case still routes to cross-project-audit', () => {
  const p = parse('cross', 'project-audit', 'rules.md', '--dry-run');
  assert.equal(p.cmd, 'cross-project-audit');
  assert.equal(p.rule, 'rules.md');
  assert.equal(p.dryRun, true);
});

test('missing target stays undefined (not a flag token)', () => {
  const p = parse('cross', 'audit', '--with=codex');
  assert.equal(p.target, undefined);
  assert.equal(p.only, 'codex');
});
