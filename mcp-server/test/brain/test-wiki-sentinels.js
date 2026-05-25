import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSections, replaceSection } from '../../src/brain/wiki-sentinels.js';

test('extractSections: finds named auto regions', () => {
  const md = `# Header
<!-- ijfw:auto:begin section="current-state" -->
- fact one
<!-- ijfw:auto:end section="current-state" -->

# Notes
operator wrote this

<!-- ijfw:auto:begin section="backlinks" -->
- [[a]] (3 links)
<!-- ijfw:auto:end section="backlinks" -->`;
  const s = extractSections(md);
  assert.equal(s.length, 2);
  assert.equal(s[0].name, 'current-state');
  assert.ok(s[0].body.includes('fact one'));
  assert.equal(s[1].name, 'backlinks');
});

test('extractSections: empty input -> []', () => {
  assert.deepEqual(extractSections(''), []);
});

test('replaceSection: swaps named region, preserves NOTES verbatim', () => {
  const md = `# Title

<!-- ijfw:auto:begin section="current-state" -->
OLD content
<!-- ijfw:auto:end section="current-state" -->

# Operator notes
this is operator-owned text that must survive [important] verbatim.

<!-- ijfw:auto:begin section="history" -->
old history
<!-- ijfw:auto:end section="history" -->`;
  const out = replaceSection(md, 'current-state', 'NEW content');
  assert.ok(out.includes('NEW content'));
  assert.ok(!out.includes('OLD content'));
  assert.ok(out.includes('operator-owned text that must survive [important] verbatim'));
  assert.ok(out.includes('old history'), 'other auto sections preserved');
});

test('replaceSection: creates region when absent', () => {
  const md = `# Title\n\noperator content\n`;
  const out = replaceSection(md, 'current-state', 'fresh');
  assert.ok(out.includes('<!-- ijfw:auto:begin section="current-state" -->'));
  assert.ok(out.includes('fresh'));
  assert.ok(out.includes('<!-- ijfw:auto:end section="current-state" -->'));
  assert.ok(out.includes('operator content'), 'existing content preserved');
});

test('replaceSection: empty source string creates region cleanly', () => {
  const out = replaceSection('', 'a', 'b');
  assert.ok(out.includes('section="a"'));
  assert.ok(out.includes('\nb\n'));
});

test('replaceSection: section names with regex-special chars handled safely', () => {
  const md = '<!-- ijfw:auto:begin section="a.b+c" -->\nold\n<!-- ijfw:auto:end section="a.b+c" -->';
  const out = replaceSection(md, 'a.b+c', 'NEW');
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('old'));
});
