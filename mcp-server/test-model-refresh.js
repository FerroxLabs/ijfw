import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  CACHE_SCHEMA,
  TTL_MS,
  HARDCODED_FALLBACKS,
  cachePath,
  isCacheFresh,
  readCache,
  writeCache,
  getLatestModel,
  refreshModelCache,
  _resetInflight,
} from './src/model-refresh.js';

const T0 = new Date('2026-05-18T12:00:00.000Z').getTime();

function mkEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'model-refresh-'));
  return { env: { IJFW_CACHE_DIR: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('isCacheFresh: within TTL → true; past TTL → false; missing → false', () => {
  const ts = new Date(T0 - (TTL_MS - 1000)).toISOString(); // 24h - 1s ago
  assert.equal(isCacheFresh(ts, T0), true);
  const stale = new Date(T0 - (TTL_MS + 1000)).toISOString();
  assert.equal(isCacheFresh(stale, T0), false);
  assert.equal(isCacheFresh(null, T0), false);
  assert.equal(isCacheFresh('not-a-date', T0), false);
});

test('getLatestModel returns HARDCODED_FALLBACKS when no cache exists', () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    // Inject a no-op fetch so the background refresh kicks off but does nothing.
    const noopFetch = async () => ({ ok: false });
    assert.equal(getLatestModel('openai', { env, now: T0, fetch: noopFetch }), HARDCODED_FALLBACKS.openai);
    assert.equal(getLatestModel('google', { env, now: T0, fetch: noopFetch }), HARDCODED_FALLBACKS.google);
    assert.equal(getLatestModel('anthropic', { env, now: T0, fetch: noopFetch }), HARDCODED_FALLBACKS.anthropic);
  } finally { cleanup(); }
});

test('getLatestModel returns cached value when cache is fresh', () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    writeCache({
      schema: CACHE_SCHEMA,
      updated_at: new Date(T0 - 60_000).toISOString(), // 1 min ago — fresh
      models: { openai: { id: 'gpt-7-canary', checked_at: '...' } },
    }, env);
    const v = getLatestModel('openai', { env, now: T0, fetch: async () => { throw new Error('should not probe when fresh'); } });
    assert.equal(v, 'gpt-7-canary');
  } finally { cleanup(); }
});

test('getLatestModel triggers background refresh when cache is stale', async () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    writeCache({
      schema: CACHE_SCHEMA,
      updated_at: new Date(T0 - (TTL_MS + 60_000)).toISOString(), // 24h+1min ago
      models: { openai: { id: 'gpt-old', checked_at: '...' } },
    }, env);

    let probed = false;
    const fakeFetch = async (url) => {
      probed = true;
      if (url.includes('openai')) {
        return { ok: true, json: async () => ({ data: [{ id: 'gpt-5.9', created: 9 }] }) };
      }
      return { ok: false };
    };

    // Synchronous call returns the stale value immediately.
    const env2 = { ...env, OPENAI_API_KEY: 'sk-test' };
    const v = getLatestModel('openai', { env: env2, now: T0, fetch: fakeFetch });
    assert.equal(v, 'gpt-old', 'stale value returned synchronously');

    // Background refresh should have fired. Wait for it.
    await new Promise(r => setTimeout(r, 50));
    assert.equal(probed, true, 'background probe fired');

    // Next call sees the fresh value.
    const v2 = getLatestModel('openai', { env: env2, now: T0, fetch: fakeFetch });
    assert.equal(v2, 'gpt-5.9', 'fresh value returned on next call');
  } finally { cleanup(); }
});

test('refreshModelCache writes well-formed JSON with timestamp', async () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    const fakeFetch = async (url, opts) => {
      if (url.includes('openai')) return { ok: true, json: async () => ({ data: [{ id: 'gpt-5.5', created: 1 }] }) };
      if (url.includes('anthropic')) return { ok: true, json: async () => ({ data: [{ id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01' }] }) };
      if (url.includes('googleapis')) return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-3.1-pro' }, { name: 'models/gemini-2.5-pro' }] }) };
      return { ok: false };
    };
    const env2 = { ...env, OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'g' };
    const result = await refreshModelCache({ env: env2, now: T0, fetch: fakeFetch });

    assert.equal(result.schema, CACHE_SCHEMA);
    assert.equal(result.updated_at, new Date(T0).toISOString());
    assert.equal(result.models.openai.id, 'gpt-5.5');
    assert.equal(result.models.anthropic.id, 'claude-haiku-4-5-20251001');
    assert.equal(result.models.google.id, 'gemini-3.1-pro');

    const onDisk = JSON.parse(readFileSync(cachePath(env2), 'utf8'));
    assert.deepEqual(onDisk, result);
  } finally { cleanup(); }
});

test('refreshModelCache handles provider HTTP failure gracefully (keeps prior value)', async () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    // Seed cache with a prior known-good openai value.
    writeCache({
      schema: CACHE_SCHEMA,
      updated_at: new Date(T0 - 60_000).toISOString(),
      models: { openai: { id: 'gpt-5.5-prior', checked_at: '...' } },
    }, env);
    const fakeFetch = async () => ({ ok: false, status: 503 });
    const env2 = { ...env, OPENAI_API_KEY: 'sk' };
    const result = await refreshModelCache({ env: env2, now: T0, fetch: fakeFetch });
    assert.equal(result.models.openai.id, 'gpt-5.5-prior', 'prior value preserved on probe failure');
  } finally { cleanup(); }
});

test('refreshModelCache skips provider when API key absent', async () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    let openaiCalled = false;
    const fakeFetch = async (url) => {
      if (url.includes('openai')) openaiCalled = true;
      return { ok: true, json: async () => ({ data: [] }) };
    };
    // No OPENAI_API_KEY in env
    await refreshModelCache({ env, now: T0, fetch: fakeFetch });
    assert.equal(openaiCalled, false, 'openai probe skipped when key absent');
  } finally { cleanup(); }
});

test('writeCache is atomic — partial write does not corrupt cache', () => {
  const { env, cleanup } = mkEnv();
  try {
    // Initial good cache
    writeCache({ schema: CACHE_SCHEMA, updated_at: '2026-01-01T00:00:00Z', models: { openai: { id: 'good', checked_at: '...' } } }, env);
    const before = readCache(env);
    assert.equal(before.models.openai.id, 'good');

    // Simulate a tmp file from a crashed prior write — should NOT be picked up by read.
    const p = cachePath(env);
    writeFileSync(`${p}.tmp.99999.0`, '{"partial": "broken"}');
    const after = readCache(env);
    assert.equal(after.models.openai.id, 'good', 'reader ignores tmp files');
  } finally { cleanup(); }
});

test('readCache returns null on malformed JSON', () => {
  const { env, cleanup } = mkEnv();
  try {
    const p = cachePath(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'not-json{');
    assert.equal(readCache(env), null);
  } finally { cleanup(); }
});

test('readCache returns null when schema version mismatches', () => {
  const { env, cleanup } = mkEnv();
  try {
    writeCache({ schema: 999, updated_at: '2026-01-01T00:00:00Z', models: {} }, env);
    assert.equal(readCache(env), null, 'unknown schema is rejected');
  } finally { cleanup(); }
});

test('getLatestModel returns null for unknown family', () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    const noopFetch = async () => ({ ok: false });
    assert.equal(getLatestModel('mistral', { env, now: T0, fetch: noopFetch }), null);
  } finally { cleanup(); }
});
