import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstRunScan } from '../../src/brain/first-run-scan.js';

function fresh() { return mkdtempSync(join(tmpdir(), 'brain-firstrun-')); }

test('firstRunScan: empty home -> all sources found:false', () => {
  const home = fresh();
  try {
    const { sources, totalSessions } = firstRunScan({ homeDir: home });
    assert.ok(sources.length >= 8);
    assert.ok(sources.every((s) => s.found === false));
    assert.equal(totalSessions, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('firstRunScan: claude/projects sessions counted', () => {
  const home = fresh();
  try {
    mkdirSync(join(home, '.claude', 'projects', 'proj-a'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'proj-a', 'sess1.jsonl'), '{}\n');
    writeFileSync(join(home, '.claude', 'projects', 'proj-a', 'sess2.jsonl'), '{}\n');
    mkdirSync(join(home, '.claude', 'projects', 'proj-b'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'proj-b', 'sess3.jsonl'), '{}\n');
    const { sources, totalSessions } = firstRunScan({ homeDir: home });
    const claude = sources.find((s) => s.id === 'claude');
    assert.equal(claude.found, true);
    assert.equal(claude.projects, 2);
    assert.equal(claude.count, 3);
    assert.equal(totalSessions, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('firstRunScan: global CLAUDE.md size>0 -> count:1', () => {
  const home = fresh();
  try {
    writeFileSync(join(home, 'CLAUDE.md'), 'has content\n');
    const { sources } = firstRunScan({ homeDir: home });
    const md = sources.find((s) => s.id === 'claude-md');
    assert.equal(md.found, true);
    assert.equal(md.count, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('firstRunScan: emits onProgress per source', () => {
  const home = fresh();
  try {
    const events = [];
    firstRunScan({ homeDir: home, onProgress: (e) => events.push(e) });
    assert.ok(events.some((e) => e.stage === 'scanning' && e.id === 'claude'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('firstRunScan: bare .codex directory counted as N entries', () => {
  const home = fresh();
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.yaml'), 'x\n');
    writeFileSync(join(home, '.codex', 'history.db'), 'y');
    const { sources } = firstRunScan({ homeDir: home });
    const codex = sources.find((s) => s.id === 'codex');
    assert.equal(codex.found, true);
    assert.equal(codex.count, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
