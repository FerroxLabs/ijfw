import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInbox, classify } from '../../src/brain/dump-ingest.js';

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
