// 1.1.6 unit tests -- atomic-io, token, npm-view, update-check/apply, log rotation, ansi-strip.
// Run: cd mcp-server && node --test test-1.1.6.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { writeAtomic, readSafe, withLock, rotateLogIfNeeded, redactUrl, stripAnsi } from './src/lib/atomic-io.js';
import { generateToken, issueToken, validateToken, consumeToken, writePendingSentinel, readPendingSentinel, clearPendingSentinel, sessionDir } from './src/lib/token.js';
import { isVersionStringValid, compareSemver } from './src/lib/npm-view.js';
import { ijfwUpdateApply } from './src/update-apply.js';
import { ijfwUpdateCheck, writeCachedCheck } from './src/update-check.js';

function isolated() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-116-'));
  process.env.IJFW_HOME = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.IJFW_HOME;
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================
// atomic-io
// ============================================================

test('writeAtomic creates file + sets 0600 perms', () => {
  const d = isolated();
  const p = join(d, 'a.json');
  writeAtomic(p, { x: 1 });
  assert.ok(existsSync(p));
  const st = statSync(p);
  assert.equal(st.mode & 0o777, 0o600, 'mode bits should be 0600');
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { x: 1 });
  cleanup(d);
});

test('writeAtomic ensureDir creates parent', () => {
  const d = isolated();
  const p = join(d, 'sub', 'nested', 'a.json');
  writeAtomic(p, { x: 'y' });
  assert.ok(existsSync(p));
  cleanup(d);
});

test('writeAtomic stringifies non-string data', () => {
  const d = isolated();
  const p = join(d, 'a.json');
  writeAtomic(p, [1, 2, 3]);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), [1, 2, 3]);
  cleanup(d);
});

test('readSafe returns enoent when file absent', () => {
  const d = isolated();
  const r = readSafe(join(d, 'nope.json'));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'enoent');
  cleanup(d);
});

test('readSafe returns parse error on malformed JSON', () => {
  const d = isolated();
  const p = join(d, 'broken.json');
  writeFileSync(p, '{not json');
  const r = readSafe(p);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'parse');
  cleanup(d);
});

test('readSafe returns invalid when validator fails', () => {
  const d = isolated();
  const p = join(d, 'a.json');
  writeAtomic(p, { x: 1 });
  const r = readSafe(p, d => d.y === 2);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid');
  cleanup(d);
});

test('withLock acquires + releases', () => {
  const d = isolated();
  const lockPath = join(d, '.lock');
  const r = withLock(lockPath, () => 42);
  assert.equal(r.status, 'ok');
  assert.equal(r.result, 42);
  assert.ok(!existsSync(lockPath));
  cleanup(d);
});

test('withLock returns locked status when contended (PID alive)', () => {
  const d = isolated();
  const lockPath = join(d, '.lock');
  // Plant a lock owned by current PID (which is alive)
  writeFileSync(lockPath, String(process.pid));
  const r = withLock(lockPath, () => 'never', { timeoutMs: 200, retryMs: 50 });
  assert.equal(r.status, 'locked');
  assert.equal(r.pid, process.pid);
  rmSync(lockPath, { force: true });
  cleanup(d);
});

test('withLock reclaims stale lock from dead PID', () => {
  const d = isolated();
  const lockPath = join(d, '.lock');
  // Plant a lock owned by a definitely-dead PID
  writeFileSync(lockPath, '999999');
  const r = withLock(lockPath, () => 'reclaimed', { timeoutMs: 1000, retryMs: 50 });
  assert.equal(r.status, 'ok');
  assert.equal(r.result, 'reclaimed');
  cleanup(d);
});

// ============================================================
// log rotation
// ============================================================

test('rotateLogIfNeeded does nothing under threshold', () => {
  const d = isolated();
  const log = join(d, 'a.log');
  writeFileSync(log, 'small\n');
  const rotated = rotateLogIfNeeded(log, 100);
  assert.equal(rotated, false);
  assert.ok(existsSync(log));
  cleanup(d);
});

test('rotateLogIfNeeded rotates over threshold', () => {
  const d = isolated();
  const log = join(d, 'a.log');
  writeFileSync(log, 'x'.repeat(2000));
  const rotated = rotateLogIfNeeded(log, 1000);
  assert.equal(rotated, true);
  assert.ok(existsSync(`${log}.1`));
  assert.ok(!existsSync(log));
  cleanup(d);
});

