import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTemplate,
  assignRoles,
  buildRequest,
  parseResponse,
  scoreRebuttalSurvival,
  mergeResponses,
  estimateCost,
  checkBudget,
} from './src/cross-dispatcher.js';

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

test('getTemplate returns system+format for every valid mode+angle', () => {
  const combos = [
    ['audit',    'general'],
    ['research', 'benchmarks'],
    ['research', 'citations'],
    ['research', 'synthesis'],
    ['critique', 'technical'],
    ['critique', 'strategic'],
    ['critique', 'ux'],
  ];
  for (const [mode, angle] of combos) {
    const t = getTemplate(mode, angle);
    assert.ok(typeof t.system === 'string' && t.system.length > 0, `${mode}/${angle} system empty`);
    assert.ok(typeof t.format === 'string' && t.format.length > 0, `${mode}/${angle} format empty`);
  }
});

test('getTemplate throws on unknown mode', () => {
  assert.throws(() => getTemplate('book', 'general'), /Unknown mode/);
});

test('getTemplate throws on unknown angle', () => {
  assert.throws(() => getTemplate('audit', 'technical'), /Unknown angle/);
  assert.throws(() => getTemplate('research', 'general'), /Unknown angle/);
});

test('getTemplate format contains json fence contract', () => {
  const { format } = getTemplate('audit', 'general');
  assert.ok(format.includes('```json'), 'format must contain json fence marker');
});

// ---------------------------------------------------------------------------
// assignRoles
// ---------------------------------------------------------------------------

const FULL_ROSTER = ['codex', 'gemini', 'claude', 'opencode', 'aider', 'copilot'];

test('assignRoles audit with full roster assigns one role', () => {
  const { roles, missing } = assignRoles('audit', FULL_ROSTER, 'claude');
  assert.equal(roles.length, 1);
  assert.equal(missing.length, 0);
  assert.equal(roles[0].angle, 'general');
  assert.notEqual(roles[0].auditorId, 'claude'); // self excluded
});

test('assignRoles research with full roster assigns three angles', () => {
  const { roles, missing } = assignRoles('research', FULL_ROSTER, 'codex');
  assert.equal(roles.length, 3);
  assert.equal(missing.length, 0);
  const angles = roles.map(r => r.angle);
  assert.ok(angles.includes('benchmarks'));
  assert.ok(angles.includes('citations'));
  assert.ok(angles.includes('synthesis'));
});

test('assignRoles research synthesis always goes to claude even when self=claude', () => {
  const { roles } = assignRoles('research', FULL_ROSTER, 'claude');
  const syn = roles.find(r => r.angle === 'synthesis');
  assert.ok(syn, 'synthesis role must be assigned');
  assert.equal(syn.auditorId, 'claude');
});

test('assignRoles critique with self=codex excludes codex from technical', () => {
  const { roles, missing } = assignRoles('critique', FULL_ROSTER, 'codex');
  assert.equal(missing.length, 0);
  const tech = roles.find(r => r.angle === 'technical');
  assert.ok(tech, 'technical role assigned');
  assert.notEqual(tech.auditorId, 'codex');
});

test('assignRoles critique assigns all three angles', () => {
  const { roles } = assignRoles('critique', FULL_ROSTER, 'aider');
  const angles = roles.map(r => r.angle);
  assert.ok(angles.includes('technical'));
  assert.ok(angles.includes('strategic'));
  assert.ok(angles.includes('ux'));
});

test('assignRoles missing when auditor not in roster', () => {
  // Remove gemini - citations angle preferred by gemini should go to missing or fallback.
  const roster = ['codex', 'claude', 'opencode', 'aider', 'copilot']; // no gemini
  const { roles } = assignRoles('research', roster, 'codex');
  // citations preferred list is ['gemini', 'claude', 'copilot']; claude is installed so it takes it
  const cit = roles.find(r => r.angle === 'citations');
  assert.ok(cit, 'citations should fall back to next preferred');
  assert.notEqual(cit.auditorId, 'gemini'); // gemini not installed

  // If ONLY gemini handles citations and nothing else is in preferred:
  // use a stripped roster with none of the citation preferred installed.
  const sparseRoster = ['codex']; // no gemini, claude, copilot
  const { missing: m2 } = assignRoles('research', sparseRoster, 'something');
  // citations preferred: gemini, claude, copilot - none in sparse roster → missing
  assert.ok(m2.some(m => m.angle === 'citations'), 'citations should be in missing');
});

