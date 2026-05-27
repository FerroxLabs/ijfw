// ui-review-runner.js -- v1.5.0 wire-W1.D + W1.E (v1.5.1 W2.A: intake wired).
//
// Production wire-up for the 6 design libs (uispec-intake, uispec-drift,
// a11y-contract, lighthouse-pillar, playwright-baseline, sketches-gc) plus
// the 7-pillar visual audit declared in `claude/agents/ijfw-ui-auditor.md`.
// All 6 are imported below; the import list IS the canonical wiring count —
// docstring and imports must move together (v1.5.1 W2.A audit finding).
//
// Before W1.D these libraries shipped with isolated tests but ZERO callers.
// The auditor agent's "wave dispatch one subagent per pillar" was declared
// in markdown but never implemented in runtime. This runner closes both
// gaps:
//
//   - Builds a per-pillar grader function that calls into the relevant lib.
//   - Dispatches all 7 graders in parallel via Promise.all (W1.E).
//   - Assembles a single UI-REVIEW.md from the per-pillar verdicts.
//   - Returns a structured result so the caller can branch on top-level
//     verdict (PASS / FLAG / BLOCK) without re-parsing markdown.
//
// Each grader function is intentionally small + boundary-pure: it reads
// from `spec` + `sourceScope` + `peerInputs` and emits
// `{ pillar, verdict, findings, startedAt, finishedAt, evidence?, reason? }`.
// Heavy lifting (Lighthouse, axe, Playwright) is done OUT-OF-PROCESS by
// peer tools (chrome-devtools-mcp's lighthouse_audit / axe runner, the
// user's own Playwright). The runner consumes the peer outputs via
// `peerInputs` and adapts them through the evaluator libs.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, isAbsolute } from 'node:path';
import {
  parseUISpec,
  scanCodeForTailwind,
  diffPaletteDrift,
} from './uispec-drift.js';
import {
  evaluateA11y,
  DEFAULT_A11Y_TARGET,
  DEFAULT_MAX_VIOLATIONS,
} from './a11y-contract.js';
import { evaluateLighthouse, LIGHTHOUSE_THRESHOLDS } from './lighthouse-pillar.js';
import { compareToBaseline } from './playwright-baseline.js';
import { runSketchesGc } from './sketches-gc.js';
import { fromImage, fromFigma } from './uispec-intake.js';

// Pillar order is canonical -- the auditor agent spec enumerates them in
// this exact sequence. The runner emits per-pillar sections in the same
// order so the rendered UI-REVIEW.md is stable across runs.
export const PILLARS = Object.freeze([
  'layout',
  'typography',
  'color',
  'spacing',
  'components',
  'interaction',
  'security',
]);

const PILLAR_TITLES = Object.freeze({
  layout:       '1. Layout & Hierarchy',
  typography:   '2. Typography & Reading Flow',
  color:        '3. Color & Contrast',
  spacing:      '4. Spacing & Rhythm',
  components:   '5. Component Consistency',
  interaction:  '6. Interaction & Motion',
  security:     '7. Security & Headers',
});

const VERDICT_PASS  = 'PASS';
const VERDICT_FLAG  = 'FLAG';
const VERDICT_BLOCK = 'BLOCK';
const VERDICT_MISSING = 'spec-section-missing';

// Source-walking — same extension set as the auditor agent's `find` step.
const SOURCE_EXTS = new Set([
  '.tsx', '.jsx', '.ts', '.js', '.css', '.scss',
  '.html', '.vue', '.svelte', '.md', '.mdx',
]);

