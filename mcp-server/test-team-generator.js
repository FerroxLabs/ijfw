import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_SPECIALIST_AGENT_IDS,
  SOFTWARE_CORE_AGENT_IDS,
  createTeamAssembly,
  detectTeamArchetype,
  loadTeamTemplate,
  readTeamAssembly,
  resolveDomainSpecialistAgentIds,
  resolveRosterForDomain,
  resolveSoftwareCoreAgentIds,
  scoreBrief,
} from './src/team/generator.js';
import {
  DOMAIN_SPECIALIST_AGENT_IDS as SCHEMA_DOMAIN_SPECIALIST_AGENT_IDS,
  SOFTWARE_CORE_AGENT_IDS as SCHEMA_SOFTWARE_CORE_AGENT_IDS,
} from './src/team/schemas.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-team-generator-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('loadTeamTemplate validates and clones archetype fixtures', () => {
  const first = loadTeamTemplate('software');
  const second = loadTeamTemplate('software');
  first.charter.team_name = 'mutated';
  assert.equal(second.charter.team_name, 'software-delivery-team');
});

test('detectTeamArchetype accepts explicit archetype and normalizes unknown to mixed', () => {
  const dir = makeTmp();
  try {
    assert.equal(detectTeamArchetype(dir, { archetype: 'design' }), 'design');
    assert.equal(detectTeamArchetype(dir, { archetype: 'unknown-domain' }), 'mixed');
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly writes charter workflow and agent files', () => {
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'content', teamName: 'launch-content-team' });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'content');
    assert.ok(existsSync(join(dir, '.ijfw', 'team', 'charter.json')));
    assert.ok(existsSync(join(dir, '.ijfw', 'team', 'workflow.json')));
    assert.ok(existsSync(join(dir, '.ijfw', 'agents', 'content-strategist.md')));
    assert.ok(existsSync(join(dir, '.ijfw', 'agents', 'editor.md')));

    const charter = JSON.parse(readFileSync(join(dir, '.ijfw', 'team', 'charter.json'), 'utf8'));
    assert.equal(charter.team_name, 'launch-content-team');
    assert.equal(charter.source_archetype, 'content');

    const agent = readFileSync(join(dir, '.ijfw', 'agents', 'content-strategist.md'), 'utf8');
    assert.match(agent, /name: content-strategist/);
    assert.match(agent, /Record claims, findings, blockers, and decisions/);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly preserves existing team unless force is set', () => {
  const dir = makeTmp();
  try {
    assert.equal(createTeamAssembly(dir, { archetype: 'book' }).ok, true);
    const blocked = createTeamAssembly(dir, { archetype: 'design' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'exists');

    const forced = createTeamAssembly(dir, { archetype: 'design', force: true });
    assert.equal(forced.ok, true);
    const state = readTeamAssembly(dir);
    assert.equal(state.ok, true);
    assert.deepEqual(state.charter.project_archetypes, ['design']);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly can detect a software project from package.json', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{}\n');
    const result = createTeamAssembly(dir, { maxFiles: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'software');
  } finally {
    cleanup(dir);
  }
});

// --- F-FUN-1 (H2.1): brief-aware archetype routing ----------------------