test('assignRoles throws on unknown mode', () => {
  assert.throws(() => assignRoles('book', FULL_ROSTER, 'codex'), /Unknown mode/);
});

// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------

test('buildRequest contains mode, auditor, angle, target', () => {
  const req = buildRequest('audit', 'src/foo.js', 'gemini', 'general');
  assert.ok(req.includes('gemini'), 'should include auditorId');
  assert.ok(req.includes('audit'), 'should include mode');
  assert.ok(req.includes('general'), 'should include angle');
  assert.ok(req.includes('src/foo.js'), 'should include target');
});

test('buildRequest contains format-contract markers', () => {
  const req = buildRequest('critique', 'design.md', 'codex', 'technical');
  assert.ok(req.includes('```json'), 'should contain json fence marker');
  assert.ok(req.includes('counterArg'), 'should contain schema key');
});

test('buildRequest research+synthesis embeds priorResponses verbatim', () => {
  const prior = 'PRIOR_RESPONSE_SENTINEL_XYZ';
  const req = buildRequest('research', 'topic', 'claude', 'synthesis', prior);
  assert.ok(req.includes(prior), 'priorResponses must appear verbatim in synthesis request');
  assert.ok(req.includes('Phase A'), 'should label prior responses section');
});

test('buildRequest non-synthesis does not embed priorResponses', () => {
  const prior = 'SHOULD_NOT_APPEAR';
  const req = buildRequest('research', 'topic', 'codex', 'benchmarks', prior);
  assert.ok(!req.includes(prior), 'priorResponses must not appear in non-synthesis request');
});

test('buildRequest has ISO timestamp', () => {
  const req = buildRequest('audit', 'foo', 'gemini', 'general');
  assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(req), 'should include ISO timestamp');
});

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

const AUDIT_FIXTURE = `Some prose intro here.

\`\`\`json
[
  {"severity":"high","dimension":"correctness","location":"src/foo.js:10","issue":"null deref","whyItMatters":"crashes on missing input","fix":"add null check"},
  {"severity":"low","dimension":"maintainability","location":"general","issue":"long function","whyItMatters":"hard to read","fix":"extract helper"}
]
\`\`\`

Trailing prose here.`;

const RESEARCH_FIXTURE = `\`\`\`json
[
  {"claim":"Node.js streams are faster for large files","evidence":"benchmark X","source":"github.com/x","confidence":"high"},
  {"claim":"async/await adds overhead","evidence":"v8 traces","source":"v8.dev","confidence":"medium"}
]
\`\`\``;

const CRITIQUE_FIXTURE = `\`\`\`json
[
  {"counterArg":"The migration path for existing users is undefined and will cause churn","conditions":"when existing users have deeply integrated workflows","mitigation":"provide a documented coexistence mode","severity":"high"},
  {"counterArg":"short arg","conditions":"","mitigation":"","severity":"low"}
]
\`\`\``;

test('parseResponse audit extracts items and prose', () => {
  const { items, prose } = parseResponse('audit', AUDIT_FIXTURE);
  assert.equal(items.length, 2);
  assert.equal(items[0].severity, 'high');
  assert.equal(items[1].severity, 'low');
  assert.ok(prose.includes('Some prose intro'));
  assert.ok(prose.includes('Trailing prose'));
  assert.ok(!prose.includes('```json'));
});

test('parseResponse research extracts items', () => {
  const { items } = parseResponse('research', RESEARCH_FIXTURE);
  assert.equal(items.length, 2);
  assert.equal(items[0].confidence, 'high');
});

test('parseResponse critique extracts items', () => {
  const { items } = parseResponse('critique', CRITIQUE_FIXTURE);
  assert.equal(items.length, 2);
  assert.equal(items[0].severity, 'high');
});

test('parseResponse returns empty items on malformed JSON', () => {
  const { items } = parseResponse('audit', '```json\n{not valid json}\n```');
  assert.deepEqual(items, []);
});

