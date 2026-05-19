// r17.1 (item 6) — wave-missing subcommand tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlers } from './src/dispatch/wave-cli.js';

function mkProject() {
  const dir = mkdtempSync(join(tmpdir(), 'wave-missing-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedReceipt(projectRoot, waveId, subId) {
  const waveDir = join(projectRoot, '.ijfw', `wave-${waveId}`);
  mkdirSync(waveDir, { recursive: true });
  writeFileSync(
    join(waveDir, `subagent-${waveId}-${subId}.checkpoint.json`),
    JSON.stringify({ wave: waveId, subagent_id: subId, status: 'DONE' }) + '\n',
  );
}

test('wave-missing: usage error when no expected ids supplied', async () => {
  const r = await handlers['wave-missing']('', {});
  assert.equal(r.ok, false);
  assert.match(r.error || '', /Usage: ijfw wave-missing/);
});

test('wave-missing: wave dir absent → all expected reported missing', async () => {
  const { dir, cleanup } = mkProject();
  try {
    const r = await handlers['wave-missing']('W99 a b c', { projectRoot: dir });
    assert.equal(r.ok, false);
    assert.match(r.output, /All 3 expected subagent\(s\) are MISSING/);
    assert.match(r.output, /Missing: a, b, c/);
  } finally { cleanup(); }
});

test('wave-missing: all receipts present → ok=true, no missing', async () => {
  const { dir, cleanup } = mkProject();
  try {
    seedReceipt(dir, 'W12-X', 'a');
    seedReceipt(dir, 'W12-X', 'b');
    seedReceipt(dir, 'W12-X', 'c');
    const r = await handlers['wave-missing']('W12-X a b c', { projectRoot: dir });
    assert.equal(r.ok, true);
    assert.match(r.output, /Missing:  0 \(none\)/);
    assert.match(r.output, /Present:  3 \(a, b, c\)/);
  } finally { cleanup(); }
});

test('wave-missing: partial — some present, some missing (the wayland pattern)', async () => {
  const { dir, cleanup } = mkProject();
  try {
    seedReceipt(dir, 'W12-X', 'a');
    seedReceipt(dir, 'W12-X', 'b');
    // c, d, e are MIA — exactly the "5 of 8 went silent" pattern
    const r = await handlers['wave-missing']('W12-X a b c d e', { projectRoot: dir });
    assert.equal(r.ok, false, 'returns ok=false when any expected is missing');
    assert.match(r.output, /Missing:  3 \(c, d, e\)/);
    assert.match(r.output, /Present:  2 \(a, b\)/);
  } finally { cleanup(); }
});

test('wave-missing: stray receipts (present but not expected) surfaced', async () => {
  const { dir, cleanup } = mkProject();
  try {
    seedReceipt(dir, 'W12-X', 'a');
    seedReceipt(dir, 'W12-X', 'b');
    seedReceipt(dir, 'W12-X', 'extra-unexpected');
    const r = await handlers['wave-missing']('W12-X a b', { projectRoot: dir });
    assert.equal(r.ok, true, 'stray doesn\'t fail the check; just informs');
    assert.match(r.output, /Stray:    1 \(extra-unexpected\)/);
  } finally { cleanup(); }
});

test('wave-missing: subcommandHelp entry exists', async () => {
  const m = await import('./src/dispatch/wave-cli.js');
  assert.ok(m.subcommandHelp['wave-missing'], 'subcommandHelp must include wave-missing');
});

// r17-M2 regression: waveId / expected-id traversal attempts must be refused
// before any filesystem access.
test('wave-missing r17-M2: waveId with .. is refused (path traversal block)', async () => {
  const r = await handlers['wave-missing']('../escape a b', { projectRoot: '/tmp' });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /invalid waveId/);
});

test('wave-missing r17-M2: waveId with slash is refused', async () => {
  const r = await handlers['wave-missing']('foo/bar a b', { projectRoot: '/tmp' });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /invalid waveId/);
});

test('wave-missing r17-M2: expected id with .. is refused', async () => {
  const r = await handlers['wave-missing']('W12-X a ../escape b', { projectRoot: '/tmp' });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /invalid expected id/);
});

test('wave-missing r17-M2: valid waveId with dots (version-style) accepted', async () => {
  // e.g. wave-1.5.0 should be valid (dots allowed; no .. sequence).
  const { dir, cleanup } = mkProject();
  try {
    seedReceipt(dir, '1.5.0', 'a');
    const r = await handlers['wave-missing']('1.5.0 a', { projectRoot: dir });
    assert.equal(r.ok, true);
  } finally { cleanup(); }
});