test('detectTeamArchetype routes a book brief to book even from an empty dir', () => {
  const dir = makeTmp();
  try {
    const brief = 'I want to write a novel about a chef. Five chapters, first-person prose.';
    assert.equal(detectTeamArchetype(dir, { brief }), 'book');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype routes a research brief to research', () => {
  const dir = makeTmp();
  try {
    const brief = 'Research paper on quantum entanglement with a literature review and methodology.';
    assert.equal(detectTeamArchetype(dir, { brief }), 'research');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype routes a campaign brief to content', () => {
  const dir = makeTmp();
  try {
    const brief = 'Launch marketing campaign with blog posts, social media, and SEO copy.';
    assert.equal(detectTeamArchetype(dir, { brief }), 'content');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype defaults a software project with no brief from filesystem signal', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    // No brief -- filesystem must drive. Manifest -> software.
    assert.equal(detectTeamArchetype(dir, { maxFiles: 20 }), 'software');
  } finally {
    cleanup(dir);
  }
});

test('detectTeamArchetype brief outweighs filesystem when both have signal', () => {
  const dir = makeTmp();
  try {
    // Filesystem says software (package.json), brief says book.
    // F-FUN-1 contract: brief wins when brief has explicit signal.
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    const brief = 'Write a book about chefs. Five chapters of literary fiction prose.';
    assert.equal(detectTeamArchetype(dir, { brief, maxFiles: 20 }), 'book');
  } finally {
    cleanup(dir);
  }
});

test('scoreBrief returns per-domain scores and handles empty briefs', () => {
  // Empty brief: all zeros.
  const empty = scoreBrief('');
  assert.equal(empty.software, 0);
  assert.equal(empty.book, 0);
  // Domain-explicit phrase scores at least the flip threshold (>= 2).
  const bookScore = scoreBrief('I want to write a book about cooking.');
  assert.ok(bookScore.book >= 2, `expected book>=2, got ${bookScore.book}`);
  // Ambiguous brief shouldn't pick a winner from a single token alone.
  const ambig = scoreBrief('research');
  // "research" alone is just 1 token-hit; below the flip threshold.
  assert.equal(ambig.research, 1);
});

test('normalizeArchetype canonicalizes detector language labels to software', () => {
  // F-FUN-1 mapping fix: typescript/javascript/python aren't in
  // SUPPORTED_ARCHETYPES but they're software in every meaningful sense.
  // The detector calling path goes through detectTeamArchetype's explicit
  // archetype option -- that's the public surface that exercises the mapping.
  const dir = makeTmp();
  try {
    assert.equal(detectTeamArchetype(dir, { archetype: 'typescript' }), 'software');
    assert.equal(detectTeamArchetype(dir, { archetype: 'javascript' }), 'software');
    assert.equal(detectTeamArchetype(dir, { archetype: 'python' }), 'software');
    assert.equal(detectTeamArchetype(dir, { archetype: 'campaign' }), 'content');
    assert.equal(detectTeamArchetype(dir, { archetype: 'novel' }), 'book');
    // Unknown still collapses to mixed.
    assert.equal(detectTeamArchetype(dir, { archetype: 'martian-poetry-slam' }), 'mixed');
  } finally {
    cleanup(dir);
  }
});

// --- T24 (G7-core): software-core agent set wiring -----------------------

test('SOFTWARE_CORE_AGENT_IDS exposes exactly the 4 G7-core agents in deterministic order', () => {
  // Contract: order and membership are stable. T25 / T27 / T30 all key off
  // this list; any drift would cascade.
  assert.deepEqual(SOFTWARE_CORE_AGENT_IDS, [
    'ijfw-doc-verifier',
    'ijfw-integration-checker',
    'ijfw-nyquist-auditor',
    'ijfw-code-fixer',
  ]);
});

test('generator.js and schemas.js export the same canonical software-core set', () => {
  // Single-source-of-truth contract: schemas.js owns the literal; generator.js
  // re-exports it. If they ever diverge we want to know via a test, not a bug.
  assert.deepEqual(
    SOFTWARE_CORE_AGENT_IDS,
    SCHEMA_SOFTWARE_CORE_AGENT_IDS,
    'generator.SOFTWARE_CORE_AGENT_IDS must equal schemas.SOFTWARE_CORE_AGENT_IDS',
  );
});

test('every G7-core agent id resolves to an existing claude/agents/<id>.md file', () => {
  // Verify contract from the task: each id must map to an on-disk markdown
  // file. This is the wiring proof — if any of the 4 ids is missing a file,
  // the installer will deploy a roster reference to a non-existent agent.
  for (const id of SOFTWARE_CORE_AGENT_IDS) {
    const agentPath = join(REPO_ROOT, 'claude', 'agents', `${id}.md`);
    assert.ok(
      existsSync(agentPath),
      `expected agent file to exist on disk: ${agentPath}`,
    );
  }
});

test('each G7-core agent .md has the required frontmatter (name, model, allowed-tools)', () => {
  // Stronger version of the file-existence check: a stub or accidentally
  // truncated agent file would still pass existsSync. Confirm the frontmatter
  // names match the id and the basic shape is present.
  for (const id of SOFTWARE_CORE_AGENT_IDS) {
    const agentPath = join(REPO_ROOT, 'claude', 'agents', `${id}.md`);
    const content = readFileSync(agentPath, 'utf8');
    assert.match(content, /^---\n/, `${id}: missing opening frontmatter`);
    assert.match(content, new RegExp(`\\nname:\\s*${id}\\b`), `${id}: name in frontmatter does not match filename`);
    assert.match(content, /\nmodel:\s*\w+/, `${id}: missing model: line in frontmatter`);
    assert.match(content, /\nallowed-tools:\s*[\w,\s-]+/, `${id}: missing allowed-tools: line in frontmatter`);
  }
});

test('resolveSoftwareCoreAgentIds returns all 4 ids for software archetype', () => {
  const ids = resolveSoftwareCoreAgentIds('software');
  assert.deepEqual(ids, [
    'ijfw-doc-verifier',
    'ijfw-integration-checker',
    'ijfw-nyquist-auditor',
    'ijfw-code-fixer',
  ]);
});

test('resolveSoftwareCoreAgentIds returns an empty list for non-software archetypes', () => {
  // Today only `software` triggers the static set. Non-software archetypes
  // get []. T25 may extend this to other archetypes via the domain-aware
  // generator; that change MUST update this test.
  for (const archetype of ['book', 'content', 'design', 'research', 'business', 'mixed']) {
    const ids = resolveSoftwareCoreAgentIds(archetype);
    assert.deepEqual(ids, [], `expected [] for archetype "${archetype}"`);
  }
});

test('resolveSoftwareCoreAgentIds canonicalises language-flavoured archetypes via alias map', () => {
  // typescript / javascript / python all collapse to `software` upstream; the
  // resolver MUST honour that so a detector that surfaces a language label
  // still gets the full software-core set.
  for (const lang of ['typescript', 'javascript', 'python', 'rust', 'go']) {
    const ids = resolveSoftwareCoreAgentIds(lang);
    assert.equal(ids.length, 4, `expected 4 ids for "${lang}" (alias of software)`);
  }
});

test('resolveSoftwareCoreAgentIds returns a fresh array (callers cannot mutate the canonical set)', () => {
  const ids = resolveSoftwareCoreAgentIds('software');
  ids.push('synthetic-attacker-id');
  // Second call must NOT see the mutation.
  const fresh = resolveSoftwareCoreAgentIds('software');
  assert.equal(fresh.length, 4);
  assert.equal(fresh.includes('synthetic-attacker-id'), false);
});

test('createTeamAssembly returns softwareCoreAgentIds for a software project', () => {
  // The wiring contract from the task brief: for a software project the
  // generator output lists all 4 agent ids AND each maps to an existing
  // claude/agents/<id>.md file on disk.
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'software' });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'software');
    assert.ok(Array.isArray(result.softwareCoreAgentIds), 'softwareCoreAgentIds must be an array');
    assert.deepEqual(result.softwareCoreAgentIds, [
      'ijfw-doc-verifier',
      'ijfw-integration-checker',
      'ijfw-nyquist-auditor',
      'ijfw-code-fixer',
    ]);
    // And the on-disk proof — same loop the T24 verify contract names.
    for (const id of result.softwareCoreAgentIds) {
      const agentPath = join(REPO_ROOT, 'claude', 'agents', `${id}.md`);
      assert.ok(existsSync(agentPath), `agent file missing: ${agentPath}`);
    }
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly returns empty softwareCoreAgentIds for non-software archetypes', () => {
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'content', teamName: 'content-team' });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.softwareCoreAgentIds));
    assert.equal(result.softwareCoreAgentIds.length, 0);
  } finally {
    cleanup(dir);
  }
});

