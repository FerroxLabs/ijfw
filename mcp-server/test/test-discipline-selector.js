/**
 * test-discipline-selector.js -- unit tests for discipline-selector.js
 *
 * Run: cd mcp-server && node --test test/test-discipline-selector.js
 *
 * Coverage:
 *   selectDisciplineTemplate -- null/undefined throws, unknown/mixed empty,
 *     unrecognized-string empty, code returns content, missing template throws,
 *     all 5 typed codes either return content or skip gracefully when absent.
 *   detectProjectTypeFromRepo -- brief.md frontmatter wins, each file-signal
 *     tier (code/narrative/business/design/research), unknown fallback.
 *
 * Template-absent strategy: if the template file does not exist on disk (Track
 * 5B-A may not have landed yet), the typed-code test is skipped with a TODO
 * marker via test({ skip: ... }). This keeps the build green across all
 * landing orders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  selectDisciplineTemplate,
  detectProjectTypeFromRepo,
} from '../src/orchestrator/discipline-selector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory with a unique suffix. */
function makeTmpDir(suffix) {
  const dir = join(tmpdir(), `ijfw-sel-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve path to the templates dir (same anchor as the module under test). */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(
  __dirname, '..', 'src', '..', '..', 'claude', 'skills', 'ijfw-agents-md', 'templates',
);

function templateExists(type) {
  return existsSync(join(TEMPLATES_DIR, `discipline-${type}.md`));
}

// ---------------------------------------------------------------------------
// selectDisciplineTemplate tests
// ---------------------------------------------------------------------------

test('selectDisciplineTemplate: throws TypeError on null', () => {
  assert.throws(
    () => selectDisciplineTemplate(null),
    TypeError,
  );
});

test('selectDisciplineTemplate: throws TypeError on undefined', () => {
  assert.throws(
    () => selectDisciplineTemplate(undefined),
    TypeError,
  );
});

test('selectDisciplineTemplate: returns IJFW hint body for "unknown"', () => {
  // Wave 5B L3-03/L3-04: previously returned empty string; now returns an
  // HTML-comment hint documenting how to activate domain-specific rules.
  const result = selectDisciplineTemplate('unknown');
  assert.ok(result.includes('IJFW: project type is "unknown"'));
});

test('selectDisciplineTemplate: returns IJFW hint body for "mixed"', () => {
  const result = selectDisciplineTemplate('mixed');
  assert.ok(result.includes('IJFW: project type is "mixed"'));
});

test('selectDisciplineTemplate: unrecognized type string collapses to "unknown" hint', () => {
  const result = selectDisciplineTemplate('fantasy-novel-generator');
  assert.ok(result.includes('IJFW: project type is "unknown"'));
});

test('selectDisciplineTemplate: "code" returns non-empty string when template present', {
  skip: !templateExists('code') ? 'discipline-code.md not yet on disk (Track 5B-A pending)' : false,
}, () => {
  const result = selectDisciplineTemplate('code');
  assert.ok(typeof result === 'string' && result.length > 0,
    'expected non-empty string for code template');
});

test('selectDisciplineTemplate: "narrative" returns non-empty string when template present', {
  skip: !templateExists('narrative') ? 'discipline-narrative.md not yet on disk (Track 5B-A pending)' : false,
}, () => {
  const result = selectDisciplineTemplate('narrative');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('selectDisciplineTemplate: "business" returns non-empty string when template present', {
  skip: !templateExists('business') ? 'discipline-business.md not yet on disk (Track 5B-A pending)' : false,
}, () => {
  const result = selectDisciplineTemplate('business');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('selectDisciplineTemplate: "design" returns non-empty string when template present', {
  skip: !templateExists('design') ? 'discipline-design.md not yet on disk (Track 5B-A pending)' : false,
}, () => {
  const result = selectDisciplineTemplate('design');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('selectDisciplineTemplate: "research" returns non-empty string when template present', {
  skip: !templateExists('research') ? 'discipline-research.md not yet on disk (Track 5B-A pending)' : false,
}, () => {
  const result = selectDisciplineTemplate('research');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('selectDisciplineTemplate: throws Error when typed template file is absent', () => {
  // W3 D1 / L2-04 closeout: selectDisciplineTemplate now accepts an
  // opts.templatesDir injection point so this test can exercise the
  // missing-file Error path. Point templatesDir at an empty temp dir; a
  // typed (TYPED_CODES) projectType then reaches the existsSync check and
  // throws Error -- the documented contract.
  const emptyTemplatesDir = makeTmpDir('empty-templates');
  assert.throws(
    () => selectDisciplineTemplate('code', { templatesDir: emptyTemplatesDir }),
    (err) => err instanceof Error
      && !(err instanceof TypeError)
      && /template file missing/i.test(err.message),
  );
});

test('selectDisciplineTemplate: throws TypeError on non-string projectType', () => {
  assert.throws(() => selectDisciplineTemplate(42), TypeError);
  assert.throws(() => selectDisciplineTemplate({}), TypeError);
  assert.throws(() => selectDisciplineTemplate([]), TypeError);
  assert.throws(() => selectDisciplineTemplate(true), TypeError);
});

test('selectDisciplineTemplate: unknown returns IJFW hint with correction path', () => {
  const body = selectDisciplineTemplate('unknown');
  assert.ok(body.includes('IJFW: project type is "unknown"'));
  assert.ok(body.includes('.ijfw/memory/brief.md'));
  assert.ok(body.includes('brainstorm-LOCK'));
});

test('selectDisciplineTemplate: mixed returns IJFW hint labelled "mixed"', () => {
  const body = selectDisciplineTemplate('mixed');
  assert.ok(body.includes('IJFW: project type is "mixed"'));
  assert.ok(body.includes('.ijfw/memory/brief.md'));
});

test('selectDisciplineTemplate: garbage type collapses to "unknown" label in hint', () => {
  const body = selectDisciplineTemplate('xyz123-not-a-real-type');
  assert.ok(body.includes('IJFW: project type is "unknown"'));
});

// ---------------------------------------------------------------------------
// detectProjectTypeFromRepo tests
// ---------------------------------------------------------------------------

test('detectProjectTypeFromRepo: returns "unknown" for empty directory', () => {
  const dir = makeTmpDir('empty');
  assert.equal(detectProjectTypeFromRepo(dir), 'unknown');
});

test('detectProjectTypeFromRepo: returns "unknown" for non-string input', () => {
  assert.equal(detectProjectTypeFromRepo(null), 'unknown');
  assert.equal(detectProjectTypeFromRepo(42), 'unknown');
  assert.equal(detectProjectTypeFromRepo(''), 'unknown');
});

test('detectProjectTypeFromRepo: brief.md frontmatter type wins over file signals', () => {
  const dir = makeTmpDir('brief-wins');
  // Plant a package.json (code signal) AND a brief.md that says narrative
  writeFileSync(join(dir, 'package.json'), '{}');
  const briefDir = join(dir, '.ijfw', 'memory');
  mkdirSync(briefDir, { recursive: true });
  writeFileSync(join(briefDir, 'brief.md'), '---\ntitle: My Novel\ntype: narrative\n---\n\nBody here.\n');
  assert.equal(detectProjectTypeFromRepo(dir), 'narrative');
});

test('detectProjectTypeFromRepo: brief.md without type key falls through to file signals', () => {
  const dir = makeTmpDir('brief-no-type');
  writeFileSync(join(dir, 'Cargo.toml'), '[package]');
  const briefDir = join(dir, '.ijfw', 'memory');
  mkdirSync(briefDir, { recursive: true });
  writeFileSync(join(briefDir, 'brief.md'), '---\ntitle: No Type Here\n---\n');
  assert.equal(detectProjectTypeFromRepo(dir), 'code');
});

test('detectProjectTypeFromRepo: package.json -> code', () => {
  const dir = makeTmpDir('pkg-json');
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.equal(detectProjectTypeFromRepo(dir), 'code');
});

test('detectProjectTypeFromRepo: Cargo.toml -> code', () => {
  const dir = makeTmpDir('cargo');
  writeFileSync(join(dir, 'Cargo.toml'), '[package]');
  assert.equal(detectProjectTypeFromRepo(dir), 'code');
});

test('detectProjectTypeFromRepo: go.mod -> code', () => {
  const dir = makeTmpDir('gomod');
  writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\n');
  assert.equal(detectProjectTypeFromRepo(dir), 'code');
});

test('detectProjectTypeFromRepo: *.csproj entry -> code', () => {
  const dir = makeTmpDir('csproj');
  writeFileSync(join(dir, 'MyApp.csproj'), '<Project/>');
  assert.equal(detectProjectTypeFromRepo(dir), 'code');
});

test('detectProjectTypeFromRepo: chapters/ dir with .md -> narrative', () => {
  const dir = makeTmpDir('chapters');
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  writeFileSync(join(dir, 'chapters', 'chapter1.md'), '# Chapter 1\n');
  assert.equal(detectProjectTypeFromRepo(dir), 'narrative');
});

test('detectProjectTypeFromRepo: manuscript/ dir with .md -> narrative', () => {
  const dir = makeTmpDir('manuscript');
  mkdirSync(join(dir, 'manuscript'), { recursive: true });
  writeFileSync(join(dir, 'manuscript', 'draft.md'), '# Draft\n');
  assert.equal(detectProjectTypeFromRepo(dir), 'narrative');
});

test('detectProjectTypeFromRepo: pitch-deck file -> business', () => {
  const dir = makeTmpDir('pitch-deck');
  writeFileSync(join(dir, 'pitch-deck-v2.pdf'), '');
  assert.equal(detectProjectTypeFromRepo(dir), 'business');
});

test('detectProjectTypeFromRepo: business-plan file -> business', () => {
  const dir = makeTmpDir('biz-plan');
  writeFileSync(join(dir, 'business-plan-2026.docx'), '');
  assert.equal(detectProjectTypeFromRepo(dir), 'business');
});

test('detectProjectTypeFromRepo: *.numbers file -> business', () => {
  const dir = makeTmpDir('numbers');
  writeFileSync(join(dir, 'forecast.numbers'), '');
  assert.equal(detectProjectTypeFromRepo(dir), 'business');
});

test('detectProjectTypeFromRepo: figma-* file -> design', () => {
  const dir = makeTmpDir('figma');
  writeFileSync(join(dir, 'figma-export.json'), '{}');
  assert.equal(detectProjectTypeFromRepo(dir), 'design');
});

test('detectProjectTypeFromRepo: *.sketch file -> design', () => {
  const dir = makeTmpDir('sketch');
  writeFileSync(join(dir, 'ui.sketch'), '');
  assert.equal(detectProjectTypeFromRepo(dir), 'design');
});

test('detectProjectTypeFromRepo: design-system/ dir -> design', () => {
  const dir = makeTmpDir('design-system');
  mkdirSync(join(dir, 'design-system'), { recursive: true });
  assert.equal(detectProjectTypeFromRepo(dir), 'design');
});

test('detectProjectTypeFromRepo: research/ dir -> research', () => {
  const dir = makeTmpDir('research');
  mkdirSync(join(dir, 'research'), { recursive: true });
  assert.equal(detectProjectTypeFromRepo(dir), 'research');
});

test('detectProjectTypeFromRepo: notebooks/ dir -> research', () => {
  const dir = makeTmpDir('notebooks');
  mkdirSync(join(dir, 'notebooks'), { recursive: true });
  assert.equal(detectProjectTypeFromRepo(dir), 'research');
});

test('detectProjectTypeFromRepo: *.ipynb file -> research', () => {
  const dir = makeTmpDir('ipynb');
  writeFileSync(join(dir, 'analysis.ipynb'), '{}');
  assert.equal(detectProjectTypeFromRepo(dir), 'research');
});
