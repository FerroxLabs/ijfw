/**
 * IJFW design intelligence helpers.
 *
 * This module is intentionally static and dependency-free. It does not render
 * pages; it scans DESIGN.md, HTML, and CSS text for practical design signals
 * that are useful across software, content, research, book, and business work.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DESIGN_FILE = 'DESIGN.md';
const DEFAULT_MAX_SUMMARY_CHARS = 1400;

const ACTION_GUIDANCE = {
  plan: {
    intent: 'Create or sharpen the design contract before producing artifacts.',
    steps: [
      'Load DESIGN.md when present; otherwise initialize a concise project-agnostic contract.',
      'Name audience, artifact type, tone, palette roles, typography, spacing, and constraints.',
      'For visual work, prepare real HTML mockups and use the live design companion when available.',
    ],
    output: 'A DESIGN.md-aligned plan with design risks and next artifacts.',
  },
  audit: {
    intent: 'Check an existing artifact against durable design constraints.',
    steps: [
      'Run static HTML/CSS audit for typography, palette, contrast, depth, card/hero, and repetition signals.',
      'Separate objective issues from taste critiques and note detector limits.',
      'Prioritize fixes that improve readability, hierarchy, accessibility, and consistency.',
    ],
    output: 'An ordered issue list with evidence, severity, and suggested fixes.',
  },
  critique: {
    intent: 'Challenge design decisions before implementation locks in.',
    steps: [
      'Identify the intended user, task, environment, and artifact format.',
      'Flag weak hierarchy, unclear emphasis, overloaded visuals, and missing constraints.',
      'Suggest focused alternatives without rewriting the entire direction.',
    ],
    output: 'A concise critique with tradeoffs and recommended direction.',
  },
  polish: {
    intent: 'Improve an already viable artifact without changing its core structure.',
    steps: [
      'Tighten spacing, type scale, contrast, alignment, states, and responsive fit.',
      'Reduce decorative noise before adding new visual elements.',
      'Preserve the artifact purpose and existing project conventions.',
    ],
    output: 'A short polish pass and verification checklist.',
  },
  normalize: {
    intent: 'Bring divergent artifacts back onto a shared design system.',
    steps: [
      'Extract repeated colors, fonts, spacing, radii, and shadows into reusable tokens.',
      'Replace one-off styling with DESIGN.md roles and local conventions.',
      'Keep normalization project-agnostic: tokens may apply to documents, slides, dashboards, or apps.',
    ],
    output: 'A normalization map from current values to design tokens.',
  },
  bolder: {
    intent: 'Increase distinction, hierarchy, and memorability while keeping the work usable.',
    steps: [
      'Raise contrast between primary and secondary elements.',
      'Use fewer, stronger accents and clearer scale jumps.',
      'Add expressive moments only where they support the artifact goal.',
    ],
    output: 'A bolder variant direction with guardrails.',
  },
  quieter: {
    intent: 'Reduce visual intensity and make repeated use more comfortable.',
    steps: [
      'Lower saturation, shadow, borders, and competing accents.',
      'Increase whitespace and simplify hierarchy.',
      'Keep critical affordances visible; quiet does not mean low contrast.',
    ],
    output: 'A quieter variant direction with accessibility checks.',
  },
  handoff: {
    intent: 'Preserve design state for future agents and sessions.',
    steps: [
      'Record the chosen design contract, open questions, decisions, and artifacts touched.',
      'Include audit findings, remaining risks, and commands or files needed to resume.',
      'Update memory or handoff notes at workflow stage boundaries.',
    ],
    output: 'A compact handoff note suitable for project memory.',
  },
};

export const DESIGN_ACTIONS = Object.keys(ACTION_GUIDANCE);

export function findDesignFile(startDir = process.cwd(), options = {}) {
  const filename = normalizeString(options.filename) || DESIGN_FILE;
  const root = resolve(startDir || process.cwd());
  let current = root;

  while (true) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) {
      return { found: true, path: candidate, directory: current };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { found: false, path: null, directory: null };
}

export function loadDesignFile(startDir = process.cwd(), options = {}) {
  const found = findDesignFile(startDir, options);
  if (!found.found) {
    return {
      found: false,
      path: null,
      content: '',
      summary: 'No DESIGN.md found. Initialize one to create a durable design contract for this project.',
      details: {},
    };
  }

  const content = readFileSync(found.path, 'utf8');
  return {
    ...found,
    content,
    summary: summarizeDesignContent(content, options),
    details: extractDesignDetails(content),
  };
}

export function summarizeDesignContent(content, options = {}) {
  const maxChars = Math.max(300, Number(options.maxChars) || DEFAULT_MAX_SUMMARY_CHARS);
  const details = extractDesignDetails(content);
  const lines = [];

  if (details.title) lines.push(`# ${details.title}`);
  if (details.headings.length) lines.push(`Sections: ${details.headings.slice(0, 8).join(', ')}`);
  if (details.colors.length) lines.push(`Color roles: ${details.colors.slice(0, 12).join(', ')}`);
  if (details.fonts.length) lines.push(`Fonts: ${details.fonts.slice(0, 8).join(', ')}`);
  if (details.spacing.length) lines.push(`Spacing/scale: ${details.spacing.slice(0, 8).join(', ')}`);
  if (details.constraints.length) lines.push(`Constraints: ${details.constraints.slice(0, 8).join('; ')}`);

  const summary = lines.join('\n').trim();
  if (!summary) return compactWhitespace(content).slice(0, maxChars);
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1).trim()}...` : summary;
}

export function createDesignMdContent(options = {}) {
  const projectName = normalizeString(options.projectName) || 'Project';
  const artifactType = normalizeString(options.artifactType) || 'project artifacts';
  const audience = normalizeString(options.audience) || 'the intended user or reader';
  const tone = normalizeString(options.tone) || 'clear, useful, and consistent';

  return `# ${projectName} DESIGN.md

## Purpose
Design direction for ${artifactType}. This contract is project-agnostic: use it for interfaces, documents, dashboards, research outputs, presentations, or other visual artifacts.

## Audience
Designed for ${audience}. Optimize for comprehension, trust, and repeated use.

## Visual Direction
- Tone: ${tone}
- Hierarchy: make primary actions and key ideas obvious before secondary detail.
- Density: match the artifact's job; operational tools can be dense, editorial work can breathe.
- Imagery: use real, relevant visuals when they help the user inspect or understand the subject.

## Color Roles
- Background:
- Surface:
- Text primary:
- Text secondary:
- Border:
- Accent:
- Critical/warning/success:

## Typography
- Display:
- Body:
- Mono/data:
- Scale:
- Line height:
- Letter spacing: 0 unless a deliberate brand exception is documented.

## Layout
- Grid:
- Spacing scale:
- Max width or page format:
- Responsive or format constraints:

## Components And Artifact Patterns
- Buttons/actions:
- Cards/panels:
- Tables/lists:
- Forms/inputs:
- Navigation/wayfinding:
- Document or slide patterns:

## Accessibility And Quality Gates
- Maintain readable contrast for text and controls.
- Avoid too many font families, one-note palettes, excessive shadows, and unnecessary rounded surfaces.
- Check mobile/compact fit for interfaces and scanability for documents.

## Agent Notes
- Preserve this file as the design source of truth.
- Update decisions and unresolved questions during handoff.
- Prefer real HTML mockups for interface brainstorming; avoid ASCII mockups unless explicitly requested.
`;
}

export function auditStaticDesign(input) {
  const source = normalizeAuditInput(input);
  const css = `${extractStyleBlocks(source.html)}\n${source.css}`;
  const html = source.html;
  const issues = [];

  const fonts = analyzeFonts(css);
  const colors = analyzeColors(css);
  const contrast = analyzeContrast(css);
  const depth = analyzeDepth(css);
  const structure = analyzeStructure(html, css);
  const repetition = analyzeRepetition(html, css);

  addFontIssues(issues, fonts);
  addColorIssues(issues, colors);
  for (const item of contrast.issues) issues.push(item);
  addDepthIssues(issues, depth);
  addStructureIssues(issues, structure);
  addRepetitionIssues(issues, repetition);

  const sorted = issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return {
    summary: summarizeAudit(sorted),
    issues: sorted,
    metrics: {
      fonts,
      colors,
      contrast,
      depth,
      structure,
      repetition,
    },
    limits: [
      'Static audit only; it does not render layout, compute inherited styles, or inspect screenshots.',
      'Contrast checks only evaluate color/background-color pairs declared in the same CSS rule.',
    ],
  };
}

export function getDesignActionGuidance(mode, context = {}) {
  const key = normalizeString(mode).toLowerCase();
  const guidance = ACTION_GUIDANCE[key] || ACTION_GUIDANCE.plan;
  return {
    mode: ACTION_GUIDANCE[key] ? key : 'plan',
    ...guidance,
    context: {
      artifactType: normalizeString(context.artifactType) || 'unspecified',
      hasDesignFile: Boolean(context.hasDesignFile),
      hasWebApp: Boolean(context.hasWebApp),
    },
  };
}

export function listDesignActionModes() {
  return Object.keys(ACTION_GUIDANCE);
}

export function initialDesignMarkdown(options = {}) {
  return createDesignMdContent({
    projectName: options.projectName,
    tone: options.direction,
    artifactType: options.artifactType,
    audience: options.audience,
  });
}

export function loadDesignContext(projectRoot = process.cwd(), options = {}) {
  const loaded = loadDesignFile(projectRoot, { maxChars: options.maxChars });
  return {
    ok: loaded.found,
    exists: loaded.found,
    path: loaded.path || join(resolve(projectRoot), DESIGN_FILE),
    summary: loaded.summary,
    text: loaded.content,
    details: loaded.details,
  };
}

export function auditDesignText(input, options = {}) {
  const audit = auditStaticDesign(input, options);
  return {
    ok: true,
    summary: audit.summary,
    findings: audit.issues.map((item) => ({
      severity: item.severity,
      rule: item.code,
      message: item.message,
      details: item.details,
    })),
    metrics: audit.metrics,
    limits: audit.limits,
  };
}

export function designActionGuide(action, context = {}) {
  const guide = getDesignActionGuidance(action, {
    hasDesignFile: context.exists || context.found || context.hasDesignFile,
    artifactType: context.artifactType,
    hasWebApp: context.hasWebApp,
  });
  return {
    action: guide.mode,
    uses_design_md: guide.context.hasDesignFile,
    reminder: 'Live preview is transient. DESIGN.md is durable design memory.',
    guidance: [guide.intent, ...guide.steps],
    output: guide.output,
  };
}

function extractDesignDetails(content) {
  const text = String(content || '');
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => cleanMarkdown(m[1]));
  const title = headings[0] || '';
  const colors = unique([...text.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-zA-Z]+)|`([^`]+)`\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-zA-Z]+)/g)]
    .map((m) => compactWhitespace(`${m[1] || m[3]} ${m[2] || m[4]}`)));
  const fonts = extractFontNames(text);
  const spacing = unique([...text.matchAll(/\b(?:spacing|padding|margin|gutter|radius|width|scale)[^:\n]*:\s*([^\n]+)/gi)]
    .map((m) => compactWhitespace(m[1]).slice(0, 120)));
  const constraints = unique([...text.matchAll(/(?:^|\n)\s*[-*]\s+(.{12,180})/g)]
    .map((m) => cleanMarkdown(m[1]))
    .filter((line) => /(avoid|never|must|minimum|keep|prefer|do not|don't|contrast|responsive|mobile|accessibility)/i.test(line)));

  return { title, headings: headings.slice(1), colors, fonts, spacing, constraints };
}

function normalizeAuditInput(input) {
  if (typeof input === 'string') {
    return /<\/?[a-z][\s\S]*>/i.test(input)
      ? { html: input, css: '' }
      : { html: '', css: input };
  }
  const source = input && typeof input === 'object' ? input : {};
  return {
    html: String(source.html || ''),
    css: String(source.css || ''),
  };
}

function extractStyleBlocks(html) {
  return [...String(html || '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n');
}

function analyzeFonts(css) {
  const declarations = [...css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)].map((m) => m[1]);
  const families = unique(declarations.flatMap(parseFontFamilies));
  const selectorFamilies = {};
  for (const rule of cssRules(css)) {
    const match = rule.body.match(/font-family\s*:\s*([^;}{]+)/i);
    if (match) selectorFamilies[rule.selector] = parseFontFamilies(match[1]);
  }
  return {
    families,
    count: families.length,
    declarations: declarations.length,
    selectorFamilies,
    hasConvergence: declarations.length >= 3 && families.length <= 1,
    hasTooMany: families.length > 3,
  };
}

function analyzeColors(css) {
  const values = extractColorValues(css);
  const uniqueValues = unique(values.map(normalizeColorToken));
  const parsed = uniqueValues.map(parseColor).filter(Boolean);
  const hueBuckets = {};
  const chromaticBuckets = {};
  for (const color of parsed) {
    const bucket = color.saturation < 0.12 ? 'neutral' : String(Math.round(color.hue / 30) * 30);
    hueBuckets[bucket] = (hueBuckets[bucket] || 0) + 1;
    if (bucket !== 'neutral') chromaticBuckets[bucket] = (chromaticBuckets[bucket] || 0) + 1;
  }
  const largestBucket = Object.entries(hueBuckets).sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const largestChromaticBucket = Object.entries(chromaticBuckets).sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const chromaticCount = Object.values(chromaticBuckets).reduce((sum, count) => sum + count, 0);
  return {
    values: uniqueValues,
    count: uniqueValues.length,
    hueBuckets,
    hasTooMany: uniqueValues.length > 12,
    hasOneNote: parsed.length >= 5 && chromaticCount >= 4 && largestChromaticBucket[1] / chromaticCount >= 0.7,
    dominantHue: largestChromaticBucket[0] || largestBucket[0] || null,
  };
}

function analyzeContrast(css) {
  const issues = [];
  const pairs = [];
  for (const rule of cssRules(css)) {
    const fg = declarationValue(rule.body, 'color');
    const bg = declarationValue(rule.body, 'background-color') || declarationValue(rule.body, 'background');
    if (!fg || !bg) continue;
    const fgColor = parseColor(firstColor(fg));
    const bgColor = parseColor(firstColor(bg));
    if (!fgColor || !bgColor) continue;
    const ratio = contrastRatio(fgColor, bgColor);
    pairs.push({ selector: rule.selector, foreground: fgColor.raw, background: bgColor.raw, ratio });
    if (ratio < 4.5) {
      issues.push(issue('contrast.low', 'high', `Low text contrast in ${rule.selector}`, {
        selector: rule.selector,
        ratio: Number(ratio.toFixed(2)),
        foreground: fgColor.raw,
        background: bgColor.raw,
        suggestion: 'Adjust foreground or background toward at least 4.5:1 for normal text.',
      }));
    }
  }
  return { pairs, issues };
}

function analyzeDepth(css) {
  const radii = [...css.matchAll(/border-radius\s*:\s*([^;}{]+)/gi)].map((m) => parseLargestPx(m[1]));
  const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;}{]+)/gi)].map((m) => m[1].trim()).filter((v) => !/^none$/i.test(v));
  const largeShadowCount = shadows.filter((shadow) => parseLargestPx(shadow) > 32).length;
  return {
    radii,
    maxRadius: radii.length ? Math.max(...radii) : 0,
    highRadiusCount: radii.filter((v) => v > 16).length,
    shadows,
    shadowCount: shadows.length,
    largeShadowCount,
  };
}

function analyzeStructure(html, css) {
  const combined = `${html}\n${css}`;
  const heroCard = /class\s*=\s*["'][^"']*hero[^"']*["'][\s\S]{0,1600}class\s*=\s*["'][^"']*card/i.test(html)
    || /\.hero\s+\.card|\.hero[^{]*{[\s\S]{0,500}(box-shadow|border-radius:\s*(?:2[0-9]|[3-9][0-9])px)/i.test(css);
  const nestedCards = /class\s*=\s*["'][^"']*card[^"']*["'][\s\S]{0,800}class\s*=\s*["'][^"']*card/i.test(html)
    || /\.card\s+\.card/i.test(css);
  const cardCount = countMatches(combined, /\bcard\b/gi);
  const heroCount = countMatches(combined, /\bhero\b/gi);
  const splitHero = /\.hero[^{]*{[^}]*grid-template-columns\s*:\s*(?:1fr\s+1fr|repeat\(2|[^\n;]*50%)/i.test(css)
    || /class\s*=\s*["'][^"']*hero[^"']*["'][\s\S]{0,1800}(class\s*=\s*["'][^"']*(?:media|image|preview)[^"']*["'])/i.test(html);
  return { heroCard, nestedCards, cardCount, heroCount, splitHero };
}

function analyzeRepetition(html, css) {
  const bodies = cssRules(css).map((rule) => compactWhitespace(rule.body));
  const bodyCounts = countBy(bodies.filter(Boolean));
  const repeatedRuleBodies = Object.entries(bodyCounts)
    .filter(([, count]) => count >= 4)
    .map(([body, count]) => ({ body, count }));
  const numberedClasses = [...`${html}\n${css}`.matchAll(/\b([a-z]+)[-_](\d{1,3})\b/gi)].map((m) => m[1].toLowerCase());
  const numberedClassGroups = Object.entries(countBy(numberedClasses)).filter(([, count]) => count >= 5);
  const repeatedInlineStyles = countMatches(html, /style\s*=\s*["'][^"']{20,}["']/gi);
  return { repeatedRuleBodies, numberedClassGroups, repeatedInlineStyles };
}

function addFontIssues(issues, fonts) {
  if (fonts.hasTooMany) {
    issues.push(issue('font.too_many_families', 'medium', 'Too many font families create weak typography cohesion.', {
      count: fonts.count,
      families: fonts.families,
      suggestion: 'Keep most artifacts to display/body/mono or fewer unless DESIGN.md documents the exception.',
    }));
  }
  if (fonts.hasConvergence) {
    issues.push(issue('font.converged', 'low', 'All font-family declarations converge on one family.', {
      families: fonts.families,
      suggestion: 'Confirm hierarchy still has enough contrast through size, weight, line height, or a documented mono/data face.',
    }));
  }
}

function addColorIssues(issues, colors) {
  if (colors.hasTooMany) {
    issues.push(issue('palette.too_many_colors', 'medium', 'Too many unique colors make the palette harder to govern.', {
      count: colors.count,
      colors: colors.values.slice(0, 20),
      suggestion: 'Normalize values into background, surface, text, border, accent, and semantic roles.',
    }));
  }
  if (colors.hasOneNote) {
    issues.push(issue('palette.one_note', 'low', 'Most detected colors sit in one hue family.', {
      dominantHue: colors.dominantHue,
      hueBuckets: colors.hueBuckets,
      suggestion: 'Add clearer role separation with neutrals, text colors, or a restrained accent.',
    }));
  }
}

function addDepthIssues(issues, depth) {
  if (depth.maxRadius > 28 || depth.highRadiusCount >= 4) {
    issues.push(issue('depth.excessive_radius', 'medium', 'Large or repeated border-radius values may make the system feel soft and generic.', {
      maxRadius: depth.maxRadius,
      highRadiusCount: depth.highRadiusCount,
      suggestion: 'Reserve high radius for deliberately pill-shaped controls or document the style in DESIGN.md.',
    }));
  }
  if (depth.shadowCount > 8 || depth.largeShadowCount >= 3) {
    issues.push(issue('depth.excessive_shadow', 'medium', 'Heavy shadow usage can blur hierarchy and add decorative noise.', {
      shadowCount: depth.shadowCount,
      largeShadowCount: depth.largeShadowCount,
      suggestion: 'Use borders, spacing, or one elevation scale instead of many one-off shadows.',
    }));
  }
}

function addStructureIssues(issues, structure) {
  if (structure.heroCard) {
    issues.push(issue('structure.hero_card_misuse', 'medium', 'Hero content appears to be placed inside a card or card-like container.', {
      suggestion: 'For landing or brand-first screens, keep primary hero text/content unframed and let the next section peek into view.',
    }));
  }
  if (structure.nestedCards) {
    issues.push(issue('structure.nested_cards', 'medium', 'Detected card nesting.', {
      suggestion: 'Use cards for repeated items or tools; avoid placing cards inside cards.',
    }));
  }
  if (structure.cardCount > 30) {
    issues.push(issue('structure.card_heavy', 'low', 'The artifact is heavily card-oriented.', {
      cardSignals: structure.cardCount,
      suggestion: 'Check whether full-width sections, tables, lists, or grouped controls would scan better.',
    }));
  }
  if (structure.splitHero) {
    issues.push(issue('structure.split_hero', 'low', 'Hero appears to use a split text/media layout.', {
      suggestion: 'For landing-page heroes, consider a stronger first-viewport signal with real product/place/object imagery or a full-width scene.',
    }));
  }
}

function addRepetitionIssues(issues, repetition) {
  if (repetition.repeatedRuleBodies.length) {
    issues.push(issue('layout.repeated_rules', 'low', 'Several CSS rules repeat identical declarations.', {
      repeated: repetition.repeatedRuleBodies.slice(0, 5),
      suggestion: 'Extract repeated declarations into shared classes, tokens, or component styles.',
    }));
  }
  if (repetition.numberedClassGroups.length) {
    issues.push(issue('layout.numbered_classes', 'low', 'Numbered class patterns suggest repeated manual layout variants.', {
      groups: repetition.numberedClassGroups,
      suggestion: 'Replace numbered variants with reusable layout primitives or data-driven repeated items.',
    }));
  }
  if (repetition.repeatedInlineStyles >= 5) {
    issues.push(issue('layout.inline_style_repetition', 'low', 'Repeated inline styles make visual normalization harder.', {
      count: repetition.repeatedInlineStyles,
      suggestion: 'Move repeated inline styles into named classes or tokens.',
    }));
  }
}

function summarizeAudit(issues) {
  if (!issues.length) return 'No major static design issues detected. Renderer-based visual review may still find layout or responsive problems.';
  const high = issues.filter((item) => item.severity === 'high').length;
  const medium = issues.filter((item) => item.severity === 'medium').length;
  const low = issues.filter((item) => item.severity === 'low').length;
  return `Static audit found ${issues.length} issue(s): ${high} high, ${medium} medium, ${low} low.`;
}

function cssRules(css) {
  const rules = [];
  const stripped = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(/([^{}@]+)\{([^{}]+)\}/g)) {
    const selector = compactWhitespace(match[1]);
    if (!selector || selector.includes('@')) continue;
    rules.push({ selector, body: match[2] });
  }
  return rules;
}

function declarationValue(body, property) {
  const pattern = new RegExp(`(?:^|;)\\s*${escapeRegex(property)}\\s*:\\s*([^;]+)`, 'i');
  const match = String(body || '').match(pattern);
  return match ? match[1].trim() : '';
}

function extractColorValues(css) {
  const text = String(css || '');
  const hex = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  const rgb = [...text.matchAll(/rgba?\([^)]+\)/gi)].map((m) => m[0]);
  return [...hex, ...rgb];
}

function firstColor(value) {
  const match = String(value || '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/i);
  return match ? match[0] : '';
}

function parseFontFamilies(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part && !/^(sans-serif|serif|monospace|system-ui|-apple-system|BlinkMacSystemFont)$/i.test(part));
}

function extractFontNames(text) {
  const fromDeclarations = [...String(text || '').matchAll(/font-family\s*:\s*([^;`\n]+)/gi)].flatMap((m) => parseFontFamilies(m[1]));
  const fromMd = [...String(text || '').matchAll(/\*\*(?:Display|Body|Mono|Data)?\s*font\*\*:\s*([^-\n]+)/gi)]
    .map((m) => compactWhitespace(m[1]));
  return unique([...fromDeclarations, ...fromMd].filter(Boolean));
}

function parseColor(value) {
  const raw = normalizeColorToken(value);
  let r;
  let g;
  let b;

  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else {
    const nums = raw.match(/[\d.]+/g)?.map(Number) || [];
    if (nums.length >= 3) [r, g, b] = nums;
  }

  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  const hsl = rgbToHsl(r, g, b);
  return { raw, r, g, b, ...hsl };
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color) {
  const values = [color.r, color.g, color.b].map((v) => {
    const channel = v / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { hue: h, saturation: s, lightness: l };
}

function parseLargestPx(value) {
  // eslint-disable-next-line security/detect-unsafe-regex -- CSS declaration values are short strings from parsed style attributes; numeric unit scan is linear in practice.
  const px = [...String(value || '').matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Math.abs(Number(m[1])));
  if (px.length) return Math.max(...px);
  // eslint-disable-next-line security/detect-unsafe-regex -- CSS declaration values are short strings from parsed style attributes; numeric unit scan is linear in practice.
  const rem = [...String(value || '').matchAll(/(-?\d+(?:\.\d+)?)rem/g)].map((m) => Math.abs(Number(m[1]) * 16));
  return rem.length ? Math.max(...rem) : 0;
}

function issue(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

function severityRank(severity) {
  return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
}

function countMatches(text, regex) {
  return [...String(text || '').matchAll(regex)].length;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function unique(values) {
  return [...new Set(values.map((value) => normalizeString(value)).filter(Boolean))];
}

function normalizeColorToken(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function compactWhitespace(value) {
  return normalizeString(value).replace(/\s+/g, ' ');
}

function cleanMarkdown(value) {
  return compactWhitespace(value).replace(/[*_`]/g, '').replace(/\s+-\s+/g, ' - ');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
