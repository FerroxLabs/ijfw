// --- swarm.json schema + lazy init ---
//
// Knows what specialists belong on a project's swarm. On first use the
// orchestrator calls loadSwarmConfig(projectDir); the result is written to
// <projectDir>/.ijfw/swarm.json so the user can customize later.
//
// Never writes at require/install time. ESM. Zero external deps.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = {
  project_type: 'string',
  specialists: [{ id: 'string', role: 'string', agent_type: 'string' }],
  // v1.4.4 N10: auditor roster for phase-e-auto
  auditors: ['string'],       // roster IDs to use for Cross-Audit Phase; default ['codex','gemini','claude']
  auditor_count: 'number',    // number of lenses; default 3
};

const BASE = [
  { id: 'reviewer',    role: 'Code review',      agent_type: 'code-reviewer' },
  { id: 'reliability', role: 'Silent failures',   agent_type: 'silent-failure-hunter' },
];

const TESTS_SPECIALIST = { id: 'tests', role: 'Test coverage', agent_type: 'pr-test-analyzer' };
const TYPES_SPECIALIST = { id: 'types', role: 'Type invariants', agent_type: 'type-design-analyzer' };

// v1.4.4 N6 — 5 specialist agents addressing v1.4.3 build pain points
const DOC_VERIFIER     = { id: 'doc-verifier',       role: 'Doc accuracy',       agent_type: 'ijfw-doc-verifier' };
const PATTERN_MAPPER   = { id: 'pattern-mapper',     role: 'Onboarding patterns', agent_type: 'ijfw-pattern-mapper' };
const SECURITY_AUDITOR = { id: 'security-auditor',   role: 'Security mitigations', agent_type: 'ijfw-security-auditor' };
const INTEGRATION_CHECKER = { id: 'integration-checker', role: 'E2E flow verification', agent_type: 'ijfw-integration-checker' };
const NYQUIST_AUDITOR  = { id: 'nyquist-auditor',    role: 'Coverage gaps',      agent_type: 'ijfw-nyquist-auditor' };

export const DEFAULT_SPECIALISTS = {
  node:   [...BASE, TESTS_SPECIALIST, DOC_VERIFIER, PATTERN_MAPPER, SECURITY_AUDITOR, INTEGRATION_CHECKER, NYQUIST_AUDITOR],
  python: [...BASE, TESTS_SPECIALIST, DOC_VERIFIER, PATTERN_MAPPER, SECURITY_AUDITOR, INTEGRATION_CHECKER, NYQUIST_AUDITOR],
  typed:  [...BASE, TESTS_SPECIALIST, TYPES_SPECIALIST, DOC_VERIFIER, PATTERN_MAPPER, SECURITY_AUDITOR, INTEGRATION_CHECKER, NYQUIST_AUDITOR],
  go:     [...BASE, DOC_VERIFIER, PATTERN_MAPPER, SECURITY_AUDITOR, INTEGRATION_CHECKER, NYQUIST_AUDITOR],
  rust:   [...BASE, DOC_VERIFIER, PATTERN_MAPPER, SECURITY_AUDITOR, INTEGRATION_CHECKER, NYQUIST_AUDITOR],
  other:  [...BASE, DOC_VERIFIER, PATTERN_MAPPER, SECURITY_AUDITOR, INTEGRATION_CHECKER, NYQUIST_AUDITOR],
};

// Detects project type from filesystem signals in projectDir.
// Returns 'node' | 'python' | 'go' | 'rust' | 'typed' | 'other'.
export function detectProjectType(projectDir) {
  const has = (f) => existsSync(join(projectDir, f));

  const isNode   = has('package.json');
  const isPython = has('pyproject.toml') || has('requirements.txt');
  const isGo     = has('go.mod');
  const isRust   = has('Cargo.toml');
  const isTyped  = has('tsconfig.json');

  // TypeScript takes precedence: typed variant of node (or bare TS project).
  if (isTyped)   return 'typed';
  if (isNode)    return 'node';
  if (isPython)  return 'python';
  if (isGo)      return 'go';
  if (isRust)    return 'rust';
  return 'other';
}

// Default auditor IDs for Cross-Audit Phase (N10).
export const DEFAULT_AUDITORS = ['codex', 'gemini', 'claude'];
export const DEFAULT_AUDITOR_COUNT = 3;

// Merge v1.4.4 N10 defaults into a raw config object (non-destructive).
function applySwarmDefaults(config) {
  const out = { ...config };
  if (!Array.isArray(out.auditors)) out.auditors = [...DEFAULT_AUDITORS];
  if (typeof out.auditor_count !== 'number' || out.auditor_count < 1) out.auditor_count = DEFAULT_AUDITOR_COUNT;
  return out;
}

// Returns a fresh default config object for the given project type.
function buildDefault(projectType) {
  const specialists = DEFAULT_SPECIALISTS[projectType] ?? DEFAULT_SPECIALISTS.other;
  return applySwarmDefaults({ project_type: projectType, specialists: specialists.map(s => ({ ...s })) });
}

// Reads .ijfw/swarm.json if present, otherwise detects type, generates
// default config, persists it, and returns it.
export function loadSwarmConfig(projectDir) {
  const swarmPath = join(projectDir, '.ijfw', 'swarm.json');

  if (existsSync(swarmPath)) {
    const raw = JSON.parse(readFileSync(swarmPath, 'utf8'));
    // Merge defaults for v1.4.4 N10 fields so older swarm.json files work.
    return applySwarmDefaults(raw);
  }

  const projectType = detectProjectType(projectDir);
  const config = buildDefault(projectType);

  const ijfwDir = join(projectDir, '.ijfw');
  if (!existsSync(ijfwDir)) mkdirSync(ijfwDir, { recursive: true });
  writeFileSync(swarmPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  return config;
}

// Convenience alias used by orchestrator (matches the spec name).
export const getSwarmConfig = loadSwarmConfig;