test('rotateLogIfNeeded deletes .2 when rotating again', () => {
  const d = isolated();
  const log = join(d, 'a.log');
  writeFileSync(log, 'x'.repeat(2000));
  rotateLogIfNeeded(log, 1000);
  writeFileSync(log, 'y'.repeat(2000));
  rotateLogIfNeeded(log, 1000);
  writeFileSync(log, 'z'.repeat(2000));
  rotateLogIfNeeded(log, 1000);
  assert.ok(existsSync(`${log}.1`));
  assert.ok(existsSync(`${log}.2`));
  // .3 should never exist
  assert.ok(!existsSync(`${log}.3`));
  cleanup(d);
});

// ============================================================
// URL redaction + ANSI strip
// ============================================================

test('redactUrl strips query strings', () => {
  assert.equal(
    redactUrl('GET https://api.example.com/v1/foo?token=secret&id=123 OK'),
    'GET https://api.example.com/v1/foo?<redacted> OK'
  );
});

test('redactUrl leaves URLs without query unchanged', () => {
  const s = 'visit https://github.com/user/repo';
  assert.equal(redactUrl(s), s);
});

test('stripAnsi removes CSI sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('stripAnsi removes OSC sequences + bell', () => {
  assert.equal(stripAnsi('\x1b]0;title\x07rest'), 'rest');
});

test('stripAnsi preserves \\n and \\t', () => {
  assert.equal(stripAnsi('a\nb\tc'), 'a\nb\tc');
});

// ============================================================
// token + sentinel
// ============================================================

test('generateToken returns 32-hex-char string', () => {
  const t = generateToken();
  assert.match(t, /^[a-f0-9]{32}$/);
});

test('issueToken + validateToken happy path', () => {
  const d = isolated();
  const sid = 'test-session-12345678';
  const r = issueToken(sid, '1.1.6');
  assert.match(r.token, /^[a-f0-9]{32}$/);
  const v = validateToken(sid, r.token);
  assert.equal(v.ok, true);
  assert.equal(v.target_version, '1.1.6');
  cleanup(d);
});

test('validateToken rejects mismatch', () => {
  const d = isolated();
  const sid = 'test-session-mismatch';
  issueToken(sid, '1.1.6');
  const v = validateToken(sid, 'a'.repeat(32));
  assert.equal(v.ok, false);
  assert.equal(v.error, 'mismatch');
  cleanup(d);
});

test('validateToken rejects expired token', () => {
  const d = isolated();
  const sid = 'test-session-expired';
  const r = issueToken(sid, '1.1.6', -1000); // already expired
  const v = validateToken(sid, r.token);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'expired');
  cleanup(d);
});

test('validateToken rejects no-token when none issued', () => {
  const d = isolated();
  const v = validateToken('test-session-blank-x', 'whatever');
  assert.equal(v.ok, false);
  assert.equal(v.error, 'no-token');
  cleanup(d);
});

test('consumeToken marks consumed; subsequent validate fails', () => {
  const d = isolated();
  const sid = 'test-session-consume';
  const r = issueToken(sid, '1.1.6');
  consumeToken(sid);
  const v = validateToken(sid, r.token);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'already-consumed');
  cleanup(d);
});

test('writePendingSentinel + read + clear roundtrip', () => {
  const d = isolated();
  const sid = 'test-session-sentinel';
  writePendingSentinel(sid, '1.1.6', 'tok123');
  const r = readPendingSentinel(sid);
  assert.equal(r.ok, true);
  assert.equal(r.data.target_version, '1.1.6');
  clearPendingSentinel(sid);
  const r2 = readPendingSentinel(sid);
  assert.equal(r2.ok, false);
  cleanup(d);
});

test('sessionDir sanitizes invalid session_id', () => {
  const d = isolated();
  const dir = sessionDir('../../../etc/passwd');
  // Should fall back to default-session, not traverse
  assert.match(dir, /default-session$/);
  cleanup(d);
});

// ============================================================
// npm-view validation
// ============================================================

test('isVersionStringValid accepts proper semver', () => {
  assert.equal(isVersionStringValid('1.1.6'), true);
  assert.equal(isVersionStringValid('10.20.30'), true);
  assert.equal(isVersionStringValid('1.1.6-rc.1'), true);
  assert.equal(isVersionStringValid('1.1.6-alpha.beta.1'), true);
});