// --- T25 (G7-gen): domain-aware team generator --------------------------

test('DOMAIN_SPECIALIST_AGENT_IDS exposes specialists for at least 3 non-software domains', () => {
  // Contract from the task brief: book / content (campaign) / design must
  // all have populated specialist lists. The ≥3 threshold guarantees T26's
  // template work has real targets and that the generator can produce
  // measurably different rosters across domains.
  const populated = Object.keys(DOMAIN_SPECIALIST_AGENT_IDS).filter(
    (domain) => Array.isArray(DOMAIN_SPECIALIST_AGENT_IDS[domain])
      && DOMAIN_SPECIALIST_AGENT_IDS[domain].length > 0,
  );
  assert.ok(
    populated.length >= 3,
    `expected ≥3 populated specialist domains, got ${populated.length}: ${populated.join(', ')}`,
  );
  // Spot-check the three named in the task brief.
  for (const domain of ['book', 'content', 'design']) {
    assert.ok(
      DOMAIN_SPECIALIST_AGENT_IDS[domain] && DOMAIN_SPECIALIST_AGENT_IDS[domain].length > 0,
      `domain "${domain}" must have ≥1 specialist`,
    );
  }
});

test('DOMAIN_SPECIALIST_AGENT_IDS contains the brief-named specialist ids', () => {
  // The task brief names specific specialist ids; the generator must
  // surface them so T26 knows exactly which agent .md files to author.
  // Book: narrative-continuity-checker / line-editor / lore-keeper.
  // Campaign (content): campaign-strategist / copy-reviewer.
  assert.deepEqual(
    DOMAIN_SPECIALIST_AGENT_IDS.book,
    ['ijfw-narrative-continuity-checker', 'ijfw-line-editor', 'ijfw-lore-keeper'],
  );
  assert.deepEqual(
    DOMAIN_SPECIALIST_AGENT_IDS.content,
    ['ijfw-campaign-strategist', 'ijfw-copy-reviewer'],
  );
});

