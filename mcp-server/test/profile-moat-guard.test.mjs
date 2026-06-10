// PHASE P4.5 — MOAT GUARD (load-bearing).
//
// The profile-bus moat: the SERVE / READ path must make ZERO LLM calls. Two
// independent guards prove it:
//
//   (a) IMPORT-GRAPH (static) — statically resolve the TRANSITIVE imports of
//       serve.js + render-brief.js and assert the reachable set NEVER includes
//       the LLM-capable modules (tiered-llm.js, derive-dialectic.js, derive.js).
//       This catches a leak at SOURCE: if anyone wires an LLM module into the
//       serve path, this test fails before any call is ever made. A static walk
//       (not a runtime mock) is the right tool because it cannot be fooled by a
//       code path that "happens not to execute" in a given test.
//
//   (b) ZERO-LLM-ON-READ (runtime) — call profile.get / profile.brief across
//       cold / stale / warm profiles with an LLM/network caller injected that
//       THROWS on any invocation. The serve path must complete without ever
//       tripping it. Belt-and-braces over the static guard.
//
// If this test fails, the moat is breached — do not weaken it; fix the import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta } from '../src/profile/merge.js';
import { writeProfile } from '../src/profile/store.js';
import { profileGet, profileBrief } from '../src/profile/serve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'src');
const PROFILE_DIR = join(SRC, 'profile');
const HANDLERS_DIR = join(SRC, 'handlers');

// The LLM-capable modules the serve path must NEVER reach (by absolute path so
// a basename collision elsewhere can't accidentally satisfy/violate the check).
const FORBIDDEN = [
  resolve(SRC, 'brain', 'tiered-llm.js'),
  resolve(SRC, 'profile', 'derive-dialectic.js'),
  resolve(SRC, 'profile', 'derive.js'),
];

/**
 * Extract every static + dynamic import specifier from a source file. Matches:
 *   - import ... from '<spec>'    (static, all forms)
 *   - export ... from '<spec>'    (re-export)
 *   - import('<spec>')            (dynamic)
 * Comments inside the JSDoc don't match because they lack the `from '...'` /
 * `import('...')` syntactic shape — this is a deliberately conservative lexical
 * scan, good enough to map the module graph of this dependency-light codebase.
 */
function extractSpecifiers(source) {
  const specs = new Set();
  const fromRe = /(?:^|[\s;}])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = fromRe.exec(source)) !== null) specs.add(m[1]);
  while ((m = dynRe.exec(source)) !== null) specs.add(m[1]);
  return [...specs];
}

/** Resolve a relative specifier from a file; null for bare/node: specifiers. */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // node: builtin or bare pkg — not in our graph
  let p = resolve(dirname(fromFile), spec);
  if (existsSync(p)) return p;
  if (existsSync(`${p}.js`)) return `${p}.js`;
  if (existsSync(join(p, 'index.js'))) return join(p, 'index.js');
  return p; // best-effort; a missing file simply has no further edges
}

/**
 * Walk the transitive import graph from `entries`, returning the set of absolute
 * file paths reachable (entries included).
 */