test('isVersionStringValid rejects malformed', () => {
  assert.equal(isVersionStringValid('1.1'), false);
  assert.equal(isVersionStringValid('v1.1.6'), false);
  assert.equal(isVersionStringValid(''), false);
  assert.equal(isVersionStringValid('1.1.6\nrm -rf /'), false);
  assert.equal(isVersionStringValid(null), false);
  assert.equal(isVersionStringValid(undefined), false);
  assert.equal(isVersionStringValid(116), false);
});

test('compareSemver orders versions correctly', () => {
  assert.equal(compareSemver('1.1.5', '1.1.6'), -1);
  assert.equal(compareSemver('1.1.6', '1.1.5'), 1);
  assert.equal(compareSemver('1.1.6', '1.1.6'), 0);
  assert.equal(compareSemver('1.1.6-rc.1', '1.1.6'), -1, 'pre-release < release');
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1);
});

// ============================================================
// MCP update-check / update-apply
// ============================================================

test('ijfwUpdateCheck returns up-to-date when state matches cache', async () => {
  const d = isolated();
  // Seed state: installed = applied = latest
  writeAtomic(join(d, 'state.json'), {
    schema_version: 1,
    install_method: 'manual',
    installed_version: '99.99.99',
    last_applied_version: '99.99.99',
  });
  // Seed cache so we don't hit npm
  writeCachedCheck({ last_latest_seen: '99.99.99', last_failure: null });
  const r = await ijfwUpdateCheck();
  assert.equal(r.available, false);
  cleanup(d);
});

test('ijfwUpdateCheck returns available + token when behind', async () => {
  const d = isolated();
  writeAtomic(join(d, 'state.json'), {
    schema_version: 1,
    install_method: 'manual',
    installed_version: '0.0.1',
  });
  writeCachedCheck({ last_latest_seen: '99.99.99', last_failure: null });
  const r = await ijfwUpdateCheck({ session_id: 'test-session-mcp-check' });
  assert.equal(r.available, true);
  assert.equal(r.latest, '99.99.99');
  assert.match(r.confirmation_token, /^[a-f0-9]{32}$/);
  assert.match(r.instruction, /ijfw update --confirm/);
  cleanup(d);
});

test('ijfwUpdateApply refuses without token', () => {
  const d = isolated();
  const r = ijfwUpdateApply({ target_version: '1.1.6' });
  assert.equal(r.status, 'error');
  cleanup(d);
});

test('ijfwUpdateApply refuses bad token', () => {
  const d = isolated();
  const r = ijfwUpdateApply({
    target_version: '1.1.6',
    confirmation_token: 'badbadbad',
    session_id: 'test-session-apply-bad',
  });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'no-token');
  cleanup(d);
});

test('ijfwUpdateApply happy path -> pending sentinel', async () => {
  const d = isolated();
  writeAtomic(join(d, 'state.json'), {
    schema_version: 1,
    install_method: 'manual',
    installed_version: '0.0.1',
  });
  writeCachedCheck({ last_latest_seen: '99.99.99', last_failure: null });
  const sid = 'test-session-apply-good';
  const check = await ijfwUpdateCheck({ session_id: sid });
  assert.equal(check.available, true);
  const apply = ijfwUpdateApply({
    target_version: '99.99.99',
    confirmation_token: check.confirmation_token,
    session_id: sid,
  });
  assert.equal(apply.status, 'pending_user_confirmation');
  assert.match(apply.instruction, /ijfw update --confirm/);
  // Sentinel should exist on disk
  assert.ok(existsSync(join(d, 'run', sid, 'update-pending.json')));
  cleanup(d);
});

test('ijfwUpdateApply refuses target mismatch even with valid token', async () => {
  const d = isolated();
  writeAtomic(join(d, 'state.json'), {
    schema_version: 1,
    install_method: 'manual',
    installed_version: '0.0.1',
  });
  writeCachedCheck({ last_latest_seen: '99.99.99', last_failure: null });
  const sid = 'test-session-apply-mismatch';
  const check = await ijfwUpdateCheck({ session_id: sid });
  const apply = ijfwUpdateApply({
    target_version: '88.88.88', // different from token-issued 99.99.99
    confirmation_token: check.confirmation_token,
    session_id: sid,
  });
  assert.equal(apply.status, 'error');
  assert.equal(apply.reason, 'target-mismatch');
  cleanup(d);
});

// ============================================================
// Re-entrancy guard (the key v3 invariant)
// ============================================================

