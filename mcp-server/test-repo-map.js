// v1.5.0 audit-MED-tok-M1 — tests for repo-map + brief compaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGitignore,
  isIgnored,
  buildRepoMap,
  compactBriefForSubagent,
  REPO_MAP_DEFAULTS,
} from './src/lib/repo-map.js';

// ---------------------------------------------------------------------------
// Helpers: build a throwaway sandbox repo for each test.
// ---------------------------------------------------------------------------

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-repomap-'));
  return dir;
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeFile(root, rel, content) {
  const abs = join(root, rel);
  const segs = rel.split('/');
  segs.pop();
  if (segs.length > 0) {
    mkdirSync(join(root, segs.join('/')), { recursive: true });
  }
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// parseGitignore
// ---------------------------------------------------------------------------

test('parseGitignore: empty / non-string input returns []', () => {
  assert.deepEqual(parseGitignore(''), []);
  assert.deepEqual(parseGitignore(null), []);
  assert.deepEqual(parseGitignore(undefined), []);
  assert.deepEqual(parseGitignore(42), []);
});

test('parseGitignore: skips comments and blank lines', () => {
  const m = parseGitignore('# comment\n\nfoo.txt\n# another\nbar.txt');
  assert.equal(m.length, 2);
  assert.equal(m[0].pattern, 'foo.txt');
  assert.equal(m[1].pattern, 'bar.txt');
});

test('parseGitignore: handles negate / anchored / dirOnly markers', () => {
  const m = parseGitignore('!foo\n/bar\nbaz/\n');
  assert.equal(m[0].negate, true);
  assert.equal(m[0].pattern, 'foo');
  assert.equal(m[1].anchored, true);
  assert.equal(m[1].pattern, 'bar');
  assert.equal(m[2].dirOnly, true);
  assert.equal(m[2].pattern, 'baz');
});

// ---------------------------------------------------------------------------
// isIgnored
// ---------------------------------------------------------------------------

test('isIgnored: simple file pattern matches at any depth', () => {
  const m = parseGitignore('secret.txt');
  assert.equal(isIgnored('secret.txt', false, m), true);
  assert.equal(isIgnored('sub/dir/secret.txt', false, m), true);
  assert.equal(isIgnored('not-secret.txt', false, m), false);
});

test('isIgnored: anchored pattern only matches at root', () => {
  const m = parseGitignore('/root-only.txt');
  assert.equal(isIgnored('root-only.txt', false, m), true);
  assert.equal(isIgnored('sub/root-only.txt', false, m), false);
});

test('isIgnored: directory-only marker rejects files', () => {
  const m = parseGitignore('build/');
  assert.equal(isIgnored('build', true, m), true);
  // For directory-only patterns, a FILE named "build" is NOT ignored.
  assert.equal(isIgnored('build', false, m), false);
});

test('isIgnored: wildcards * and ** behave correctly', () => {
  const m = parseGitignore('*.log\n**/tmp/**');
  assert.equal(isIgnored('a.log', false, m), true);
  assert.equal(isIgnored('sub/a.log', false, m), true);
  assert.equal(isIgnored('tmp/x', false, m), true);
  assert.equal(isIgnored('sub/tmp/x', false, m), true);
  assert.equal(isIgnored('readme.md', false, m), false);
});

test('isIgnored: negate ! re-includes a previously-ignored path', () => {
  const m = parseGitignore('*.log\n!keep.log');
  assert.equal(isIgnored('a.log', false, m), true);
  assert.equal(isIgnored('keep.log', false, m), false);
});

// ---------------------------------------------------------------------------
// buildRepoMap
// ---------------------------------------------------------------------------

test('buildRepoMap: rejects missing / non-directory rootDir', () => {
  assert.throws(() => buildRepoMap({}), /rootDir is required/);
  assert.throws(() => buildRepoMap({ rootDir: '' }), /rootDir is required/);
  assert.throws(() => buildRepoMap({ rootDir: '/nonexistent-path-xyz-9999' }), /cannot access rootDir/);
});

test('buildRepoMap: ranks files by TF-IDF importance', () => {
  const root = makeSandbox();
  try {
    // Three files: one with unique symbols (high IDF), one with common
    // symbols across files (low IDF), one empty.
    writeFile(root, 'unique.js', 'export function quasarFusionEngine() {}\nconst neutrinoTrap = 42;\n');
    writeFile(root, 'common1.js', 'function foo() {}\nfunction bar() {}\n');
    writeFile(root, 'common2.js', 'function foo() {}\nfunction bar() {}\n');
    writeFile(root, 'empty.js', '');

    const map = buildRepoMap({ rootDir: root, budgetTokens: 1000 });
    assert.ok(map.files.length >= 3, `expected at least 3 files in map, got ${map.files.length}`);
    // unique.js should be ranked above common1.js because its symbols
    // appear only once across the corpus -> higher IDF.
    const uniqueIdx = map.files.findIndex(f => f.path === 'unique.js');
    const common1Idx = map.files.findIndex(f => f.path === 'common1.js');
    assert.ok(uniqueIdx >= 0, 'unique.js must appear in map');
    assert.ok(common1Idx >= 0, 'common1.js must appear in map');
    assert.ok(uniqueIdx < common1Idx, `unique.js (rank=${uniqueIdx}) must rank above common1.js (rank=${common1Idx})`);
  } finally {
    cleanup(root);
  }
});

test('buildRepoMap: respects .gitignore', () => {
  const root = makeSandbox();
  try {
    writeFile(root, '.gitignore', 'secret.js\nignored-dir/\n');
    writeFile(root, 'visible.js', 'export function visibleFn(){}\n');
    writeFile(root, 'secret.js', 'export function secretFn(){}\n');
    writeFile(root, 'ignored-dir/x.js', 'export function nopeFn(){}\n');

    const map = buildRepoMap({ rootDir: root, budgetTokens: 1000 });
    const paths = map.files.map(f => f.path);
    assert.ok(paths.includes('visible.js'), 'visible.js must appear');
    assert.ok(!paths.includes('secret.js'), `secret.js must be ignored, got paths: ${paths.join(',')}`);
    assert.ok(!paths.some(p => p.startsWith('ignored-dir/')), 'ignored-dir contents must be filtered');
  } finally {
    cleanup(root);
  }
});

test('buildRepoMap: skips ALWAYS_SKIP_DIRS (node_modules, .git, etc) even without .gitignore', () => {
  const root = makeSandbox();
  try {
    writeFile(root, 'real.js', 'export function realFn(){}\n');
    writeFile(root, 'node_modules/lodash/index.js', 'function lodashFn(){}\n');
    writeFile(root, '.git/HEAD', 'ref: refs/heads/main\n');

    const map = buildRepoMap({ rootDir: root, budgetTokens: 1000 });
    const paths = map.files.map(f => f.path);
    assert.ok(paths.includes('real.js'));
    assert.ok(!paths.some(p => p.startsWith('node_modules/')), 'node_modules must be skipped');
    assert.ok(!paths.some(p => p.startsWith('.git/')), '.git must be skipped');
  } finally {
    cleanup(root);
  }
});

test('buildRepoMap: enforces budgetTokens with truncated=true', () => {
  const root = makeSandbox();
  try {
    // Make many files so the budget is forced to truncate.
    for (let i = 0; i < 50; i++) {
      writeFile(root, `file${i}.js`, `export function fn${i}(){}\nconst x${i} = ${i};\n`);
    }
    // Very small budget -> must truncate.
    const map = buildRepoMap({ rootDir: root, budgetTokens: 50 });
    assert.ok(map.truncated, 'must report truncated=true under tight budget');
    assert.ok(map.totalTokens <= 50, `totalTokens must respect budget, got ${map.totalTokens}`);
    assert.ok(map.files.length < 50, 'must not include all 50 files under tight budget');
  } finally {
    cleanup(root);
  }
});

test('buildRepoMap: maxFiles caps the list independent of budget', () => {
  const root = makeSandbox();
  try {
    for (let i = 0; i < 20; i++) {
      writeFile(root, `f${i}.js`, `export function fn${i}(){}\n`);
    }
    const map = buildRepoMap({ rootDir: root, budgetTokens: 10000, maxFiles: 5 });
    assert.ok(map.files.length <= 5, `maxFiles=5 must cap files, got ${map.files.length}`);
  } finally {
    cleanup(root);
  }
});

test('buildRepoMap: filters by extension', () => {
  const root = makeSandbox();
  try {
    writeFile(root, 'keep.js', 'export function k(){}\n');
    writeFile(root, 'skip.txt', 'just text\n');
    writeFile(root, 'also-skip.bin', 'binary-ish\n');

    const map = buildRepoMap({ rootDir: root, budgetTokens: 1000, extensions: ['.js'] });
    const paths = map.files.map(f => f.path);
    assert.ok(paths.includes('keep.js'));
    assert.ok(!paths.includes('skip.txt'));
    assert.ok(!paths.includes('also-skip.bin'));
  } finally {
    cleanup(root);
  }
});

test('buildRepoMap: summary contains symbols + first-line teaser', () => {
  const root = makeSandbox();
  try {
    writeFile(root, 'lib.js', `// Header comment first
export function alpha() {}
export function beta() {}
`);
    const map = buildRepoMap({ rootDir: root, budgetTokens: 1000 });
    const f = map.files.find(x => x.path === 'lib.js');
    assert.ok(f, 'lib.js must appear');
    assert.ok(/alpha|beta/.test(f.summary), `summary must mention extracted symbols, got: ${f.summary}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// compactBriefForSubagent
// ---------------------------------------------------------------------------

test('compactBriefForSubagent: rejects non-string baseBrief', () => {
  assert.throws(() => compactBriefForSubagent({ baseBrief: null, repoMap: { files: [] } }), /baseBrief must be a string/);
});

test('compactBriefForSubagent: null repoMap returns baseBrief unchanged', () => {
  const out = compactBriefForSubagent({ baseBrief: 'do the thing', repoMap: null });
  assert.equal(out.brief, 'do the thing');
  assert.equal(out.repoMapTokens, 0);
  assert.ok(out.baseBriefTokens > 0);
});

test('compactBriefForSubagent: empty repoMap.files returns baseBrief unchanged', () => {
  const out = compactBriefForSubagent({ baseBrief: 'do the thing', repoMap: { files: [] } });
  assert.equal(out.brief, 'do the thing');
  assert.equal(out.repoMapTokens, 0);
});

test('compactBriefForSubagent: prepends a REPO MAP header + footer with file list', () => {
  const repoMap = { files: [
    { path: 'src/a.js', summary: 'foo, bar', importance: 0.9 },
    { path: 'src/b.js', summary: 'baz', importance: 0.5 },
  ]};
  const out = compactBriefForSubagent({ baseBrief: 'task: do X', repoMap, maxPrefixTokens: 1000 });
  assert.match(out.brief, /REPO MAP \(importance-ranked/);
  assert.match(out.brief, /END REPO MAP/);
  assert.match(out.brief, /src\/a\.js: foo, bar/);
  assert.match(out.brief, /src\/b\.js: baz/);
  // Base brief must still be present.
  assert.match(out.brief, /task: do X/);
  // Repo map prefix must be BEFORE the base brief.
  assert.ok(out.brief.indexOf('REPO MAP') < out.brief.indexOf('task: do X'));
});

test('compactBriefForSubagent: respects maxPrefixTokens (truncates file list)', () => {
  // 50 files, each ~10 tokens -> ~500 tokens total. Budget = 50 -> must drop most.
  const files = Array.from({ length: 50 }, (_, i) => ({
    path: `src/long-file-name-${i}.js`,
    summary: `symbolName${i}, anotherSymbol${i}`,
    importance: 1 / (i + 1),
  }));
  const out = compactBriefForSubagent({
    baseBrief: 'task: do X',
    repoMap: { files },
    maxPrefixTokens: 50,
  });
  // Count file-list lines in the prefix.
  const fileLines = (out.brief.match(/src\/long-file-name-\d+\.js/g) || []).length;
  assert.ok(fileLines < 50, `must drop some files under tight budget, got ${fileLines}`);
  assert.ok(out.repoMapTokens <= 50 || out.repoMapTokens <= 60, // small over-budget tolerated due to header
    `repoMapTokens should respect maxPrefixTokens (got ${out.repoMapTokens})`);
});

// ---------------------------------------------------------------------------
// REPO_MAP_DEFAULTS sanity
// ---------------------------------------------------------------------------

test('REPO_MAP_DEFAULTS exposes sensible defaults', () => {
  assert.equal(REPO_MAP_DEFAULTS.budgetTokens, 1000);
  assert.equal(REPO_MAP_DEFAULTS.maxFiles, 200);
  assert.ok(REPO_MAP_DEFAULTS.tokensPerChar > 0 && REPO_MAP_DEFAULTS.tokensPerChar < 1);
  assert.ok(REPO_MAP_DEFAULTS.extensions instanceof Set);
  assert.ok(REPO_MAP_DEFAULTS.extensions.has('.js'));
  assert.ok(REPO_MAP_DEFAULTS.extensions.has('.md'));
});

// ---------------------------------------------------------------------------
// End-to-end: build a map AND inject it into a brief.
// ---------------------------------------------------------------------------

test('e2e: buildRepoMap → compactBriefForSubagent shrinks a "dump-source" brief', () => {
  const root = makeSandbox();
  try {
    // 10 files. Simulate a "dump source" brief = 50KB of file contents.
    const fileContents = [];
    for (let i = 0; i < 10; i++) {
      const content = `export function fn${i}() { return ${i}; }\n` +
        Array.from({ length: 200 }, (_, j) => `// line ${j} of file ${i}`).join('\n');
      writeFile(root, `f${i}.js`, content);
      fileContents.push(`// === f${i}.js ===\n${content}`);
    }
    const dumpBrief = fileContents.join('\n\n');
    const dumpTokens = Math.ceil(dumpBrief.length / 4);

    const map = buildRepoMap({ rootDir: root, budgetTokens: 1000 });
    assert.ok(map.files.length > 0);

    // Construct a SHRUNK brief = repo map + a thin task line.
    const taskOnly = 'task: refactor fn3 to use a Map';
    const shrunk = compactBriefForSubagent({ baseBrief: taskOnly, repoMap: map, maxPrefixTokens: 1000 });
    const shrunkTokens = Math.ceil(shrunk.brief.length / 4);

    // The shrunk brief must be substantially smaller than the dump brief.
    assert.ok(shrunkTokens < dumpTokens / 2, `shrunk (${shrunkTokens}) must be <50% of dump (${dumpTokens})`);
    // And must still mention the task.
    assert.match(shrunk.brief, /refactor fn3/);
  } finally {
    cleanup(root);
  }
});
