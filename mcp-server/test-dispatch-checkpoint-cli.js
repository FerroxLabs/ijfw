import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlers, subcommandHelp } from './src/dispatch/checkpoint-cli.js';

function makeCtx() {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-cli-'));
  return { root, ctx: { projectRoot: root } };
}

test('checkpoint: happy path returns ok + writes checkpoint file', async (t) => {
  const { root, ctx } = makeCtx();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const args = `W11-A0 W11-A1 ${JSON.stringify({ tool_use_count: 5, last_action: 'wrote module', next_step: 'write tests' })}`;
  const result = await handlers.checkpoint(args, ctx);

  assert.equal(result.ok, true);
  assert.match(result.output, /^ok: wrote checkpoint for W11-A0\/W11-A1/);

  const file = join(root, '.ijfw', 'wave-W11-A0', 'subagent-W11-A1.checkpoint.json');
  assert.ok(existsSync(file), 'checkpoint file should exist');
  // v1.5.0 T9 changed the on-disk shape: the recordCheckpoint envelope is
  // now NESTED under `.checkpoint` because the state-SDK `subagent.checkpoint`
  // verb wraps it with `{ waveId, subagentId, dedupKey, checkpoint, updated_at }`.
  // Runtime readers (readLastCheckpoint) auto-unwrap; raw-file readers like
  // this test need to descend into `.checkpoint`. Both the wrapper-level
  // (waveId / subagentId) and the nested envelope (wave_id / sub_id / payload
  // fields) are asserted below.
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.waveId, 'W11-A0');
  assert.equal(raw.subagentId, 'W11-A1');
  const stored = raw.checkpoint;
  assert.equal(stored.wave_id, 'W11-A0');
  assert.equal(stored.sub_id, 'W11-A1');
  assert.equal(stored.tool_use_count, 5);
  assert.equal(stored.last_action, 'wrote module');
  assert.equal(stored.next_step, 'write tests');
  assert.equal(stored.schema_version, 1);
  assert.ok(typeof stored.ts === 'string' && stored.ts.includes('T'));
});

test('checkpoint: missing args returns ok:false with usage error', async (t) => {
  const { root, ctx } = makeCtx();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await handlers.checkpoint('W11-A0', ctx);  // only 1 token
  assert.equal(result.ok, false);
  assert.match(result.error, /Usage:/);
});

test('checkpoint: invalid JSON returns ok:false with parse error', async (t) => {
  const { root, ctx } = makeCtx();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await handlers.checkpoint('W11-A0 W11-A1 {not-valid-json', ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid JSON payload/);
});

test('checkpoint: path traversal in subId rejected (recordCheckpoint validation)', async (t) => {
  const { root, ctx } = makeCtx();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const args = `W11-A0 ../etc ${JSON.stringify({ last_action: 'x' })}`;
  const result = await handlers.checkpoint(args, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid subId/);
});

test('checkpoint: payload too large rejected', async (t) => {
  const { root, ctx } = makeCtx();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const big = { last_action: 'x'.repeat(5000) };
  const args = `W11-A0 W11-A1 ${JSON.stringify(big)}`;
  const result = await handlers.checkpoint(args, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds MAX_CHECKPOINT_SIZE/);
});

test('subcommandHelp exports the checkpoint subcommand', () => {
  assert.ok(typeof subcommandHelp.checkpoint === 'string');
  assert.match(subcommandHelp.checkpoint, /checkpoint <waveId> <subId>/);
});
