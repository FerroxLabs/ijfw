import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateFactsInternalOnce } from '../../src/brain/migrate-facts-internal-once.js';

function fresh() { return mkdtempSync(join(tmpdir(), 'facts-mig-')); }

test('migrateFactsInternalOnce: fresh install (no source) -> skipped:false moved:[]', () => {
  const root = fresh();
  try {
    const r = migrateFactsInternalOnce(root);
    assert.equal(r.skipped, false);
    assert.deepEqual(r.moved, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateFactsInternalOnce: source files exist -> moved to internal paths', () => {
  const root = fresh();
  try {
    mkdirSync(join(root, '.ijfw', 'memory'), { recursive: true });
    writeFileSync(join(root, '.ijfw', 'memory', 'facts.jsonl'), '{"id":1}\n');
    writeFileSync(join(root, '.ijfw', 'memory', 'facts.db'), 'fake-sqlite-bytes');

    const r = migrateFactsInternalOnce(root);
    assert.equal(r.skipped, false);
    assert.equal(r.moved.length, 2);

    // New locations populated
    assert.ok(existsSync(join(root, '.ijfw', 'facts.jsonl')));
    assert.ok(existsSync(join(root, '.ijfw', 'index', 'memory.db')));
    // Old locations empty
    assert.ok(!existsSync(join(root, '.ijfw', 'memory', 'facts.jsonl')));
    assert.ok(!existsSync(join(root, '.ijfw', 'memory', 'facts.db')));
    // Content preserved
    assert.equal(readFileSync(join(root, '.ijfw', 'facts.jsonl'), 'utf8'), '{"id":1}\n');
    assert.equal(readFileSync(join(root, '.ijfw', 'index', 'memory.db'), 'utf8'), 'fake-sqlite-bytes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateFactsInternalOnce: idempotent — new path exists -> skipped', () => {
  const root = fresh();
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    writeFileSync(join(root, '.ijfw', 'facts.jsonl'), '{"id":2}\n');
    // Also seed an OLD jsonl that SHOULD NOT be touched (idempotency wins)
    mkdirSync(join(root, '.ijfw', 'memory'), { recursive: true });
    writeFileSync(join(root, '.ijfw', 'memory', 'facts.jsonl'), '{"id":3}\n');

    const r = migrateFactsInternalOnce(root);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'already-migrated');
    // Old file should NOT be touched on re-run
    assert.ok(existsSync(join(root, '.ijfw', 'memory', 'facts.jsonl')));
    // Content of new file unchanged
    assert.equal(readFileSync(join(root, '.ijfw', 'facts.jsonl'), 'utf8'), '{"id":2}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateFactsInternalOnce: only jsonl present (no db) -> moves jsonl only', () => {
  const root = fresh();
  try {
    mkdirSync(join(root, '.ijfw', 'memory'), { recursive: true });
    writeFileSync(join(root, '.ijfw', 'memory', 'facts.jsonl'), '{"id":4}\n');

    const r = migrateFactsInternalOnce(root);
    assert.equal(r.skipped, false);
    assert.equal(r.moved.length, 1);
    assert.ok(r.moved[0].to.endsWith('.ijfw/facts.jsonl'));
    assert.ok(existsSync(join(root, '.ijfw', 'facts.jsonl')));
    assert.ok(!existsSync(join(root, '.ijfw', 'index', 'memory.db')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateFactsInternalOnce: bad input (no repoRoot) -> skipped no-repo-root', () => {
  const r = migrateFactsInternalOnce();
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-repo-root');
});
