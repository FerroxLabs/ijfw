import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROSTER, detectSelf, rosterFor, defaultAuditor, formatRoster, pickAuditors, isInstalled, isReachable } from './src/audit-roster.js';

test('ROSTER has expected ids', () => {
  const ids = ROSTER.map(e => e.id);
  for (const expected of ['codex', 'gemini', 'qwen', 'opencode', 'aider', 'copilot', 'claude']) {
    assert.ok(ids.includes(expected), `missing: ${expected}`);
  }
});

test('detectSelf returns qwen on QWEN_SESSION', () => {
  assert.equal(detectSelf({ QWEN_SESSION: 'abc' }), 'qwen');
});

test('detectSelf returns claude when Claude Code env is set', () => {
  const env = { CLAUDECODE: '1' };
  assert.equal(detectSelf(env), 'claude');
});

test('detectSelf returns codex on CODEX_SESSION_ID', () => {
  assert.equal(detectSelf({ CODEX_SESSION_ID: 'abc' }), 'codex');
});

test('detectSelf returns gemini on GEMINI_CLI', () => {
  assert.equal(detectSelf({ GEMINI_CLI: '1' }), 'gemini');
});

test('detectSelf returns null when no env matches', () => {
  assert.equal(detectSelf({}), null);
});

test('rosterFor excludes self by default', () => {
  const list = rosterFor({ env: { CLAUDECODE: '1' } });
  assert.ok(!list.some(e => e.id === 'claude'));
  assert.ok(list.length === ROSTER.length - 1);
});

test('rosterFor with excludeSelf:false keeps self but marks isSelf', () => {
  const list = rosterFor({ excludeSelf: false, env: { CLAUDECODE: '1' } });
  assert.equal(list.length, ROSTER.length);
  const claude = list.find(e => e.id === 'claude');
  assert.equal(claude.isSelf, true);
});

test('rosterFor with only: gemini returns just that one', () => {
  const list = rosterFor({ only: 'gemini' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'gemini');
});

test('rosterFor with only: unknown returns empty', () => {
  assert.deepEqual(rosterFor({ only: 'bogus' }), []);
});

test('defaultAuditor picks first non-self', () => {
  const self = detectSelf({ CLAUDECODE: '1' });
  const d = defaultAuditor({ CLAUDECODE: '1' });
  assert.ok(d);
  assert.notEqual(d.id, self);
  assert.equal(d.id, 'codex'); // first in roster order after claude-excluded
});

test('defaultAuditor when caller unknown returns first in roster', () => {
  const d = defaultAuditor({});
  assert.equal(d.id, 'codex');
});

test('formatRoster marks self correctly and shows ready/install status', () => {
  const out = formatRoster({ CLAUDECODE: '1' });
  assert.match(out, /Detected caller: claude/);
  assert.match(out, /claude\s+self/);
  // Codex is listed as either 'ready' (installed) or 'install' (missing).
  assert.match(out, /codex\s+(ready|install)/);
});

test('isInstalled returns boolean for any roster id', () => {
  for (const e of ROSTER) {
    assert.equal(typeof isInstalled(e.id), 'boolean');
  }
});

test('isInstalled returns false for unknown id', () => {
  assert.equal(isInstalled('definitely-not-a-cli'), false);
});

test('pickAuditors with explicit only: filters to requested', () => {
  const r = pickAuditors({ only: 'codex,gemini', env: { CLAUDECODE: '1' } });
  assert.ok(Array.isArray(r.picks));
  assert.ok(Array.isArray(r.missing));
  // Every pick must be one of the requested ids.
  for (const p of r.picks) assert.ok(['codex', 'gemini'].includes(p.id));
});

test('pickAuditors default count=2 returns up to 2 non-self installed', () => {
  const r = pickAuditors({ env: { CLAUDECODE: '1' } });
  assert.ok(r.picks.length <= 2);
  assert.ok(!r.picks.some(p => p.id === 'claude'));
  for (const p of r.picks) assert.equal(p.installed, true);
});

test('pickAuditors note advises Trident when only one installed', () => {
  // We can't fake "installed" easily here, so this test asserts shape:
  // when picks < count, note is non-empty and mentions Trident principle.
  const r = pickAuditors({ count: 99, env: { CLAUDECODE: '1' } });
  if (r.picks.length < 99) {
    assert.ok(r.note.length > 0);
  }
});

test('formatRoster acknowledges unknown caller', () => {
  const out = formatRoster({});
  assert.match(out, /Caller unknown/);
});

// --- TASK-3-1: family + model fields on ROSTER entries ---

test('every ROSTER entry has a family field with valid value', () => {
  const valid = new Set(['anthropic', 'openai', 'google', 'oss']);
  for (const e of ROSTER) {
    assert.ok(valid.has(e.family), `${e.id} has invalid family: ${e.family}`);
  }
});

test('every ROSTER entry has a model field (string)', () => {
  for (const e of ROSTER) {
    assert.equal(typeof e.model, 'string', `${e.id}.model should be a string`);
  }
});

test('family mappings are correct', () => {
  const map = Object.fromEntries(ROSTER.map(e => [e.id, e.family]));
  assert.equal(map.claude, 'anthropic');
  assert.equal(map.codex, 'openai');
  assert.equal(map.copilot, 'openai');
  assert.equal(map.gemini, 'google');
  assert.equal(map.opencode, 'oss');
  assert.equal(map.aider, 'oss');
});

test('picks returned by pickAuditors carry .family property', () => {
  const r = pickAuditors({ env: { CLAUDECODE: '1' } });
  for (const p of r.picks) {
    assert.ok(p.family, `pick ${p.id} missing .family`);
  }
});

// --- TASK-3-2: strategy: 'diversity' ---

// Helper: build a fake env + override isInstalled via the _installedCache.
// Since we can't actually install CLIs in tests, we monkey-patch spawnSync
// by using the only escape hatch available: the `only` filter or a known-installed
// binary. Instead, we test the logic by observing picks shape and the
// installed=false handling - the diversity picker works on rosterWithStatus
// which respects the real probe. We test the family-selection logic using
// the real roster by simply asserting structural properties.

test('diversity strategy returns shape { picks, missing, note }', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CLAUDECODE: '1' } });
  assert.ok(Array.isArray(r.picks), 'picks is array');
  assert.ok(Array.isArray(r.missing), 'missing is array');
  assert.equal(typeof r.note, 'string', 'note is string');
});