test('generator.js and schemas.js export the same canonical domain specialist map', () => {
  // Single-source-of-truth contract mirrors the SOFTWARE_CORE assertion.
  assert.deepEqual(
    DOMAIN_SPECIALIST_AGENT_IDS,
    SCHEMA_DOMAIN_SPECIALIST_AGENT_IDS,
    'generator.DOMAIN_SPECIALIST_AGENT_IDS must equal schemas.DOMAIN_SPECIALIST_AGENT_IDS',
  );
});

test('resolveDomainSpecialistAgentIds returns the right ids per archetype', () => {
  assert.deepEqual(
    resolveDomainSpecialistAgentIds('book'),
    ['ijfw-narrative-continuity-checker', 'ijfw-line-editor', 'ijfw-lore-keeper'],
  );
  assert.deepEqual(
    resolveDomainSpecialistAgentIds('content'),
    ['ijfw-campaign-strategist', 'ijfw-copy-reviewer'],
  );
  assert.deepEqual(
    resolveDomainSpecialistAgentIds('design'),
    ['ijfw-design-critic', 'ijfw-accessibility-reviewer'],
  );
  // Software intentionally exposes [] here — its roster is covered by
  // resolveSoftwareCoreAgentIds. The split keeps "core" and "specialist"
  // concerns separable.
  assert.deepEqual(resolveDomainSpecialistAgentIds('software'), []);
  // Archetypes with no template yet return [].
  for (const archetype of ['research', 'business', 'mixed']) {
    assert.deepEqual(
      resolveDomainSpecialistAgentIds(archetype),
      [],
      `expected [] for archetype "${archetype}"`,
    );
  }
});

