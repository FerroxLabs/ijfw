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
import { assertValidTeamBundle, validateTeamCharter, validateWorkflowManifest } from './schemas.js';

const FIXTURE_DIR = resolve(fileURLToPath(new URL('../../fixtures/team/', import.meta.url)));
const SUPPORTED_ARCHETYPES = new Set(['software', 'design', 'content', 'book', 'research', 'business', 'mixed']);

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

export function loadTeamTemplate(archetype) {
  const normalized = normalizeArchetype(archetype);
  const path = join(FIXTURE_DIR, `${normalized}.json`);
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  assertValidTeamBundle(bundle);
  return structuredClone(bundle);
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
  for (const role of bundle.charter.roles) {
    const agentPath = join(agentsDir, `${role.name}.md`);
    writeAtomic(agentPath, renderAgent(role, bundle), { mode: 0o600 });
    agentFiles.push(agentPath);
  }
  const codexAgents = syncCodexAgents(root, { bundle });

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

function renderAgent(role, bundle) {
  const owned = role.owns.map((item) => `- ${item.artifact_type}: ${(item.paths || item.refs || []).join(', ')}`).join('\n');
  const reviews = role.reviews.map((item) => `- ${item.artifact_type}: ${item.criteria.join(', ')}`).join('\n') || '- None';
  const phases = role.phase_scope.join(', ');
  const sections = role.handoff.required_sections.join(', ');
  const archetypes = bundle.charter.project_archetypes.join(', ');

  return `---\nname: ${role.name}\nmodel: ${role.model}\neffort: ${role.effort || 'medium'}\ndescription: ${role.name} for ${archetypes} projects; owns ${role.owns.map((item) => item.artifact_type).join(', ')}.\nallowed-tools: Read, Write, Edit, Bash\n---\n\n# ${role.name}\n\nYou are part of this project's IJFW team assembly.\n\nProject archetypes: ${archetypes}\nRole type: ${role.role_type}\nPhase scope: ${phases}\n\n## Owns\n\n${owned}\n\n## Reviews\n\n${reviews}\n\n## Coordination\n\n- Claim required: ${role.coordination.claim_required ? 'yes' : 'no'}\n- Parallel safe: ${role.coordination.parallel_safe ? 'yes' : 'no'}\n- Conflicts with: ${role.coordination.conflicts_with.length ? role.coordination.conflicts_with.join(', ') : 'none'}\n\n## Handoff\n\nFormat: ${role.handoff.format}\nRequired sections: ${sections}\n\nRecord claims, findings, blockers, and decisions in .ijfw/blackboard/ when swarm execution is active.\n`;
}
