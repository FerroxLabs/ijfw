#!/usr/bin/env node
// Generates per-platform rules files from shared/rules/IJFW.md.
// Split point: <!-- PLATFORM_HEADER --> marker (everything before it is replaced).
// Usage: node scripts/generate-platform-rules.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Format types:
//   'html-comment' -- wraps header in <!-- --> comment block (wayland/hermes/claude)
//   'mdc'          -- YAML frontmatter + body (cursor modern format)
//   'plain'        -- raw body, no wrapper (cursor legacy, windsurf, copilot)

const PLATFORMS = [
  {
    dest: 'wayland/WAYLAND.md',
    format: 'html-comment',
    header: 'These rules apply when running IJFW on the Wayland CLI agent.',
  },
  {
    dest: 'hermes/HERMES.md',
    format: 'html-comment',
    header: 'These rules apply when running IJFW on the Hermes CLI agent.',
  },
  {
    dest: 'claude/rules/IJFW-CLAUDE.md',
    format: 'html-comment',
    header:
      'These rules apply when running IJFW on Claude Code. The `ijfw-core` skill loads this file as its always-on rules.',
  },
  {
    dest: 'cursor/.cursor/rules/ijfw.mdc',
    format: 'mdc',
    frontmatter: {
      description: 'IJFW -- AI Efficiency Framework. Applies to every response.',
      alwaysApply: true,
    },
  },
  {
    dest: 'cursor/.cursorrules',
    format: 'plain',
  },
  {
    dest: 'windsurf/.windsurfrules',
    format: 'plain',
  },
  {
    dest: 'copilot/copilot-instructions.md',
    format: 'plain',
  },
];

const MARKER = '<!-- PLATFORM_HEADER -->';

const source = readFileSync(join(ROOT, 'shared/rules/IJFW.md'), 'utf8');
const markerIdx = source.indexOf(MARKER);
if (markerIdx === -1) {
  console.error('ERROR: PLATFORM_HEADER marker not found in shared/rules/IJFW.md');
  process.exit(1);
}

// Body = everything after the marker (trim leading newlines)
const body = source.slice(markerIdx + MARKER.length).replace(/^\n+/, '');

function buildContent({ format, header, frontmatter }) {
  if (format === 'html-comment') {
    return `<!-- PLATFORM_HEADER -->\n<!-- ${header} -->\n\n${body}`;
  }
  if (format === 'mdc') {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : v}`)
      .join('\n');
    return `---\n${fm}\n---\n\n${body}`;
  }
  if (format === 'plain') {
    return body;
  }
  throw new Error(`Unknown format: ${format}`);
}

for (const platform of PLATFORMS) {
  const outPath = join(ROOT, platform.dest);
  mkdirSync(dirname(outPath), { recursive: true });
  const content = buildContent(platform);
  writeFileSync(outPath, content, 'utf8');
}

console.log(`Generated ${PLATFORMS.length} platform rules files from shared/rules/IJFW.md`);
console.log(PLATFORMS.map(p => `  ${p.dest}`).join('\n'));