test('resolveDomainSpecialistAgentIds canonicalises aliases via the alias map', () => {
  // `campaign` should route to `content` (per the alias map) and surface
  // the campaign-strategist / copy-reviewer specialists. Likewise `novel`
  // → book.
  assert.deepEqual(
    resolveDomainSpecialistAgentIds('campaign'),
    ['ijfw-campaign-strategist', 'ijfw-copy-reviewer'],
  );
  assert.deepEqual(
    resolveDomainSpecialistAgentIds('novel'),
    ['ijfw-narrative-continuity-checker', 'ijfw-line-editor', 'ijfw-lore-keeper'],
  );
});

test('resolveDomainSpecialistAgentIds returns a fresh array (mutations do not leak)', () => {
  const ids = resolveDomainSpecialistAgentIds('book');
  ids.push('synthetic-attacker-id');
  const fresh = resolveDomainSpecialistAgentIds('book');
  assert.equal(fresh.includes('synthetic-attacker-id'), false);
  assert.equal(fresh.length, 3);
});

test('resolveRosterForDomain returns software-core for software archetype', () => {
  // Software: the full G7-core software set, no domain specialists.
  const roster = resolveRosterForDomain('software');
  assert.deepEqual(roster, [
    'ijfw-doc-verifier',
    'ijfw-integration-checker',
    'ijfw-nyquist-auditor',
    'ijfw-code-fixer',
  ]);
});

test('resolveRosterForDomain returns specialists for non-software archetypes', () => {
  // Book: only domain specialists, no software-core agents.
  assert.deepEqual(
    resolveRosterForDomain('book'),
    ['ijfw-narrative-continuity-checker', 'ijfw-line-editor', 'ijfw-lore-keeper'],
  );
  // Content (campaign): only domain specialists.
  assert.deepEqual(
    resolveRosterForDomain('content'),
    ['ijfw-campaign-strategist', 'ijfw-copy-reviewer'],
  );
});

test('resolveRosterForDomain yields PROVABLY DIFFERENT rosters per domain', () => {
  // T25 acceptance criterion from the task brief: "software vs ≥2
  // non-software domains yield provably different rosters". This is the
  // structural test that proves it.
  const software = resolveRosterForDomain('software');
  const book = resolveRosterForDomain('book');
  const content = resolveRosterForDomain('content');
  const design = resolveRosterForDomain('design');

  // Each pair must differ in at least one element.
  function differ(a, b) {
    if (a.length !== b.length) return true;
    return a.some((id, i) => b[i] !== id);
  }
  assert.ok(differ(software, book), 'software vs book must differ');
  assert.ok(differ(software, content), 'software vs content must differ');
  assert.ok(differ(software, design), 'software vs design must differ');
  assert.ok(differ(book, content), 'book vs content must differ');
  assert.ok(differ(book, design), 'book vs design must differ');
  assert.ok(differ(content, design), 'content vs design must differ');

  // And no shared ids between software-core and any domain specialist set
  // — proves the "core" / "specialist" namespaces don't accidentally
  // overlap. If they ever do, the union dedupe in resolveRosterForDomain
  // would mask the bug.
  const softwareSet = new Set(software);
  for (const id of [...book, ...content, ...design]) {
    assert.equal(
      softwareSet.has(id),
      false,
      `specialist id "${id}" must not collide with a software-core id`,
    );
  }
});

