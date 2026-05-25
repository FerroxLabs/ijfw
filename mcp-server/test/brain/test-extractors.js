import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile, extractMarkdown, extractTranscript } from '../../src/brain/extractors/index.js';
import { chunkAtBlankLines } from '../../src/brain/extractors/markdown.js';
import { splitOnSpeakerTurns } from '../../src/brain/extractors/transcript.js';

function fresh() { return mkdtempSync(join(tmpdir(), 'brain-extractors-')); }

test('chunkAtBlankLines: short text returns single chunk', () => {
  assert.deepEqual(chunkAtBlankLines('hello'), ['hello']);
});

test('chunkAtBlankLines: greedily packs paragraphs up to maxChars', () => {
  const p = 'lorem ipsum '.repeat(20).trim();  // ~240 chars
  const text = [p, p, p, p].join('\n\n');       // 4 paras × ~240 = ~960
  const chunks = chunkAtBlankLines(text, 500);
  // each chunk holds ≤500 chars; ≥2 chunks expected
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk ${c.length} > 500`);
  assert.equal(chunks.join('\n\n'), text);
});

test('chunkAtBlankLines: paragraph longer than maxChars hard-splits', () => {
  const giant = 'x'.repeat(7500);
  const chunks = chunkAtBlankLines(giant, 3000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 3000);
  assert.equal(chunks[1].length, 3000);
  assert.equal(chunks[2].length, 1500);
});

test('extractMarkdown: reads file + chunks', () => {
  const dir = fresh();
  try {
    const p = join(dir, 'note.md');
    writeFileSync(p, '# title\n\nbody line 1\n\nbody line 2\n');
    const out = extractMarkdown(p);
    assert.ok(out.text.includes('body line 2'));
    assert.equal(out.chunks.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('splitOnSpeakerTurns: Name: and [Name] both detected; preamble preserved', () => {
  const t = `intro paragraph\nstill intro\nAlice: hello there\nhow are you\nBob: I am fine\n[Charlie] short reply\nlater context`;
  const turns = splitOnSpeakerTurns(t);
  assert.equal(turns.length, 4);
  assert.ok(turns[0].startsWith('intro paragraph'));
  assert.ok(turns[1].startsWith('Alice:'));
  assert.ok(turns[1].includes('how are you'));
  assert.ok(turns[2].startsWith('Bob:'));
  assert.ok(turns[3].startsWith('[Charlie]'));
  assert.ok(turns[3].includes('later context'));
});

test('splitOnSpeakerTurns: empty input → empty array', () => {
  assert.deepEqual(splitOnSpeakerTurns(''), []);
});

test('extractTranscript: reads file + splits on turns', () => {
  const dir = fresh();
  try {
    const p = join(dir, 'mtg.transcript.txt');
    writeFileSync(p, 'Alice: hi\nBob: hi back\n');
    const out = extractTranscript(p);
    assert.equal(out.chunks.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile dispatch: markdown -> markdown extractor', async () => {
  const dir = fresh();
  try {
    const p = join(dir, 'a.md');
    writeFileSync(p, 'hello\n');
    const out = await extractFile({ kind: 'markdown', path: p });
    assert.equal(out.text, 'hello\n');
    assert.deepEqual(out.chunks, ['hello\n']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile dispatch: text -> markdown extractor (text reuses md path)', async () => {
  const dir = fresh();
  try {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'plain text');
    const out = await extractFile({ kind: 'text', path: p });
    assert.equal(out.text, 'plain text');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile dispatch: unsupported kind -> { error: "unsupported-kind" }', async () => {
  const out = await extractFile({ kind: 'zip', path: '/dev/null' });
  assert.equal(out.error, 'unsupported-kind');
});

test('extractPdf: returns graceful { error } when pdf-parse not installed', async () => {
  // pdf-parse is NOT in package.json — this is the expected runtime path.
  const dir = fresh();
  try {
    const p = join(dir, 'doc.pdf');
    writeFileSync(p, '%PDF-fake\n');
    const out = await extractFile({ kind: 'pdf', path: p });
    assert.equal(out.error, 'pdf-parse-not-installed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