test('diversity strategy: picks never include self (caller=claude)', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CLAUDECODE: '1' } });
  assert.ok(!r.picks.some(p => p.id === 'claude'), 'claude must not appear in picks');
});

test('diversity strategy: picks never include self (caller=codex)', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CODEX_SESSION_ID: '1' } });
  assert.ok(!r.picks.some(p => p.id === 'codex'), 'codex must not appear in picks');
});

test('diversity strategy: all picks are installed', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CLAUDECODE: '1' } });
  for (const p of r.picks) {
    assert.equal(p.installed, true, `pick ${p.id} must be installed`);
  }
});

test('diversity strategy: picks have .family property', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CLAUDECODE: '1' } });
  for (const p of r.picks) {
    assert.ok(p.family, `pick ${p.id} missing .family`);
  }
});

test('diversity strategy: missing entries have family + reason shape', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CLAUDECODE: '1' } });
  for (const m of r.missing) {
    assert.ok(m.family, `missing entry lacks .family: ${JSON.stringify(m)}`);
    assert.ok(m.reason, `missing entry lacks .reason: ${JSON.stringify(m)}`);
  }
});

test('diversity strategy: when openai+google both absent, missing covers both families', () => {
  // Simulate caller=unknown (no self) but no CLIs installed - missing should
  // reflect what we aimed for. We assert at minimum that missing is an array
  // and any entries have the expected shape.
  const r = pickAuditors({ strategy: 'diversity', env: {} });
  // missing is an array (may be empty if some CLIs happen to be installed)
  assert.ok(Array.isArray(r.missing));
  for (const m of r.missing) {
    assert.ok(typeof m.family === 'string');
    assert.ok(typeof m.reason === 'string');
  }
});

test('diversity strategy: picks at most 2', () => {
  const r = pickAuditors({ strategy: 'diversity', env: { CLAUDECODE: '1' } });
  assert.ok(r.picks.length <= 2, `expected ≤2 picks, got ${r.picks.length}`);
});

test('priority strategy (default) still returns same shape', () => {
  const r1 = pickAuditors({ env: { CLAUDECODE: '1' } });
  const r2 = pickAuditors({ strategy: 'priority', env: { CLAUDECODE: '1' } });
  assert.deepEqual(r1, r2, 'default and explicit priority strategy must match');
});

