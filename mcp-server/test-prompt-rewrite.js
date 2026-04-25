import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPrompt, buildQuestionPack } from './src/prompt-check.js';

test('vague bare-verb prompt returns a rewrite question pack', () => {
  const r = checkPrompt('fix');
  assert.equal(r.vague, true);
  assert.ok(Array.isArray(r.rewrite));
  assert.ok(r.rewrite.length > 0 && r.rewrite.length <= 3);
  assert.match(r.rewrite[0], /file, function, or line/i);
});

test('anaphora prompt surfaces the reference question', () => {
  const r = checkPrompt('that bug');
  assert.equal(r.vague, true);
  assert.ok(r.rewrite.some(q => /refer/i.test(q)));
});

test('non-vague prompt returns rewrite: null', () => {
  const r = checkPrompt('fix the off-by-one in src/paginate.py:5');
  assert.equal(r.vague, false);
  assert.equal(r.rewrite, null);
});

test('question pack is capped at 3 questions', () => {
  // All signals tripped (synthetic): request everything.
  const pack = buildQuestionPack([
    'bare_verb', 'no_target', 'unresolved_anaphora',
    'abstract_goal', 'scope_plural', 'missing_constraint', 'polysemous',
  ]);
  assert.ok(pack.length <= 3);
  assert.ok(pack.length >= 1);
});

test('duplicate signals do not produce duplicate questions', () => {
  const pack = buildQuestionPack(['bare_verb', 'no_target']);
  // Both map to "which file, function, or line" - should appear once.
  assert.equal(pack.length, 1);
});

test('empty signals still returns a default fallback question', () => {
  const pack = buildQuestionPack([]);
  assert.equal(pack.length, 1);
  assert.match(pack[0], /target/i);
});