test('reentrancy: last_applied_version >= last_latest_seen suppresses nudge', async () => {
  const d = isolated();
  writeAtomic(join(d, 'state.json'), {
    schema_version: 1,
    install_method: 'manual',
    installed_version: '1.1.6',
    last_applied_version: '1.1.6',
  });
  writeCachedCheck({ last_latest_seen: '1.1.6', last_failure: null });
  const r = await ijfwUpdateCheck();
  assert.equal(r.available, false, 'should not nudge after just applying');
  assert.equal(r.reason, 'up-to-date');
  cleanup(d);
});

// ============================================================
// Clock skew
// ============================================================

test('compareSemver handles same-version without infinite loop', () => {
  // Sanity check on the helper used in re-entrancy + clock-skew logic
  assert.equal(compareSemver('1.1.6', '1.1.6'), 0);
});

// ============================================================
// Wave 9 W9-M4: sentinel cleanup via real subprocess invocation
// Each test spawns `node cross-orchestrator-cli.js update --confirm <token>` with
// a fake npm on PATH that fails in the target shape. After the subprocess exits,
// the sentinel file must be gone -- proving the try/finally in cmdUpdateConfirm
// fires on all failure paths and would fail if the finally block were removed.
// ============================================================

const CLI = resolve(new URL('.', import.meta.url).pathname, 'src/cross-orchestrator-cli.js');

function makeFakeNpm(dir, script) {
  const bin = join(dir, 'npm');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}

function spawnConfirm(token, ijfwHome, fakeBinDir) {
  const env = { ...process.env, IJFW_HOME: ijfwHome, IJFW_FROM_MCP: '0' };
  if (fakeBinDir !== null) env.PATH = fakeBinDir + ':' + (process.env.PATH || '');
  return spawnSync(process.execPath, [CLI, 'update', '--confirm', token], {
    encoding: 'utf8', env, timeout: 15_000,
  });
}

test('cmdUpdateConfirm cleans sentinel on install spawn-error (npm not on PATH)', () => {
  const d = isolated();
  const sid = 'test-session-spawn-error';
  const tok = issueToken(sid, '9.9.9');
  writePendingSentinel(sid, '9.9.9', tok.token);
  assert.equal(readPendingSentinel(sid).ok, true, 'sentinel must exist before failure');

  // Empty fakeBinDir -- npm is absent, spawnSync returns ENOENT
  const emptyBin = mkdtempSync(join(tmpdir(), 'ijfw-nobin-'));
  spawnConfirm(tok.token, d, emptyBin);

  assert.equal(readPendingSentinel(sid).ok, false, 'sentinel must be gone after spawn-error path');
  rmSync(emptyBin, { recursive: true, force: true });
  cleanup(d);
});

test('cmdUpdateConfirm cleans sentinel on install non-zero exit', () => {
  const d = isolated();
  const sid = 'test-session-nonzero-exit';
  const tok = issueToken(sid, '9.9.9');
  writePendingSentinel(sid, '9.9.9', tok.token);
  assert.equal(readPendingSentinel(sid).ok, true, 'sentinel must exist before failure');

  const fakeBin = mkdtempSync(join(tmpdir(), 'ijfw-fakebin-'));
  makeFakeNpm(fakeBin, 'exit 7');
  spawnConfirm(tok.token, d, fakeBin);

  assert.equal(readPendingSentinel(sid).ok, false, 'sentinel must be gone after non-zero exit path');
  rmSync(fakeBin, { recursive: true, force: true });
  cleanup(d);
});

test('cmdUpdateConfirm cleans sentinel on install signal-kill', () => {
  const d = isolated();
  const sid = 'test-session-signal-kill';
  const tok = issueToken(sid, '9.9.9');
  writePendingSentinel(sid, '9.9.9', tok.token);
  assert.equal(readPendingSentinel(sid).ok, true, 'sentinel must exist before failure');

  const fakeBin = mkdtempSync(join(tmpdir(), 'ijfw-fakebin-'));
  // Self-signal SIGTERM; spawnSync sees signal != null -> finally fires
  makeFakeNpm(fakeBin, 'kill -TERM $$');
  spawnConfirm(tok.token, d, fakeBin);

  assert.equal(readPendingSentinel(sid).ok, false, 'sentinel must be gone after signal-kill path');
  rmSync(fakeBin, { recursive: true, force: true });
  cleanup(d);
});
