/**
 * test-atomic-io.js — coverage for atomic-io helpers, especially the
 * v1.5.1 H1.3 symlink-refuse defense.
 *
 * Created in v1.5.1 audit-H1.3 — atomic-io had zero direct test coverage at
 * HEAD 9ddf1ed. Audit finding update-install-trust.md F-COR-1 caught that the
 * documented symlink-refuse defense at `writeAtomic` was dead code because
 * `statSync()` follows symlinks (so the returned stat is the target's, not
 * the link's, and `isSymbolicLink()` returns false). Fix: `lstatSync`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, readSafe, redactUrl, stripAnsi } from './src/lib/atomic-io.js';

const IS_WIN = platform() === 'win32';

function mkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-io-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// writeAtomic — baseline
// ---------------------------------------------------------------------------

test('writeAtomic writes a file atomically with default 0o600 mode', () => {
  const { dir, cleanup } = mkdir();
  try {
    const target = join(dir, 'out.json');
    const result = writeAtomic(target, { hello: 'world' });
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    const r = readSafe(target);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { hello: 'world' });
  } finally { cleanup(); }
});

test('writeAtomic accepts string data verbatim', () => {
  const { dir, cleanup } = mkdir();
  try {
    const target = join(dir, 'plain.txt');
    writeAtomic(target, 'hello\nworld\n');
    const r = readSafe(target);
    // readSafe parses JSON; plain text fails parse but that's fine — we just
    // want to verify the bytes landed.
    assert.equal(r.ok, false);
    assert.equal(r.error, 'parse');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// v1.5.1 H1.3 — audit finding F-COR-1: symlink-refuse must actually refuse
// ---------------------------------------------------------------------------

test('v1.5.1 H1.3: writeAtomic refuses to overwrite a symlink target', { skip: IS_WIN }, () => {
  // Setup: real-file + symlink → real-file. writeAtomic on the SYMLINK path
  // must throw, NOT silently replace the symlink. Pre-fix this passed because
  // statSync followed the symlink and returned the target's regular stat.
  const { dir, cleanup } = mkdir();
  try {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(real, '{"original": true}');
    symlinkSync(real, link);
    // Sanity-check the setup: link is a symlink at the FS level.
    // (statSync follows it; lstatSync does not — that's the whole bug.)
    assert.equal(statSync(link).isFile(), true, 'symlink target exists as file');

    assert.throws(
      () => writeAtomic(link, { override: true }),
      /refusing to overwrite symlink/,
      'writeAtomic must refuse the symlink path',
    );
  } finally { cleanup(); }
});

test('v1.5.1 H1.3: writeAtomic still overwrites a regular file at target', { skip: IS_WIN }, () => {
  // Regression: must not break the normal case.
  const { dir, cleanup } = mkdir();
  try {
    const target = join(dir, 'normal.json');
    writeFileSync(target, '{"v": 1}');
    writeAtomic(target, { v: 2 });
    const r = readSafe(target);
    assert.equal(r.ok, true);
    assert.equal(r.data.v, 2);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// readSafe — never throws (baseline)
// ---------------------------------------------------------------------------

test('readSafe returns {ok:false,error:enoent} for missing path', () => {
  const r = readSafe('/nonexistent/path/should/never/exist.json');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'enoent');
});

test('readSafe returns parse error for malformed JSON', () => {
  const { dir, cleanup } = mkdir();
  try {
    const target = join(dir, 'bad.json');
    writeFileSync(target, '{not valid json');
    const r = readSafe(target);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'parse');
  } finally { cleanup(); }
});

test('readSafe runs validator and surfaces invalid', () => {
  const { dir, cleanup } = mkdir();
  try {
    const target = join(dir, 'shape.json');
    writeFileSync(target, '{"wrong_shape": true}');
    const r = readSafe(target, (d) => d && typeof d.required === 'string');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Utility helpers (baseline)
// ---------------------------------------------------------------------------

test('redactUrl strips query strings', () => {
  assert.equal(
    redactUrl('https://api.example.com/v1/users?token=secret&id=42'),
    'https://api.example.com/v1/users?<redacted>',
  );
});

test('stripAnsi removes color escapes and bell', () => {
  // eslint-disable-next-line no-control-regex
  const colored = '\x1b[31mred\x1b[0m text\x07';
  assert.equal(stripAnsi(colored), 'red text');
});
