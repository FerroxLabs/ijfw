import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate, _renderCurrentState, _renderHistory, _renderBacklinks, _renderSources } from '../../src/brain/wiki-templates.js';

test('renderCurrentState: facts with ids include cites', () => {
  const out = _renderCurrentState({
    subject: 'sean',
    facts: [
      { id: 11, predicate: 'role', object: 'founder', memory_id: 5 },
      { id: 12, predicate: 'works-at', object: 'foundry', memory_id: 6 },
    ],
  });
  assert.ok(out.includes('[fact:11]'));
  assert.ok(out.includes('[mem:5]'));
  assert.ok(out.includes('**founder**'));
});

test('renderCurrentState: no facts -> placeholder', () => {
  const out = _renderCurrentState({ subject: 'unknown', facts: [] });
  assert.ok(out.includes('unknown'));
  assert.ok(out.includes('No facts'));
});

test('renderHistory: appends Older rollup when present', () => {
  const out = _renderHistory({
    history: {
      rows: [
        { id: 1, predicate: 'role', object: 'A', valid_from: '2024-01-15T00:00:00Z', memory_id: 10 },
      ],
      older: { count: 55, fromIso: '2023-01-01T00:00:00Z', toIso: '2023-12-31T00:00:00Z' },
    },
  });
  assert.ok(out.includes('2024-01-15'));
  assert.ok(out.includes('[fact:1]'));
  assert.ok(out.includes('Older: 55 events'));
  assert.ok(out.includes('2023-01-01'));
  assert.ok(out.includes('2023-12-31'));
});

test('renderHistory: empty rows -> placeholder', () => {
  const out = _renderHistory({ history: { rows: [], older: null } });
  assert.ok(out.includes('No history'));
});

test('renderBacklinks: counts pluralize correctly', () => {
  const out = _renderBacklinks({
    backlinks: [
      { target: 'foo', count: 1 },
      { target: 'bar', count: 3 },
    ],
  });
  assert.ok(out.includes('[[foo]] (1 link)'));
  assert.ok(out.includes('[[bar]] (3 links)'));
});

test('renderSources: takes top-5 only', () => {
  const out = _renderSources({
    sources: Array.from({ length: 8 }, (_, i) => ({ path: `/p/${i}.md`, kind: 'markdown', mentions: 10 - i })),
  });
  const lines = out.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes('/p/0.md'));
});

test('applyTemplate: returns markdown with 4 auto sentinel regions + cites + wikilinks', () => {
  const data = {
    subject: 'sean',
    facts: [{ id: 11, predicate: 'role', object: 'founder', memory_id: 5 }],
    history: { rows: [{ id: 11, predicate: 'role', object: 'founder', valid_from: '2024-01-01T00:00:00Z', memory_id: 5 }], older: null },
    backlinks: [{ target: 'ijfw', count: 2 }],
    sources: [{ path: '/notes/a.md', kind: 'markdown', mentions: 4 }],
  };
  const out = applyTemplate('entity', '', data);
  assert.ok(out.includes('section="current-state"'));
  assert.ok(out.includes('section="history"'));
  assert.ok(out.includes('section="backlinks"'));
  assert.ok(out.includes('section="sources"'));
  assert.ok(out.includes('[fact:11]'));
  assert.ok(out.includes('[mem:5]'));
  assert.ok(out.includes('[[ijfw]]'));
});

test('applyTemplate: preserves NOTES between AUTO regions', () => {
  const existing = `# sean

<!-- ijfw:auto:begin section="current-state" -->
OLD
<!-- ijfw:auto:end section="current-state" -->

## Operator notes
hand-written context that MUST survive.

<!-- ijfw:auto:begin section="history" -->
old-history
<!-- ijfw:auto:end section="history" -->`;
  const out = applyTemplate('entity', existing, {
    subject: 'sean',
    facts: [{ id: 1, predicate: 'p', object: 'NEW' }],
    history: { rows: [], older: null },
    backlinks: [],
    sources: [],
  });
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('OLD'));
  assert.ok(out.includes('hand-written context that MUST survive'));
});
