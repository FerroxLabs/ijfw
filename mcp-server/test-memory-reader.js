#!/usr/bin/env node
/**
 * Tests: mcp-server/src/memory/reader.js -- 5-tier unified reader
 * Run: node mcp-server/test-memory-reader.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== Build fixture filesystem =====
const FAKE_HOME    = join(tmpdir(), 'ijfw-fake-home-' + Date.now());
const REPO_ROOT    = join(FAKE_HOME, 'repo');
const FAKE_IJFW    = join(FAKE_HOME, '.ijfw');
const FAKE_SESS    = join(REPO_ROOT, '.ijfw', 'sessions');
const FAKE_PROJMEM = join(REPO_ROOT, '.ijfw', 'memory');
// Claude slug = REPO_ROOT with every separator replaced by -. On Windows
// the path uses backslashes AND a drive letter; flatten both and strip the
// "C:" prefix so the slug is a simple flat directory name.
const REPO_SLUG       = REPO_ROOT.replace(/^[A-Z]:/i, '').replace(/[\/\\]/g, '-');
const FAKE_CLAUDE_MEM = join(FAKE_HOME, '.claude', 'projects', REPO_SLUG, 'memory');

// Tier 2: project .ijfw/memory
mkdirSync(FAKE_PROJMEM, { recursive: true });
writeFileSync(join(FAKE_PROJMEM, 'handoff.md'), [
  '---', 'title: Project Handoff', 'description: Latest handoff', 'type: handoff', '---',
  '# Handoff', 'Project handoff content.', '',
].join('\n'));
writeFileSync(join(FAKE_PROJMEM, 'notes.md'), '# Project Notes\nNo frontmatter.\n');

// Tier 1: Claude auto-memory
mkdirSync(FAKE_CLAUDE_MEM, { recursive: true });
writeFileSync(join(FAKE_CLAUDE_MEM, 'auto-mem.md'), [
  '---', 'title: Auto Memory Entry', 'type: pattern', '---', 'An auto-memory entry.', '',
].join('\n'));

// Tier 3: sessions
mkdirSync(FAKE_SESS, { recursive: true });
writeFileSync(join(FAKE_SESS, 'session-2026.md'), '# Session 2026-04-16\nSession notes.\n');

// Tier 4: global observations
mkdirSync(FAKE_IJFW, { recursive: true });
writeFileSync(join(FAKE_IJFW, 'observations.jsonl'),
  JSON.stringify({ id: 1, platform: 'claude', ts: new Date().toISOString(), title: 'test' }) + '\n' +
  JSON.stringify({ id: 2, platform: 'codex',  ts: new Date().toISOString(), title: 'test2' }) + '\n'
);

// Tier 5: global HANDOFF.md
writeFileSync(join(FAKE_IJFW, 'HANDOFF.md'), '# Global Handoff\nGlobal state.\n');

// Set HOME before importing (reader uses homedir() at module load time).
// On Windows, homedir() reads USERPROFILE not HOME.
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const { listMemoryFiles, readMemoryFile, listKnownProjects, resolveMemoryRoot } = await import('./src/memory/reader.js');

// ===== Tests =====

test('listMemoryFiles returns tiers object with all 5 keys', () => {
  const { tiers } = listMemoryFiles(REPO_ROOT);
  assert.ok(tiers && typeof tiers === 'object', 'tiers should be an object');
  for (const key of ['Project', 'Auto-memory', 'Sessions', 'Global', 'Handoff']) {
    assert.ok(key in tiers, 'tiers should have ' + key + ' key');
  }
});

test('tier 2 (Project) files read correctly', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const projFiles = files.filter(f => f.tier === 'Project');
  assert.ok(projFiles.length >= 2, 'should find at least 2 project files, got: ' + projFiles.length);
  const handoff = projFiles.find(f => f.title === 'Project Handoff');
  assert.ok(handoff, 'handoff.md should be in Project tier');
  assert.equal(handoff.description, 'Latest handoff');
  assert.equal(handoff.type, 'handoff');
});

test('tier 1 (Auto-memory) files read correctly', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const autoFiles = files.filter(f => f.tier === 'Auto-memory');
  assert.ok(autoFiles.length >= 1, 'should find at least 1 auto-memory file, got: ' + autoFiles.length);
  const entry = autoFiles.find(f => f.title === 'Auto Memory Entry');
  assert.ok(entry, 'auto-mem.md should be in Auto-memory tier');
  assert.equal(entry.type, 'pattern');
});

test('tier 3 (Sessions) files read correctly', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const sessFiles = files.filter(f => f.tier === 'Sessions');
  assert.ok(sessFiles.length >= 1, 'should find at least 1 session file, got: ' + sessFiles.length);
  assert.ok(sessFiles.some(f => f.relpath && f.relpath.includes('session-2026.md')), 'session-2026.md should be in Sessions tier');
});

test('tier 4 (Global) observations file read correctly', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const globalFiles = files.filter(f => f.tier === 'Global');
  assert.ok(globalFiles.length >= 1, 'should find at least 1 global file, got: ' + globalFiles.length);
  const obs = globalFiles.find(f => f.path.endsWith('observations.jsonl'));
  assert.ok(obs, 'observations.jsonl should be in Global tier');
  assert.ok(obs.count >= 2, 'count should reflect line count');
});

test('tier 5 (Handoff) HANDOFF.md read correctly', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const handoffFiles = files.filter(f => f.tier === 'Handoff');
  assert.ok(handoffFiles.length >= 1, 'should find HANDOFF.md, got: ' + handoffFiles.length);
  assert.ok(handoffFiles.some(f => f.relpath === 'HANDOFF.md'), 'HANDOFF.md should be in Handoff tier');
});

test('all files have valid tier field', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const VALID_TIERS = new Set(['Project', 'Auto-memory', 'Sessions', 'Global', 'Handoff']);
  for (const f of files) {
    assert.ok(VALID_TIERS.has(f.tier), 'file ' + f.relpath + ' has invalid tier: ' + f.tier);
  }
});

test('tierFilter param restricts results to one tier', () => {
  const { files: projOnly } = listMemoryFiles(REPO_ROOT, 'Project');
  assert.ok(projOnly.every(f => f.tier === 'Project'), 'filtered result should only have Project tier');
  assert.ok(projOnly.length >= 1, 'should find at least 1 Project file');
});

test('frontmatter title parsed correctly', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const hf = files.find(f => f.title === 'Project Handoff');
  assert.ok(hf, 'frontmatter title should be parsed');
  assert.equal(hf.type, 'handoff');
});

test('fallback title from # heading when no frontmatter', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const notes = files.find(f => f.relpath && f.relpath.includes('notes.md'));
  assert.ok(notes, 'notes.md should be found');
  assert.equal(notes.title, 'Project Notes');
});

test('preview is a string for all files', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  for (const f of files) {
    assert.ok(typeof f.preview === 'string', 'preview should be string for ' + f.relpath);
  }
});

test('files sorted by last_modified descending', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  for (let i = 1; i < files.length; i++) {
    assert.ok(files[i-1].last_modified >= files[i].last_modified, 'should be sorted newest first');
  }
});

test('readMemoryFile returns content', () => {
  const { files } = listMemoryFiles(REPO_ROOT);
  const f = files[0];
  const body = readMemoryFile(f.path);
  assert.ok(body && body.length > 0, 'body should have content');
});

test('readMemoryFile returns null for missing file', () => {
  assert.equal(readMemoryFile('/nonexistent/definitely/missing.md'), null);
});

test('listKnownProjects returns array', () => {
  const projects = listKnownProjects();
  assert.ok(Array.isArray(projects), 'should return an array');
  // Our fake project slug dir exists, so there should be at least 1
  assert.ok(projects.length >= 1, 'should find at least 1 project from fixture, got: ' + projects.length);
});

test('resolveMemoryRoot returns path', () => {
  const root = resolveMemoryRoot(REPO_ROOT);
  assert.ok(root !== null, 'should find a memory root (project .ijfw/memory)');
});

process.on('exit', () => {
  try { rmSync(FAKE_HOME, { recursive: true }); } catch {}
});
