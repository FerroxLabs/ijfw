import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handlers, subcommandHelp } from './src/dispatch/wave-cli.js';
import { writeWaveState } from './src/orchestrator/wave-state.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'wave-cli-'));
}

test('wave-status <id> reads state and includes wave_id in output', async () => {
  const root = makeTmp();
  await writeWaveState('W10-A0', {
    frontmatter: { wave_id: 'W10-A0', status: 'in_progress', created_at: '2026-05-18T00:00:00.000Z' },
    body: '# notes\n\nfoo',
  }, root);
  const r = await handlers['wave-status']([ 'W10-A0' ], { projectRoot: root });
  assert.equal(r.ok, true);
  assert.match(r.output, /Wave: W10-A0/);
  assert.match(r.output, /status: in_progress/);
  assert.match(r.output, /--- notes ---/);
});

test('wave-status latest resolves most-recent wave by mtime', async () => {
  const root = makeTmp();
  await writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0', status: 'done' }, body: '' }, root);
  await new Promise((r) => setTimeout(r, 10));
  await writeWaveState('W10-A1', { frontmatter: { wave_id: 'W10-A1', status: 'in_progress' }, body: '' }, root);
  const r = await handlers['wave-status']([ 'latest' ], { projectRoot: root });
  assert.equal(r.ok, true);
  assert.match(r.output, /Wave: W10-A1/);
});

test('wave-status (no arg) defaults to latest', async () => {
  const root = makeTmp();
  await writeWaveState('W10-B2', { frontmatter: { wave_id: 'W10-B2', status: 'in_progress' }, body: '' }, root);
  const r = await handlers['wave-status']([], { projectRoot: root });
  assert.equal(r.ok, true);
  assert.match(r.output, /Wave: W10-B2/);
});

test('wave-status missing wave returns ok:false with clear error', async () => {
  const root = makeTmp();
  const r = await handlers['wave-status']([ 'nope' ], { projectRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.output, /not found/);
});

test('wave-status on empty project returns ok:false', async () => {
  const root = makeTmp();
  const r = await handlers['wave-status']([ 'latest' ], { projectRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.output, /No waves found/);
});

test('wave-list returns tab-separated lines newest-first', async () => {
  const root = makeTmp();
  await writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0', status: 'done', created_at: '2026-05-18T01:00:00.000Z' }, body: '' }, root);
  await new Promise((r) => setTimeout(r, 10));
  await writeWaveState('W10-A1', { frontmatter: { wave_id: 'W10-A1', status: 'in_progress', created_at: '2026-05-18T02:00:00.000Z' }, body: '' }, root);
  const r = await handlers['wave-list']([], { projectRoot: root });
  assert.equal(r.ok, true);
  const lines = r.output.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('W10-A1\t'), 'newest first');
  assert.match(lines[0], /\tin_progress\t/);
});

test('wave-list on empty project returns "(no waves)"', async () => {
  const root = makeTmp();
  const r = await handlers['wave-list']([], { projectRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.output, '(no waves)');
});

test('wave-cli accepts string-form args (tokenizes)', async () => {
  const root = makeTmp();
  await writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0', status: 'done' }, body: '' }, root);
  const r = await handlers['wave-status']('W10-A0', { projectRoot: root });
  assert.equal(r.ok, true);
  assert.match(r.output, /Wave: W10-A0/);
});

test('subcommandHelp exports correct keys with descriptive strings', () => {
  assert.ok('wave-status' in subcommandHelp);
  assert.ok('wave-list' in subcommandHelp);
  assert.match(subcommandHelp['wave-status'], /wave/i);
  assert.match(subcommandHelp['wave-list'], /list/i);
});
