/**
 * test-dashboard-no-sample-data.js -- the local dashboard must show only the
 * user's own data.
 *
 * Field report (Mac): the dashboard showed the developer's name, a "MAX 20x"
 * plan, $200/$20/$249.99 subscriptions, ~17 foreign project names, ~35
 * foreign memory titles, a fake session list and a fake "Live Feed" labelled
 * "Real data from ~/.ijfw/observations.jsonl". They were design-mockup
 * values typed into dashboard-client.html; the loaders return early when the
 * user has no data, so the mockup stayed on screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'src', 'dashboard-client.html'), 'utf8');

// Markup only (strip <script>/<style>) for "what the user sees before JS".
const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

const SAMPLE = [
  'Sean Donahoe', '>SD<', 'MAX 20x', 'Claude Max 20x', 'Codex Pro', 'Gemini AI Ultra', '$469.99',
  'wayland', 'socialmedia', '>aion<', 'Crucible', 'hearth', 'PiPLLM', 'mindgraph', 'ContentDev',
  'twitterclean', 'deepcode', 'TestBEd', 'tradecanyon', '>Flow<',
  'Donahoe Loop', 'Positive Framing is Sacred', 'Cross-AI Combo Policy',
  '$981', '$6,546', '$6,544', '$2,736', '2.71B', '97.0%', '48 in 30 days', '2h 21m',
  'claude-opus-4-7', 'Projects (17)', 'Mar 17', 'Apr 16', '$270/mo', '(50 entries)', 'all 35 files',
];

test('no developer sample data in the page markup', () => {
  const found = SAMPLE.filter((s) => markup.includes(s));
  assert.deepEqual(found, [], `sample values still in markup: ${found.join(', ')}`);
});

test('no sample session/feed rows dated from the mockup', () => {
  assert.doesNotMatch(markup, /2026-0[34]-\d\d/, 'mockup dates (Mar/Apr 2026) must not be shown');
});

test('Live Feed is loaded from /api/observations and rendered with textContent', () => {
  assert.match(html, /async function loadLiveFeed\(\)/);
  assert.match(html, /fetch\('\/api\/observations\?limit=50'\)/);
  const body = html.slice(html.indexOf('async function loadLiveFeed()'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.ok(!/innerHTML\s*=\s*[^'"]/.test(fn), 'feed rows must not be built from data via innerHTML');
  assert.match(html, /loadLiveFeed\(\);/, 'loader is called on page load');
});

test('tier pill and operator link are hidden until there is something real to show', () => {
  assert.match(markup, /<span class="tier-pill" style="display:none"><\/span>/);
  assert.match(markup, /id="operatorDashLink"[^>]*style="display:none"/);
});

test('All-projects rows do not claim a hard-coded model', () => {
  assert.ok(!/chip\.textContent = 'Opus 4\.6'/.test(html), 'model chip must come from the data');
});
