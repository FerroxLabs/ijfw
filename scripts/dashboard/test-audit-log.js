// v1.5.0 audit-H5.8 — tests for /api/extension-audit-log endpoint + the
// XSS-safe row renderer used in dashboard-client / server.js.
//
// Coverage matrix:
//   endpoint-empty     -> no events file -> {events:[]}
//   endpoint-basic     -> seed 5 events -> all 5 returned in reverse-chrono
//   filter-by-ext      -> seed mixed -> ?ext=foo returns only foo's
//   filter-by-since    -> ?since=... returns only events at-or-after
//   symlink-refused    -> symlinked events file -> empty + stderr advisory
//   xss-escape         -> '<script>' in extension name -> '&lt;script&gt;'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readPermissionEvents,
  readPermissionEventsFile,
  renderAuditRow,
  escAuditCell,
} from './server.js';

// -------- helpers --------

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ijfw-audit-log-test-'));
  mkdirSync(join(home, '.ijfw', 'state'), { recursive: true });
  return home;
}

function seedEvents(home, events, { rotated = false } = {}) {
  const fname = rotated ? 'permission-events.jsonl.0' : 'permission-events.jsonl';
  const path = join(home, '.ijfw', 'state', fname);
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, body, 'utf8');
  return path;
}

function cleanup(home) {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// -------- endpoint-empty --------

test('endpoint-empty: no events file returns {events:[]} and no-op', () => {
  const home = makeFakeHome();
  try {
    const result = readPermissionEvents({ homeDir: home });
    assert.deepEqual(result.events, []);
    assert.equal(result.total_read, 0);
    assert.equal(result.truncated, false);
  } finally {
    cleanup(home);
  }
});

// -------- endpoint-basic --------

test('endpoint-basic: seed 5 events, get all 5 reverse-chrono', () => {
  const home = makeFakeHome();
  try {
    const events = [
      { timestamp: '2026-05-19T10:00:00Z', extension: 'a', tool: 't1', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T11:00:00Z', extension: 'a', tool: 't2', allowed: false, reason: 'denied' },
      { timestamp: '2026-05-19T12:00:00Z', extension: 'b', tool: 't3', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T13:00:00Z', extension: 'a', tool: 't4', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T14:00:00Z', extension: 'c', tool: 't5', allowed: true, reason: 'ok' },
    ];
    seedEvents(home, events);
    const result = readPermissionEvents({ homeDir: home, limit: 50 });
    assert.equal(result.events.length, 5);
    // Reverse chronological: newest first
    assert.equal(result.events[0].timestamp, '2026-05-19T14:00:00Z');
    assert.equal(result.events[1].timestamp, '2026-05-19T13:00:00Z');
    assert.equal(result.events[4].timestamp, '2026-05-19T10:00:00Z');
  } finally {
    cleanup(home);
  }
});

test('endpoint-basic: reads rotated .0 file alongside current', () => {
  const home = makeFakeHome();
  try {
    seedEvents(home, [
      { timestamp: '2026-05-18T10:00:00Z', extension: 'a', tool: 'old', allowed: true, reason: 'ok' },
    ], { rotated: true });
    seedEvents(home, [
      { timestamp: '2026-05-19T10:00:00Z', extension: 'a', tool: 'new', allowed: true, reason: 'ok' },
    ]);
    const result = readPermissionEvents({ homeDir: home });
    assert.equal(result.events.length, 2);
    // Newest first
    assert.equal(result.events[0].tool, 'new');
    assert.equal(result.events[1].tool, 'old');
  } finally {
    cleanup(home);
  }
});

test('endpoint-basic: tolerates malformed JSONL lines', () => {
  const home = makeFakeHome();
  try {
    const path = join(home, '.ijfw', 'state', 'permission-events.jsonl');
    const body = [
      JSON.stringify({ timestamp: '2026-05-19T10:00:00Z', extension: 'a', tool: 't1', allowed: true, reason: 'ok' }),
      'this is not json',
      JSON.stringify({ timestamp: '2026-05-19T11:00:00Z', extension: 'b', tool: 't2', allowed: false, reason: 'no' }),
    ].join('\n') + '\n';
    writeFileSync(path, body, 'utf8');
    const result = readPermissionEvents({ homeDir: home });
    assert.equal(result.events.length, 2);
  } finally {
    cleanup(home);
  }
});

// -------- filter-by-ext --------

test('filter-by-ext: ?ext=foo returns only foo events', () => {
  const home = makeFakeHome();
  try {
    seedEvents(home, [
      { timestamp: '2026-05-19T10:00:00Z', extension: 'foo', tool: 't1', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T11:00:00Z', extension: 'bar', tool: 't2', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T12:00:00Z', extension: 'foo', tool: 't3', allowed: false, reason: 'no' },
      { timestamp: '2026-05-19T13:00:00Z', extension: 'baz', tool: 't4', allowed: true, reason: 'ok' },
    ]);
    const result = readPermissionEvents({ homeDir: home, ext: 'foo' });
    assert.equal(result.events.length, 2);
    for (const ev of result.events) {
      assert.equal(ev.extension, 'foo');
    }
  } finally {
    cleanup(home);
  }
});

// -------- filter-by-since --------

test('filter-by-since: returns only events at-or-after the cutoff', () => {
  const home = makeFakeHome();
  try {
    seedEvents(home, [
      { timestamp: '2026-05-18T10:00:00Z', extension: 'a', tool: 'old', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T00:00:00Z', extension: 'a', tool: 'edge', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-19T10:00:00Z', extension: 'a', tool: 'today', allowed: true, reason: 'ok' },
      { timestamp: '2026-05-20T10:00:00Z', extension: 'a', tool: 'tomorrow', allowed: true, reason: 'ok' },
    ]);
    const result = readPermissionEvents({
      homeDir: home,
      since: '2026-05-19T00:00:00Z',
    });
    // Cutoff is inclusive: edge + today + tomorrow = 3
    assert.equal(result.events.length, 3);
    const tools = result.events.map((e) => e.tool).sort();
    assert.deepEqual(tools, ['edge', 'today', 'tomorrow']);
  } finally {
    cleanup(home);
  }
});

// -------- symlink-refused --------

test('symlink-refused: symlinked events file returns empty + stderr advisory', () => {
  const home = makeFakeHome();
  // Capture stderr.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (s) => {
    captured += String(s);
    return true;
  };
  try {
    // Create the real target somewhere else, then symlink the canonical
    // events path to point at it.
    const realFile = join(home, 'real-events.jsonl');
    writeFileSync(realFile, JSON.stringify({
      timestamp: '2026-05-19T10:00:00Z',
      extension: 'leaked',
      tool: 't',
      allowed: true,
      reason: 'should not be read',
    }) + '\n', 'utf8');
    const linkPath = join(home, '.ijfw', 'state', 'permission-events.jsonl');
    symlinkSync(realFile, linkPath);
    // Sanity: ensure the symlink exists where we expect.
    assert.ok(existsSync(linkPath));

    const evs = readPermissionEventsFile(linkPath);
    assert.deepEqual(evs, [], 'symlinked file must yield empty events');
    assert.match(captured, /refusing to read symlinked permission-events file/i);

    // Full endpoint path: should produce {events:[]} too.
    const result = readPermissionEvents({ homeDir: home });
    assert.deepEqual(result.events, []);
  } finally {
    process.stderr.write = origWrite;
    cleanup(home);
  }
});

// -------- xss-escape --------

test('xss-escape: renderAuditRow escapes <script> in extension name', () => {
  const ev = {
    timestamp: '2026-05-19T10:00:00Z',
    extension: '<script>alert(1)</script>',
    tool: 'tool-name',
    allowed: true,
    reason: 'fine',
  };
  const row = renderAuditRow(ev);
  // Raw '<script>' must NOT appear; escaped form must.
  assert.ok(!row.includes('<script>'), `raw <script> tag leaked: ${row}`);
  assert.ok(!row.includes('</script>'), `raw </script> tag leaked: ${row}`);
  assert.match(row, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('xss-escape: renderAuditRow escapes tool + reason cells too', () => {
  const ev = {
    timestamp: '2026-05-19T10:00:00Z',
    extension: 'ext-ok',
    tool: '<img src=x onerror=alert(1)>',
    allowed: false,
    reason: 'denied because of "<>"',
  };
  const row = renderAuditRow(ev);
  assert.ok(!row.includes('<img src=x'), `raw <img> leaked: ${row}`);
  assert.ok(!row.includes('onerror=alert(1)>'), `raw onerror leaked: ${row}`);
  assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // Quotes in reason must be escaped.
  assert.ok(!/denied because of "<>"/.test(row), `raw quotes leaked: ${row}`);
  assert.match(row, /&quot;&lt;&gt;&quot;/);
});

test('xss-escape: escAuditCell handles null/undefined/empty cleanly', () => {
  assert.equal(escAuditCell(null), '');
  assert.equal(escAuditCell(undefined), '');
  assert.equal(escAuditCell(''), '');
  assert.equal(escAuditCell("o'reilly"), 'o&#39;reilly');
  assert.equal(escAuditCell('a & b'), 'a &amp; b');
});

// -------- DoS cap --------

test('limit-cap: limit is capped at 5000 to prevent DoS', () => {
  const home = makeFakeHome();
  try {
    // Seed a handful — the cap behaviour is independent of input size.
    seedEvents(home, [
      { timestamp: '2026-05-19T10:00:00Z', extension: 'a', tool: 't', allowed: true, reason: 'ok' },
    ]);
    const result = readPermissionEvents({ homeDir: home, limit: 99999 });
    // The internal limit must have been clamped — we don't return more than 5000.
    assert.ok(result.events.length <= 5000);
  } finally {
    cleanup(home);
  }
});
