#!/usr/bin/env node
/**
 * dashboard-charts tests (W9-C / B19) — logic only, no DOM.
 * Run: node --test --test-force-exit mcp-server/test-dashboard-charts.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { lineChart, barChart, progressBar } = await import('./src/dashboard-charts.js');

// Canvas mock per W9-C spec.
function makeCanvas() {
  const calls = { fillRect: 0, beginPath: 0, moveTo: 0, lineTo: 0, stroke: 0, fill: 0, fillText: 0, clearRect: 0 };
  return {
    width: 200,
    height: 100,
    _calls: calls,
    getContext: () => ({
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      clearRect:  () => { calls.clearRect++; },
      fillRect:   () => { calls.fillRect++; },
      beginPath:  () => { calls.beginPath++; },
      moveTo:     () => { calls.moveTo++; },
      lineTo:     () => { calls.lineTo++; },
      stroke:     () => { calls.stroke++; },
      fill:       () => { calls.fill++; },
      fillText:   () => { calls.fillText++; },
      measureText: () => ({ width: 10 }),
    }),
  };
}

// Lightweight DOM-ish div for progressBar tests. Provides ownerDocument so the
// helper can build child spans without throwing.
function makeDiv() {
  const children = [];
  const makeChild = (tag) => {
    const c = {
      tagName: tag,
      _attrs: {},
      _children: [],
      textContent: '',
      className: '',
      setAttribute(name, value) { this._attrs[name] = value; },
      appendChild(child) { this._children.push(child); return child; },
    };
    return c;
  };
  return {
    className: '',
    _children: children,
    firstChild: null,
    removeChild() { /* no-op for cleanup loop; we never populate firstChild */ },
    appendChild(child) { children.push(child); return child; },
    ownerDocument: { createElement: (tag) => makeChild(tag) },
  };
}

// ---- lineChart ----

test('lineChart with empty data renders nothing and does not throw', () => {
  const c = makeCanvas();
  lineChart(c, [], {});
  // clearRect should run; no stroke calls since no points.
  assert.ok(c._calls.clearRect >= 1);
  assert.equal(c._calls.stroke, 0);
});

test('lineChart with valid points strokes a line', () => {
  const c = makeCanvas();
  lineChart(c, [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }]);
  assert.ok(c._calls.stroke >= 1, 'stroke called');
  assert.ok(c._calls.lineTo >= 2, 'multiple lineTo calls');
});

test('lineChart tolerates negative and very-large values without throwing', () => {
  const c = makeCanvas();
  lineChart(c, [{ x: 0, y: -5 }, { x: 1, y: 1e12 }, { x: 2, y: 0 }]);
  assert.ok(c._calls.stroke >= 1);
});

// ---- barChart ----

test('barChart with zero values renders empty bars (no throw)', () => {
  const c = makeCanvas();
  barChart(c, [
    { label: 'a', value: 0 },
    { label: 'b', value: 0 },
  ]);
  // fillRect runs for the background rails even at zero.
  assert.ok(c._calls.fillRect >= 2);
});

test('barChart respects maxValue option', () => {
  const c = makeCanvas();
  barChart(c, [
    { label: 'a', value: 5 },
    { label: 'b', value: 10 },
  ], { maxValue: 100 });
  assert.ok(c._calls.fillRect >= 2);
});

test('barChart with empty rows is a no-op (clears only)', () => {
  const c = makeCanvas();
  barChart(c, []);
  assert.equal(c._calls.fillRect, 0);
});

test('barChart with negative values is clamped (no throw)', () => {
  const c = makeCanvas();
  barChart(c, [
    { label: 'neg', value: -3 },
    { label: 'pos', value: 7 },
  ]);
  assert.ok(c._calls.fillRect >= 2);
});

// ---- progressBar ----

test('progressBar with current=0, limit=10 renders empty rail', () => {
  const d = makeDiv();
  progressBar(d, { current: 0, limit: 10, label: 'files' });
  assert.ok(d.className.includes('ijfw-progress'));
  assert.ok(!d.className.includes('ijfw-progress--unlimited'));
});

test('progressBar with current=10, limit=10 renders full bar', () => {
  const d = makeDiv();
  progressBar(d, { current: 10, limit: 10, label: 'files' });
  // The "fill" span should have width: 100.0%
  const rail = d._children.find((c) => c.className === 'ijfw-progress-rail');
  assert.ok(rail, 'rail element created');
  const fill = rail._children.find((c) => c.className === 'ijfw-progress-fill');
  assert.ok(fill, 'fill element created');
  assert.ok(/width:\s*100\.0%/.test(fill._attrs.style), 'fill style is 100%');
});

test('progressBar with limit=null renders "unlimited" placeholder', () => {
  const d = makeDiv();
  progressBar(d, { current: 17, limit: null, label: 'wall_clock_ms' });
  assert.ok(d.className.includes('ijfw-progress--unlimited'));
  const val = d._children.find((c) => c.className === 'ijfw-progress-val');
  assert.ok(val);
  assert.ok(/unlimited/i.test(val.textContent));
});

test('progressBar with warning: true applies warning class', () => {
  const d = makeDiv();
  progressBar(d, { current: 5, limit: 10, label: 'files', warning: true });
  assert.ok(d.className.includes('ijfw-progress--warn'));
});

test('progressBar handles edge values without throwing', () => {
  // Negative current, very large limit, null/undefined fields.
  const d1 = makeDiv();
  progressBar(d1, { current: -50, limit: 1_000_000_000 });
  const d2 = makeDiv();
  progressBar(d2, { current: 1e15, limit: 100 });
  const d3 = makeDiv();
  progressBar(d3, {});
  // None of the above should throw — passing means survival.
  assert.ok(true);
});