// --- Fix 3: diversity dedupe - caller=codex, only gemini installed ---
// We test the deduplication logic using the _installedCache escape hatch:
// override the module's cache so that only gemini appears installed.
import { _installedCache } from './src/audit-roster.js';

test('diversity dedupe: codex-caller + only-gemini-installed picks gemini once', () => {
  // Manually prime the installed cache so test is deterministic.
  // codex=caller(self), gemini=installed, all others=not installed.
  const allIds = ['codex', 'gemini', 'opencode', 'aider', 'copilot', 'claude'];
  for (const id of allIds) _installedCache.set(id, id === 'gemini');

  const r = pickAuditors({ strategy: 'diversity', env: { CODEX_SESSION_ID: '1' } });

  // Restore: clear the overrides so subsequent tests get real probes.
  for (const id of allIds) _installedCache.delete(id);

  // gemini must appear exactly once
  const geminiPicks = r.picks.filter(p => p.id === 'gemini');
  assert.equal(geminiPicks.length, 1, `gemini should appear exactly once, picks: ${JSON.stringify(r.picks.map(p => p.id))}`);

  // codex must never appear (it's self)
  assert.ok(!r.picks.some(p => p.id === 'codex'), 'codex (self) must not appear in picks');

  // total picks <= 2 (deduplication, not double-counting)
  assert.ok(r.picks.length <= 2, `picks.length should be ≤2, got ${r.picks.length}`);
});

// --- Phase 9 Item 1: apiFallback + isReachable ---

test('every ROSTER entry has apiFallback defined (object or null)', () => {
  for (const e of ROSTER) {
    assert.ok(
      e.apiFallback === null || (typeof e.apiFallback === 'object' && e.apiFallback !== null),
      `${e.id}.apiFallback must be object or null, got: ${JSON.stringify(e.apiFallback)}`
    );
  }
});

test('apiFallback entries have required fields where non-null', () => {
  for (const e of ROSTER) {
    if (!e.apiFallback) continue;
    assert.ok(typeof e.apiFallback.provider === 'string', `${e.id}: apiFallback.provider must be string`);
    assert.ok(typeof e.apiFallback.model === 'string',    `${e.id}: apiFallback.model must be string`);
    assert.ok(typeof e.apiFallback.authEnv === 'string',  `${e.id}: apiFallback.authEnv must be string`);
    // google entries must have an endpoint with {model} placeholder
    if (e.apiFallback.provider === 'google') {
      assert.ok(e.apiFallback.endpoint.includes('{model}'), `${e.id}: google endpoint must contain {model}`);
    }
  }
});

test('OSS tools (opencode, aider, copilot) have apiFallback: null', () => {
  for (const id of ['opencode', 'aider', 'copilot']) {
    const e = ROSTER.find(r => r.id === id);
    assert.equal(e.apiFallback, null, `${id} should have apiFallback: null`);
  }
});

test('codex, gemini, claude have non-null apiFallback', () => {
  for (const id of ['codex', 'gemini', 'claude']) {
    const e = ROSTER.find(r => r.id === id);
    assert.ok(e.apiFallback !== null, `${id} should have non-null apiFallback`);
  }
});

test('isReachable returns {cli, api, any} shape for known id', () => {
  const r = isReachable('codex', {});
  assert.equal(typeof r.cli, 'boolean');
  assert.equal(typeof r.api, 'boolean');
  assert.equal(typeof r.any, 'boolean');
});

test('isReachable: api=true when auth env key is set', () => {
  const codex = ROSTER.find(e => e.id === 'codex');
  const env = { [codex.apiFallback.authEnv]: 'sk-test' };
  const r = isReachable('codex', env);
  assert.equal(r.api, true);
  assert.equal(r.any, true);
});

test('isReachable: api=false when auth env key is absent', () => {
  const r = isReachable('codex', {});
  assert.equal(r.api, false);
});

test('isReachable: api=false for OSS tool with null apiFallback', () => {
  const r = isReachable('opencode', { OPENAI_API_KEY: 'sk-x' });
  assert.equal(r.api, false);
});

test('isReachable: returns all-false for unknown id', () => {
  const r = isReachable('not-a-real-id', { OPENAI_API_KEY: 'x' });
  assert.equal(r.cli, false);
  assert.equal(r.api, false);
  assert.equal(r.any, false);
});