test('parseResponse returns empty items when no fence present', () => {
  const { items, prose } = parseResponse('audit', 'plain text only');
  assert.deepEqual(items, []);
  assert.equal(prose, 'plain text only');
});

test('parseResponse handles non-string input', () => {
  const { items, prose } = parseResponse('audit', null);
  assert.deepEqual(items, []);
  assert.equal(prose, '');
});

// ---------------------------------------------------------------------------
// scoreRebuttalSurvival
// ---------------------------------------------------------------------------

// STRONG_ARG hits every structural marker (not length): severity=critical,
// conditions has scenario marker ("when"/"in production"), mitigation has
// actionable verb ("implement"), counterArg cites concrete code evidence
// (backticked `function()` reference).
const STRONG_ARG = {
  counterArg: 'The `rotateToken()` call in auth.js:42 never revokes the prior token',
  conditions: 'when a stolen refresh token is replayed before rotation completes',
  mitigation: 'Implement immediate revocation in the rotation transaction',
  severity: 'critical',
};

const WEAK_ARG = {
  counterArg: 'could be better',
  conditions: '',
  mitigation: '',
  severity: 'low',
};

// Regression fixture for the length-bias bug dogfood-critique flagged:
// verbose prose with no structural signal should NOT outscore a concise
// code-anchored critical finding.
const VERBOSE_WEAK_ARG = {
  counterArg: 'This particular aspect of the overall system architecture has a number of considerations that might be worth looking into at some point in the future because it seems like it could potentially matter to somebody somewhere',
  conditions: 'generally speaking and in various situations that could arise',
  mitigation: 'someone could think about it more carefully than has been done so far',
  severity: 'low',
};

test('scoreRebuttalSurvival strong arg scores higher than weak arg', () => {
  const strong = scoreRebuttalSurvival(STRONG_ARG);
  const weak = scoreRebuttalSurvival(WEAK_ARG);
  assert.ok(strong > weak, `strong (${strong}) should beat weak (${weak})`);
});

test('scoreRebuttalSurvival is deterministic', () => {
  assert.equal(scoreRebuttalSurvival(STRONG_ARG), scoreRebuttalSurvival(STRONG_ARG));
  assert.equal(scoreRebuttalSurvival(WEAK_ARG), scoreRebuttalSurvival(WEAK_ARG));
});

test('scoreRebuttalSurvival clamps to [1,5]', () => {
  const s = scoreRebuttalSurvival(STRONG_ARG);
  assert.ok(s >= 1 && s <= 5, `score ${s} out of range`);
  const w = scoreRebuttalSurvival(WEAK_ARG);
  assert.ok(w >= 1 && w <= 5, `score ${w} out of range`);
});

test('scoreRebuttalSurvival handles null/missing input', () => {
  assert.equal(scoreRebuttalSurvival(null), 1);
  assert.equal(scoreRebuttalSurvival(undefined), 1);
  assert.equal(scoreRebuttalSurvival({}), 1);
});

test('scoreRebuttalSurvival max score for fully specified critical arg', () => {
  // All four bonus conditions met → base 1 + 4 = 5
  assert.equal(scoreRebuttalSurvival(STRONG_ARG), 5);
});

test('scoreRebuttalSurvival base score for empty arg', () => {
  assert.equal(scoreRebuttalSurvival(WEAK_ARG), 1);
});

// M1 regression: dogfood critique (Codex + Gemini consensus) flagged that
// the old length-based rubric let verbose-but-weak args outscore concise
// strong args. The structural rubric must NOT exhibit that behaviour.
test('scoreRebuttalSurvival verbose weak arg does not outscore concise strong arg', () => {
  const strong = scoreRebuttalSurvival(STRONG_ARG);
  const verboseWeak = scoreRebuttalSurvival(VERBOSE_WEAK_ARG);
  assert.ok(strong > verboseWeak, `concise strong (${strong}) must beat verbose weak (${verboseWeak})`);
});

// ---------------------------------------------------------------------------
// mergeResponses
// ---------------------------------------------------------------------------

