import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPageBundle, writeShareReadme } from '../../src/brain/export.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'brain-export-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  writeLayoutVersion(r, 2);
  return r;
}

function seedPage(root, type, slug, body) {
  const dir = join(root, 'ijfw', 'wiki', type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body);
}

test('exportPageBundle: missing page -> error', () => {
  const root = freshRoot();
  try {
    const out = join(root, 'out.md');
    const r = exportPageBundle(root, 'no-such-slug', out);
    assert.equal(r.error, 'page-not-found');
    assert.equal(existsSync(out), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exportPageBundle: inlines linked pages as ### sections', () => {
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'sean', '# sean\n\nWorks at [[foundry]] and built [[ijfw]].');
    seedPage(root, 'concepts', 'foundry', '# foundry\n\nThe company.');
    seedPage(root, 'concepts', 'ijfw', '# ijfw\n\nThe brain.');
    seedPage(root, 'concepts', 'unreferenced', '# unreferenced\n\nNot linked.');
    const outFile = join(root, 'export.md');
    const r = exportPageBundle(root, 'sean', outFile);
    assert.equal(r.outFile, outFile);
    assert.ok(r.bytes > 0);
    assert.deepEqual(r.linkedPagesIncluded.sort(), ['foundry', 'ijfw']);
    const body = readFileSync(outFile, 'utf8');
    assert.ok(body.includes('# Export: sean'));
    assert.ok(body.includes('## sean'));
    assert.ok(body.includes('### foundry'));
    assert.ok(body.includes('### ijfw'));
    assert.ok(!body.includes('### unreferenced'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exportPageBundle: dangling wikilinks tolerated (skipped silently)', () => {
  const root = freshRoot();
  try {
    seedPage(root, 'entities', 'alice', '# alice\n\nLinks to [[nonexistent]].');
    const outFile = join(root, 'a.md');
    const r = exportPageBundle(root, 'alice', outFile);
    assert.equal(r.linkedPagesIncluded.length, 0);
    const body = readFileSync(outFile, 'utf8');
    assert.ok(body.includes('## alice'));
    assert.ok(!body.includes('### nonexistent'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeShareReadme: writes ijfw/README.md with team-share instructions', () => {
  const root = freshRoot();
  try {
    const r = writeShareReadme(root);
    assert.ok(r.outFile.endsWith(join('ijfw', 'README.md')));
    assert.ok(r.bytes > 0);
    const body = readFileSync(r.outFile, 'utf8');
    assert.ok(body.includes('Your IJFW Brain'));
    assert.ok(body.includes('Share with your team'));
    assert.ok(body.includes('ijfw memory reindex'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
