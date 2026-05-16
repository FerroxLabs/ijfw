/**
 * test-override-resolution.js
 *
 * IJFW v1.4.0 Wave 4 / t18 — Override resolution tests.
 *
 * Covers:
 *   1. No overrides -> base body returned
 *   2. Section fence replacement (project tier)
 *   3. extends chain composition order (later wins)
 *   4. Circular extends rejected by detectCircularExtends
 *   5. 4-tier precedence (base preset < user < org < project)
 *   6. validateOverrideManifest happy + sad path
 *   7. MAX_EXTENDS_DEPTH respected
 *   8. resolveSkill on non-existent skill returns '' (no crash)
 *
 * HOME is isolated per test via process.env.HOME swap to a fresh mkdtemp.
 * The resolver reads os.homedir() at call time, so this works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OVERRIDE_SCOPES,
  BUILTIN_PRESETS,
  MAX_EXTENDS_DEPTH,
  validateOverrideManifest,
  detectCircularExtends,
  OVERRIDE_OPEN_FENCE,
  OVERRIDE_CLOSE_FENCE,
} from './src/override-manifest-schema.js';

import { resolveSkill } from './src/override-resolver.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  return mkdtempSync(join(tmpdir(), 'ijfw-ovr-res-proj-'));
}

function makeTmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-ovr-res-home-'));
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeBaseSkill(projectRoot, skill, targetSections) {
  // targetSections: { sectionName: 'inner content' }
  const dir = join(projectRoot, 'shared', 'skills', skill);
  mkdirSync(dir, { recursive: true });
  let body = `# ${skill}\n\nIntro paragraph that has no override target.\n\n`;
  for (const [section, inner] of Object.entries(targetSections)) {
    body += `<!-- ijfw-override-target: ${section} -->\n${inner}\n<!-- ijfw-override-target-end -->\n\n`;
  }
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function writeOverride(filePath, manifest, sections) {
  // sections: { sectionName: 'override inner content' }
  mkdirSync(join(filePath, '..'), { recursive: true });
  let body = '---\n';
  for (const [k, v] of Object.entries(manifest)) {
    if (Array.isArray(v)) {
      body += `${k}: [${v.map((p) => p).join(', ')}]\n`;
    } else {
      body += `${k}: ${v}\n`;
    }
  }
  body += '---\n\n';
  for (const [section, inner] of Object.entries(sections)) {
    body += `<!-- ijfw-override: ${section} -->\n${inner}\n<!-- ijfw-override-end -->\n\n`;
  }
  writeFileSync(filePath, body, 'utf8');
}

function projectOverridePath(projectRoot, skill) {
  return join(projectRoot, '.ijfw', 'skill-overrides', skill, 'override.md');
}

function userOverridePath(home, skill) {
  return join(home, '.ijfw', 'user-overrides', skill, 'override.md');
}

function orgOverridePath(home, skill) {
  return join(home, '.ijfw', 'org-overrides', skill, 'override.md');
}

function presetPath(home, preset) {
  return join(home, '.ijfw', 'overrides', 'presets', `${preset}.md`);
}

function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });
}

// ---------------------------------------------------------------------------
// 1. No overrides -> base body returned
// ---------------------------------------------------------------------------

test('resolveSkill: no overrides returns the base body verbatim', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', {
      rubric: 'BASE-CONTENT-MARKER',
    });

    const merged = await withHome(home, () => resolveSkill('demo-skill', proj));
    assert.match(merged, /BASE-CONTENT-MARKER/);
    assert.match(merged, /# demo-skill/);
    // Target fence markers remain because nothing was overridden.
    assert.match(merged, /<!-- ijfw-override-target: rubric -->/);
    assert.match(merged, /<!-- ijfw-override-target-end -->/);
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 2. Section fence replacement (project tier)
// ---------------------------------------------------------------------------

test('resolveSkill: project override replaces fenced section', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', {
      rubric: 'BASE',
    });
    writeOverride(
      projectOverridePath(proj, 'demo-skill'),
      { scope: 'project', skill: 'demo-skill' },
      { rubric: 'OVERRIDDEN' }
    );

    const merged = await withHome(home, () => resolveSkill('demo-skill', proj));
    assert.match(merged, /OVERRIDDEN/);
    // Ensure BASE no longer lives inside the rubric span.
    const span = merged.match(
      /<!-- ijfw-override-target: rubric -->[\s\S]*?<!-- ijfw-override-target-end -->/
    );
    assert.ok(span, 'rubric span should still exist');
    assert.doesNotMatch(span[0], /BASE/);
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 3. extends chain composes in correct order (later wins)
// ---------------------------------------------------------------------------

test('resolveSkill: extends chain composes child-after-parent (later wins)', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', { x: 'BASE-X' });

    // Preset A: replaces section x with FROM-A. No extends.
    writeOverride(
      presetPath(home, 'preset-a'),
      { scope: 'base', skill: 'demo-skill' },
      { x: 'FROM-A' }
    );
    // Preset B: extends preset-a, replaces section x with FROM-B.
    writeOverride(
      presetPath(home, 'preset-b'),
      { scope: 'base', skill: 'demo-skill', extends: ['preset-a'] },
      { x: 'FROM-B' }
    );
    // Project file extends preset-b so the chain is referenced.
    writeOverride(
      projectOverridePath(proj, 'demo-skill'),
      { scope: 'project', skill: 'demo-skill', extends: ['preset-b'] },
      {} // no own sections
    );

    const merged = await withHome(home, () => resolveSkill('demo-skill', proj));
    // preset-a applies first, then preset-b applies on top -> FROM-B wins.
    assert.match(merged, /FROM-B/);
    const span = merged.match(
      /<!-- ijfw-override-target: x -->[\s\S]*?<!-- ijfw-override-target-end -->/
    );
    assert.ok(span);
    assert.doesNotMatch(span[0], /FROM-A/);
    assert.doesNotMatch(span[0], /BASE-X/);
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 4. Circular extends rejected by detectCircularExtends
// ---------------------------------------------------------------------------

test('detectCircularExtends: A -> B -> A is circular', () => {
  const graph = new Map();
  graph.set('A', { extends: ['B'] });
  graph.set('B', { extends: ['A'] });
  const r = detectCircularExtends(graph, 'A');
  assert.equal(r.circular, true);
  assert.ok(Array.isArray(r.chain));
  assert.ok(r.chain.length >= 2);
});

// ---------------------------------------------------------------------------
// 5. 4-tier precedence (project > org > user > base preset)
// ---------------------------------------------------------------------------

test('resolveSkill: 4-tier precedence — project wins over org, org over user, user over preset', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    writeBaseSkill(proj, 'demo-skill', { p: 'BASE-DEFAULT' });

    writeOverride(
      presetPath(home, 'preset-z'),
      { scope: 'base', skill: 'demo-skill' },
      { p: 'P-BASE' }
    );
    writeOverride(
      userOverridePath(home, 'demo-skill'),
      { scope: 'user', skill: 'demo-skill', extends: ['preset-z'] },
      { p: 'P-USER' }
    );
    writeOverride(
      orgOverridePath(home, 'demo-skill'),
      { scope: 'org', skill: 'demo-skill' },
      { p: 'P-ORG' }
    );
    writeOverride(
      projectOverridePath(proj, 'demo-skill'),
      { scope: 'project', skill: 'demo-skill' },
      { p: 'P-PROJECT' }
    );

    const merged = await withHome(home, () => resolveSkill('demo-skill', proj));
    assert.match(merged, /P-PROJECT/);
    const span = merged.match(
      /<!-- ijfw-override-target: p -->[\s\S]*?<!-- ijfw-override-target-end -->/
    );
    assert.ok(span);
    assert.doesNotMatch(span[0], /P-BASE/);
    assert.doesNotMatch(span[0], /P-USER/);
    assert.doesNotMatch(span[0], /P-ORG/);
    assert.doesNotMatch(span[0], /BASE-DEFAULT/);
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 6. validateOverrideManifest happy + sad paths
// ---------------------------------------------------------------------------

test('validateOverrideManifest: accepts scope+skill, rejects bogus scope and missing skill', () => {
  const ok = validateOverrideManifest({ scope: 'project', skill: 'ijfw-critique' });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);

  const badScope = validateOverrideManifest({ scope: 'bogus', skill: 'ijfw-critique' });
  assert.equal(badScope.valid, false);
  assert.ok(badScope.errors.some((e) => /scope/.test(e)));

  const noSkill = validateOverrideManifest({ scope: 'project' });
  assert.equal(noSkill.valid, false);
  assert.ok(noSkill.errors.some((e) => /skill/.test(e)));

  // Sanity: exports we depend on are present.
  assert.ok(Array.isArray(OVERRIDE_SCOPES));
  assert.deepEqual([...BUILTIN_PRESETS].sort(), ['academic', 'book', 'campaign', 'screenplay']);
  assert.equal(MAX_EXTENDS_DEPTH, 5);
  assert.ok(OVERRIDE_OPEN_FENCE instanceof RegExp);
  assert.ok(OVERRIDE_CLOSE_FENCE instanceof RegExp);
});

// ---------------------------------------------------------------------------
// 7. MAX_EXTENDS_DEPTH respected
// ---------------------------------------------------------------------------

test('detectCircularExtends: chain of 6 presets each extending the next is rejected past depth 5', () => {
  const graph = new Map();
  // p1 -> p2 -> p3 -> p4 -> p5 -> p6 -> (end)
  graph.set('p1', { extends: ['p2'] });
  graph.set('p2', { extends: ['p3'] });
  graph.set('p3', { extends: ['p4'] });
  graph.set('p4', { extends: ['p5'] });
  graph.set('p5', { extends: ['p6'] });
  graph.set('p6', { extends: ['p7'] });
  graph.set('p7', { extends: [] });
  const r = detectCircularExtends(graph, 'p1');
  // Depth exceeds MAX_EXTENDS_DEPTH=5 -> treated as circular by the schema.
  assert.equal(r.circular, true);
});

// ---------------------------------------------------------------------------
// 8. resolveSkill on non-existent skill returns ''
// ---------------------------------------------------------------------------

test('resolveSkill: non-existent skill returns empty string, does not throw', async () => {
  const proj = makeTmpProject();
  const home = makeTmpHome();
  try {
    const merged = await withHome(home, () => resolveSkill('does-not-exist-skill', proj));
    assert.equal(typeof merged, 'string');
    assert.equal(merged, '');
  } finally {
    cleanup(proj);
    cleanup(home);
  }
});
