import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('runner.mjs registers the wiki-compile stage', () => {
  const src = readFileSync(new URL('../../src/dream/runner.mjs', import.meta.url), 'utf8');
  assert.ok(
    src.includes("name: 'wiki-compile'") || src.includes('name: "wiki-compile"'),
    'wiki-compile stage must be registered in runner.mjs'
  );
  assert.ok(src.includes('runDreamCycle'), 'must import runDreamCycle');
});
