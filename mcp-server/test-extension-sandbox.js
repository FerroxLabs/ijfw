#!/usr/bin/env node
/**
 * test-extension-sandbox.js -- IJFW 1.4.0 W4/t19
 *
 * Tests for the install-time static analysis surface:
 *   - scanExtensionForSecrets      (uses real classify() from redactor.js)
 *   - scanInlineCommands           (uses real isSafeVerifyCommand() / FORBID_LIST)
 *   - validatePermissions
 *
 * HOME-isolated: tests build a fresh tmp dir per case, never touch real
 * ~/.ijfw or real .ijfw/state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scanExtensionForSecrets,
  scanInlineCommands,
  validatePermissions,
} from './src/extension-signer.js';

async function makeTmp() {
  return mkdtemp(join(tmpdir(), 'ijfw-ext-sandbox-test-'));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

test('scanExtensionForSecrets returns clean for benign content', async () => {
  const dir = await makeTmp();
  try {
    await writeFile(join(dir, 'readme.md'), '# hello\nThis is a normal skill body with no secrets.\n', 'utf8');
    const r = await scanExtensionForSecrets(dir);
    assert.equal(r.clean, true);
    assert.deepEqual(r.findings, []);
  } finally {
    await cleanup(dir);
  }
});

test('scanExtensionForSecrets detects an anthropic-style secret WITHOUT surfacing the value', async () => {
  const dir = await makeTmp();
  try {
    // The classify() pattern is sk-ant-[A-Za-z0-9_-]{20,}. Build a token that
    // satisfies the length requirement without using a real key.
    const fakeToken = 'sk-ant-' + 'A1b2C3d4E5f6G7h8I9j0kK';
    await writeFile(join(dir, 'skill.md'), `# Skill\ntoken: ${fakeToken}\n`, 'utf8');

    const r = await scanExtensionForSecrets(dir);
    assert.equal(r.clean, false);
    assert.ok(r.findings.length >= 1, 'expected at least one finding');
    const f = r.findings[0];
    // Finding shape: {file, line, kind}.
    assert.ok(typeof f.file === 'string' && f.file.length > 0);
    assert.equal(typeof f.line, 'number');
    assert.ok(typeof f.kind === 'string' && f.kind.length > 0);
    // Security spec §3.1: the raw matched value must NEVER appear in findings.
    for (const finding of r.findings) {
      for (const v of Object.values(finding)) {
        if (typeof v === 'string') {
          assert.ok(
            !v.includes(fakeToken),
            `finding leaked the raw secret value: ${v}`,
          );
          assert.ok(
            !v.includes('sk-ant-'),
            `finding leaked the secret prefix: ${v}`,
          );
        }
      }
    }
  } finally {
    await cleanup(dir);
  }
});

test('scanExtensionForSecrets skips binary-ish / oversized files gracefully', async () => {
  const dir = await makeTmp();
  try {
    // 2 MiB random buffer — exceeds SCAN_MAX_FILE_BYTES (1 MiB) so should be skipped.
    const big = randomBytes(2 * 1024 * 1024);
    await writeFile(join(dir, 'blob.bin'), big);
    // Also add a benign companion text file.
    await writeFile(join(dir, 'ok.md'), 'just text\n', 'utf8');
    const r = await scanExtensionForSecrets(dir);
    // Whether `clean` is true or false depends on whether the random buffer
    // happens to contain a secret-shaped substring (vanishingly unlikely, but
    // we don't rely on it). What matters: it didn't crash / OOM.
    assert.equal(typeof r.clean, 'boolean');
    assert.ok(Array.isArray(r.findings));
  } finally {
    await cleanup(dir);
  }
});

test('scanInlineCommands flags unsafe fenced bash (rm -rf /)', () => {
  const body = '```bash\nrm -rf /\n```';
  const r = scanInlineCommands(body);
  assert.equal(r.clean, false);
  assert.ok(r.findings.length >= 1);
  assert.equal(r.findings[0].kind, 'unsafe-command');
  assert.ok(/forbid/i.test(r.findings[0].reason));
});

test('scanInlineCommands accepts allowlisted verify commands (node --check)', () => {
  // `node --check` passes the FORBID_LIST (no forbidden tokens). The
  // allowlist miss does NOT produce a finding (per scanInlineCommands docs).
  const body = '```bash\nnode --check x.js\n```';
  const r = scanInlineCommands(body);
  assert.equal(r.clean, true);
  assert.deepEqual(r.findings, []);
});

test('scanInlineCommands handles inline `$ <cmd>` form outside fenced blocks', () => {
  const body = 'Run this:\n$ rm -rf /\n';
  const r = scanInlineCommands(body);
  assert.equal(r.clean, false);
  assert.ok(r.findings.length >= 1);
  assert.equal(r.findings[0].kind, 'unsafe-command');
});

test('validatePermissions accepts allowlisted reads/writes', () => {
  const r = validatePermissions({
    permissions: {
      reads: ['./README.md'],
      writes: ['memory:write'],
    },
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validatePermissions rejects non-allowlisted reads', () => {
  const r = validatePermissions({
    permissions: {
      reads: ['/etc/passwd'],
      writes: [],
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /not in allowlist/i.test(e)));
});
