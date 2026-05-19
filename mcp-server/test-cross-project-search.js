import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCorpus,
  crossProjectSearch,
  aggregatePortfolioFindings,
  _resetSkipLog,
  _resetCorpusCache,
} from './src/cross-project-search.js';

// --- Shared fixture: spin up real project dirs in tmp so realpathSync passes,
//     then point allowedRoots at the tmp parent so the containment check passes. ---
function makeProjectDirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-')));
  const alpha = join(root, 'alpha');
  const beta  = join(root, 'beta');
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta,  { recursive: true });
  return { root, alpha, beta };
}

function fakeReader(map) {
  return (path) => map[path] || { knowledge: '', journal: '', handoff: '' };
}

// --- Original 8 tests (migrated to real tmp paths so realpathSync resolves) ---

test('buildCorpus produces one doc per non-empty line, tagged with project', () => {
  const { root, alpha, beta } = makeProjectDirs();
  try {
    const PROJECTS = [{ path: alpha }, { path: beta }];
    const reader = fakeReader({
      [alpha]: { knowledge: 'alpha decision about caching\nsecond line', journal: '', handoff: '' },
      [beta]:  { knowledge: '', journal: 'beta journaling prompt caching', handoff: '' },
    });
    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(docs.length, 3);
    assert.equal(docs[0].meta.project, 'alpha');
    assert.equal(docs[0].meta.source, 'knowledge');
    assert.equal(docs[0].meta.lineNo, 1);
    assert.equal(docs[2].meta.project, 'beta');
    assert.equal(docs[2].meta.source, 'journal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCorpus skips empty/whitespace-only lines', () => {
  const { root, alpha, beta } = makeProjectDirs();
  try {
    const PROJECTS = [{ path: alpha }, { path: beta }];
    const reader = fakeReader({
      [alpha]: { knowledge: 'real line\n\n   \nmore content', journal: '', handoff: '' },
      [beta]:  { knowledge: '', journal: '', handoff: '' },
    });
    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(docs.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('crossProjectSearch ranks matching project first', () => {
  const { root, alpha, beta } = makeProjectDirs();
  try {
    const PROJECTS = [{ path: alpha }, { path: beta }];
    const reader = fakeReader({
      [alpha]: { knowledge: 'unrelated content about widgets', journal: '', handoff: '' },
      [beta]:  { knowledge: 'prompt caching halves API spend', journal: '', handoff: '' },
    });
    const results = crossProjectSearch('prompt caching', PROJECTS, reader, { allowedRoots: [root] });
    assert.ok(results.length > 0);
    assert.equal(results[0].project, 'beta');
    assert.match(results[0].content, /^\[project:beta\]/);
    assert.ok(results[0].score > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('crossProjectSearch respects limit option', () => {
  const { root, alpha, beta } = makeProjectDirs();
  try {
    const PROJECTS = [{ path: alpha }, { path: beta }];
    const bigText = Array.from({ length: 20 }, (_, i) => `line ${i} matches caching`).join('\n');
    const reader = fakeReader({
      [alpha]: { knowledge: bigText, journal: '', handoff: '' },
      [beta]:  { knowledge: '', journal: '', handoff: '' },
    });
    const results = crossProjectSearch('caching', PROJECTS, reader, { limit: 5, allowedRoots: [root] });
    assert.equal(results.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('crossProjectSearch returns [] on empty query or empty registry', () => {
  const { root, alpha, beta } = makeProjectDirs();
  try {
    const PROJECTS = [{ path: alpha }, { path: beta }];
    const reader = fakeReader({});
    assert.deepEqual(crossProjectSearch('', PROJECTS, reader, { allowedRoots: [root] }), []);
    assert.deepEqual(crossProjectSearch('caching', [], reader, { allowedRoots: [root] }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregatePortfolioFindings renders summary table + per-project sections', () => {
  const md = aggregatePortfolioFindings([
    { project: 'alpha', path: '/a', status: 'ok',      findings: 'HIGH: null deref in parser.js:42\nMED: unused import' },
    { project: 'beta',  path: '/b', status: 'failed',  findings: '', error: 'ijfw not installed' },
    { project: 'gamma', path: '/g', status: 'skipped', findings: '',  error: 'no audit rule match' },
  ], { rule: 'README.md', startedAt: '2026-04-15T03:00:00Z', finishedAt: '2026-04-15T03:02:00Z' });
  assert.match(md, /# Portfolio audit -- README\.md/);
  assert.match(md, /Projects audited: 1 \/ 3/);
  assert.match(md, /\| alpha \| ok \| HIGH: null deref/);
  assert.match(md, /\| beta \| failed \| ijfw not installed \|/);
  assert.match(md, /### alpha  \(\/a\)/);
  assert.match(md, /\*\*Error:\*\* ijfw not installed/);
});

test('aggregatePortfolioFindings handles empty results array', () => {
  const md = aggregatePortfolioFindings([], { rule: 'foo' });
  assert.match(md, /Projects audited: 0 \/ 0/);
  assert.match(md, /## Per-project findings/);
});

test('crossProjectSearch attaches line number and source to each hit', () => {
  const { root, alpha, beta } = makeProjectDirs();
  try {
    const PROJECTS = [{ path: alpha }, { path: beta }];
    const reader = fakeReader({
      [alpha]: {
        knowledge: 'irrelevant\nthe answer is 42 about caching',
        journal: '',
        handoff: '',
      },
      [beta]:  { knowledge: '', journal: '', handoff: '' },
    });
    const results = crossProjectSearch('caching 42', PROJECTS, reader, { allowedRoots: [root] });
    assert.ok(results.length > 0);
    assert.equal(results[0].line, 2);
    assert.equal(results[0].source, 'knowledge@alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- New tests for v1.5.0 audit-H3.4 (F-SEC-1): realpath + containment ---

test('F-SEC-1: symlink pointing outside allowedRoots is refused', () => {
  _resetSkipLog();
  // Capture stderr so the advisory doesn't pollute test output AND so we
  // can assert it fired.
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };

  // outside-root holds the real target; inside-root holds a symlink to it.
  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-outside-')));
  const insideRoot  = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-inside-')));
  try {
    const evilTarget = join(outsideRoot, 'evil-project');
    mkdirSync(evilTarget, { recursive: true });
    const linkPath = join(insideRoot, 'looks-innocent');
    symlinkSync(evilTarget, linkPath);

    const PROJECTS = [{ path: linkPath }];
    let readerCalled = false;
    const reader = (p) => { readerCalled = true; return { knowledge: 'should-not-see', journal: '', handoff: '' }; };

    // allowedRoots = insideRoot only; the symlink target escapes it.
    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [insideRoot] });
    assert.equal(docs.length, 0, 'symlink-escape entry must produce zero docs');
    assert.equal(readerCalled, false, 'reader must not run on a skipped entry');
    assert.ok(
      writes.some(w => w.includes('skipped registry entry') && w.includes('escapes-allowed-roots')),
      'expected stderr advisory for escapes-allowed-roots'
    );
  } finally {
    process.stderr.write = orig;
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(insideRoot,  { recursive: true, force: true });
  }
});

test('F-SEC-1: realpath outside allowedRoots is refused (direct path, no symlink)', () => {
  _resetSkipLog();
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;

  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-direct-out-')));
  const allowedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-allowed-')));
  try {
    const directOut = join(outsideRoot, 'project-x');
    mkdirSync(directOut, { recursive: true });

    const PROJECTS = [{ path: directOut }];
    const reader = () => { throw new Error('reader must not be called'); };

    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [allowedRoot] });
    assert.equal(docs.length, 0);
  } finally {
    process.stderr.write = orig;
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(allowedRoot, { recursive: true, force: true });
  }
});

test('F-SEC-1: realpath inside allowedRoots is accepted', () => {
  _resetSkipLog();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-accept-')));
  try {
    const good = join(root, 'good-project');
    mkdirSync(good, { recursive: true });

    const PROJECTS = [{ path: good }];
    const reader = fakeReader({
      [good]: { knowledge: 'legit content here', journal: '', handoff: '' },
    });
    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].meta.project, 'good-project');
    // canonical path is forwarded to the reader and stored in meta
    assert.equal(docs[0].meta.projectPath, good);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F-SEC-1: missing path is gracefully skipped (no throw)', () => {
  _resetSkipLog();
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-missing-')));
  try {
    const realProj = join(root, 'real');
    mkdirSync(realProj, { recursive: true });

    const PROJECTS = [
      { path: join(root, 'does-not-exist') },  // ENOENT
      { path: realProj },                       // valid
      { path: null },                           // not-a-string
      { path: undefined },                      // not-a-string
    ];
    const reader = fakeReader({
      [realProj]: { knowledge: 'survivor', journal: '', handoff: '' },
    });
    // Must not throw and must yield exactly the surviving project's doc.
    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].meta.project, 'real');
    assert.ok(
      writes.some(w => w.includes('realpath-failed')),
      'expected realpath-failed advisory for ENOENT entry'
    );
  } finally {
    process.stderr.write = orig;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F-SEC-1: same offender logged only once across multiple calls (Set dedup)', () => {
  _resetSkipLog();
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };

  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-dedup-out-')));
  const allowedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-dedup-allowed-')));
  try {
    const evil = join(outsideRoot, 'evil');
    mkdirSync(evil, { recursive: true });

    const PROJECTS = [{ path: evil }];
    const reader = () => { throw new Error('reader must not be called'); };

    // Three calls + a duplicate entry within one call = still one stderr line.
    buildCorpus(PROJECTS, reader, { allowedRoots: [allowedRoot] });
    buildCorpus(PROJECTS, reader, { allowedRoots: [allowedRoot] });
    buildCorpus([{ path: evil }, { path: evil }], reader, { allowedRoots: [allowedRoot] });

    const offenderHits = writes.filter(w =>
      w.includes('skipped registry entry') && w.includes(evil)
    );
    assert.equal(offenderHits.length, 1, `expected 1 stderr line, got ${offenderHits.length}: ${JSON.stringify(offenderHits)}`);
  } finally {
    process.stderr.write = orig;
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(allowedRoot, { recursive: true, force: true });
  }
});

test('F-SEC-1: reader receives canonical path, not raw symlink path', () => {
  _resetSkipLog();
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-cps-canonical-')));
  try {
    const real = join(root, 'real-project');
    mkdirSync(real, { recursive: true });
    const link = join(root, 'symlink-to-real');
    symlinkSync(real, link);

    const PROJECTS = [{ path: link }];
    let calledWith = null;
    const reader = (p) => { calledWith = p; return { knowledge: 'data', journal: '', handoff: '' }; };

    const docs = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(docs.length, 1);
    assert.equal(calledWith, real, 'reader must be invoked with the canonical (realpath) path');
    assert.equal(docs[0].meta.project, 'real-project', 'tag derives from canonical basename');
    assert.equal(docs[0].meta.projectPath, real);
  } finally {
    process.stderr.write = orig;
    rmSync(root, { recursive: true, force: true });
  }
});

// --- v1.5.0 audit MED #10: mtime-keyed corpus cache ---------------------

test('mtime cache: second buildCorpus call hits the cache (no second reader invocation)', () => {
  _resetCorpusCache();
  const { root, alpha } = makeProjectDirs();
  try {
    // Write the .ijfw/memory files so the signature can stat them.
    const memDir = join(alpha, '.ijfw', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'knowledge.md'), 'alpha decision about caching\n');

    let readerCalls = 0;
    const reader = () => { readerCalls++; return { knowledge: 'alpha decision about caching' }; };

    const PROJECTS = [{ path: alpha }];
    const first = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    const second = buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(readerCalls, 1, 'second call hits cache, reader not re-invoked');
    assert.deepEqual(first.length, second.length);
    assert.equal(first[0].id, second[0].id, 'cached docs equal first-call docs');
  } finally {
    _resetCorpusCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mtime cache: file modification busts the cache', () => {
  _resetCorpusCache();
  const { root, alpha } = makeProjectDirs();
  try {
    const memDir = join(alpha, '.ijfw', 'memory');
    mkdirSync(memDir, { recursive: true });
    const kbPath = join(memDir, 'knowledge.md');
    writeFileSync(kbPath, 'first version\n');

    let readerCalls = 0;
    const reader = () => { readerCalls++; return { knowledge: 'first version' }; };
    const PROJECTS = [{ path: alpha }];

    buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    // Bump mtime by writing different content. utimesSync would also work
    // but writing a real new size makes the signature shift more obviously.
    writeFileSync(kbPath, 'second version with more bytes\n');
    buildCorpus(PROJECTS, reader, { allowedRoots: [root] });
    assert.equal(readerCalls, 2, 'reader re-invoked after mtime change');
  } finally {
    _resetCorpusCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mtime cache: useCache=false bypasses the cache (consistency runs)', () => {
  _resetCorpusCache();
  const { root, alpha } = makeProjectDirs();
  try {
    const memDir = join(alpha, '.ijfw', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'knowledge.md'), 'alpha\n');

    let readerCalls = 0;
    const reader = () => { readerCalls++; return { knowledge: 'alpha' }; };
    const PROJECTS = [{ path: alpha }];

    buildCorpus(PROJECTS, reader, { allowedRoots: [root], useCache: false });
    buildCorpus(PROJECTS, reader, { allowedRoots: [root], useCache: false });
    assert.equal(readerCalls, 2, 'useCache=false invokes reader every time');
  } finally {
    _resetCorpusCache();
    rmSync(root, { recursive: true, force: true });
  }
});
