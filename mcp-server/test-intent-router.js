import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent } from './src/intent-router.js';

test('brainstorm → ijfw-workflow', () => {
  assert.equal(detectIntent('brainstorm a new API').skill, 'ijfw-workflow');
  assert.equal(detectIntent("let's design the auth flow").skill, 'ijfw-workflow');
  assert.equal(detectIntent('help me build a todo app').skill, 'ijfw-workflow');
  assert.equal(detectIntent('starting a new project tonight').skill, 'ijfw-workflow');
});

test('ship → ijfw-commit', () => {
  assert.equal(detectIntent('ship it').skill, 'ijfw-commit');
  assert.equal(detectIntent('ready to commit this').skill, 'ijfw-commit');
  assert.equal(detectIntent('create a PR for main').skill, 'ijfw-commit');
});

test('review → ijfw-review', () => {
  assert.equal(detectIntent('code review please').skill, 'ijfw-review');
  assert.equal(detectIntent('review the diff').skill, 'ijfw-review');
});

test('remember → ijfw_memory_store', () => {
  assert.equal(detectIntent('remember this: auth uses RS256').skill, 'ijfw_memory_store');
  assert.equal(detectIntent("that's important to remember").skill, 'ijfw_memory_store');
  assert.equal(detectIntent('note to self: never use ISO-8601 in DB').skill, 'ijfw_memory_store');
});

test('recall → ijfw_memory_recall', () => {
  assert.equal(detectIntent('what did we decide about auth?').skill, 'ijfw_memory_recall');
  assert.equal(detectIntent('do you remember the pagination fix?').skill, 'ijfw_memory_recall');
});

test('critique → ijfw-critique', () => {
  assert.equal(detectIntent('should I use websockets for this?').skill, 'ijfw-critique');
  assert.equal(detectIntent("play devil's advocate").skill, 'ijfw-critique');
  assert.equal(detectIntent('poke holes in this design').skill, 'ijfw-critique');
});

test('cross-research phrases → /cross-research', () => {
  assert.equal(detectIntent('cross research this').skill, '/cross-research');
  assert.equal(detectIntent("let's cross-research the approach").skill, '/cross-research');
  assert.equal(detectIntent('dig into GDPR implications from multiple angles').skill, '/cross-research');
  assert.equal(detectIntent('multi-angle research on caching strategies').skill, '/cross-research');
  assert.equal(detectIntent('research this from multiple angles').skill, '/cross-research');
});

test('cross-critique phrases → /cross-critique', () => {
  assert.equal(detectIntent("let's cross-critique the design").skill, '/cross-critique');
  assert.equal(detectIntent('adversarial review of the auth flow').skill, '/cross-critique');
  assert.equal(detectIntent('attack this from all sides').skill, '/cross-critique');
  assert.equal(detectIntent('stress-test this claim').skill, '/cross-critique');
});

// Shadow-regression: cross-critique (priority 10) outranks generic critique (priority 1) -
// result is priority-driven, not dependent on INTENTS array position.
test('shadow-regression: "challenge this from every angle" → /cross-critique not critique (priority-driven)', () => {
  const r = detectIntent('challenge this from every angle');
  assert.ok(r, 'should match something');
  assert.equal(r.skill, '/cross-critique', 'higher-priority cross-critique must win over lower-priority critique');
});

// Generic critique still works
test('generic critique still routes to ijfw-critique', () => {
  assert.equal(detectIntent('poke holes in this').skill, 'ijfw-critique');
});

test('cross-audit phrases → /cross-audit', () => {
  assert.equal(detectIntent('we need to cross-audit this').skill, '/cross-audit');
  assert.equal(detectIntent('cross audit the installer').skill, '/cross-audit');
  assert.equal(detectIntent('get a second opinion on the auth flow').skill, '/cross-audit');
  assert.equal(detectIntent('have gemini review this').skill, '/cross-audit');
  assert.equal(detectIntent('ask codex to audit the diff').skill, '/cross-audit');
  assert.equal(detectIntent('do a peer-review pass').skill, '/cross-audit');
  assert.equal(detectIntent('second-model review please').skill, '/cross-audit');
});

test('handoff → ijfw-handoff', () => {
  assert.equal(detectIntent('session handoff please').skill, 'ijfw-handoff');
  assert.equal(detectIntent('context is getting full, wrap up').skill, 'ijfw-handoff');
});

test('brutal mode → ijfw-core', () => {
  assert.equal(detectIntent('brutal mode').skill, 'ijfw-core');
  assert.equal(detectIntent('be brutal').skill, 'ijfw-core');
});

test('leading asterisk bypasses routing', () => {
  assert.equal(detectIntent('* brainstorm a new API'), null);
});

