// T26: domain-template schema validation test.
//
// Discovers all JSON files in src/team/domain-templates/, validates each
// against the domain-template/v1 schema (hand-rolled, zero new deps), and
// cross-references the T25 generator to assert that every template's
// agent_ids is consistent with what resolveRosterForDomain returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_SPECIALIST_AGENT_IDS,
  SOFTWARE_CORE_AGENT_IDS,
  resolveRosterForDomain,
} from './src/team/generator.js';

const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'src/team/domain-templates',
);

// ---------------------------------------------------------------------------
// Hand-rolled schema validator for domain-template/v1
// ---------------------------------------------------------------------------

const VALID_SCHEMA_VERSIONS = new Set(['domain-template/v1']);
const VALID_AGENT_ID_SOURCES = new Set(['software-core', 'domain-specialist']);
const VALID_FIELD_TYPES = new Set(['string', 'array', 'boolean', 'number']);

// Agent-id convention: lowercase letters, digits, hyphens; must start with
// "ijfw-" so accidental bare-word ids are caught immediately.
const AGENT_ID_RE = /^ijfw-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateDomainTemplate(tpl, filename) {
  const errors = [];

  // --- top-level required strings ----------------------------------------
  if (typeof tpl.schema_version !== 'string' || !VALID_SCHEMA_VERSIONS.has(tpl.schema_version)) {
    errors.push(`schema_version must be one of: ${[...VALID_SCHEMA_VERSIONS].join(', ')}`);
  }
  if (typeof tpl.domain !== 'string' || tpl.domain.trim() === '') {
    errors.push('domain must be a non-empty string');
  }
  if (typeof tpl.display_name !== 'string' || tpl.display_name.trim() === '') {
    errors.push('display_name must be a non-empty string');
  }
  if (typeof tpl.description !== 'string' || tpl.description.trim() === '') {
    errors.push('description must be a non-empty string');
  }

  // --- agent_ids -----------------------------------------------------------
  if (!Array.isArray(tpl.agent_ids)) {
    errors.push('agent_ids must be an array');
  } else {
    tpl.agent_ids.forEach((id, i) => {
      if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
        errors.push(`agent_ids[${i}] "${id}" must be a string matching /^ijfw-[a-z0-9-]+$/`);
      }
    });
  }

  // --- agent_id_source -----------------------------------------------------
  if (typeof tpl.agent_id_source !== 'string' || !VALID_AGENT_ID_SOURCES.has(tpl.agent_id_source)) {
    errors.push(`agent_id_source must be one of: ${[...VALID_AGENT_ID_SOURCES].join(', ')}`);
  }

  // --- workflow_phases -----------------------------------------------------
  if (!Array.isArray(tpl.workflow_phases) || tpl.workflow_phases.length === 0) {
    errors.push('workflow_phases must be a non-empty array');
  } else {
    tpl.workflow_phases.forEach((phase, i) => {
      if (typeof phase !== 'string' || phase.trim() === '') {
        errors.push(`workflow_phases[${i}] must be a non-empty string`);
      }
    });
  }

  // --- brief_fields --------------------------------------------------------
  if (!Array.isArray(tpl.brief_fields)) {
    errors.push('brief_fields must be an array');
  } else {
    tpl.brief_fields.forEach((field, i) => {
      const fp = `brief_fields[${i}]`;
      if (typeof field !== 'object' || field === null || Array.isArray(field)) {
        errors.push(`${fp} must be an object`);
        return;
      }
      if (typeof field.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(field.key)) {
        errors.push(`${fp}.key must be a lowercase snake_case string`);
      }
      if (!VALID_FIELD_TYPES.has(field.type)) {
        errors.push(`${fp}.type must be one of: ${[...VALID_FIELD_TYPES].join(', ')}`);
      }
      if (typeof field.description !== 'string' || field.description.trim() === '') {
        errors.push(`${fp}.description must be a non-empty string`);
      }
      if (typeof field.required !== 'boolean') {
        errors.push(`${fp}.required must be a boolean`);
      }
    });
  }

  // --- filename convention check ------------------------------------------
  // The JSON filename (without extension) should match the domain field.
  const expectedFilename = `${tpl.domain}.json`;
  if (filename !== expectedFilename) {
    errors.push(`filename "${filename}" does not match domain "${tpl.domain}" (expected "${expectedFilename}")`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Discover templates
// ---------------------------------------------------------------------------

const templateFiles = readdirSync(TEMPLATES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('domain-templates directory contains at least 3 JSON files', () => {
  assert.ok(
    templateFiles.length >= 3,
    `expected ≥3 domain-template files, found ${templateFiles.length}: ${templateFiles.join(', ')}`,
  );
});

test('at least 3 templates cover distinct domains (software, book, content/campaign)', () => {
  const templates = templateFiles.map((f) =>
    JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf8')),
  );
  const domains = new Set(templates.map((t) => t.domain));
  for (const required of ['software', 'book', 'content']) {
    assert.ok(domains.has(required), `missing required domain template: "${required}"`);
  }
});

// One schema-validation test per discovered file.
for (const filename of templateFiles) {
  test(`schema-valid: ${filename}`, () => {
    const raw = readFileSync(join(TEMPLATES_DIR, filename), 'utf8');
    let tpl;
    try {
      tpl = JSON.parse(raw);
    } catch (err) {
      assert.fail(`${filename} is not valid JSON: ${err.message}`);
    }

    const errors = validateDomainTemplate(tpl, filename);
    assert.deepEqual(
      errors,
      [],
      `${filename} failed schema validation:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  });
}

// Cross-reference: each template's agent_ids must be consistent with the
// T25 generator's resolveRosterForDomain output for that domain.
//
// Consistency rule:
//   - For domains where the generator returns a non-empty roster, every id
//     in the template must appear in the generator roster (template is a
//     subset-or-equal of the generator roster). This allows a template to
//     document a subset for brevity, but not to invent ids the generator
//     doesn't know about.
//   - For domains where the generator returns [] (research, business, mixed),
//     the template's agent_ids is allowed to be [] or non-empty (template
//     may pre-declare agents that a future generator wave will wire up).
//
// The key invariant is the other direction: if a template lists an id and
// the generator DOES have a non-empty roster for that domain, the id must
// appear in the generator roster (no phantom ids in active domains).

for (const filename of templateFiles) {
  test(`generator cross-reference: ${filename}`, () => {
    const tpl = JSON.parse(readFileSync(join(TEMPLATES_DIR, filename), 'utf8'));
    const generatorRoster = resolveRosterForDomain(tpl.domain);

    if (generatorRoster.length === 0) {
      // Generator doesn't populate this domain yet — template may be empty
      // or pre-declare future agents; both are fine. Just verify well-formed.
      // (schema test above already covers well-formedness)
      return;
    }

    // Generator has a roster — every template agent_id must appear in it.
    const rosterSet = new Set(generatorRoster);
    for (const id of tpl.agent_ids) {
      assert.ok(
        rosterSet.has(id),
        `template "${filename}" lists agent_id "${id}" but resolveRosterForDomain("${tpl.domain}") does not include it.\nGenerator roster: [${generatorRoster.join(', ')}]`,
      );
    }

    // Also assert template agent_ids is non-empty when the generator roster
    // is non-empty — an active domain must declare its agents.
    assert.ok(
      tpl.agent_ids.length > 0,
      `template "${filename}" has empty agent_ids but generator returns ${generatorRoster.length} agents for domain "${tpl.domain}"`,
    );
  });
}

// Canonical agent-id spot checks — ensure the three brief-named domains
// carry exactly the ids that schemas.js declares as canonical.

test('software template agent_ids match SOFTWARE_CORE_AGENT_IDS', () => {
  const tpl = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, 'software.json'), 'utf8'),
  );
  assert.deepEqual(
    tpl.agent_ids,
    [...SOFTWARE_CORE_AGENT_IDS],
    'software.json agent_ids must equal the canonical SOFTWARE_CORE_AGENT_IDS list',
  );
});

test('book template agent_ids match DOMAIN_SPECIALIST_AGENT_IDS.book', () => {
  const tpl = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, 'book.json'), 'utf8'),
  );
  assert.deepEqual(
    tpl.agent_ids,
    [...DOMAIN_SPECIALIST_AGENT_IDS.book],
    'book.json agent_ids must equal the canonical DOMAIN_SPECIALIST_AGENT_IDS.book list',
  );
});

test('content template agent_ids match DOMAIN_SPECIALIST_AGENT_IDS.content', () => {
  const tpl = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, 'content.json'), 'utf8'),
  );
  assert.deepEqual(
    tpl.agent_ids,
    [...DOMAIN_SPECIALIST_AGENT_IDS.content],
    'content.json agent_ids must equal the canonical DOMAIN_SPECIALIST_AGENT_IDS.content list',
  );
});

test('design template agent_ids match DOMAIN_SPECIALIST_AGENT_IDS.design', () => {
  const tpl = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, 'design.json'), 'utf8'),
  );
  assert.deepEqual(
    tpl.agent_ids,
    [...DOMAIN_SPECIALIST_AGENT_IDS.design],
    'design.json agent_ids must equal the canonical DOMAIN_SPECIALIST_AGENT_IDS.design list',
  );
});

test('no duplicate agent_ids within any single template', () => {
  for (const filename of templateFiles) {
    const tpl = JSON.parse(readFileSync(join(TEMPLATES_DIR, filename), 'utf8'));
    const seen = new Set();
    for (const id of tpl.agent_ids) {
      assert.equal(
        seen.has(id),
        false,
        `${filename}: duplicate agent_id "${id}"`,
      );
      seen.add(id);
    }
  }
});

test('all template domains are distinct (no two files claim the same domain)', () => {
  const seen = new Map();
  for (const filename of templateFiles) {
    const tpl = JSON.parse(readFileSync(join(TEMPLATES_DIR, filename), 'utf8'));
    if (seen.has(tpl.domain)) {
      assert.fail(
        `domain "${tpl.domain}" is declared in both "${seen.get(tpl.domain)}" and "${filename}"`,
      );
    }
    seen.set(tpl.domain, filename);
  }
});

test('brief_fields keys are unique within each template', () => {
  for (const filename of templateFiles) {
    const tpl = JSON.parse(readFileSync(join(TEMPLATES_DIR, filename), 'utf8'));
    if (!Array.isArray(tpl.brief_fields)) continue;
    const seen = new Set();
    for (const field of tpl.brief_fields) {
      if (typeof field.key !== 'string') continue;
      assert.equal(
        seen.has(field.key),
        false,
        `${filename}: duplicate brief_field key "${field.key}"`,
      );
      seen.add(field.key);
    }
  }
});