test('mergeResponses audit sorts by severity critical→low', () => {
  const r1 = { items: [{ severity: 'low', dimension: 'maint', location: 'f', issue: 'a', whyItMatters: 'b', fix: 'c' }] };
  const r2 = { items: [{ severity: 'critical', dimension: 'sec', location: 'g', issue: 'd', whyItMatters: 'e', fix: 'f' }] };
  const r3 = { items: [{ severity: 'high', dimension: 'cor', location: 'h', issue: 'g', whyItMatters: 'h', fix: 'i' }] };
  const merged = mergeResponses('audit', [r1, r2, r3]);
  assert.equal(merged[0].severity, 'critical');
  assert.equal(merged[1].severity, 'high');
  assert.equal(merged[2].severity, 'low');
});

test('mergeResponses audit handles empty responses', () => {
  const merged = mergeResponses('audit', [{items:[]}, {items:[]}]);
  assert.deepEqual(merged, []);
});

test('mergeResponses research consensus - same normalised claim from ≥2 auditors', () => {
  const r1 = { items: [{ claim: 'Node is fast', evidence: 'bench A', source: 'x', confidence: 'high' }] };
  const r2 = { items: [{ claim: 'node is fast', evidence: 'bench A', source: 'y', confidence: 'high' }] }; // same after normalise
  const { consensus, unique } = mergeResponses('research', [r1, r2]);
  assert.equal(consensus.length, 1, 'should detect consensus across normalised claim');
  assert.equal(Object.keys(unique).length, 0, 'no unique items when consensus detected');
});

test('mergeResponses research contested - same claim with differing confidence', () => {
  const r1 = { items: [{ claim: 'async adds overhead', evidence: 'traces', source: 'a', confidence: 'high' }] };
  const r2 = { items: [{ claim: 'Async adds overhead', evidence: 'traces', source: 'b', confidence: 'low' }] };
  const { contested, consensus } = mergeResponses('research', [r1, r2]);
  assert.equal(contested.length, 2, 'both entries should be in contested');
  assert.equal(consensus.length, 0);
});

test('mergeResponses research unique - claims only from one auditor', () => {
  const r1 = { items: [{ claim: 'claim A', evidence: 'e', source: 's', confidence: 'high' }] };
  const r2 = { items: [{ claim: 'claim B', evidence: 'e', source: 's', confidence: 'high' }] };
  const { unique, consensus } = mergeResponses('research', [r1, r2]);
  assert.equal(consensus.length, 0);
  assert.equal(unique[0].length, 1);
  assert.equal(unique[1].length, 1);
});

test('mergeResponses critique ranks by survival DESC then severity DESC', () => {
  const strong = { counterArg: STRONG_ARG.counterArg, conditions: STRONG_ARG.conditions, mitigation: STRONG_ARG.mitigation, severity: 'critical' };
  const medium = { counterArg: 'Medium length arg that has some specificity to it here yes', conditions: 'under some conditions here described', mitigation: 'with a reasonable mitigation path described here', severity: 'medium' };
  const weak = { counterArg: 'weak', conditions: '', mitigation: '', severity: 'low' };

  const merged = mergeResponses('critique', [
    { items: [weak, strong] },
    { items: [medium] },
  ]);

  assert.equal(merged[0].severity, 'critical', 'critical/high-survival should be first');
  // strong should come before weak
  const strongIdx = merged.indexOf(strong);
  const weakIdx = merged.indexOf(weak);
  assert.ok(strongIdx < weakIdx, `strong (${strongIdx}) should rank before weak (${weakIdx})`);
});

test('mergeResponses throws on unknown mode', () => {
  assert.throws(() => mergeResponses('book', []), /Unknown mode/);
});

// ---------------------------------------------------------------------------
// estimateCost + checkBudget (Step 10B.6)
// ---------------------------------------------------------------------------

test('estimateCost returns positive number for non-empty target', () => {
  const cost = estimateCost('hello world', [{ id: 'codex' }]);
  assert.ok(typeof cost === 'number' && cost > 0);
});

test('estimateCost returns 0 for empty target', () => {
  assert.equal(estimateCost('', [{ id: 'codex' }]), 0);
});

