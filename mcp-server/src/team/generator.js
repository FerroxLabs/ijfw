// Team Assembly 2.0 generator.
//
// Creates project-local agent markdown plus machine-readable charter/workflow
// contracts from archetype fixtures. This is the first executable slice; later
// waves can replace fixture selection with richer brief-aware synthesis.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from '../lib/atomic-io.js';
import { syncCodexAgents } from '../codex-agents.js';
import { detect } from '../project-type-detector.js';
import {
  DOMAIN_SPECIALIST_AGENT_IDS as CANONICAL_DOMAIN_SPECIALIST_AGENT_IDS,
  SOFTWARE_CORE_AGENT_IDS as CANONICAL_SOFTWARE_CORE_AGENT_IDS,
  assertValidTeamBundle,
  validateTeamCharter,
  validateWorkflowManifest,
} from './schemas.js';

const FIXTURE_DIR = resolve(fileURLToPath(new URL('../../fixtures/team/', import.meta.url)));
// W1.5.B (ADR W1.5 Option C "merge"): domain-templates is the canonical
// agent-id spec; fixtures remain canonical for the executable team bundle.
// `loadTeamTemplate` cross-validates the two sources at load time so any
// future drift surfaces as a load-time signal rather than a silent
// runtime mismatch. See `.planning/1.5.1/decisions/W1.5-canonical-source.md`.
const DOMAIN_TEMPLATES_DIR = resolve(fileURLToPath(new URL('./domain-templates/', import.meta.url)));
const SUPPORTED_ARCHETYPES = new Set(['software', 'design', 'content', 'book', 'research', 'business', 'mixed']);

// W1.5.B: one-time warning suppression per archetype so drift between
// fixtures and domain-templates emits a single, clearly-attributed
// warning rather than spamming stderr on every loadTeamTemplate call
// (tests + the CLI may both call into the loader inside the same process).
const _crossValidationWarned = new Set();

// T24 / G7-core: the four universal software-core agents. Any software-
// domain roster MUST include all four. The ids resolve to static markdown
// files under `claude/agents/<id>.md`; the generator does not synthesise
// these — it references them by id and trusts the installer to deploy the
// markdown files into platform-native agent directories.
//
// Single source of truth lives in `./schemas.js` (so downstream validators
// can reference the canonical list without importing the generator). This
// re-export keeps the historic generator.js surface intact for callers
// already wired to `SOFTWARE_CORE_AGENT_IDS`.
//
// Static set (order is deterministic for snapshot stability):
//   - ijfw-doc-verifier        — factual-claim verification post-doc-gen
//   - ijfw-integration-checker — cross-subagent E2E flow verification
//   - ijfw-nyquist-auditor     — coverage-gap closure + skeleton-test proposals
//   - ijfw-code-fixer          — atomic per-finding code fixes (G4 fixer)
export const SOFTWARE_CORE_AGENT_IDS = CANONICAL_SOFTWARE_CORE_AGENT_IDS;

// T25 / G7-gen: canonical per-domain specialist agent ids. Re-exported from
// schemas.js so callers wired to `generator.js` get a stable surface. See
// schemas.js for the per-archetype contract and the rationale for which
// archetypes are populated today.
export const DOMAIN_SPECIALIST_AGENT_IDS = CANONICAL_DOMAIN_SPECIALIST_AGENT_IDS;

// T24: archetypes that always include the software-core agent set.
// Currently only `software`; future domains (`mixed` with software files)
// may opt in via T25's domain-aware generator.
const SOFTWARE_CORE_ARCHETYPES = new Set(['software']);

