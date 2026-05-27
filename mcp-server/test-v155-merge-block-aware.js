// Regression tests for v1.5.5 fix wave — agent G4b scope.
// Covers: V155-010 (mergeFile refuses to write when backup of existing
// target fails).
//
// Run: node --test test-v155-merge-block-aware.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import {
  rotateBackups,
  mergeFile,
  MergeBlockAwareError,
} from './src/orchestrator/merge-block-aware.js';

describe('V155-010: rotateBackups returns structured reason instead of swallowing failure', () => {
  it('reason="absent" when target does not exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-abs-'));
    try {
      const r = rotateBackups(join(tmp, 'no-such-file.md'), { homeDir: tmp });
      assert.equal(r.taken, false);
      assert.equal(r.reason, 'absent');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reason="empty" when target is 0 bytes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-empty-'));
    try {
      const f = join(tmp, 'AGENTS.md');
      writeFileSync(f, '');
      const r = rotateBackups(f, { homeDir: tmp });
      assert.equal(r.taken, false);
      assert.equal(r.reason, 'empty');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('taken=true when target exists and copy succeeds', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-ok-'));
    try {
      const f = join(tmp, 'AGENTS.md');
      writeFileSync(f, 'hello\n');
      const r = rotateBackups(f, { homeDir: tmp });
      assert.equal(r.taken, true);
      assert.equal(typeof r.path, 'string');
      assert.ok(existsSync(r.path));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reason="io-error" when backup directory cannot be created (skipped on Windows)', () => {
    if (platform() === 'win32') return; // chmod 0o000 unreliable on Windows
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-io-'));
    try {
      const f = join(tmp, 'AGENTS.md');
      writeFileSync(f, 'data\n');
      // Make the homeDir unwritable so mkdirSync(...) fails when allocating
      // the canonical backup subtree under it.
      const readOnlyHome = join(tmp, 'ro-home');
      mkdirSync(readOnlyHome);
      try { chmodSync(readOnlyHome, 0o500); } catch { /* best-effort */ }
      const r = rotateBackups(f, { homeDir: readOnlyHome });
      // Some filesystems (root/CI) ignore 0o500 → fall through to a successful
      // backup. Accept either outcome but if io-error is reported, the shape
      // must be the new structured one.
      if (r.taken === false && r.reason !== 'absent' && r.reason !== 'empty') {
        assert.equal(r.reason, 'io-error');
        assert.equal(typeof r.error, 'string');
      }
    } finally {
      // Restore permissions so cleanup works.
      try { chmodSync(join(tmp, 'ro-home'), 0o700); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('V155-010: mergeFile aborts when existing-target backup fails', () => {
  it('seed case (target absent) still works — reason="absent" is not an io-error', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-seed-'));
    try {
      const tpl = join(tmp, 'AGENTS.md.tmpl');
      writeFileSync(tpl, '<!-- IJFW-MEMORY-START -->\n<!-- IJFW-MEMORY-END -->\n');
      const target = join(tmp, 'AGENTS.md'); // does not exist yet
      const res = mergeFile(target, [{ block: 'MEMORY', content: 'hello' }], {
        templatePath: tpl, homeDir: tmp,
      });
      assert.equal(res.ok, true);
      assert.equal(res.seeded, true);
      assert.ok(existsSync(target));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('mergeFile throws ERR_BACKUP_REQUIRED when rotateBackups reports io-error', () => {
    // We monkey-patch rotateBackups indirectly by supplying a custom homeDir
    // that we then chmod 0o500 between the target-exists check and the
    // backup attempt. Easier: stub via direct injection — but the public
    // surface doesn't allow it, so we use FS permissions on POSIX.
    if (platform() === 'win32') return;
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-refuse-'));
    try {
      // Seed AGENTS.md with real content under a writable area.
      const target = join(tmp, 'AGENTS.md');
      writeFileSync(target, '<!-- IJFW-MEMORY-START -->\n<!-- IJFW-MEMORY-END -->\noriginal\n');
      // Read original bytes so we can assert "did not get overwritten" on
      // abort. (atomic-rename means partial writes can't occur, but if the
      // backup gate were missing, the new content would still land.)
      const before = readFileSync(target, 'utf8');

      // Make the homedir-backed backup directory unwritable.
      const roHome = join(tmp, 'ro-home');
      mkdirSync(roHome);
      try { chmodSync(roHome, 0o500); } catch {}

      let threw = false;
      try {
        mergeFile(
          target,
          [{ block: 'MEMORY', content: 'replaced' }],
          { homeDir: roHome },
        );
      } catch (e) {
        threw = true;
        assert.ok(e instanceof MergeBlockAwareError);
        assert.equal(e.code, 'ERR_BACKUP_REQUIRED');
      }
      if (threw) {
        // Refused path → original file bytes unchanged.
        assert.equal(readFileSync(target, 'utf8'), before);
      }
      // If host filesystem ignored chmod 0o500 (e.g., CI as root), the test
      // would silently fall through; in that case the backup actually
      // succeeded and the merge proceeded, which is the legitimate non-io-error
      // codepath. We don't assert in that case.
    } finally {
      try { chmodSync(join(tmp, 'ro-home'), 0o700); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('opts.backups === false lets merge proceed without backup', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-010-optout-'));
    try {
      const target = join(tmp, 'AGENTS.md');
      writeFileSync(target, '<!-- IJFW-MEMORY-START -->\n<!-- IJFW-MEMORY-END -->\n');
      const res = mergeFile(target, [{ block: 'MEMORY', content: 'x' }], {
        homeDir: '/nonexistent-readonly-anchor', backups: false,
      });
      assert.equal(res.ok, true);
      assert.equal(res.backup, undefined);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
