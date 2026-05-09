import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as claudeMem from './src/importers/claude-mem.js';
import * as rtk from './src/importers/rtk.js';
import { makeEntry, emptyStats, bumpStat, renderSummary } from './src/importers/common.js';
import { runImport, listImporters } from './src/importers/cli.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ijfw-import-')); }
function clean(d) { rmSync(d, { recursive: true, force: true }); }

test('makeEntry returns null when content is empty', () => {
  assert.equal(makeEntry({ type: 'decision', content: '' }), null);
  assert.equal(makeEntry({ type: null, content: 'x' }), null);
});

test('makeEntry trims content + caps summary at 80 chars', () => {
  const e = makeEntry({ type: 'pattern', content: '  hello  ', summary: 'a'.repeat(200) });
  assert.equal(e.content, 'hello');
  assert.equal(e.summary.length, 80);
});

test('bumpStat + renderSummary compose a positive-framed summary', () => {
  const s = emptyStats();
  bumpStat(s, { type: 'decision' }, 'ok');
  bumpStat(s, { type: 'pattern' }, 'ok');
  bumpStat(s, null, 'skipped');
  const line = renderSummary('claude-mem', s);
  assert.match(line, /Imported 1 decisions \+ 1 patterns from claude-mem/);
  assert.match(line, /1 skipped/);
});

test('claude-mem normalize maps type=decision -> IJFW decision', () => {
  const entry = claudeMem.normalize({
    title: 'pick postgres over sqlite',
    type: 'decision',
    narrative: 'we need multi-writer support in prod',
    facts: '["no SQLite multi-writer"]',
    concepts: '["db","scaling"]',
    files_modified: '["docs/adr/0007.md"]',
    project: '/home/me/dev/alpha',
    session_id: 'sess-42',
  });
  assert.equal(entry.type, 'decision');
  assert.equal(entry.summary, 'pick postgres over sqlite');
  assert.deepEqual(entry.tags, ['db', 'scaling']);
  assert.match(entry.content, /multi-writer support in prod/);
  assert.match(entry.content, /Files touched: docs\/adr\/0007\.md/);
  assert.match(entry.content, /project alpha/);
});

test('claude-mem normalize maps type=feature -> pattern', () => {
  const e = claudeMem.normalize({ title: 't', type: 'feature', narrative: 'n' });
  assert.equal(e.type, 'pattern');
});

test('claude-mem normalize maps type=discovery -> observation', () => {
  const e = claudeMem.normalize({ title: 't', type: 'discovery', narrative: 'n' });
  assert.equal(e.type, 'observation');
});

test('claude-mem normalize defaults unknown type to observation', () => {
  const e = claudeMem.normalize({ title: 't', type: 'mystery', narrative: 'n' });
  assert.equal(e.type, 'observation');
});

test('claude-mem normalize returns null when title + narrative are both empty', () => {
  assert.equal(claudeMem.normalize({ type: 'decision' }), null);
  assert.equal(claudeMem.normalize(null), null);
});

test('claude-mem normalize tolerates malformed JSON in facts/concepts', () => {
  const e = claudeMem.normalize({ title: 't', type: 'decision', narrative: 'n', concepts: 'not json', facts: 'also not json' });
  assert.deepEqual(e.tags, []);
});

test('claude-mem detect finds db at custom --path', () => {
  const d = tmp();
  try {
    const dbPath = join(d, 'claude-mem.db');
    writeFileSync(dbPath, 'fake');
    const hit = claudeMem.detect({ path: dbPath });
    assert.equal(hit.found, true);
    assert.equal(hit.path, dbPath);
  } finally { clean(d); }
});

test('claude-mem detect returns found=false when nothing matches', () => {
  assert.equal(claudeMem.detect({ home: '/nonexistent-home-xyz', path: null }).found, false);
});

test('rtk normalize defaults to observation + parses tags', () => {
  const e = rtk.normalize({ content: 'bash ls', type: 'command', tags: ['shell'] });
  assert.equal(e.type, 'observation');
  assert.deepEqual(e.tags, ['shell']);
});

test('rtk normalize returns null on empty content', () => {
  assert.equal(rtk.normalize({ type: 'x' }), null);
});

test('runImport skips rtk by default with an opt-in hint', async () => {
  const result = await runImport({ tool: 'rtk' });
  assert.equal(result.ok, true);
  assert.match(result.summary, /Skipped rtk/);
  assert.match(result.summary, /--include-metrics/);
});

test('runImport rejects unknown tools with the available list', async () => {
  const result = await runImport({ tool: 'mempalace' });
  assert.equal(result.ok, false);
  assert.match(result.error, /claude-mem/);
});

test('runImport reports no-data-found with a --path hint', async () => {
  const result = await runImport({ tool: 'claude-mem', path: '/does/not/exist/claude-mem.db' });
  assert.equal(result.ok, false);
  assert.match(result.error, /No claude-mem data found/);
  assert.match(result.error, /--path/);
});

test('listImporters returns both importers', () => {
  const list = listImporters();
  assert.ok(list.includes('claude-mem'));
  assert.ok(list.includes('rtk'));
});

test('claude-mem round-trip writes a decision into knowledge.md', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (err) {
    // node:sqlite is in Node 22.5+ but flagged on 22.x (--experimental-sqlite)
    // and unflagged on 23+. CI passes the flag; local invocations without it
    // skip cleanly with a diagnostic instead of a silent miss.
    t.skip(`node:sqlite import failed (${err.code || err.message}). Run with --experimental-sqlite on Node 22.x, or use Node 23+.`);
    return;
  }
  const d = tmp();
  try {
    const dbPath = join(d, 'claude-mem.db');
    const db = new DatabaseSync(dbPath);
    const ddl = [
      'CREATE TABLE observations (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  session_id TEXT, sdk_session_id TEXT, claude_session_id TEXT,',
      '  project TEXT, prompt_number INTEGER, tool_name TEXT, correlation_id TEXT,',
      '  title TEXT, subtitle TEXT, type TEXT, narrative TEXT,',
      '  facts TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,',
      '  text TEXT, created_at TEXT, created_at_epoch INTEGER',
      ')'
    ].join('\n');
    db.exec(ddl);
    db.prepare('INSERT INTO observations (title, type, narrative, facts, concepts, files_modified, project, session_id, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('pick postgres', 'decision', 'multi-writer support', '["multi-writer"]', '["db"]', '["docs/adr/0007.md"]', '/home/me/dev/alpha', 'sess-42', '2026-04-15T03:00:00Z', 1760494800000);
    db.close();

    const projectDir = join(d, 'project');
    mkdirSync(projectDir, { recursive: true });
    const result = await runImport({ tool: 'claude-mem', path: dbPath, projectDir });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stats.decisions, 1);
    const knowledge = readFileSync(join(projectDir, '.ijfw', 'memory', 'knowledge.md'), 'utf8');
    assert.match(knowledge, /name: pick postgres/);
    assert.match(knowledge, /type: decision/);
    assert.match(knowledge, /multi-writer support/);

    const second = await runImport({ tool: 'claude-mem', path: dbPath, projectDir });
    assert.equal(second.stats.skipped, 1);
    assert.equal(second.stats.decisions, 0);
  } finally { clean(d); }
});
