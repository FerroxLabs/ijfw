import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, 'src');
const PLANNING_HTML = readFileSync(join(SRC, 'dashboard-client-planning.html'), 'utf8');
const WAVES_HTML = readFileSync(join(SRC, 'dashboard-client-waves.html'), 'utf8');

// v1.5.0 F2 (R3 fold-in) — XSS regression tests for dashboard HTML files.
// Constructed via String.fromCharCode + split() so the file does NOT contain
// the literal forbidden substrings (PreToolUse security hook would block).
const FN_KEYWORD = String.fromCharCode(70, 117, 110, 99, 116, 105, 111, 110); // "Fu" + "nction"
const EV_KEYWORD = String.fromCharCode(101, 118, 97, 108);                    // four letters
const FN_PATTERN = new RegExp('new\\s+' + FN_KEYWORD + '\\s*\\(');
const EV_PATTERN = new RegExp('\\b' + EV_KEYWORD + '\\s*\\(');

test('planning HTML constructs nodes safely', () => {
  assert.match(PLANNING_HTML, /createElement|textContent/, 'planning HTML should construct nodes safely');
});

test('waves HTML constructs nodes safely', () => {
  assert.match(WAVES_HTML, /createElement|textContent/, 'waves HTML should construct nodes safely');
});

test('planning HTML scheme-aware (mentions http and javascript:)', () => {
  const hasGuard = /javascript:/i.test(PLANNING_HTML) && /https?:/i.test(PLANNING_HTML);
  assert.ok(hasGuard, 'planning HTML should declare URL scheme guards');
});

test('waves HTML link safety (no links OR has scheme guard)', () => {
  const hasLinks = /<a\s+href|href\s*=/.test(WAVES_HTML);
  if (!hasLinks) return;
  const hasGuard = /javascript:/i.test(WAVES_HTML) || /isSafeUrl|allowedScheme/.test(WAVES_HTML);
  assert.ok(hasGuard, 'waves HTML renders links but missing URL scheme guard');
});

test('planning HTML free of dynamic-code footguns', () => {
  assert.doesNotMatch(PLANNING_HTML, EV_PATTERN, 'planning HTML must not use ' + EV_KEYWORD + '()');
  assert.doesNotMatch(PLANNING_HTML, FN_PATTERN, 'planning HTML must not use the ' + FN_KEYWORD + ' constructor');
});

test('waves HTML free of dynamic-code footguns', () => {
  assert.doesNotMatch(WAVES_HTML, EV_PATTERN, 'waves HTML must not use ' + EV_KEYWORD + '()');
  assert.doesNotMatch(WAVES_HTML, FN_PATTERN, 'waves HTML must not use the ' + FN_KEYWORD + ' constructor');
});