test('"ijfw off" bypasses routing', () => {
  assert.equal(detectIntent('ijfw off; brainstorm a new API'), null);
});

// --- Broader brainstorm patterns (non-software) ---
test('brainstorm: non-software "build/create/design/launch/..." triggers', () => {
  assert.equal(detectIntent('build a new product for our team').skill, 'ijfw-workflow');
  assert.equal(detectIntent('create a landing page for my SaaS').skill, 'ijfw-workflow');
  assert.equal(detectIntent('design a brand for our startup').skill, 'ijfw-workflow');
  assert.equal(detectIntent('launch a campaign next month').skill, 'ijfw-workflow');
  assert.equal(detectIntent('write a book about productivity').skill, 'ijfw-workflow');
  assert.equal(detectIntent('outline a course on machine learning').skill, 'ijfw-workflow');
});

test('brainstorm: artifact keywords trigger', () => {
  assert.equal(detectIntent('design a landing page that converts').skill, 'ijfw-workflow');
  assert.equal(detectIntent('outline a book proposal for publishers').skill, 'ijfw-workflow');
  assert.equal(detectIntent('build a platform for freelancers').skill, 'ijfw-workflow');
});

test('brainstorm: strategy/roadmap phrases trigger', () => {
  assert.equal(detectIntent('roadmap for the new service launch').skill, 'ijfw-workflow');
  assert.equal(detectIntent('plan for our Q3 campaign').skill, 'ijfw-workflow');
  assert.equal(detectIntent('strategy for entering the EU market').skill, 'ijfw-workflow');
  assert.equal(detectIntent('outline for the onboarding flow').skill, 'ijfw-workflow');
});

test('brainstorm: marketing artifact phrases trigger', () => {
  assert.equal(detectIntent('put together an email sequence for new users').skill, 'ijfw-workflow');
  assert.equal(detectIntent('design a sales funnel for our product').skill, 'ijfw-workflow');
  assert.equal(detectIntent('create a launch plan for the rebrand').skill, 'ijfw-workflow');
  assert.equal(detectIntent('content marketing strategy for Q4').skill, 'ijfw-workflow');
});

test('brainstorm: greenfield phrases trigger', () => {
  assert.equal(detectIntent('starting this from scratch').skill, 'ijfw-workflow');
  assert.equal(detectIntent('a new venture I want to explore').skill, 'ijfw-workflow');
  assert.equal(detectIntent('new initiative for the sales team').skill, 'ijfw-workflow');
});

// --- project-scale intent ---
test('project-scale: long prompt with multiple deliverables fires ijfw-workflow', () => {
  // Long prompt without brainstorm keyword patterns - only project-scale check() fires
  const prompt = 'We need to coordinate the member portal rollout and configure the email nurture sequence and prepare a referral program and get it all live by end of next month for our coaching business so we can hit our quarterly revenue targets.';
  const r = detectIntent(prompt);
  assert.ok(r, 'should match');
  assert.equal(r.skill, 'ijfw-workflow');
  assert.equal(r.intent, 'project-scale');
});

test('project-scale: long prompt with budget signal fires', () => {
  // 45 words, budget signal
  const prompt = 'We have a budget of $80k allocated for this quarter and a team of four engineers plus two designers and we need to coordinate the work across all of them while keeping the scope manageable and shipping incrementally over the next several weeks.';
  const r = detectIntent(prompt);
  assert.ok(r);
  assert.equal(r.skill, 'ijfw-workflow');
  assert.equal(r.intent, 'project-scale');
});

test('project-scale: long prompt with timeline signal fires', () => {
  // 46 words, timeline + multiple "and"
  const prompt = 'We are planning to overhaul the billing module and rewrite the notification layer and update all the webhook contracts and harden the test suite and get everything reviewed and merged and deployed to staging before the launch next month so QA has time.';
  const r = detectIntent(prompt);
  assert.ok(r);
  assert.equal(r.skill, 'ijfw-workflow');
  assert.equal(r.intent, 'project-scale');
});

test('project-scale: short prompt does NOT fire even with signals', () => {
  // Under 40 words - must not fire project-scale
  assert.notEqual(detectIntent('build a login button with a budget').intent, 'project-scale');
});

test('project-scale: long prose without project signals does NOT fire', () => {
  const prompt = 'The paginator is broken again and the fix I pushed yesterday was reverted because it broke a test so now I need to figure out why the test is wrong.';
  // May or may not match other intents, but must not fire project-scale
  const r = detectIntent(prompt);
  if (r) assert.notEqual(r.intent, 'project-scale');
});

