/**
 * test-override-presets.js
 *
 * IJFW v1.4.0 Wave 4 / t18 — Built-in preset content tests.
 *
 * For each preset shipped under src/overrides/presets/ this suite asserts:
 *   1. The file parses as a valid override manifest
 *   2. scope is 'base'
 *   3. skill is 'ijfw-critique'
 *   4. At least one section fence pair exists in the body
 *   5. Domain-specific terminology is present (preset-specific keywords)
 *   6. No code-specific terminology leaks into the rubric (no "test
 *      coverage", "API surface", "type safety", "function signature")
 *
 * No HOME swap needed — these tests read the preset files directly from the
 * source tree via loadOverrideFile and inspect their parsed content.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateOverrideManifest,
  OVERRIDE_OPEN_FENCE,
  OVERRIDE_CLOSE_FENCE,
  SKILL_NAME_PATTERN,
  PRESET_NAME_PATTERN,
} from './src/override-manifest-schema.js';
import { loadOverrideFile } from './src/override-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = join(__dirname, 'src', 'overrides', 'presets');

const PRESETS = ['book', 'campaign', 'academic', 'screenplay'];

// Domain-specific keywords that should appear somewhere in the preset body.
// Case-insensitive substring match; the preset only needs to mention at
// least one of the listed words for each category.
const DOMAIN_TERMS = {
  book: ['voice', 'pacing'],
  campaign: ['hook', 'audience', 'CTA'],
  academic: ['thesis', 'citation', 'evidence'],
  screenplay: ['scene', 'dialogue', 'character'],
};

// Code-specific terminology that must NOT appear in the rubric section.
// These would indicate the preset has leaked engineering jargon into prose.
const FORBIDDEN_CODE_TERMS = [
  'test coverage',
  'API surface',
  'type safety',
  'function signature',
];

function extractRubricSection(body) {
  // Pull the inner content of the first <!-- ijfw-override: rubric --> block.
  const m = body.match(
    /<!--\s*ijfw-override:\s*rubric\s*-->([\s\S]*?)<!--\s*ijfw-override-end\s*-->/
  );
  return m ? m[1] : null;
}

for (const preset of PRESETS) {
  const filePath = join(PRESETS_DIR, `${preset}.md`);

  test(`preset[${preset}]: file parses as a valid override manifest`, async () => {
    const loaded = await loadOverrideFile(filePath);
    assert.ok(loaded, `${preset}.md should load`);
    const v = validateOverrideManifest(loaded.manifest);
    assert.equal(v.valid, true, `manifest errors: ${v.errors.join('; ')}`);
  });

  test(`preset[${preset}]: scope is 'base'`, async () => {
    const loaded = await loadOverrideFile(filePath);
    assert.equal(loaded.manifest.scope, 'base');
  });

  test(`preset[${preset}]: skill is 'ijfw-critique'`, async () => {
    const loaded = await loadOverrideFile(filePath);
    assert.equal(loaded.manifest.skill, 'ijfw-critique');
  });

  test(`preset[${preset}]: at least one section fence pair exists`, async () => {
    const loaded = await loadOverrideFile(filePath);
    // Re-create the open-fence regex globally because OVERRIDE_OPEN_FENCE is
    // a stateful global RegExp; reset lastIndex defensively.
    OVERRIDE_OPEN_FENCE.lastIndex = 0;
    const opens = loaded.body.match(OVERRIDE_OPEN_FENCE) || [];
    assert.ok(
      opens.length >= 1,
      `${preset}.md should contain at least one <!-- ijfw-override: ... --> open fence`
    );
    assert.ok(
      OVERRIDE_CLOSE_FENCE.test(loaded.body),
      `${preset}.md should contain a <!-- ijfw-override-end --> close fence`
    );
  });

  test(`preset[${preset}]: domain-specific terminology present`, async () => {
    const loaded = await loadOverrideFile(filePath);
    const body = loaded.body.toLowerCase();
    const terms = DOMAIN_TERMS[preset];
    for (const term of terms) {
      assert.ok(
        body.includes(term.toLowerCase()),
        `${preset}.md should mention "${term}"`
      );
    }
  });

  test(`preset[${preset}]: rubric has no code-specific terminology`, async () => {
    const loaded = await loadOverrideFile(filePath);
    const rubric = extractRubricSection(loaded.body);
    assert.ok(
      rubric,
      `${preset}.md should have a rubric section to scan`
    );
    const lower = rubric.toLowerCase();
    for (const banned of FORBIDDEN_CODE_TERMS) {
      assert.ok(
        !lower.includes(banned.toLowerCase()),
        `${preset}.md rubric should not contain "${banned}"`
      );
    }
  });
}

// Sanity guard: if a new preset is added under src/overrides/presets/ the
// test file should be updated. Detect by listing the directory at test time.
test('preset list matches files on disk', async () => {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(PRESETS_DIR);
  const md = entries.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual(md, [...PRESETS].sort(),
    `presets on disk (${md.join(',')}) do not match tested presets (${PRESETS.join(',')}) — update the test if a new preset was added`);
});

// Sanity: a synthetic FORBIDDEN-term injection would be caught (negative
// control). We construct a fake rubric body and confirm the detector trips.
test('forbidden-term detector trips on a synthetic positive', () => {
  const fake = '<!-- ijfw-override: rubric -->\nThis paragraph references type safety on purpose.\n<!-- ijfw-override-end -->';
  const rubric = (fake.match(
    /<!--\s*ijfw-override:\s*rubric\s*-->([\s\S]*?)<!--\s*ijfw-override-end\s*-->/
  ) || [, ''])[1];
  const lower = rubric.toLowerCase();
  const hit = FORBIDDEN_CODE_TERMS.find((t) => lower.includes(t.toLowerCase()));
  assert.ok(hit, 'sanity: detector must catch a synthetic forbidden-term injection');
});

// Sanity guard against unused imports being silently dropped — make sure
// readFileSync stays in the dependency closure even though loadOverrideFile
// handles I/O for us. We use it for the negative control.
test('readFileSync reads at least one preset', () => {
  const raw = readFileSync(join(PRESETS_DIR, `${PRESETS[0]}.md`), 'utf8');
  assert.ok(raw.length > 100, 'preset file should be substantial');
});

// B4: PRESET_NAME_PATTERN is a canonical named export from
// override-manifest-schema.js. Its source must match SKILL_NAME_PATTERN
// (same regex) and must reject traversal strings.
test('B4: PRESET_NAME_PATTERN exported from schema has same source as SKILL_NAME_PATTERN', () => {
  assert.ok(PRESET_NAME_PATTERN instanceof RegExp, 'PRESET_NAME_PATTERN must be a RegExp');
  assert.equal(PRESET_NAME_PATTERN.source, SKILL_NAME_PATTERN.source,
    'PRESET_NAME_PATTERN.source must equal SKILL_NAME_PATTERN.source');
  assert.ok(PRESET_NAME_PATTERN.test('book'), 'valid preset name accepted');
  assert.ok(!PRESET_NAME_PATTERN.test('../../evil/pwn'), 'traversal string rejected');
  assert.ok(!PRESET_NAME_PATTERN.test('Book'), 'uppercase rejected');
  assert.ok(!PRESET_NAME_PATTERN.test(''), 'empty string rejected');
});
