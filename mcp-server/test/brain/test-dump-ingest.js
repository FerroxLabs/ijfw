import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInbox, classify, writeManifest, commitProcessed, isProcessed, readManifest } from '../../src/brain/dump-ingest.js';

function freshInbox() {
  return mkdtempSync(join(tmpdir(), 'brain-dump-'));
}

test('classify recognizes md, markdown, pdf, txt, transcript; unknown otherwise', () => {
  assert.equal(classify('notes.md'), 'markdown');
  assert.equal(classify('Notes.MARKDOWN'), 'markdown');
  assert.equal(classify('paper.pdf'), 'pdf');
  assert.equal(classify('rough.txt'), 'text');
  assert.equal(classify('meeting.transcript.txt'), 'transcript');
  assert.equal(classify('weird.zip'), 'unknown');
  assert.equal(classify('no-ext'), 'unknown');
});

test('scanInbox returns empty when dir missing (ENOENT swallowed)', () => {
  const result = scanInbox(join(tmpdir(), 'no-such-dir-' + Date.now()));
  assert.deepEqual(result, []);
});

test('scanInbox returns depth-0 files only, classifies, skips dotfiles and subdirs', () => {
  const root = freshInbox();
  try {
    writeFileSync(join(root, 'a.md'), '# a\n');
    writeFileSync(join(root, 'b.pdf'), '%PDF-fake\n');
    writeFileSync(join(root, 'c.transcript.txt'), 'Speaker: hi\n');
    writeFileSync(join(root, 'd.zip'), 'zip-bytes');           // unknown → filtered out
    writeFileSync(join(root, '.hidden.md'), '# hidden\n');     // dotfile → skipped
    mkdirSync(join(root, 'subdir'));
    writeFileSync(join(root, 'subdir', 'deep.md'), '# deep\n'); // depth-1 → NOT returned

    const result = scanInbox(root);
    const names = result.map((r) => r.name).sort();
    const kinds = result.map((r) => ({ name: r.name, kind: r.kind })).sort((x, y) => x.name.localeCompare(y.name));

    assert.deepEqual(names, ['a.md', 'b.pdf', 'c.transcript.txt']);
    assert.deepEqual(kinds, [
      { name: 'a.md', kind: 'markdown' },
      { name: 'b.pdf', kind: 'pdf' },
      { name: 'c.transcript.txt', kind: 'transcript' },
    ]);
    for (const r of result) {
      assert.ok(typeof r.sizeBytes === 'number' && r.sizeBytes > 0, `${r.name} sizeBytes`);
      assert.ok(typeof r.mtimeMs === 'number' && r.mtimeMs > 0, `${r.name} mtimeMs`);
      assert.ok(r.path.endsWith(r.name), `${r.name} path`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeManifest writes <name>.manifest.json atomically', () => {
  const processed = freshInbox();
  try {
    writeManifest(processed, 'a.md', { facts: 3, pages: ['x'] });
    assert.ok(existsSync(join(processed, 'a.md.manifest.json')));
    // no .tmp leftover
    const leftover = readdirSync(processed).some((f) => f.endsWith('.tmp'));
    assert.equal(leftover, false, 'no .tmp left behind after atomic rename');
  } finally { rmSync(processed, { recursive: true, force: true }); }
});

test('readManifest round-trips the payload', () => {
  const processed = freshInbox();
  try {
    const payload = { facts: 7, pages: ['p', 'q'], note: 'ok' };
    writeManifest(processed, 'b.md', payload);
    assert.deepEqual(readManifest(processed, 'b.md'), payload);
  } finally { rmSync(processed, { recursive: true, force: true }); }
});

test('isProcessed: true iff manifest present', () => {
  const processed = freshInbox();
  try {
    assert.equal(isProcessed(processed, 'never.md'), false);
    writeManifest(processed, 'c.md', { facts: 0 });
    assert.equal(isProcessed(processed, 'c.md'), true);
  } finally { rmSync(processed, { recursive: true, force: true }); }
});

test('commitProcessed renames inbox->processed; idempotent on recovery', () => {
  const inbox = freshInbox();
  const processed = freshInbox();
  try {
    const srcPath = join(inbox, 'd.md');
    writeFileSync(srcPath, '# d\n');
    // proper order: writeManifest first, then commitProcessed
    writeManifest(processed, 'd.md', { facts: 1 });
    commitProcessed(inbox, processed, 'd.md');
    assert.equal(existsSync(srcPath), false, 'src removed by rename');
    assert.equal(existsSync(join(processed, 'd.md')), true, 'dst present');
    assert.equal(isProcessed(processed, 'd.md'), true);
    // Idempotent: calling again is a no-op (recovery path)
    commitProcessed(inbox, processed, 'd.md');
    assert.equal(existsSync(join(processed, 'd.md')), true);
  } finally {
    rmSync(inbox, { recursive: true, force: true });
    rmSync(processed, { recursive: true, force: true });
  }
});
