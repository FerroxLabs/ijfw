// v1.6.0 PERSONALIZATION S1 — MCP `initialize` instructions-field injection.
//
// The MCP `instructions` string is surfaced by hosts as ambient context the
// moment they connect: it is the cross-tool "it followed me" surface. This suite
// proves the field is GATED EXACTLY like the passive Resource read:
//   - present (the observed-pattern brief) ONLY when settings.profile.inject ===
//     'on' AND IJFW_PROFILE_KILL is not engaged;
//   - ABSENT when inject !== 'on' (default / "ask" / "off");
//   - ABSENT when IJFW_PROFILE_KILL is engaged (even with inject 'on');
//   - the brief carries STYLE/EXPERTISE bands, NEVER preference slugs (low-only).
//
// We drive the REAL server over stdio (a spawned `node src/server.js`) so the
// test exercises the actual JSON-RPC `initialize` path, including the
// Promise-return handling in the stdio transport. Profile + settings are
// isolated per test via IJFW_PROFILE_DIR + IJFW_HOME temp dirs (no real homedir
// writes), matching the store's path policy.
//
// renderSnapshot (the rules-file adapter surface S5 extends next wave) is unit-
// tested directly against the export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta } from '../src/profile/merge.js';
import { writeProfile } from '../src/profile/store.js';
import { renderSnapshot } from '../src/profile/render-brief.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '..', 'src', 'server.js');

/** A confirmed style axis (>=5 sessions of evidence — surfaces in the brief). */
function confirmedAxis(ema) {
  return { ema, alpha: 6, beta: 2, evidence_count: 6 };
}

/**
 * Run fn with a fresh IJFW_PROFILE_DIR (renderSnapshot's loadRedaction resolves
 * redact.txt under the profile dir, which the store refuses to default to under
 * a test context). Restores env after. Mirrors the suite-wide isolation pattern.
 */
async function withProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-s1-snap-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Seed an isolated HOME (settings.json) + PROFILE_DIR (profile.json), returning
 * the env the spawned server should run with. The profile carries a confirmed
 * style axis so a non-empty brief is possible when the gate is open.
 */
function seedEnv({ inject, kill } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ijfw-s1-home-'));
  const profileDir = mkdtempSync(join(tmpdir(), 'ijfw-s1-prof-'));

  // settings.json under IJFW_HOME — the gate reads s.profile.inject.
  const settings = inject === undefined ? {} : { profile: { inject } };
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings), 'utf8');

  // A profile with a confirmed style axis (terseness -> "terse"). Seed it via the
  // store's writeProfile so the on-disk format (serialized user-profile.md) is
  // byte-exactly what the spawned server's readProfile expects — a raw JSON dump
  // to the wrong filename would read back as a cold profile. The store resolves
  // its path from IJFW_PROFILE_DIR; we point it at profileDir for this one write
  // (this test process is under the node:test runner, so the tmpdir override is
  // honored), then restore.
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.95);
  const prevDir = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = profileDir;
  try {
    const w = writeProfile(p);
    assert.ok(w.ok, `seed writeProfile failed: ${w.code || ''} ${w.message || ''}`);
  } finally {
    if (prevDir === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prevDir;
  }

  const env = {
    ...process.env,
    IJFW_HOME: home,
    IJFW_PROFILE_DIR: profileDir,
    // The path policy (path-policy.js) only honors an IJFW_PROFILE_DIR override
    // that resolves UNDER homedir in production — a tmpdir override is rejected.
    // NODE_ENV=test flips inTestContext() so the spawned server honors the tmpdir
    // scratch dir verbatim, exactly as the policy's test carve-out intends.
    NODE_ENV: 'test',
    // Keep the spawned server out of the real repo's facts/migrations noise by
    // pointing REPO-rooted work at a temp cwd via the spawn cwd below; env here
    // only governs the profile + settings surfaces under test.
  };
  if (kill !== undefined) env.IJFW_PROFILE_KILL = kill;
  else delete env.IJFW_PROFILE_KILL;

  return { env, home, profileDir };
}

/**
 * Spawn the real server, send a single `initialize` request, resolve with the
 * parsed `result`. Cleans up the child and temp dirs.
 */
function initializeResult(seed) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ijfw-s1-cwd-'));
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: seed.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let settled = false;
    const cleanup = () => {
      try { child.kill('SIGKILL'); } catch {}
      for (const d of [seed.home, seed.profileDir, cwd]) {
        try { rmSync(d, { recursive: true, force: true }); } catch {}
      }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(rejectPromise, new Error('initialize timed out')),
      15000,
    );

    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      // One JSON object per line; find the response to id:1.
      let nl;
      while ((nl = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id === 1) {
          clearTimeout(timer);
          if (msg.error) finish(rejectPromise, new Error(msg.error.message));
          else finish(resolvePromise, msg.result);
          return;
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); finish(rejectPromise, e); });
    child.on('exit', (code) => {
      if (!settled) {
        clearTimeout(timer);
        finish(rejectPromise, new Error(`server exited (code ${code}) before responding`));
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    }) + '\n');
  });
}

