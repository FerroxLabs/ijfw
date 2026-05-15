import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditStaticDesign,
  createDesignMdContent,
  findDesignFile,
  getDesignActionGuidance,
  listDesignActionModes,
  loadDesignFile,
  summarizeDesignContent,
} from './src/design-intelligence.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'ijfw-design-intel-'));
}

test('findDesignFile walks upward and loadDesignFile returns compact summary', () => {
  const root = tempProject();
  const nested = join(root, 'packages', 'app', 'src');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, 'DESIGN.md'), `# Atlas DESIGN.md

## Color Palette
- \`--color-bg\`: #ffffff
- \`--color-accent\`: #0057ff

## Typography Rules
- **Display font**: Inter - weights 400, 700
- **Mono font**: JetBrains Mono

## Layout
- Spacing scale: 4 / 8 / 16 / 24 / 32
- Maintain 4.5:1 contrast minimum.
`, 'utf8');

  try {
    const found = findDesignFile(nested);
    assert.equal(found.found, true);
    assert.equal(found.path, join(root, 'DESIGN.md'));

    const loaded = loadDesignFile(nested, { maxChars: 500 });
    assert.equal(loaded.found, true);
    assert.match(loaded.summary, /Atlas DESIGN\.md/);
    assert.match(loaded.summary, /Color roles:/);
    assert.match(loaded.summary, /Inter/);
    assert.ok(loaded.summary.length <= 500);
    assert.deepEqual(loaded.details.colors.slice(0, 2), ['--color-bg #ffffff', '--color-accent #0057ff']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadDesignFile handles missing DESIGN.md with useful fallback', () => {
  const root = tempProject();
  try {
    const loaded = loadDesignFile(root);
    assert.equal(loaded.found, false);
    assert.equal(loaded.content, '');
    assert.match(loaded.summary, /No DESIGN\.md found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDesignMdContent creates project-agnostic initialization content', () => {
  const content = createDesignMdContent({
    projectName: 'Research Atlas',
    artifactType: 'research reports and dashboards',
    audience: 'analysts and executives',
    tone: 'quiet, credible, and data-forward',
  });

  assert.match(content, /^# Research Atlas DESIGN\.md/);
  assert.match(content, /research reports and dashboards/);
  assert.match(content, /interfaces, documents, dashboards, research outputs, presentations/);
  assert.match(content, /Avoid too many font families/);
  assert.match(content, /real HTML mockups/);
});

test('summarizeDesignContent extracts headings, colors, fonts, and constraints', () => {
  const summary = summarizeDesignContent(`# Product DESIGN.md

## Visual Theme
Clear and direct.

## Color Roles
- \`--text\`: #111111
- \`--bg\`: #ffffff

## Typography
- **Body font**: Source Sans 3
- **Mono font**: IBM Plex Mono

## Rules
- Do not use decorative shadows.
- Mobile layouts must preserve readable text.
`, { maxChars: 700 });

  assert.match(summary, /Product DESIGN\.md/);
  assert.match(summary, /Color roles: --text #111111, --bg #ffffff/);
  assert.match(summary, /Source Sans 3/);
  assert.match(summary, /decorative shadows/);
});

test('auditStaticDesign flags practical static design issues', () => {
  const html = `<!doctype html>
<html><head><style>
body { font-family: Inter; color: #777777; background-color: #777999; }
h1 { font-family: "Playfair Display"; color: #3344ff; background-color: #4455ff; }
.kpi { font-family: Roboto; color: #3355ee; }
.code { font-family: "IBM Plex Mono"; color: #3344dd; }
.extra { font-family: Lora; color: #2233cc; }
.hero { display:grid; grid-template-columns:1fr 1fr; border-radius:32px; box-shadow:0 28px 70px rgba(0,0,0,.35); }
.hero .card { border-radius:36px; box-shadow:0 18px 48px rgba(0,0,0,.30); }
.card .card { border-radius:40px; box-shadow:0 16px 44px rgba(0,0,0,.25); }
.tile-1 { padding: 16px; margin: 8px; }
.tile-2 { padding: 16px; margin: 8px; }
.tile-3 { padding: 16px; margin: 8px; }
.tile-4 { padding: 16px; margin: 8px; }
.tile-5 { padding: 16px; margin: 8px; }
</style></head>
<body>
<section class="hero"><div class="card"><h1>Launch</h1><div class="card">Nested</div></div><div class="media"></div></section>
</body></html>`;

  const audit = auditStaticDesign({ html });
  const codes = audit.issues.map((item) => item.code);

  assert.match(audit.summary, /Static audit found/);
  assert.ok(codes.includes('font.too_many_families'));
  assert.ok(codes.includes('palette.one_note'));
  assert.ok(codes.includes('contrast.low'));
  assert.ok(codes.includes('depth.excessive_radius'));
  assert.ok(codes.includes('structure.hero_card_misuse'));
  assert.ok(codes.includes('structure.nested_cards'));
  assert.ok(codes.includes('structure.split_hero'));
  assert.ok(codes.includes('layout.repeated_rules'));
  assert.ok(codes.includes('layout.numbered_classes'));
  assert.equal(audit.metrics.fonts.count, 5);
  assert.ok(audit.limits.some((line) => line.includes('Static audit only')));
});

test('auditStaticDesign flags too many colors and repeated inline styles', () => {
  const css = `
.a { color:#111111; background:#ffffff; }
.b { color:#222222; }
.c { color:#333333; }
.d { color:#444444; }
.e { color:#555555; }
.f { color:#666666; }
.g { color:#777777; }
.h { color:#888888; }
.i { color:#999999; }
.j { color:#aaaaaa; }
.k { color:#bbbbbb; }
.l { color:#cccccc; }
.m { color:#dddddd; }
`;
  const html = `<div style="padding: 16px; margin: 8px; color: #111;">a</div>
<div style="padding: 16px; margin: 8px; color: #222;">b</div>
<div style="padding: 16px; margin: 8px; color: #333;">c</div>
<div style="padding: 16px; margin: 8px; color: #444;">d</div>
<div style="padding: 16px; margin: 8px; color: #555;">e</div>`;

  const audit = auditStaticDesign({ html, css });
  const codes = audit.issues.map((item) => item.code);
  assert.ok(codes.includes('palette.too_many_colors'));
  assert.ok(codes.includes('layout.inline_style_repetition'));
});

test('auditStaticDesign returns no major issues for restrained CSS', () => {
  const audit = auditStaticDesign(`
.page { font-family: Inter, system-ui, sans-serif; color: #111111; background-color: #ffffff; }
.panel { border: 1px solid #e5e7eb; border-radius: 6px; }
.accent { color: #0f766e; }
`);

  assert.equal(audit.issues.length, 0);
  assert.match(audit.summary, /No major static design issues detected/);
});

test('getDesignActionGuidance supports all requested modes', () => {
  const modes = ['plan', 'audit', 'critique', 'polish', 'normalize', 'bolder', 'quieter', 'handoff'];
  assert.deepEqual(listDesignActionModes(), modes);

  for (const mode of modes) {
    const guidance = getDesignActionGuidance(mode, {
      artifactType: 'book chapter',
      hasDesignFile: true,
      hasWebApp: false,
    });
    assert.equal(guidance.mode, mode);
    assert.ok(guidance.intent.length > 10);
    assert.ok(guidance.steps.length >= 3);
    assert.ok(guidance.output.length > 5);
    assert.equal(guidance.context.artifactType, 'book chapter');
  }

  assert.equal(getDesignActionGuidance('unknown').mode, 'plan');
});