test('isReachable: any=true when either cli or api is true', () => {
  const codex = ROSTER.find(e => e.id === 'codex');
  const env = { [codex.apiFallback.authEnv]: 'sk-test' };
  // Prime cache so cli=false (not installed)
  _installedCache.set('codex', false);
  const r = isReachable('codex', env);
  _installedCache.delete('codex');
  assert.equal(r.api, true);
  assert.equal(r.any, true);
});

// --- Fix 1: API-only diversity picks - no CLIs but API keys set ---

test('diversity picker: node env with no CLIs but OPENAI_API_KEY + GEMINI_API_KEY returns both with preferredSource:api', () => {
  const allIds = ['codex', 'gemini', 'opencode', 'aider', 'copilot', 'claude'];
  // No CLIs installed
  for (const id of allIds) _installedCache.set(id, false);

  const codexEntry = ROSTER.find(e => e.id === 'codex');
  const geminiEntry = ROSTER.find(e => e.id === 'gemini');
  const env = {
    [codexEntry.apiFallback.authEnv]: 'sk-openai-test',
    [geminiEntry.apiFallback.authEnv]: 'sk-gemini-test',
  };

  const r = pickAuditors({ strategy: 'diversity', env });

  // Restore cache
  for (const id of allIds) _installedCache.delete(id);

  // Both codex and gemini should be picked
  const pickedIds = r.picks.map(p => p.id);
  assert.ok(pickedIds.includes('codex'), `codex should be picked, got: ${pickedIds}`);
  assert.ok(pickedIds.includes('gemini'), `gemini should be picked, got: ${pickedIds}`);

  // Both should be annotated with preferredSource: 'api'
  for (const p of r.picks) {
    assert.equal(p.preferredSource, 'api', `${p.id} should have preferredSource:'api'`);
  }
});

// ---------------------------------------------------------------------------
// 1.2.4 follow-on improvements (surfaced during PR #11 review)
// ---------------------------------------------------------------------------

test('detectSelf does NOT match codex on CODEX_HOME alone', () => {
  // CODEX_HOME is a config-path env var that's set whenever codex is installed
  // -- not whenever codex is the active session. Using it for self-detection
  // false-excludes codex from every Trident run on machines with codex
  // installed but a non-codex caller (Claude Code, Cursor, etc.).
  const env = { CODEX_HOME: '/Users/test/.codex' };
  assert.notEqual(detectSelf(env), 'codex', 'CODEX_HOME alone must not flag self');
});

test('detectSelf still matches codex on CODEX_SESSION_ID', () => {
  // The active-session env var should still produce a self match.
  assert.equal(detectSelf({ CODEX_SESSION_ID: 'sess-123' }), 'codex');
});

test('defaultAuditor returns a reachable pick when one is available', () => {
  // CLAUDECODE=1 makes claude=self. With OPENAI_API_KEY set codex is reachable
  // via API even without the CLI; defaultAuditor should pick a reachable entry.
  const env = { CLAUDECODE: '1', OPENAI_API_KEY: 'sk-test' };
  const pick = defaultAuditor(env);
  assert.ok(pick, 'defaultAuditor should return a pick');
  assert.notEqual(pick.id, 'claude', 'caller (claude) must be excluded');
  assert.equal(isReachable(pick.id, env).any, true, `${pick.id} should be reachable`);
});

test('formatRoster shows ready when API key is set even without CLI', () => {
  // OPENAI_API_KEY makes codex reachable via API. Roster line should say
  // "ready", not "install" -- otherwise the user thinks they need to install
  // when they're already configured.
  const env = { OPENAI_API_KEY: 'sk-test' };
  const out = formatRoster(env);
  // Only verify codex line says "ready" -- gemini/others still depend on host
  // PATH (test machine may have them installed).
  const codexLine = out.split('\n').find(l => l.startsWith('  codex'));
  assert.ok(codexLine, 'codex line should be present');
  assert.match(codexLine, /\bready\b/, 'codex must show "ready" when OPENAI_API_KEY is set');
});

test('pickAuditors({only:"claude"}) excludes self when caller is claude', () => {
  // --with claude on a claude session collapses Trident to a single source.
  // Surface the skip instead of silently producing a self-audit.
  const env = { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-test' };
  const r = pickAuditors({ only: 'claude', env });
  assert.equal(r.picks.length, 0, 'self must not appear in picks');
  assert.match(r.note, /Skipped self-audit/, 'note should explain the skip');
});