// ---------------------------------------------------------------------------
// initialize `instructions` gate
// ---------------------------------------------------------------------------

test('S1: instructions PRESENT when inject==="on" (gate open)', async () => {
  const seed = seedEnv({ inject: 'on' });
  const result = await initializeResult(seed);
  // Base handshake fields untouched.
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(result.serverInfo.name, 'ijfw-memory');
  // The personalization surface: a non-empty observed-pattern brief.
  assert.equal(typeof result.instructions, 'string');
  assert.ok(result.instructions.length > 0, 'instructions should carry the brief');
  assert.match(result.instructions, /observed patterns/i);
  // STYLE band surfaced (terseness -> terse); NO preference slugs by default.
  assert.match(result.instructions, /terseness: terse/);
  assert.doesNotMatch(result.instructions, /Observed preference/);
});

test('S1: instructions ABSENT when inject!=="on" (default/off)', async () => {
  // No profile.inject key at all => default off.
  const seed = seedEnv({});
  const result = await initializeResult(seed);
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(result.instructions, undefined, 'no instructions when gate closed');
});

test('S1: instructions ABSENT when inject==="ask" (consent not granted)', async () => {
  const seed = seedEnv({ inject: 'ask' });
  const result = await initializeResult(seed);
  assert.equal(result.instructions, undefined);
});

test('S1: instructions ABSENT when IJFW_PROFILE_KILL engaged (even with inject on)', async () => {
  const seed = seedEnv({ inject: 'on', kill: '1' });
  const result = await initializeResult(seed);
  // Handshake still succeeds — the field is simply omitted.
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(result.instructions, undefined, 'kill-switch forces empty brief => field omitted');
});

test('S1: handshake never breaks when settings.json is missing entirely', async () => {
  // Seed then delete settings.json to simulate a brand-new install. The gate must
  // fail-closed (no instructions) but the initialize result must still be valid.
  const seed = seedEnv({ inject: 'on' });
  rmSync(join(seed.home, 'settings.json'), { force: true });
  const result = await initializeResult(seed);
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(result.instructions, undefined);
});

// ---------------------------------------------------------------------------
// renderSnapshot — rules-file adapter surface (S5 extends the preference seam)
// ---------------------------------------------------------------------------

test('renderSnapshot: emits flat style/expertise lines (no markdown header)', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.95); // terse
  p.global.style.formality = confirmedAxis(0.9);  // formal
  const { text, fields } = renderSnapshot(p, { env: {} });
  assert.match(text, /style\.terseness: terse/);
  assert.match(text, /style\.formality: formal/);
  // Flat plain-text — NOT the renderBrief markdown header/bullets.
  assert.doesNotMatch(text, /observed patterns/i);
  assert.doesNotMatch(text, /^- /m);
  assert.ok(fields.includes('style:terseness'));
  assert.ok(fields.includes('style:formality'));
}));

test('renderSnapshot: includePreferences seam is INERT in this slice (no pref content)', () => withProfileDir(() => {
  let p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.95);
  p = applyDelta(p, {
    inferences: [makeInference({
      kind: 'preference', subject: 'x', value: { phrase: 'concise replies' },
      confidence: 0.9, evidence_count: 5, sensitivity: 'low',
    })],
  });
  // Even with the seam flipped ON, NO preference content is emitted this slice.
  const on = renderSnapshot(p, { env: {}, includePreferences: true });
  const off = renderSnapshot(p, { env: {}, includePreferences: false });
  assert.equal(on.text, off.text, 'preference seam must be a no-op in S1');
  assert.doesNotMatch(on.text, /concise replies/);
  assert.ok(!on.fields.includes('preference::x'));
}));

test('renderSnapshot: cold-start (empty profile) yields empty snapshot', () => withProfileDir(() => {
  const { text, fields } = renderSnapshot(makeProfile(), { env: {} });
  assert.equal(text, '');
  assert.deepEqual(fields, []);
}));

test('renderSnapshot: kill-switch yields empty snapshot', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = confirmedAxis(0.95);
  const { text, fields } = renderSnapshot(p, { env: { IJFW_PROFILE_KILL: '1', IJFW_PROFILE_DIR: process.env.IJFW_PROFILE_DIR } });
  assert.equal(text, '');
  assert.deepEqual(fields, []);
}));

test('renderSnapshot: unconfirmed style axis is omitted (earned-signal only)', () => withProfileDir(() => {
  const p = makeProfile();
  p.global.style.terseness = { ema: 0.95, alpha: 2, beta: 1, evidence_count: 2 }; // <5 sessions
  const { text, fields } = renderSnapshot(p, { env: {} });
  assert.equal(text, '');
  assert.deepEqual(fields, []);
}));