// F-FUN-1: alias map -- detector returns language-flavoured labels and
// project-type-detector emits 'unknown' / unmapped domains. Canonicalize
// BEFORE the SUPPORTED_ARCHETYPES gate so detector outputs don't collapse
// to 'mixed' just because the literal string isn't in the supported set.
const ARCHETYPE_ALIASES = new Map([
  // language-specific aliases that some detector paths surface
  ['typescript', 'software'],
  ['javascript', 'software'],
  ['python', 'software'],
  ['rust', 'software'],
  ['go', 'software'],
  ['java', 'software'],
  ['ruby', 'software'],
  ['php', 'software'],
  ['cpp', 'software'],
  ['c++', 'software'],
  ['csharp', 'software'],
  ['code', 'software'],
  ['app', 'software'],
  ['api', 'software'],
  // domain synonyms surfaced by briefs and detector secondaries
  ['marketing', 'content'],
  ['campaign', 'content'],
  ['launch', 'content'],
  ['blog', 'content'],
  ['copy', 'content'],
  ['ui', 'design'],
  ['ux', 'design'],
  ['novel', 'book'],
  ['story', 'book'],
  ['manuscript', 'book'],
  ['paper', 'research'],
  ['study', 'research'],
  ['thesis', 'research'],
  ['strategy', 'business'],
  ['ops', 'business'],
  ['operations', 'business'],
  ['education', 'mixed'],
  ['unknown', 'mixed'],
]);

// F-FUN-1: brief keyword maps. Each phrase scores +1 toward the listed
// archetype on whole-word hit. Word boundaries matter -- "research" matches
// in "research project" but not "researching" -- so we tokenize the brief
// before scoring. Mirrors the canonical domain list in team-templates.md.
const BRIEF_KEYWORDS = {
  software: [
    'software', 'app', 'application', 'api', 'code', 'codebase', 'service',
    'webapp', 'backend', 'frontend', 'mobile', 'sdk', 'library', 'cli',
    'feature', 'endpoint', 'module', 'refactor', 'bugfix', 'plugin',
    'platform', 'integration', 'pipeline',
  ],
  book: [
    'book', 'novel', 'novella', 'story', 'chapter', 'chapters', 'manuscript',
    'memoir', 'fiction', 'nonfiction', 'prose', 'narrative', 'screenplay',
    'cookbook', 'anthology',
  ],
  content: [
    'campaign', 'launch', 'marketing', 'content', 'blog', 'article',
    'newsletter', 'copy', 'copywriting', 'landing', 'social', 'seo',
    'email', 'post', 'posts', 'announcement', 'press',
  ],
  design: [
    'design', 'ui', 'ux', 'wireframe', 'mockup', 'figma', 'prototype',
    'visual', 'brand', 'logo', 'illustration', 'typography', 'palette',
    'design-system',
  ],
  research: [
    'research', 'paper', 'study', 'thesis', 'methodology', 'experiment',
    'literature', 'corpus', 'survey', 'analysis', 'hypothesis', 'findings',
    'whitepaper',
  ],
  business: [
    'business', 'strategy', 'operations', 'ops', 'financial', 'finance',
    'budget', 'forecast', 'plan', 'pitch', 'investor', 'gtm', 'b2b', 'b2c',
    'revenue', 'roadmap', 'okrs',
  ],
};

// F-FUN-1: brief signal threshold. A single keyword hit isn't enough to
// override filesystem signals (a software repo whose README says "we plan to
// research X" should stay software). Two distinct keyword hits OR a strong
// signal phrase ("write a book", "marketing campaign", "research paper")
// flips the result. Phrases score double because they're explicit.
const BRIEF_PHRASES = {
  software: [/\b(build|ship|develop|implement)\s+(?:a|an|the)?\s*(app|application|api|service|feature|module|library)\b/i, /\bsource\s+code\b/i],
  book: [/\bwrite\s+(?:a|an|the)?\s*(book|novel|memoir|story|chapter)\b/i, /\bbook\s+about\b/i],
  content: [/\b(marketing|launch|content|seo|social\s+media)\s+(campaign|strategy|plan|push)\b/i, /\bblog\s+post\b/i],
  design: [/\b(design|brand|ui|ux)\s+(system|kit|guide|language|review)\b/i, /\bwireframe(?:s|d)?\s+(?:the|for|of)\b/i],
  research: [/\bresearch\s+(paper|project|study|report|brief)\b/i, /\bliterature\s+review\b/i],
  business: [/\b(business|strategy|operations)\s+(plan|roadmap|memo)\b/i, /\binvestor\s+(deck|pitch|memo)\b/i],
};

