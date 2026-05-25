import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, isIjfwProject, scanFilesystem, discoverProjects } from '../../src/brain/discovery.js';

function fresh() { return mkdtempSync(join(tmpdir(), 'brain-disc-')); }

test('readRegistry: missing file -> []', () => {
  const home = fresh();
  try { assert.deepEqual(readRegistry(home), []); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test('readRegistry: parses "- [name](path)" entries', () => {
  const home = fresh();
  try {
    mkdirSync(join(home, '.ijfw'), { recursive: true });
    writeFileSync(join(home, '.ijfw', 'registry.md'),
      '# Registry\n- [ijfw](/Users/x/ijfw)\n- [paperclip](/Users/x/paperclip)\nnot-a-list-item\n');
    const r = readRegistry(home);
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((e) => e.name), ['ijfw', 'paperclip']);
    for (const e of r) assert.equal(e.fromRegistry, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('isIjfwProject: v2 wins over legacy', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, '.ijfw'), { recursive: true });
    assert.deepEqual(isIjfwProject(dir), { kind: 'legacy', migrate: true });
    mkdirSync(join(dir, 'ijfw'), { recursive: true });
    assert.deepEqual(isIjfwProject(dir), { kind: 'v2', migrate: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isIjfwProject: neither marker -> null', () => {
  const dir = fresh();
  try { assert.equal(isIjfwProject(dir), null); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanFilesystem: finds projects, skips node_modules + dotdirs, stops at marker', () => {
  const root = fresh();
  try {
    // dev/project-a (v2)
    mkdirSync(join(root, 'dev', 'project-a', 'ijfw'), { recursive: true });
    mkdirSync(join(root, 'dev', 'project-a', 'src', 'should-not-be-walked'), { recursive: true });
    // dev/project-b (legacy)
    mkdirSync(join(root, 'dev', 'project-b', '.ijfw'), { recursive: true });
    // dev/.hidden (skipped)
    mkdirSync(join(root, 'dev', '.hidden'), { recursive: true });
    // dev/node_modules (skipped)
    mkdirSync(join(root, 'dev', 'node_modules', 'fake-dep'), { recursive: true });
    // dev/non-project (no markers, no descendants)
    mkdirSync(join(root, 'dev', 'non-project'), { recursive: true });
    const found = scanFilesystem([root]);
    const names = found.map((f) => f.name).sort();
    assert.deepEqual(names, ['project-a', 'project-b']);
    const a = found.find((f) => f.name === 'project-a');
    assert.equal(a.kind, 'v2');
    const b = found.find((f) => f.name === 'project-b');
    assert.equal(b.kind, 'legacy');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverProjects: registry wins on duplicate path', () => {
  const home = fresh();
  const projects = fresh();
  try {
    // Create one project that the registry references AND the scan finds
    mkdirSync(join(projects, 'ijfw'), { recursive: true });
    mkdirSync(join(home, '.ijfw'), { recursive: true });
    writeFileSync(join(home, '.ijfw', 'registry.md'), `- [my-proj](${projects})\n`);
    const merged = discoverProjects({ homeDir: home, scanRoots: [projects] });
    // The same path appears once, marked fromRegistry true
    const entries = merged.filter((m) => m.path === projects);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fromRegistry, true);
    assert.equal(entries[0].name, 'my-proj');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
