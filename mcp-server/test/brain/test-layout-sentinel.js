import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readLayoutVersion,
  writeLayoutVersion,
  withLayoutLock,
} from '../../src/brain/layout-sentinel.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'brain-lst-'));
}

test('no-sentinel → returns 1', () => {
  const root = freshRoot();
  // No .ijfw/ dir, no sentinel file at all
  assert.strictEqual(readLayoutVersion(root), 1);
});

test('write-then-read → returns 2', () => {
  const root = freshRoot();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeLayoutVersion(root, 2);
  assert.strictEqual(readLayoutVersion(root), 2);
});

test('non-numeric junk in sentinel → falls back to 1', () => {
  const root = freshRoot();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(join(root, '.ijfw', '.layout-version'), 'not-a-number\n');
  assert.strictEqual(readLayoutVersion(root), 1);
});

test('concurrent lock rejects within timeoutMs', async () => {
  const root = freshRoot();
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  const lockPath = join(root, '.ijfw', '.migrate.lock');

  let firstFnCompleted = false;

  // First lock holds for ~200ms
  const firstLock = withLayoutLock(root, async () => {
    await new Promise(r => setTimeout(r, 200));
    firstFnCompleted = true;
  });

  // Small delay to ensure first lock is acquired before second tries
  await new Promise(r => setTimeout(r, 10));

  // Second lock tries with 50ms timeout — must reject
  await assert.rejects(
    () => withLayoutLock(root, async () => {}, { timeoutMs: 50 }),
    (err) => {
      assert.ok(err.message.includes('locked >'), `Expected "locked >" in: ${err.message}`);
      return true;
    },
  );

  // Wait for first lock to fully release
  await firstLock;
  assert.strictEqual(firstFnCompleted, true, 'First fn should have completed');
  assert.strictEqual(existsSync(lockPath), false, 'Lock file should be cleaned up after release');
});
