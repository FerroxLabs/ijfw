#!/usr/bin/env node
// Generates per-platform rules files from shared/rules/IJFW.md.
// Split point: <!-- PLATFORM_HEADER --> marker (everything before it is replaced).
// Usage: node scripts/generate-platform-rules.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const PLATFORMS = [
  {
    dest: 'wayland/WAYLAND.md',
    header: 'These rules apply when running IJFW on the Wayland CLI agent.',
  },
  {
    dest: 'hermes/HERMES.md',
    header: 'These rules apply when running IJFW on the Hermes CLI agent.',
  },
  {
    dest: 'claude/rules/IJFW-CLAUDE.md',
    header:
      'These rules apply when running IJFW on Claude Code. The `ijfw-core` skill loads this file as its always-on rules.',
  },
];

const MARKER = '<!-- PLATFORM_HEADER -->';

const source = readFileSync(join(ROOT, 'shared/rules/IJFW.md'), 'utf8');
const markerIdx = source.indexOf(MARKER);
if (markerIdx === -1) {
  console.error('ERROR: PLATFORM_HEADER marker not found in shared/rules/IJFW.md');
  process.exit(1);
}

// Body = everything after the marker (trim leading newline)
const body = source.slice(markerIdx + MARKER.length).replace(/^\n/, '');

for (const { dest, header } of PLATFORMS) {
  const outPath = join(ROOT, dest);
  mkdirSync(dirname(outPath), { recursive: true });
  const content = `<!-- PLATFORM_HEADER -->\n<!-- ${header} -->\n\n${body}`;
  writeFileSync(outPath, content, 'utf8');
}

console.log('Generated 3 platform rules files from shared/rules/IJFW.md');
