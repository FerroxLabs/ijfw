// IJFW v1.5.0 M1.2 -- unit tests for the pure parseObsidian function.
// Integration with the db (M1.3) is covered by test-obsidian-indexing.js;
// this file pins the parser's structural guarantees in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObsidian } from './src/memory/obsidian-parser.js';

test('parses wikilinks (lowercase + dash-collapse target)', () => {
  const out = parseObsidian('See [[v150-brief]] and [[Memory Field Comparison]].');
  assert.deepEqual(out.links.map((l) => l.target), [
    'v150-brief',
    'memory-field-comparison',
  ]);
});

test('parses nested tags with depth', () => {
  const out = parseObsidian('Tagged #project/r17/audit and #ship.');
  const paths = out.tags.map((t) => t.path);
  assert.ok(paths.includes('project/r17/audit'));
  assert.ok(paths.includes('ship'));
  const audit = out.tags.find((t) => t.path === 'project/r17/audit');
  assert.equal(audit.depth, 3);
  const ship = out.tags.find((t) => t.path === 'ship');
  assert.equal(ship.depth, 1);
});

test('parses inline meta [key:: value] (Dataview style)', () => {
  const out = parseObsidian('Owner is [author:: Sean] and [status:: shipped].');
  assert.deepEqual(out.meta, [
    { key: 'author', value: 'Sean' },
    { key: 'status', value: 'shipped' },
  ]);
});

test('ignores wikilinks inside triple-backtick code fences', () => {
  const src = ['```', 'See [[no-link]]', '```', 'Real [[link]] here.'].join('\n');
  const out = parseObsidian(src);
  assert.deepEqual(out.links.map((l) => l.target), ['link']);
});

test('ignores tags inside inline code spans', () => {
  const out = parseObsidian('Real #ship but `#fake-tag-in-code` ignored.');
  const paths = out.tags.map((t) => t.path);
  assert.ok(paths.includes('ship'));
  assert.ok(!paths.includes('fake-tag-in-code'));
});

test('returns empty arrays for empty / non-string input', () => {
  assert.deepEqual(parseObsidian(''), { links: [], tags: [], meta: [] });
  assert.deepEqual(parseObsidian(null), { links: [], tags: [], meta: [] });
  assert.deepEqual(parseObsidian(undefined), { links: [], tags: [], meta: [] });
});
