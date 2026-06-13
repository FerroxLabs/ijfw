import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  hasProjectMarker,
  shouldSeedProject,
  PROJECT_MARKERS,
} from '../../src/brain/seed-gate.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'seed-gate-'));
}

test('hasProjectMarker: bare dir has no marker', () => {
  const d = freshDir();
  try {
    assert.equal(hasProjectMarker(d), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('hasProjectMarker: .git dir is a marker', () => {
  const d = freshDir();
  try {
    mkdirSync(join(d, '.git'));
    assert.equal(hasProjectMarker(d), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('hasProjectMarker: package.json is a marker', () => {
  const d = freshDir();
  try {
    writeFileSync(join(d, 'package.json'), '{}');
    assert.equal(hasProjectMarker(d), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('hasProjectMarker: ijfw init marker (.ijfw/project) blesses a signal-less dir', () => {
  const d = freshDir();
  try {
    mkdirSync(join(d, '.ijfw'), { recursive: true });
    writeFileSync(join(d, '.ijfw', 'project'), '# blessed');
    assert.equal(hasProjectMarker(d), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('hasProjectMarker: every declared marker is individually sufficient', () => {
  for (const m of PROJECT_MARKERS) {
    const d = freshDir();
    try {
      const parts = m.split('/');
      if (parts.length > 1) mkdirSync(join(d, ...parts.slice(0, -1)), { recursive: true });
      // .git / .hg / .svn are conventionally dirs, but existence is all we test.
      writeFileSync(join(d, ...parts), '');
      assert.equal(hasProjectMarker(d), true, `marker ${m} should be sufficient`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test('hasProjectMarker: defensive on bad input', () => {
  assert.equal(hasProjectMarker(''), false);
  assert.equal(hasProjectMarker(null), false);
  assert.equal(hasProjectMarker(undefined), false);
});

test('shouldSeedProject: bare temp dir is refused (the spam case)', () => {
  const d = freshDir();
  try {
    assert.equal(shouldSeedProject(d), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('shouldSeedProject: real project (has .git) is seeded', () => {
  const d = freshDir();
  try {
    mkdirSync(join(d, '.git'));
    assert.equal(shouldSeedProject(d), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('shouldSeedProject: refuses the home directory even with a marker', () => {
  // We never create markers in the real home dir; assert the home-root refusal
  // holds regardless of marker presence by pointing at homedir() directly.
  assert.equal(shouldSeedProject(homedir()), false);
});

test('shouldSeedProject: refuses the filesystem root', () => {
  assert.equal(shouldSeedProject('/'), false);
});

test('shouldSeedProject: defensive on bad input', () => {
  assert.equal(shouldSeedProject(''), false);
  assert.equal(shouldSeedProject(null), false);
});