test('createTeamAssembly returns domain-specific rosterAgentIds for a book project', () => {
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'book', teamName: 'novel-team' });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'book');
    assert.ok(Array.isArray(result.domainSpecialistAgentIds));
    assert.deepEqual(result.domainSpecialistAgentIds, [
      'ijfw-narrative-continuity-checker',
      'ijfw-line-editor',
      'ijfw-lore-keeper',
    ]);
    // No software-core in a book roster.
    assert.deepEqual(result.softwareCoreAgentIds, []);
    // The merged roster equals the specialists for a book project.
    assert.deepEqual(result.rosterAgentIds, result.domainSpecialistAgentIds);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly returns campaign specialists when archetype routes to content', () => {
  const dir = makeTmp();
  try {
    // Explicit content archetype: campaign-strategist + copy-reviewer.
    const result = createTeamAssembly(dir, { archetype: 'content', teamName: 'launch-team' });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'content');
    assert.deepEqual(result.domainSpecialistAgentIds, [
      'ijfw-campaign-strategist',
      'ijfw-copy-reviewer',
    ]);
    assert.deepEqual(result.rosterAgentIds, result.domainSpecialistAgentIds);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly returns software-core for a software project (rosterAgentIds union)', () => {
  const dir = makeTmp();
  try {
    const result = createTeamAssembly(dir, { archetype: 'software' });
    assert.equal(result.ok, true);
    // Software project: core ids populated, specialists empty, roster = core.
    assert.deepEqual(result.softwareCoreAgentIds, [
      'ijfw-doc-verifier',
      'ijfw-integration-checker',
      'ijfw-nyquist-auditor',
      'ijfw-code-fixer',
    ]);
    assert.deepEqual(result.domainSpecialistAgentIds, []);
    assert.deepEqual(result.rosterAgentIds, result.softwareCoreAgentIds);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly produces PROVABLY DIFFERENT rosters across software / book / content', () => {
  // End-to-end proof at the createTeamAssembly surface: three projects,
  // three archetypes, three different rosters. This is the contract the
  // brief asks for: "software vs ≥2 non-software domains yield provably
  // different rosters".
  const dirSoftware = makeTmp();
  const dirBook = makeTmp();
  const dirContent = makeTmp();
  try {
    const sw = createTeamAssembly(dirSoftware, { archetype: 'software' });
    const bk = createTeamAssembly(dirBook, { archetype: 'book' });
    const cn = createTeamAssembly(dirContent, { archetype: 'content' });

    assert.equal(sw.ok, true);
    assert.equal(bk.ok, true);
    assert.equal(cn.ok, true);

    // All three rosters must be non-empty.
    assert.ok(sw.rosterAgentIds.length > 0, 'software roster must not be empty');
    assert.ok(bk.rosterAgentIds.length > 0, 'book roster must not be empty');
    assert.ok(cn.rosterAgentIds.length > 0, 'content roster must not be empty');

    // And they must be pairwise distinct.
    assert.notDeepEqual(sw.rosterAgentIds, bk.rosterAgentIds, 'software vs book rosters must differ');
    assert.notDeepEqual(sw.rosterAgentIds, cn.rosterAgentIds, 'software vs content rosters must differ');
    assert.notDeepEqual(bk.rosterAgentIds, cn.rosterAgentIds, 'book vs content rosters must differ');
  } finally {
    cleanup(dirSoftware);
    cleanup(dirBook);
    cleanup(dirContent);
  }
});

test('createTeamAssembly routes a book brief from an empty dir to a book roster', () => {
  // Domain-detection mechanism end-to-end: a brief alone — no
  // filesystem signal — must steer the generator to the right specialist
  // set. This is the "read the project brief / domain" path the task
  // brief calls out.
  const dir = makeTmp();
  try {
    const brief = 'I want to write a novel about a chef. Five chapters of literary fiction prose.';
    const result = createTeamAssembly(dir, { brief });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'book');
    assert.deepEqual(result.domainSpecialistAgentIds, [
      'ijfw-narrative-continuity-checker',
      'ijfw-line-editor',
      'ijfw-lore-keeper',
    ]);
  } finally {
    cleanup(dir);
  }
});

test('createTeamAssembly routes a campaign brief from an empty dir to content specialists', () => {
  const dir = makeTmp();
  try {
    const brief = 'Launch marketing campaign with blog posts, social media, and SEO copy.';
    const result = createTeamAssembly(dir, { brief });
    assert.equal(result.ok, true);
    assert.equal(result.archetype, 'content');
    assert.deepEqual(result.domainSpecialistAgentIds, [
      'ijfw-campaign-strategist',
      'ijfw-copy-reviewer',
    ]);
  } finally {
    cleanup(dir);
  }
});

