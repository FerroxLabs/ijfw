import { test } from 'node:test';
import assert from 'node:assert';
import { BRAIN_VERSION } from '../../src/brain/index.js';

test('brain scaffold: BRAIN_VERSION should be 1', () => {
  assert.strictEqual(BRAIN_VERSION, 1, 'BRAIN_VERSION should export 1');
});