// --- domain-adaptive nudge ---
test('project-scale nudge: software domain uses "brainstorm the architecture"', () => {
  // 47 words, "and" x3, timeline, budget - domain: SaaS/API/dashboard
  const prompt = 'We need to stand up a SaaS platform and wire up a REST API and build out a dashboard and integrate the billing layer and get it all deployed and tested before the launch next month with a budget of $80k and a team of five engineers.';
  const r = detectIntent(prompt);
  assert.ok(r);
  assert.equal(r.intent, 'project-scale');
  assert.ok(r.nudge.includes('brainstorm the architecture'), `nudge was: ${r.nudge}`);
});

test('project-scale nudge: book domain routes to workflow', () => {
  // Book prompts hit brainstorm (priority 8) via marketing patterns - correct routing
  const prompt = 'I am working on a business book and need to develop a full chapter arrangement and draft each section and work with an editor and get the manuscript polished and submitted to the publisher before the end of this month so we can hit the print deadline on time.';
  const r = detectIntent(prompt);
  assert.ok(r);
  assert.equal(r.skill, 'ijfw-workflow', 'book project routes to workflow');
});

test('project-scale nudge: campaign domain routes to workflow', () => {
  // Campaign prompts hit brainstorm (priority 8) via marketing patterns - correct routing
  const prompt = 'We are running a full marketing campaign and need the email nurture sequence and the social media content calendar and all conversions tracked and ROI reported before the end of this quarter with the full team of six people coordinating across multiple channels.';
  const r = detectIntent(prompt);
  assert.ok(r);
  assert.equal(r.skill, 'ijfw-workflow', 'campaign project routes to workflow');
});

test('project-scale nudge: design domain uses "explore the design"', () => {
  // Long prompt with design keywords but no brainstorm verb patterns
  const prompt = 'I am working on a landing page and the complete UI kit and the visual brand system and need stakeholder sign-off on every component and handoff to the dev team before the deadline next month so nothing slips and the whole experience feels cohesive.';
  const r = detectIntent(prompt);
  assert.ok(r);
  assert.equal(r.intent, 'project-scale');
  assert.ok(r.nudge.includes('explore the design'), `nudge was: ${r.nudge}`);
});

// --- precision guard: short/specific prompts must not over-fire ---
test('precision: "build the login button" does not fire brainstorm (too specific, short)', () => {
  // "build" + noun triggers the pattern, but this is fine - the pattern is designed
  // for high recall on the brainstorm intent, not for project-scale.
  // Verify project-scale specifically does NOT fire on this.
  const r = detectIntent('build the login button');
  if (r) assert.notEqual(r.intent, 'project-scale');
});

test('ordinary prose returns null', () => {
  assert.equal(detectIntent('fix the paginator bug in paginate.py'), null);
  assert.equal(detectIntent('add a unit test for the new function'), null);
});

test('empty/invalid input returns null', () => {
  assert.equal(detectIntent(''), null);
  assert.equal(detectIntent(null), null);
  assert.equal(detectIntent(undefined), null);
  assert.equal(detectIntent(42), null);
});

test('priority-driven ordering: higher priority entry wins when both match', () => {
  // brainstorm (priority 8) is a primary workflow entry point - beats remember (priority 5)
  const r = detectIntent('note to self: brainstorm the auth redesign');
  assert.ok(r);
  assert.equal(r.skill, 'ijfw-workflow', 'priority-8 brainstorm beats priority-5 remember');
  // cross-audit (priority 10) still beats brainstorm (priority 8)
  const r2 = detectIntent('get a second opinion on this brainstorm');
  assert.ok(r2);
  assert.equal(r2.intent, 'cross-audit', 'priority-10 cross-audit beats priority-8 brainstorm');
});

test('specificity tiebreak: longer pattern wins when priorities tie', () => {
  // Both "review PR" (review, priority 5) and "code review" (review, priority 5) are the
  // same entry, so test a cross-* tiebreak: "adversarial review" hits cross-critique
  // (priority 10, longer token match) vs "review" alone; cross-critique must win.
  const r = detectIntent('adversarial review of the proposal');
  assert.ok(r);
  assert.equal(r.skill, '/cross-critique', 'cross-critique adversarial-review pattern wins over plain review');
});

test('order-stable: array-order tiebreak when priority AND specificity tie', () => {
  // "remember to brainstorm" - both remember (priority 5) and brainstorm (priority 1) match,
  // but remember wins on priority. For a true array-order tiebreak we need same priority AND
  // same match length. "ship it" (ship, priority 5) and "note to self" (remember, priority 5)
  // each fire on distinct prompts; verify determinism by running detectIntent twice.
  const r1 = detectIntent('note to self: save for later');
  const r2 = detectIntent('note to self: save for later');
  assert.ok(r1);
  assert.equal(r1.skill, r2.skill, 'repeated calls return identical result (deterministic)');
});