test('estimateCost uses fallback price for unknown provider', () => {
  const c1 = estimateCost('hello world', [{ id: 'unknown-provider' }]);
  assert.ok(c1 > 0);
});

test('checkBudget returns null when no prior receipts (first call always passes)', () => {
  const sessionStart = new Date(Date.now() - 10_000);
  const result = checkBudget({
    target: 'some target',
    picks: [{ id: 'codex' }],
    receipts: [],
    sessionStart,
    env: { IJFW_AUDIT_BUDGET_USD: '0.01' },
  });
  assert.equal(result, null);
});

test('checkBudget returns null when accumulated is zero and estimate fits (default $2)', () => {
  const sessionStart = new Date(Date.now() - 10_000);
  const result = checkBudget({
    target: 'small target',
    picks: [{ id: 'codex' }],
    receipts: [],
    sessionStart,
    env: {},
  });
  assert.equal(result, null);
});

test('checkBudget returns error message when accumulated + estimate exceeds budget', () => {
  const sessionStart = new Date(Date.now() - 10_000);
  // accumulated=$0.009 + any positive estimate must exceed $0.009 budget
  const priorReceipt = { timestamp: new Date().toISOString(), cost_usd: 0.009 };
  const result = checkBudget({
    target: 'some target text that has some chars to estimate',
    picks: [{ id: 'codex' }],
    receipts: [priorReceipt],
    sessionStart,
    env: { IJFW_AUDIT_BUDGET_USD: '0.009' }, // budget exactly equal to accumulated
  });
  assert.ok(typeof result === 'string', 'should return a string error message');
  assert.ok(result.includes('Budget'), 'message must mention Budget');
  assert.ok(result.includes('accumulated'), 'message must mention accumulated');
  assert.ok(result.includes('Raise IJFW_AUDIT_BUDGET_USD'), 'message must include raise instruction');
});

test('checkBudget message matches exact format spec', () => {
  // With accumulated=$0.01 and budget=$0.01 and any estimate>0, should refuse.
  const sessionStart = new Date(Date.now() - 10_000);
  const priorReceipt = { timestamp: new Date().toISOString(), cost_usd: 0.01 };
  const result = checkBudget({
    target: 'a',
    picks: [{ id: 'codex' }],
    receipts: [priorReceipt],
    sessionStart,
    env: { IJFW_AUDIT_BUDGET_USD: '0.01' },
  });
  // Message format: "Budget $X.XX reached (accumulated $X.XX + next ~$X.XX). Raise IJFW_AUDIT_BUDGET_USD to continue."
  assert.ok(/Budget \$[\d.]+/.test(result), 'message must contain Budget $X.XX');
  assert.ok(/accumulated \$[\d.]+/.test(result), 'message must contain accumulated $X.XX');
  assert.ok(/next ~\$[\d.]+/.test(result), 'message must contain next ~$X.XX');
  assert.ok(result.endsWith('Raise IJFW_AUDIT_BUDGET_USD to continue.'), 'message must end with raise instruction');
});

test('checkBudget ignores receipts older than session start', () => {
  // Receipt is 1 hour before session start - should not count toward accumulated.
  const sessionStart = new Date(Date.now() - 1_000);
  const oldReceipt = { timestamp: new Date(Date.now() - 7_200_000).toISOString(), cost_usd: 100.0 };
  const result = checkBudget({
    target: 'small',
    picks: [{ id: 'codex' }],
    receipts: [oldReceipt],
    sessionStart,
    env: { IJFW_AUDIT_BUDGET_USD: '0.01' },
  });
  // old receipt excluded → accumulated=0 → first call allowed
  assert.equal(result, null);
});

test('checkBudget returns null when IJFW_AUDIT_BUDGET_USD is not set (default $2)', () => {
  const sessionStart = new Date(Date.now() - 10_000);
  // Even with a $1.50 receipt, $2 default still allows another call
  const priorReceipt = { timestamp: new Date().toISOString(), cost_usd: 0.50 };
  const result = checkBudget({
    target: 'small target',
    picks: [{ id: 'codex' }],
    receipts: [priorReceipt],
    sessionStart,
    env: {},
  });
  assert.equal(result, null);
});