function walkSourceFiles(scopes, projectRoot, opts = {}) {
  const maxFiles = typeof opts.maxFiles === 'number' ? opts.maxFiles : 2000;
  const out = [];
  for (const scope of scopes) {
    // V155-044: isAbsolute() so Windows C:\… scopes aren't joined as relative,
    // which previously yielded a non-existent path and a vacuous "everything
    // passes" review verdict.
    // TP-004 (v1.5.5 Trident): re-indented the comment + statement to match
    // the enclosing for-body scope. Visual-only fix; the file already parsed.
    const abs = isAbsolute(scope) ? scope : join(projectRoot, scope);
    if (!existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length > 0 && out.length < maxFiles) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        if (ent.name === 'node_modules') continue;
        const p = join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(p); continue; }
        if (!ent.isFile()) continue;
        if (!SOURCE_EXTS.has(extname(ent.name).toLowerCase())) continue;
        out.push(p);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

function readSafe(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Pillar graders. Each returns the same shape:
//   { pillar, verdict, findings, evidence?, reason?, startedAt, finishedAt }
// findings: Array<{ severity, text, file?, line? }>
// ---------------------------------------------------------------------------

function gradeLayout({ spec, files, projectRoot: _projectRoot }) {
  const startedAt = Date.now();
  const findings = [];
  // Surface presence is hard to derive from a spec we only parse loosely.
  // We default to FLAG when the spec is silent on layout (a stronger signal
  // would require parseUISpec to surface layout fields). If the spec text
  // mentions `## 1.` (Layout) at all, we treat it as covered enough to PASS.
  const specText = spec.__rawText || '';
  if (!/^##\s*1\b/m.test(specText) && !/Layout\s*&\s*Hierarchy/i.test(specText)) {
    return {
      pillar: 'layout', verdict: VERDICT_MISSING, findings: [],
      reason: 'UI-SPEC has no Layout section (## 1 ...)',
      startedAt, finishedAt: Date.now(),
    };
  }
  // Presence check: surfaces (any html/tsx file) must exist somewhere in scope.
  const surfaces = files.filter((f) => /\.(tsx|jsx|html|vue|svelte)$/i.test(f));
  if (surfaces.length === 0) {
    findings.push({ severity: 'high', text: 'no surface files (.tsx/.jsx/.html/.vue/.svelte) found in source_scope' });
    return { pillar: 'layout', verdict: VERDICT_BLOCK, findings, startedAt, finishedAt: Date.now() };
  }
  return { pillar: 'layout', verdict: VERDICT_PASS, findings, evidence: `${surfaces.length} surface files in scope`, startedAt, finishedAt: Date.now() };
}

function gradeTypography({ spec, files }) {
  const startedAt = Date.now();
  const findings = [];
  const specText = spec.__rawText || '';
  if (!/^##\s*2\b/m.test(specText) && !/Typography/i.test(specText)) {
    return { pillar: 'typography', verdict: VERDICT_MISSING, findings: [], reason: 'UI-SPEC has no Typography section', startedAt, finishedAt: Date.now() };
  }
  // Cheap check: at least one font-family declaration should exist in scope.
  let fontDecls = 0;
  for (const f of files.slice(0, 200)) {
    const txt = readSafe(f);
    if (/font-family\s*:/i.test(txt)) fontDecls += 1;
    if (fontDecls > 0) break;
  }
  if (fontDecls === 0) {
    findings.push({ severity: 'med', text: 'no `font-family` declaration found in scope (spec defines typography but source omits it)' });
    return { pillar: 'typography', verdict: VERDICT_FLAG, findings, startedAt, finishedAt: Date.now() };
  }
  return { pillar: 'typography', verdict: VERDICT_PASS, findings, evidence: 'font-family declared', startedAt, finishedAt: Date.now() };
}

function gradeColor({ spec, sourceScope, projectRoot }) {
  const startedAt = Date.now();
  const findings = [];
  if (!spec.paletteHex || spec.paletteHex.length === 0) {
    return { pillar: 'color', verdict: VERDICT_MISSING, findings: [], reason: 'UI-SPEC has no color tokens (## 3 Color)', startedAt, finishedAt: Date.now() };
  }
  // Run the existing drift detector across the scope. `diffPaletteDrift`
  // returns an array of { type, value, severity, declared } findings. A
  // finding here means a color in source that the spec does NOT declare.
  //
  // v1.5.0 r20-HIGH fix: an error inside scanCodeForTailwind / diffPaletteDrift
  // previously silently set drift=[] -- the color pillar would then PASS
  // even though we never actually scanned. Surface the failure as a FLAG
  // finding AND log to stderr; the pillar's verdict reflects real
  // coverage instead of a false-positive PASS.
  let drift = [];
  let driftError = null;
  try {
    const scan = scanCodeForTailwind(sourceScope, { projectRoot });
    drift = diffPaletteDrift(spec, scan);
  } catch (err) {
    driftError = err && err.message ? err.message : String(err);
    drift = [];
    process.stderr.write(
      `ijfw ui-review: gradeColor drift detection failed (${driftError}). ` +
      `Color pillar will FLAG instead of PASS until the scan succeeds.\n`,
    );
  }

  const blockers = drift.filter((d) => d.severity === 'block');
  const flagsOnly = drift.filter((d) => d.severity === 'flag');

  for (const d of drift.slice(0, 25)) {
    findings.push({
      severity: d.severity === 'block' ? 'high' : 'med',
      text: `unauthorized ${d.type} in source: ${d.value}`,
    });
  }

  let verdict = VERDICT_PASS;
  if (blockers.length > 0) verdict = VERDICT_BLOCK;
  else if (flagsOnly.length > 0) verdict = VERDICT_FLAG;
  // r20-HIGH: when the scan itself failed, surface FLAG even with no
  // drift findings so the user doesn't read a false-PASS.
  if (driftError) {
    verdict = VERDICT_FLAG;
    findings.unshift({ severity: 'med', text: `drift scan failed: ${driftError}` });
  }

  return {
    pillar: 'color',
    verdict,
    findings,
    evidence: driftError
      ? `scan failed (${driftError}); ${drift.length} drift findings observed before failure`
      : `${drift.length} drift findings (${blockers.length} block / ${flagsOnly.length} flag)`,
    startedAt, finishedAt: Date.now(),
  };
}

function gradeSpacing({ spec, files }) {
  const startedAt = Date.now();
  const findings = [];
  const specText = spec.__rawText || '';
  if (!/^##\s*4\b/m.test(specText) && !/Spacing/i.test(specText)) {
    return { pillar: 'spacing', verdict: VERDICT_MISSING, findings: [], reason: 'UI-SPEC has no Spacing section', startedAt, finishedAt: Date.now() };
  }
  // Quick smell test: arbitrary-value Tailwind brackets (e.g. `p-[17px]`)
  // suggest the scale wasn't honored.
  let arbitraryCount = 0;
  for (const f of files.slice(0, 300)) {
    const txt = readSafe(f);
    const m = txt.match(/\b[pm][trblxy]?-\[[^\]]+\]/g);
    if (m) arbitraryCount += m.length;
  }
  if (arbitraryCount > 10) {
    findings.push({ severity: 'med', text: `${arbitraryCount} arbitrary spacing values in scope; spec defines a scale` });
    return { pillar: 'spacing', verdict: VERDICT_FLAG, findings, startedAt, finishedAt: Date.now() };
  }
  return { pillar: 'spacing', verdict: VERDICT_PASS, findings, evidence: `${arbitraryCount} arbitrary values (<= threshold)`, startedAt, finishedAt: Date.now() };
}

function gradeComponents({ spec, files }) {
  const startedAt = Date.now();
  const findings = [];
  const specText = spec.__rawText || '';
  if (!/^##\s*5\b/m.test(specText) && !/Component/i.test(specText)) {
    return { pillar: 'components', verdict: VERDICT_MISSING, findings: [], reason: 'UI-SPEC has no Components section', startedAt, finishedAt: Date.now() };
  }
  // Spec is silent on the exact component set in the parsed shape, so we
  // just confirm that SOME components exist in scope.
  let componentDecls = 0;
  for (const f of files.slice(0, 300)) {
    const txt = readSafe(f);
    // eslint-disable-next-line security/detect-unsafe-regex -- scans developer-authored source files on local disk; bounded by file line length, not exploitable
    if (/export\s+(?:default\s+)?(?:function|class|const)\s+[A-Z]/.test(txt)) componentDecls += 1;
  }
  if (componentDecls === 0) {
    findings.push({ severity: 'med', text: 'no exported component declarations found in scope' });
    return { pillar: 'components', verdict: VERDICT_FLAG, findings, startedAt, finishedAt: Date.now() };
  }
  return { pillar: 'components', verdict: VERDICT_PASS, findings, evidence: `${componentDecls} component declarations`, startedAt, finishedAt: Date.now() };
}

function gradeInteraction({ spec, files, peerInputs }) {
  const startedAt = Date.now();
  const findings = [];
  const specText = spec.__rawText || '';
  if (!/^##\s*6\b/m.test(specText) && !/Interaction|Motion/i.test(specText)) {
    return { pillar: 'interaction', verdict: VERDICT_MISSING, findings: [], reason: 'UI-SPEC has no Interaction section', startedAt, finishedAt: Date.now() };
  }
  // Floor check: every interactive surface should declare :focus styling.
  // Cheap heuristic: count :focus mentions in scope; if zero, BLOCK (a11y floor).
  let focusMentions = 0;
  let interactiveDecls = 0;
  for (const f of files.slice(0, 300)) {
    const txt = readSafe(f);
    if (/:focus(?:-visible)?\b/.test(txt)) focusMentions += 1;
    if (/<(?:button|a|input|select|textarea)\b/i.test(txt)) interactiveDecls += 1;
  }
  if (interactiveDecls > 0 && focusMentions === 0) {
    findings.push({ severity: 'high', text: ':focus styling not found in any file with interactive elements (WCAG floor violation)' });
    return { pillar: 'interaction', verdict: VERDICT_BLOCK, findings, startedAt, finishedAt: Date.now() };
  }
  // Playwright baseline check (optional peer)
  if (peerInputs && peerInputs.playwright) {
    try {
      const cmp = compareToBaseline(peerInputs.playwright);
      if (cmp && cmp.pass === false) {
        findings.push({ severity: 'med', text: `playwright baseline diff: ${cmp.reason || 'changed'}` });
      }
    } catch { /* peer tool optional */ }
  }
  // r21-HIGH-1: derive the verdict from findings instead of returning PASS
  // unconditionally. A recorded playwright baseline diff (or any other
  // finding) must downgrade the pillar — a true PASS means zero findings.
  let verdict = VERDICT_PASS;
  if (findings.some((f) => f.severity === 'high')) verdict = VERDICT_BLOCK;
  else if (findings.length > 0) verdict = VERDICT_FLAG;
  return { pillar: 'interaction', verdict, findings, evidence: `${focusMentions} :focus / ${interactiveDecls} interactive surfaces`, startedAt, finishedAt: Date.now() };
}

function gradeSecurity({ spec, files, peerInputs }) {
  const startedAt = Date.now();
  const findings = [];
  // a11y is part of the security pillar per the v1.5.0 7-pillar enumeration.
  if (peerInputs && peerInputs.axe !== undefined) {
    // r21-MED: isolate evaluator failures — a malformed axe peer input must
    // not throw out of the grader and reject the whole Promise.all review.
    try {
      const a11y = evaluateA11y(peerInputs.axe, {
        target: spec.a11yTarget || DEFAULT_A11Y_TARGET,
        maxViolations: spec.maxViolations != null ? spec.maxViolations : DEFAULT_MAX_VIOLATIONS,
      });
      if (a11y.pass === false) {
        findings.push({ severity: 'high', text: `a11y: ${a11y.count} violations exceed budget ${a11y.maxViolations}` });
      }
    } catch (err) {
      findings.push({ severity: 'med', text: `a11y evaluation failed: ${err && err.message ? err.message : String(err)}` });
    }
  }
  // CSP / inline-handler smell tests
  let inlineHandlers = 0;
  let unsafeCspHits = 0;
  for (const f of files.slice(0, 300)) {
    const txt = readSafe(f);
    if (/\bon(?:click|load|error|change|input|submit)\s*=\s*["']/.test(txt)) inlineHandlers += 1;
    if (/unsafe-(?:inline|eval)/i.test(txt)) unsafeCspHits += 1;
  }
  if (inlineHandlers > 0) {
    findings.push({ severity: 'med', text: `${inlineHandlers} inline event handler(s) in scope` });
  }
  if (unsafeCspHits > 0) {
    findings.push({ severity: 'high', text: `${unsafeCspHits} mention(s) of CSP unsafe-inline / unsafe-eval` });
  }
  // Lighthouse audit (optional peer)
  if (peerInputs && peerInputs.lighthouse !== undefined) {
    // r21-MED: isolate evaluator failures — a malformed lighthouse peer
    // input must not throw out of the grader and crash the review.
    try {
      const lh = evaluateLighthouse(peerInputs.lighthouse);
      if (lh.pass === false) {
        findings.push({ severity: 'med', text: `lighthouse: LCP ${lh.lcpMs}ms / CLS ${lh.clsScore} -- ${lh.reason}` });
      }
    } catch (err) {
      findings.push({ severity: 'med', text: `lighthouse evaluation failed: ${err && err.message ? err.message : String(err)}` });
    }
  }
  let verdict = VERDICT_PASS;
  if (findings.some((f) => f.severity === 'high')) verdict = VERDICT_BLOCK;
  else if (findings.length > 0) verdict = VERDICT_FLAG;
  return { pillar: 'security', verdict, findings, evidence: `${inlineHandlers} inline handlers, ${unsafeCspHits} unsafe CSP hits`, startedAt, finishedAt: Date.now() };
}

const GRADERS = Object.freeze({
  layout:      gradeLayout,
  typography:  gradeTypography,
  color:       gradeColor,
  spacing:     gradeSpacing,
  components:  gradeComponents,
  interaction: gradeInteraction,
  security:    gradeSecurity,
});

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

/**
 * Run the 7-pillar UI review. All 7 graders fire in parallel via Promise.all
 * (W1.E). Returns the structured result + writes UI-REVIEW.md next to the
 * UI-SPEC path.
 *
 * @param {object} args
 * @param {string} args.uiSpecPath        absolute path to UI-SPEC.md
 * @param {string|string[]} args.sourceScope   dirs to grade (comma-separated or array)
 * @param {string} [args.projectRoot]     default cwd
 * @param {object} [args.peerInputs]      { axe, lighthouse, playwright } -- optional pre-computed peer-tool outputs
 * @param {boolean} [args.write]          when true, write UI-REVIEW.md (default true)
 * @param {boolean} [args.gcSketches]     when true, run sketches-gc as the finalizer (default false)
 * @param {string}  [args.fromImage]      when set, run uispec-intake.fromImage and attach the stub to the result + UI-REVIEW.md "Intake" section.
 * @param {string}  [args.fromFigma]      when set, run uispec-intake.fromFigma (same surfacing as fromImage).
 * @returns {Promise<{
 *   topVerdict: 'PASS'|'FLAG'|'BLOCK',
 *   pillarVerdicts: Record<string, string>,
 *   verdicts: Array<{pillar, verdict, findings, startedAt, finishedAt}>,
 *   reviewPath: string|null,
 *   reviewMarkdown: string,
 *   parallel: { minStart: number, maxStart: number, minFinish: number, maxFinish: number, parallelism: number },
 *   intake: { kind: 'image'|'figma', ok: boolean, stub: object|null, error: string|null }|null
 * }>}
 */
export async function runUiReview({
  uiSpecPath,
  sourceScope,
  projectRoot = process.cwd(),
  peerInputs = {},
  write = true,
  gcSketches = false,
  fromImage: fromImagePath = null,
  fromFigma: fromFigmaUrl = null,
} = {}) {
  if (typeof uiSpecPath !== 'string' || uiSpecPath.length === 0) {
    throw new TypeError('runUiReview: uiSpecPath is required');
  }
  if (!existsSync(uiSpecPath)) {
    throw new Error(`runUiReview: UI-SPEC not found at ${uiSpecPath}`);
  }
  const scopes = Array.isArray(sourceScope)
    ? sourceScope
    : typeof sourceScope === 'string'
      ? sourceScope.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  if (scopes.length === 0) {
    throw new Error('runUiReview: sourceScope is required (comma-separated paths or array)');
  }

  const rawSpec = readFileSync(uiSpecPath, 'utf8');
  const spec = parseUISpec(rawSpec);
  spec.__rawText = rawSpec;

  // v1.5.1 W2.A: optional uispec-intake pre-fill. When the caller supplies
  // --from-image or --from-figma we run the intake helper and surface the
  // resulting stub on the review (rendered into UI-REVIEW.md and returned
  // structurally). This does NOT mutate the parsed spec used for grading —
  // intake is purely a pre-fill hint for the user's next UI-SPEC edit.
  let intake = null;
  if (fromImagePath) {
    const res = fromImage(fromImagePath, { projectRoot });
    intake = { kind: 'image', ok: res.ok, stub: res.stub, error: res.error };
  } else if (fromFigmaUrl) {
    const res = await fromFigma(fromFigmaUrl);
    intake = { kind: 'figma', ok: res.ok, stub: res.stub, error: res.error };
  }

  const files = walkSourceFiles(scopes, projectRoot);

  // W1.E: 7 graders in parallel via Promise.all. Concurrency witness is a
  // counter (not timestamps): each grader increments `inFlight` on entry,
  // yields the microtask queue once, then runs to completion. With
  // Promise.all dispatch, all 7 graders enter their wrapper in the same
  // tick before any returns -- so `peakConcurrent === PILLARS.length`.
  // A sequential implementation would peak at 1.
  //
  // What this witness proves: Promise.all DISPATCH is concurrent — the 7
  // grader wrappers all run their entry block in the same event-loop tick
  // before any can exit. It does NOT prove that the (currently synchronous)
  // grader BODIES execute interleaved on the event loop — sync work
  // serializes by definition. If a grader gains a real async operation
  // (e.g. a Lighthouse call), the witness already accommodates it: the
  // yield ensures all peers register before any awaits. This is the
  // semantic guarantee that matters; the lib design intentionally keeps
  // grader bodies cheap + sync so the runner stays fast.
  // (Replaces the earlier Date.now() ms-precision comparison which was
  // flaky on fast sync work.)
  const graderArgs = { spec, sourceScope: scopes, files, projectRoot, peerInputs };
  const beforeAll = Date.now();
  let _inFlight = 0;
  let _peakConcurrent = 0;
  const verdicts = await Promise.all(
    PILLARS.map((pillar) => Promise.resolve().then(async () => {
      _inFlight += 1;
      if (_inFlight > _peakConcurrent) _peakConcurrent = _inFlight;
      // Yield so all other graders also reach this point before any finishes.
      await Promise.resolve();
      try { return GRADERS[pillar](graderArgs); }
      finally { _inFlight -= 1; }
    })),
  );
  const afterAll = Date.now();

  // Parallelism stats — used by tests + observability.
  const startedAtList  = verdicts.map((v) => v.startedAt).sort((a, b) => a - b);
  const finishedAtList = verdicts.map((v) => v.finishedAt).sort((a, b) => a - b);
  const parallel = {
    minStart: startedAtList[0],
    maxStart: startedAtList[startedAtList.length - 1],
    minFinish: finishedAtList[0],
    maxFinish: finishedAtList[finishedAtList.length - 1],
    // Concurrency witness: how many graders were simultaneously inside the
    // dispatcher wrapper at the peak. Equals PILLARS.length when Promise.all
    // dispatch is parallel; would be 1 if implementation went sequential.
    peakConcurrent: _peakConcurrent,
    // True iff the witness == PILLARS.length (all 7 entered before any
    // exited). Robust to wall-clock resolution since it's a tick-level event
    // count, not a timestamp comparison.
    parallelism: _peakConcurrent === PILLARS.length,
    wallMs: afterAll - beforeAll,
  };

  const pillarVerdicts = {};
  for (const v of verdicts) pillarVerdicts[v.pillar] = v.verdict;

  const topVerdict = computeTopVerdict(verdicts);

  const reviewMarkdown = renderReview({
    uiSpecPath,
    sourceScope: scopes,
    verdicts,
    topVerdict,
    intake,
  });

  let reviewPath = null;
  if (write) {
    reviewPath = join(dirname(uiSpecPath), 'UI-REVIEW.md');
    try { mkdirSync(dirname(reviewPath), { recursive: true }); } catch {}
    writeFileSync(reviewPath, reviewMarkdown, 'utf8');
  }

  if (gcSketches) {
    try { runSketchesGc({ root: join(projectRoot, '.planning', 'sketches') }); } catch {}
  }

  return { topVerdict, pillarVerdicts, verdicts, reviewPath, reviewMarkdown, parallel, intake };
}

function computeTopVerdict(verdicts) {
  // BLOCK > FLAG > PASS; spec-section-missing ranks as BLOCK (auditor agent
  // rule: spec-missing is treated as blocking until the spec is updated).
  const ranks = { PASS: 0, FLAG: 1, BLOCK: 2 };
  let top = 'PASS';
  for (const v of verdicts) {
    const norm = v.verdict === VERDICT_MISSING ? 'BLOCK' : v.verdict;
    if ((ranks[norm] ?? 0) > (ranks[top] ?? 0)) top = norm;
  }
  return top;
}

function renderReview({ uiSpecPath, sourceScope, verdicts, topVerdict, intake = null }) {
  const date = new Date().toISOString().slice(0, 10);
  const scopeStr = Array.isArray(sourceScope) ? sourceScope.join(',') : String(sourceScope);
  const lines = [
    `# UI-REVIEW`,
    `**Audited:** ${date}  **Auditor:** ijfw-ui-review-runner`,
    `**Spec:** ${uiSpecPath}  **Source scope:** ${scopeStr}`,
    `**Top-level verdict:** ${topVerdict}`,
    '',
  ];
  if (intake) {
    lines.push('## Intake (uispec-intake)');
    lines.push('');
    lines.push(`- **Source kind:** ${intake.kind}`);
    lines.push(`- **Status:** ${intake.ok ? 'ok' : 'error'}`);
    if (intake.error) lines.push(`- **Error:** ${intake.error}`);
    if (intake.stub && intake.stub.advisory) lines.push(`- **Advisory:** ${intake.stub.advisory}`);
    if (intake.stub && intake.stub.source) {
      const src = intake.stub.source;
      if (src.path) lines.push(`- **Path:** ${src.path}`);
      if (src.url) lines.push(`- **URL:** ${src.url}`);
      if (src.bytes != null) lines.push(`- **Bytes:** ${src.bytes}`);
      if (src.dimensions) lines.push(`- **Dimensions:** ${src.dimensions.width}x${src.dimensions.height}`);
      if (src.fileKey) lines.push(`- **Figma file key:** ${src.fileKey}`);
      if (src.name) lines.push(`- **Figma file name:** ${src.name}`);
    }
    lines.push('');
  }
  lines.push('## Per-pillar verdicts');
  lines.push('');
  for (const v of verdicts) {
    const title = PILLAR_TITLES[v.pillar] || v.pillar;
    lines.push(`### ${title} — ${v.verdict}`);
    if (v.reason) lines.push(`- **Reason:** ${v.reason}`);
    if (v.evidence) lines.push(`- **Evidence:** ${v.evidence}`);
    if (v.findings && v.findings.length > 0) {
      for (const f of v.findings) {
        const where = f.file ? `\`${f.file}${f.line ? ':' + f.line : ''}\`` : '';
        lines.push(`- **Finding (${f.severity || 'info'}):** ${f.text}${where ? ` ${where}` : ''}`);
      }
    }
    lines.push('');
  }
  // Summary
  const blocks = verdicts.filter((v) => v.verdict === VERDICT_BLOCK || v.verdict === VERDICT_MISSING).map((v) => v.pillar);
  const flags  = verdicts.filter((v) => v.verdict === VERDICT_FLAG).map((v) => v.pillar);
  const passes = verdicts.filter((v) => v.verdict === VERDICT_PASS).map((v) => v.pillar);
  const totalFindings = verdicts.reduce((n, v) => n + (v.findings ? v.findings.length : 0), 0);
  const blockFindings = verdicts.reduce((n, v) => n + (v.findings ? v.findings.filter((f) => f.severity === 'high').length : 0), 0);
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Top-level:** ${topVerdict}`);
  lines.push(`- **Pillars at BLOCK:** ${blocks.length > 0 ? blocks.join(', ') : 'none'}`);
  lines.push(`- **Pillars at FLAG:** ${flags.length > 0 ? flags.join(', ') : 'none'}`);
  lines.push(`- **Pillars at PASS:** ${passes.length > 0 ? passes.join(', ') : 'none'}`);
  lines.push(`- **Total findings:** ${totalFindings} (${blockFindings} BLOCK / ${totalFindings - blockFindings} FLAG)`);
  lines.push('');
  return lines.join('\n');
}

// Constants exported for tests + tooling.
export const RUNNER_DEFAULTS = Object.freeze({
  pillars: PILLARS,
  pillarTitles: PILLAR_TITLES,
  verdicts: Object.freeze({ PASS: VERDICT_PASS, FLAG: VERDICT_FLAG, BLOCK: VERDICT_BLOCK, MISSING: VERDICT_MISSING }),
  lighthouseThresholds: LIGHTHOUSE_THRESHOLDS,
});