function reachableFrom(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable / non-file node — no outgoing edges
    }
    for (const spec of extractSpecifiers(source)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// (a) IMPORT-GRAPH — static proof the serve path never reaches the LLM tier.
// ---------------------------------------------------------------------------

test('P4.5(a) serve.js + render-brief.js NEVER transitively import the LLM tier', () => {
  const entries = [
    join(PROFILE_DIR, 'serve.js'),
    join(PROFILE_DIR, 'render-brief.js'),
  ];
  const reachable = reachableFrom(entries);

  for (const forbidden of FORBIDDEN) {
    assert.ok(
      !reachable.has(forbidden),
      `MOAT BREACH: the serve path transitively imports ${forbidden}. `
      + 'The profile read/serve path must be ZERO-LLM — remove the import.',
    );
  }
});

test('P4.5(a) the walker is sound: it DOES find a known-reachable module', () => {
  // Sanity check the walker isn't silently returning an empty/under-populated
  // set (which would make the forbidden-absence assertion vacuously pass).
  const reachable = reachableFrom([join(PROFILE_DIR, 'serve.js')]);
  assert.ok(reachable.has(join(PROFILE_DIR, 'store.js')), 'serve.js must reach store.js');
  assert.ok(reachable.has(join(PROFILE_DIR, 'render-brief.js')), 'serve.js must reach render-brief.js');
  assert.ok(reachable.has(join(PROFILE_DIR, 'egress.js')), 'serve.js must reach egress.js');
  assert.ok(reachable.has(join(PROFILE_DIR, 'sensitivity.js')), 'serve.js must reach sensitivity.js');
});

test('P4.5(a) the walker is sound: a CONTROL entrypoint DOES reach the LLM tier', () => {
  // derive.js is the LLM-capable composition module. Walking from it MUST find
  // derive-dialectic.js — proving the walker can detect a forbidden edge when
  // one genuinely exists (else the serve-path assertion proves nothing).
  const reachable = reachableFrom([join(PROFILE_DIR, 'derive.js')]);
  assert.ok(
    reachable.has(resolve(PROFILE_DIR, 'derive-dialectic.js')),
    'control: derive.js must reach derive-dialectic.js (walker can see forbidden edges)',
  );
});

test('P4.5(a) the brain-handler profile verbs route only through the serve moat', () => {
  // The verbs are folded into brain-handler.js; confirm the handler reaches the
  // serve module but the serve module itself stays clean (already asserted).
  // This guards against a future refactor that bypasses serve.js and wires a
  // profile verb straight into an LLM-capable derive module.
  const handler = join(HANDLERS_DIR, 'brain-handler.js');
  const source = readFileSync(handler, 'utf8');
  const specs = extractSpecifiers(source);
  // The handler must import the serve module for the profile verbs...
  assert.ok(specs.some((s) => s.endsWith('/profile/serve.js')), 'brain-handler must import profile/serve.js');
  // ...and must NOT import any LLM-capable profile derive module directly.
  assert.ok(!specs.some((s) => s.endsWith('/profile/derive.js')), 'brain-handler must not import profile/derive.js');
  assert.ok(!specs.some((s) => s.endsWith('/profile/derive-dialectic.js')), 'brain-handler must not import profile/derive-dialectic.js');
});

// ---------------------------------------------------------------------------
// (b) ZERO-LLM-ON-READ — runtime proof across cold / stale / warm.
// ---------------------------------------------------------------------------

/** An LLM/network caller that detonates on ANY call. */
function explodingLLM() {
  return () => { throw new Error('MOAT BREACH: an LLM/network call fired on the read path'); };
}

function withProfileDir(fn) {
  const dir = mkdtempSync(join((process.env.TMPDIR || '/tmp'), 'ijfw-p4-moat-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P4.5(b) profile.get / brief make ZERO LLM calls across cold/stale/warm', () => {
  const callLLM = explodingLLM();

  // COLD — no profile on disk.
  withProfileDir(() => {
    const env = process.env;
    // Pass the exploding caller in every plausible injection slot. The serve
    // path takes NO LLM caller (that's the moat) — these are ignored — but if a
    // regression ever threads one through, it detonates here.
    assert.doesNotThrow(() => profileGet({ env, _callLLM: callLLM, callLLM }));
    assert.doesNotThrow(() => profileBrief({ env, _callLLM: callLLM, callLLM }));
  });

  // STALE — an old, low-evidence profile (decay-eligible) on disk.
  withProfileDir(() => {
    let p = makeProfile();
    p = applyDelta(p, {
      inferences: [makeInference({
        kind: 'preference', subject: 'old', value: { phrase: 'stale pref' },
        confidence: 0.7, evidence_count: 1,
        last_confirmed: new Date(Date.now() - 1000 * 60 * 60 * 24 * 200).toISOString(),
        sensitivity: 'low',
      })],
    });
    writeProfile(p);
    assert.doesNotThrow(() => profileGet({ env: process.env, _callLLM: callLLM, callLLM }));
    assert.doesNotThrow(() => profileBrief({ env: process.env, _callLLM: callLLM, callLLM }));
  });

  // WARM — a confirmed, evidence-rich profile on disk.
  withProfileDir(() => {
    let p = makeProfile();
    p.global.style.terseness = { ema: 0.9, alpha: 7, beta: 2, evidence_count: 8 };
    p = applyDelta(p, {
      inferences: [makeInference({
        kind: 'preference', subject: 'warm', value: { phrase: 'warm pref' },
        confidence: 0.9, evidence_count: 6, sensitivity: 'low',
      })],
      expertise: { rust: { accepts: 9, n: 10 } },
    });
    writeProfile(p);
    const g = profileGet({ env: process.env, _callLLM: callLLM, callLLM });
    const b = profileBrief({ env: process.env, _callLLM: callLLM, callLLM });
    assert.equal(g.ok, true);
    assert.equal(b.ok, true);
    assert.match(b.brief, /warm pref/);
  });
});
