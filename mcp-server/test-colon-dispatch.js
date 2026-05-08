#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- W1B colon-syntax dispatcher test.
//
// Covers:
//   - parseColonCommand recognises valid forms; null on plain strings
//   - dispatchRun({compute:js})    runs vm.Script JS-only path and returns stdout
//   - dispatchRun({index:foo})     writes to FTS5; dispatchSearch finds it
//   - dispatchRun({detect:project_type}) returns the Phase 3 wired envelope
//   - dispatchRun unknown namespace returns null (so caller falls through)
//   - dispatchRun unknown compute language returns ok:false with informative error
//   - dispatchSearch unknown namespace returns null (caller falls through)
//
// Run: node mcp-server/test-colon-dispatch.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  parseColonCommand,
  dispatchRun,
  dispatchSearch,
} from './src/dispatch/colon-syntax.js';

// Force vm.Script JS-only path so the test does not depend on a writable
// subprocess sandbox surface or a Python interpreter.
process.env.IJFW_COMPUTE_VM_ONLY = '1';

// --- parser -------------------------------------------------------------

test('parseColonCommand: compute:python with quoted body', () => {
  const r = parseColonCommand('compute:python "print(1)"');
  assert.deepEqual(r, { namespace: 'compute', command: 'python', args: 'print(1)' });
});

test('parseColonCommand: compute:js with unquoted body', () => {
  const r = parseColonCommand('compute:js code goes here');
  assert.deepEqual(r, { namespace: 'compute', command: 'js', args: 'code goes here' });
});

test('parseColonCommand: index:source no args', () => {
  const r = parseColonCommand('index:source');
  assert.deepEqual(r, { namespace: 'index', command: 'source', args: '' });
});

test('parseColonCommand: detect:project_type', () => {
  const r = parseColonCommand('detect:project_type');
  assert.deepEqual(r, { namespace: 'detect', command: 'project_type', args: '' });
});

test('parseColonCommand: plain string returns null', () => {
  assert.equal(parseColonCommand('ls -la'), null);
  assert.equal(parseColonCommand(''), null);
  assert.equal(parseColonCommand('   '), null);
  assert.equal(parseColonCommand(null), null);
  assert.equal(parseColonCommand(undefined), null);
  assert.equal(parseColonCommand(123), null);
});

test('parseColonCommand: leading colon rejected', () => {
  assert.equal(parseColonCommand(':foo'), null);
});

test('parseColonCommand: trailing colon rejected (empty remainder)', () => {
  assert.equal(parseColonCommand('compute:'), null);
});

test('parseColonCommand: namespace charset enforced', () => {
  // Numbers in first position rejected; uppercase rejected.
  assert.equal(parseColonCommand('1bad:foo'), null);
  assert.equal(parseColonCommand('Compute:js x'), null);
});

test('parseColonCommand: single-quoted args body', () => {
  const r = parseColonCommand("compute:js 'console.log(1)'");
  assert.deepEqual(r, { namespace: 'compute', command: 'js', args: 'console.log(1)' });
});

// --- dispatchRun: compute:js (vm.Script path) ---------------------------

test('dispatchRun compute:js executes via vm.Script and returns stdout', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-js-'));
  try {
    const parsed = parseColonCommand('compute:js console.log(2 + 2)');
    const r = await dispatchRun(parsed, { projectRoot });
    assert.equal(r.ok, true, `expected ok=true; got ${JSON.stringify(r)}`);
    assert.match(r.stdout, /4/);
    assert.equal(r.exitCode, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('dispatchRun compute:js with empty body returns informative error', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-emptyjs-'));
  try {
    // parseColonCommand returns null for "compute:" alone; build manually
    // to test the dispatcher's own validation.
    const r = await dispatchRun({ namespace: 'compute', command: 'js', args: '' }, { projectRoot });
    assert.equal(r.ok, false);
    assert.match(r.error, /requires a script body/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('dispatchRun compute:<unknown> returns informative error', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-unkcompute-'));
  try {
    const r = await dispatchRun({ namespace: 'compute', command: 'rust', args: 'fn main(){}' }, { projectRoot });
    assert.equal(r.ok, false);
    assert.match(r.error, /Unknown compute language/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// --- dispatchRun: index:source + dispatchSearch round-trip --------------

test('dispatchRun index:foo writes; dispatchSearch compute:hello finds it', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-idx-'));
  try {
    const parsedIndex = parseColonCommand('index:foo hello world delta lever');
    const indexed = await dispatchRun(parsedIndex, {
      projectRoot,
      sessionId: 'colon-test-session',
    });
    assert.equal(indexed.ok, true, `index write expected ok; got ${JSON.stringify(indexed)}`);
    assert.equal(indexed.source, 'foo');
    assert.ok(indexed.id != null, 'expected an FTS5 row id');

    const parsedSearch = parseColonCommand('compute:hello');
    const found = await dispatchSearch(parsedSearch, { projectRoot });
    assert.equal(found.ok, true);
    assert.ok(Array.isArray(found.hits));
    assert.ok(found.hits.length >= 1, `expected at least 1 hit; got ${found.hits.length}`);
    assert.match(found.hits[0].body, /hello world delta lever/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('dispatchRun index:source with no body returns error', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-idx-empty-'));
  try {
    const r = await dispatchRun({ namespace: 'index', command: 'source', args: '' }, { projectRoot });
    assert.equal(r.ok, false);
    assert.match(r.error, /requires content to index/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// --- dispatchRun: detect:project_type real (Phase 3 wired) --------------

test('dispatchRun detect:project_type returns real detection result', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-detect-'));
  try {
    const parsed = parseColonCommand('detect:project_type');
    const r = await dispatchRun(parsed, { projectRoot });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'sync');
    assert.ok(r.result, 'result envelope present');
    assert.equal(typeof r.result.primary_type, 'string');
    assert.equal(typeof r.result.confidence, 'number');
    assert.equal(Array.isArray(r.result.secondary_types), true);
    assert.equal(typeof r.result.scan_incomplete, 'boolean');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('dispatchRun detect:<unknown> returns informative error', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-colon-disp-detect-unk-'));
  try {
    const r = await dispatchRun({ namespace: 'detect', command: 'language', args: '' }, { projectRoot });
    assert.equal(r.ok, false);
    assert.match(r.error, /Unknown detect sub-command/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// --- fall-through behaviour --------------------------------------------

test('dispatchRun unknown namespace returns null (caller falls through)', async () => {
  const r = await dispatchRun({ namespace: 'shell', command: 'ls', args: '' });
  assert.equal(r, null);
});

test('dispatchSearch unknown namespace returns null (caller falls through)', async () => {
  const r = await dispatchSearch({ namespace: 'memory', command: 'foo', args: '' });
  assert.equal(r, null);
});

test('dispatchRun null parsed returns null', async () => {
  assert.equal(await dispatchRun(null), null);
  assert.equal(await dispatchRun(undefined), null);
});