const BRIEF_SCORE_FLIP_THRESHOLD = 2;

export function detectTeamArchetype(projectRoot = process.cwd(), options = {}) {
  if (options.archetype) return normalizeArchetype(options.archetype);

  // F-FUN-1: brief-first archetype routing. When the caller hands us a
  // non-empty project brief, score it for explicit domain signals before
  // falling back to filesystem-only detection. An explicit brief domain
  // (e.g. "I'm writing a book about ...") MUST outweigh the filesystem
  // signal -- otherwise book/research/campaign projects collapse to 'mixed'
  // when run from a tmp directory or a freshly cloned repo with no files.
  const brief = typeof options.brief === 'string' ? options.brief : '';
  const briefScores = scoreBrief(brief);
  const briefWinner = topBriefDomain(briefScores);

  const detected = detect(projectRoot, { maxFiles: options.maxFiles || 4000, c9Available: false });
  const detectedArchetype = normalizeArchetype(detected.primary_type || detected.type);

  if (briefWinner) return briefWinner;
  return detectedArchetype;
}

// F-FUN-1: brief scorer. Returns a map of {archetype: score}. Word-boundary
// match for single tokens, regex match for phrase signals (which count
// double). The caller picks the winner.
export function scoreBrief(brief) {
  const scores = { software: 0, book: 0, content: 0, design: 0, research: 0, business: 0 };
  if (!brief || typeof brief !== 'string') return scores;
  const text = brief.toLowerCase();

  for (const [domain, tokens] of Object.entries(BRIEF_KEYWORDS)) {
    for (const token of tokens) {
      const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i');
      if (re.test(text)) scores[domain] += 1;
    }
  }

  for (const [domain, patterns] of Object.entries(BRIEF_PHRASES)) {
    for (const re of patterns) {
      if (re.test(text)) scores[domain] += 2;
    }
  }

  return scores;
}

