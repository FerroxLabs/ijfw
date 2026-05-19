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
  compareModelIds,
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

// --- v1.5.0 audit-H4.7: semver-aware sort (MED) -----------------------------

test('compareModelIds: gemini-10.0 sorts AFTER gemini-2.0 (semver, not lexical)', () => {
  // The original bug: lexical sort puts '10' before '2' because '1' < '2'.
  // Semver-aware sort must treat them as integers.
  const ids = ['gemini-2.0-pro', 'gemini-10.0-pro', 'gemini-3.5-pro'];
  const sorted = [...ids].sort(compareModelIds);
  assert.deepEqual(sorted, ['gemini-2.0-pro', 'gemini-3.5-pro', 'gemini-10.0-pro'],
    'sorted ascending: 2 < 3.5 < 10');
  // The picker uses the LAST element — verify the flagship resolves to 10.0.
  assert.equal(sorted[sorted.length - 1], 'gemini-10.0-pro');
});

test('compareModelIds: gemini-2.5-flash sits between gemini-2.0 and gemini-3.0', () => {
  const ids = ['gemini-3.0-pro', 'gemini-2.0-pro', 'gemini-2.5-flash'];
  const sorted = [...ids].sort(compareModelIds);
  assert.deepEqual(sorted, ['gemini-2.0-pro', 'gemini-2.5-flash', 'gemini-3.0-pro']);
});

test('compareModelIds: gemini-1.5-pro vs gemini-1.5-flash is deterministic', () => {
  // Same numeric prefix — tail tier name disambiguates lexically.
  // 'flash' < 'pro' alphabetically, so flash comes first.
  const a = compareModelIds('gemini-1.5-pro', 'gemini-1.5-flash');
  const b = compareModelIds('gemini-1.5-flash', 'gemini-1.5-pro');
  assert.ok(a > 0, 'pro > flash');
  assert.ok(b < 0, 'flash < pro (inverse is consistent)');
  // Run sort twice — must produce same result.
  const ids = ['gemini-1.5-pro', 'gemini-1.5-flash'];
  const s1 = [...ids].sort(compareModelIds);
  const s2 = [...ids].sort(compareModelIds);
  assert.deepEqual(s1, s2, 'sort is deterministic');
  assert.deepEqual(s1, ['gemini-1.5-flash', 'gemini-1.5-pro']);
});

test('refreshModelCache google probe uses semver sort (picks gemini-10.0 over gemini-2.5)', async () => {
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    // Simulate Google API returning a mix where lexical sort would pick '-2.5-pro'
    // (because '9' > '1' lexically at position 8 of the string) but semver-aware
    // sort should pick the actual highest version '-10.0-pro'.
    const fakeFetch = async (url) => {
      if (url.includes('googleapis')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'models/gemini-2.5-pro' },
              { name: 'models/gemini-9.5-pro' },
              { name: 'models/gemini-10.0-pro' },
              { name: 'models/gemini-3.1-pro' },
            ],
          }),
        };
      }
      return { ok: false };
    };
    const env2 = { ...env, GEMINI_API_KEY: 'g' };
    const result = await refreshModelCache({ env: env2, now: T0, fetch: fakeFetch });
    assert.equal(result.models.google.id, 'gemini-10.0-pro',
      'semver sort picks gemini-10.0-pro, not gemini-9.5-pro (lexical bug)');
  } finally { cleanup(); }
});

test('openai probe still resolves by created timestamp (not lexical) — regression guard', async () => {
  // OpenAI/Anthropic paths use numeric timestamps / ISO dates, not lexical
  // model-ID sort. This test pins that contract so a future refactor doesn't
  // accidentally re-introduce the bug class on those probes.
  const { env, cleanup } = mkEnv();
  try {
    _resetInflight();
    const fakeFetch = async (url) => {
      if (url.includes('openai')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'gpt-5.5', created: 100 },
              { id: 'gpt-5.10', created: 200 }, // higher created → flagship
              { id: 'gpt-5.2', created: 150 },
            ],
          }),
        };
      }
      if (url.includes('anthropic')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'claude-haiku-4-2-20260101', created_at: '2026-01-01' },
              { id: 'claude-haiku-4-10-20260301', created_at: '2026-03-01' },
              { id: 'claude-haiku-4-5-20260201', created_at: '2026-02-01' },
            ],
          }),
        };
      }
      return { ok: false };
    };
    const env2 = { ...env, OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'k' };
    const result = await refreshModelCache({ env: env2, now: T0, fetch: fakeFetch });
    assert.equal(result.models.openai.id, 'gpt-5.10',
      'openai picks highest created timestamp regardless of model-ID lexical order');
    assert.equal(result.models.anthropic.id, 'claude-haiku-4-10-20260301',
      'anthropic picks latest created_at ISO date regardless of model-ID lexical order');
  } finally { cleanup(); }
});
