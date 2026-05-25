import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContextInjection } from '../../src/brain/context-injection.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'brain-ctxinj-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  writeLayoutVersion(r, 2);
  return r;
}

function seedPage(root, type, slug, body, mtimeSecondsAgo = 60) {
  const dir = join(root, 'ijfw', 'wiki', type);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${slug}.md`);
  writeFileSync(p, body);
  const t = (Date.now() - mtimeSecondsAgo * 1000) / 1000;
  utimesSync(p, t, t);
}

test('buildContextInjection: empty wiki -> ""', () => {
  const root = freshRoot();
  try { assert.equal(buildContextInjection(root), ''); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildContextInjection: mode=never -> "" even when pages exist', () => {
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'sean', '# sean\n\nfounder of foundry.');
    assert.equal(buildContextInjection(root, { mode: 'never' }), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildContextInjection: surfaces top-N most recent pages with wrapper', () => {
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'older', 'OLD CONTENT', 1000);
    seedPage(root, 'entities', 'middle', 'MID CONTENT', 500);
    seedPage(root, 'entities', 'newest', 'NEW CONTENT', 1);
    const out = buildContextInjection(root, { topN: 2 });
    assert.ok(out.includes('--- Recently relevant from your brain ---'));
    assert.ok(out.includes('--- end brain context ---'));
    assert.ok(out.includes('entities/newest'));
    assert.ok(out.includes('entities/middle'));
    assert.ok(!out.includes('entities/older'), 'topN=2 excludes 3rd');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildContextInjection: truncates per charBudget', () => {
  const root = freshRoot();
  try {
    const longBody = 'lorem ipsum '.repeat(500);
    seedPage(root, 'concepts', 'verbose', longBody);
    const out = buildContextInjection(root, { charBudget: 200 });
    assert.ok(out.includes('...'));
    assert.ok(out.length < longBody.length / 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildContextInjection: walks all 4 wiki type dirs', () => {
  const root = freshRoot();
  try {
    seedPage(root, 'concepts', 'a', 'A');
    seedPage(root, 'entities', 'b', 'B');
    seedPage(root, 'decisions', 'c', 'C');
    seedPage(root, 'milestones', 'd', 'D');
    const out = buildContextInjection(root, { topN: 10 });
    for (const t of ['concepts/a','entities/b','decisions/c','milestones/d']) {
      assert.ok(out.includes(t), `missing ${t}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