function topBriefDomain(scores) {
  let best = null;
  let bestScore = 0;
  for (const [domain, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  // Require at least the flip threshold AND a clear margin over runner-up.
  // Without margin, "research the market for an app" ties software vs
  // research and we should fall through to filesystem detection instead.
  if (bestScore < BRIEF_SCORE_FLIP_THRESHOLD) return null;
  const second = Object.entries(scores)
    .filter(([d]) => d !== best)
    .reduce((m, [, s]) => Math.max(m, s), 0);
  if (second >= bestScore) return null;
  return best;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// T24 / G7-core: resolve the static software-core agent set for an
// archetype. Returns `[]` for non-software archetypes. The returned ids
// each resolve to `claude/agents/<id>.md` in the IJFW repo — callers can
// look the files up via the installer's deploy step (the markdown is the
// agent spec; the generator doesn't render its content, it references
// it). Deterministic order.
export function resolveSoftwareCoreAgentIds(archetype) {
  const normalized = normalizeArchetype(archetype);
  if (!SOFTWARE_CORE_ARCHETYPES.has(normalized)) return [];
  // Return a fresh array so callers cannot mutate the frozen source set
  // through the public surface.
  return [...SOFTWARE_CORE_AGENT_IDS];
}

// T25 / G7-gen: resolve the per-domain specialist agent set. Returns the
// archetype's specialist ids per `DOMAIN_SPECIALIST_AGENT_IDS`, or `[]` if
// the archetype has no domain specialists yet (e.g. `research`, `business`,
// `mixed`). For `software` this returns `[]` — the software roster is
// covered by `resolveSoftwareCoreAgentIds`, not duplicated here.
//
// Deterministic order. Returns a fresh array per call.
export function resolveDomainSpecialistAgentIds(archetype) {
  const normalized = normalizeArchetype(archetype);
  const specialists = DOMAIN_SPECIALIST_AGENT_IDS[normalized];
  if (!Array.isArray(specialists)) return [];
  return [...specialists];
}

// T25 / G7-gen: resolve the FULL roster for an archetype — the union of
// software-core agents (when applicable) plus domain specialists. This is
// the single function downstream callers (installers, dashboard tiles,
// `roster.synthesize` consumers) should reach for when they want the
// complete set of agents the generator believes a domain needs.
//
// Contract:
//   - software archetype  → all 4 SOFTWARE_CORE_AGENT_IDS, no specialists
//   - book/content/design → only the domain specialists for that archetype
//   - other archetypes    → []
//   - order is deterministic: software-core first, then domain specialists
//   - no duplicates: even if a domain ever overlaps with a core id (it
//     should not, by convention — see schemas.js), the union dedupes.
//
// The returned array is fresh per call so callers cannot mutate the
// canonical sources via the public surface.
export function resolveRosterForDomain(archetype) {
  const normalized = normalizeArchetype(archetype);
  const core = resolveSoftwareCoreAgentIds(normalized);
  const specialists = resolveDomainSpecialistAgentIds(normalized);
  const merged = [...core];
  for (const id of specialists) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

export function loadTeamTemplate(archetype) {
  const normalized = normalizeArchetype(archetype);
  const path = join(FIXTURE_DIR, `${normalized}.json`);
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  assertValidTeamBundle(bundle);

  // W1.5.B cross-validation gate. Read the matching T26 domain-template
  // (if any) and cross-check that the fixture's `charter.roles[].name`
  // set agrees with the template's `agent_ids`. Two sources of truth
  // that SHOULD agree by construction (ADR W1.5 Option C "merge"); this
  // gate makes future drift self-detect at load time rather than as a
  // silent runtime miss far from the cause.
  //
  // Behaviour:
  //   - template file missing
  //       → e.g. `mixed` (deliberately template-free per ADR W1.5).
  //         Fixture is the sole source of truth; gate is a no-op.
  //   - template present but `agent_ids` empty
  //       → fall back to fixture as ground truth; emit a one-time
  //         warning so the unpopulated template is visible. W1.5.C
  //         populated research + business; if any other archetype ever
  //         lands empty in future, operators see it immediately.
  //   - template populated AND agrees with fixture role names
  //         (every fixture role name appears in template `agent_ids`)
  //       → silent pass; the canonical contract holds.
  //   - template populated AND disagrees
  //       → emit a one-time warning naming the drifting role(s) and the
  //         template ids they failed to match. Fail-loud at load time
  //         via `process.emitWarning` so CI logs and operators see the
  //         drift, but DON'T throw during the v1.5.1 transitional
  //         window where W1.5.E (fixture rename) and W1.5.B (this gate)
  //         ship in separate commits. Once W1.5.E lands and shipped
  //         fixtures are realigned, this warning never fires in the
  //         normal codepath; downstream may graduate the warning to a
  //         thrown error once the steady state is confirmed.
  //
  // The contract for callers: a non-throwing return ALWAYS means the
  // fixture bundle is structurally valid (assertValidTeamBundle above);
  // drift between fixture role names and the domain-template agent_ids
  // surfaces as a one-time `IjfwTeamFixtureDrift` warning on stderr.
  crossValidateAgainstDomainTemplate(normalized, bundle);

  return structuredClone(bundle);
}

// W1.5.B: read the T26 domain-template for an archetype (if any) and
// compare it against the fixture bundle's role names. See
// loadTeamTemplate above for the contract and ADR W1.5 for the rationale.
function crossValidateAgainstDomainTemplate(archetype, bundle) {
  const templatePath = join(DOMAIN_TEMPLATES_DIR, `${archetype}.json`);
  if (!existsSync(templatePath)) {
    // No T26 template for this archetype (e.g. `mixed` — deliberately
    // template-free per ADR W1.5). Fixture is the sole source of truth.
    return;
  }

  let template;
  try {
    template = JSON.parse(readFileSync(templatePath, 'utf8'));
  } catch (err) {
    // Unparseable template should not silently bypass the gate, but a
    // parse error in the template is a separate failure mode from
    // drift; emit a warning so the broken file is visible without
    // breaking the generator for users whose fixture is structurally fine.
    warnOnce(
      `team-generator: domain-template "${archetype}.json" is unreadable (${err.message}); ` +
        'falling back to fixture as ground truth.',
      `parse:${archetype}`,
    );
    return;
  }

  const templateIds = Array.isArray(template.agent_ids) ? template.agent_ids : [];
  if (templateIds.length === 0) {
    // ADR W1.5 step 5: T26 empty. Fall back to fixture as ground truth
    // and emit a one-time warning so the gap is visible to operators.
    warnOnce(
      `team-generator: domain-template "${archetype}" has empty agent_ids — ` +
        'falling back to fixture as ground truth.',
      `empty:${archetype}`,
    );
    return;
  }

  const fixtureRoleNames = (bundle.charter && Array.isArray(bundle.charter.roles))
    ? bundle.charter.roles.map((role) => role && role.name).filter(Boolean)
    : [];

  // The contract (ADR W1.5 Option C): every shipped-fixture role.name
  // MUST appear in the template's agent_ids set. Drift is a load-time
  // observability signal — emitted as a one-time warning so CI/operators
  // see it, but NOT thrown during the v1.5.1 transitional window where
  // W1.5.E (fixture rename) and W1.5.B (this gate) ship in separate
  // commits. Steady state post-W1.5.E: this warning never fires; the
  // gate becomes effectively-throw because mismatch can no longer exist.
  const templateSet = new Set(templateIds);
  const missing = fixtureRoleNames.filter((name) => !templateSet.has(name));
  if (missing.length === 0) return;

  warnOnce(
    `team-generator: fixtures/team/${archetype}.json drifted from ` +
      `domain-templates/${archetype}.json — role name(s) ${missing.map((m) => `"${m}"`).join(', ')} ` +
      `not present in template agent_ids [${templateIds.join(', ')}]. ` +
      'See ADR .planning/1.5.1/decisions/W1.5-canonical-source.md (Option C "merge"): ' +
      'fixture roles MUST be a subset of the domain-template agent_ids. ' +
      'W1.5.E (fixture rename) will close any remaining drift; until then ' +
      'the fixture is treated as ground truth for the executable team bundle.',
    `drift:${archetype}`,
  );
}

function warnOnce(message, key) {
  if (_crossValidationWarned.has(key)) return;
  _crossValidationWarned.add(key);
  // process.emitWarning is the Node-canonical channel for non-fatal
  // load-time signals — visible to CI logs, suppressible via
  // --no-warnings, and includes a stack so the source is traceable.
  process.emitWarning(message, { type: 'IjfwTeamFixtureDrift', code: 'IJFW_W1_5_B_DRIFT' });
}

export function createTeamAssembly(projectRoot = process.cwd(), options = {}) {
  const root = resolve(projectRoot);
  // F-FUN-1: `options.brief` flows through to detectTeamArchetype so a
  // CLI / MCP caller can hand in a project brief and get a correct
  // archetype before any filesystem signals exist.
  const archetype = detectTeamArchetype(root, options);
  const bundle = loadTeamTemplate(archetype);
  const teamName = options.teamName || `${basename(root) || archetype}-team`;

  bundle.charter.team_name = teamName;
  bundle.charter.generated_at = new Date().toISOString();
  bundle.charter.source_archetype = archetype;
  bundle.workflow.generated_at = bundle.charter.generated_at;
  bundle.workflow.source_archetype = archetype;

  const teamDir = join(root, '.ijfw', 'team');
  const agentsDir = join(root, '.ijfw', 'agents');
  mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });

  const charterPath = join(teamDir, 'charter.json');
  const workflowPath = join(teamDir, 'workflow.json');
  if (!options.force && (existsSync(charterPath) || existsSync(workflowPath))) {
    return { ok: false, error: 'exists', teamDir, agentsDir, archetype };
  }

  writeAtomic(charterPath, `${JSON.stringify(bundle.charter, null, 2)}\n`, { mode: 0o600 });
  writeAtomic(workflowPath, `${JSON.stringify(bundle.workflow, null, 2)}\n`, { mode: 0o600 });

  const agentFiles = [];
  const writtenAgentNames = new Set();
  for (const role of bundle.charter.roles) {
    const agentPath = join(agentsDir, `${role.name}.md`);
    writeAtomic(agentPath, renderAgent(role, bundle), { mode: 0o600 });
    agentFiles.push(agentPath);
    writtenAgentNames.add(role.name);
  }
  const codexAgents = syncCodexAgents(root, { bundle });

  // T24 / G7-core: software-domain rosters always advertise the static
  // software-core agent set. Non-software archetypes get an empty array
  // (preserves the field on every return shape so callers don't need to
  // null-check). The ids point to `claude/agents/<id>.md` in the IJFW
  // install; the installer is responsible for placing the markdown.
  const softwareCoreAgentIds = resolveSoftwareCoreAgentIds(archetype);

  // T25 / G7-gen: domain-specific specialist agent ids. Same on-disk
  // contract as the software-core ids — each id resolves to
  // `claude/agents/<id>.md`. T25 returns the ids; T26 lands the matching
  // markdown files. Until T26 ships, downstream installers should treat
  // a missing file as "deploy stub" rather than fail-closed.
  const domainSpecialistAgentIds = resolveDomainSpecialistAgentIds(archetype);
  const rosterAgentIds = resolveRosterForDomain(archetype);

  // W1.5.B: wire DOMAIN_SPECIALIST_AGENT_IDS through to file creation.
  // Previously the canonical specialist ids were surfaced in the return
  // value (`domainSpecialistAgentIds`, `rosterAgentIds`) but no matching
  // `.md` files were written into `.ijfw/agents/` — so a swarm
  // dispatcher resolving "the book domain specialists" by id got a list
  // pointing at non-existent local files. This loop closes that gap by
  // emitting a stub agent .md for every canonical specialist id that
  // the fixture role-write loop above did NOT already cover. When
  // fixture role names already match the canonical ids (the steady
  // state post-W1.5.E), this loop is a no-op because `writtenAgentNames`
  // already contains them.
  //
  // The stub references the canonical `claude/agents/<id>.md` so a
  // swarm dispatcher resolving by id still gets a discoverable local
  // entry; the installer is responsible for materialising the full
  // agent spec.
  for (const specialistId of domainSpecialistAgentIds) {
    if (writtenAgentNames.has(specialistId)) continue;
    const agentPath = join(agentsDir, `${specialistId}.md`);
    writeAtomic(agentPath, renderSpecialistStub(specialistId, archetype, bundle), { mode: 0o600 });
    agentFiles.push(agentPath);
    writtenAgentNames.add(specialistId);
  }

  return {
    ok: true,
    archetype,
    team_name: teamName,
    teamDir,
    agentsDir,
    charterPath,
    workflowPath,
    agentFiles,
    codexAgents,
    softwareCoreAgentIds,
    domainSpecialistAgentIds,
    rosterAgentIds,
  };
}

export function readTeamAssembly(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const charterPath = join(root, '.ijfw', 'team', 'charter.json');
  const workflowPath = join(root, '.ijfw', 'team', 'workflow.json');
  const agentsDir = join(root, '.ijfw', 'agents');
  const charter = existsSync(charterPath) ? JSON.parse(readFileSync(charterPath, 'utf8')) : null;
  const workflow = existsSync(workflowPath) ? JSON.parse(readFileSync(workflowPath, 'utf8')) : null;
  const agents = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((file) => file.endsWith('.md')).sort()
    : [];
  const charterValidation = charter ? validateTeamCharter(charter) : { ok: false, errors: ['missing charter'] };
  const workflowValidation = workflow ? validateWorkflowManifest(workflow, charter) : { ok: false, errors: ['missing workflow'] };
  return {
    ok: Boolean(charter && workflow && charterValidation.ok && workflowValidation.ok),
    charterPath,
    workflowPath,
    agentsDir,
    agents,
    charter,
    workflow,
    validation: {
      charter: charterValidation,
      workflow: workflowValidation,
    },
  };
}

function normalizeArchetype(value) {
  const archetype = String(value || '').toLowerCase();
  if (SUPPORTED_ARCHETYPES.has(archetype)) return archetype;
  // F-FUN-1: canonicalize via the alias map BEFORE collapsing to 'mixed'.
  // Without this, the detector's language-flavoured outputs (typescript,
  // javascript, python, ...) and project-type-detector's 'unknown' all
  // collapse to 'mixed', losing the strongest signal we have.
  const aliased = ARCHETYPE_ALIASES.get(archetype);
  if (aliased && SUPPORTED_ARCHETYPES.has(aliased)) return aliased;
  return 'mixed';
}

// W1.5.B: stub renderer for canonical domain-specialist ids that the
// shipped fixture doesn't yet name as a `charter.roles[].name`. Keeps
// the `.ijfw/agents/<id>.md` directory in agreement with
// `domainSpecialistAgentIds` so downstream swarm dispatchers resolving
// by id always find a local file. The stub is intentionally minimal —
// the full agent spec lives in `claude/agents/<id>.md` and is deployed
// by the installer; this is a discovery breadcrumb, not a duplicated spec.
function renderSpecialistStub(specialistId, archetype, bundle) {
  const archetypes = bundle.charter.project_archetypes.join(', ');
  return `---\nname: ${specialistId}\nmodel: sonnet\neffort: medium\ndescription: ${specialistId} — canonical ${archetype} domain specialist (T26 domain-template).\nallowed-tools: Read, Write, Edit, Bash\n---\n\n# ${specialistId}\n\nCanonical domain specialist for ${archetypes} projects.\n\nFull agent specification: claude/agents/${specialistId}.md (deployed by the IJFW installer).\n\nThis stub exists so swarm dispatchers resolving by id find a local entry; the canonical spec is the source of truth.\n\nRecord claims, findings, blockers, and decisions in .ijfw/blackboard/ when swarm execution is active.\n`;
}

function renderAgent(role, bundle) {
  const owned = role.owns.map((item) => `- ${item.artifact_type}: ${(item.paths || item.refs || []).join(', ')}`).join('\n');
  const reviews = role.reviews.map((item) => `- ${item.artifact_type}: ${item.criteria.join(', ')}`).join('\n') || '- None';
  const phases = role.phase_scope.join(', ');
  const sections = role.handoff.required_sections.join(', ');
  const archetypes = bundle.charter.project_archetypes.join(', ');

  return `---\nname: ${role.name}\nmodel: ${role.model}\neffort: ${role.effort || 'medium'}\ndescription: ${role.name} for ${archetypes} projects; owns ${role.owns.map((item) => item.artifact_type).join(', ')}.\nallowed-tools: Read, Write, Edit, Bash\n---\n\n# ${role.name}\n\nYou are part of this project's IJFW team assembly.\n\nProject archetypes: ${archetypes}\nRole type: ${role.role_type}\nPhase scope: ${phases}\n\n## Owns\n\n${owned}\n\n## Reviews\n\n${reviews}\n\n## Coordination\n\n- Claim required: ${role.coordination.claim_required ? 'yes' : 'no'}\n- Parallel safe: ${role.coordination.parallel_safe ? 'yes' : 'no'}\n- Conflicts with: ${role.coordination.conflicts_with.length ? role.coordination.conflicts_with.join(', ') : 'none'}\n\n## Handoff\n\nFormat: ${role.handoff.format}\nRequired sections: ${sections}\n\nRecord claims, findings, blockers, and decisions in .ijfw/blackboard/ when swarm execution is active.\n`;
}
