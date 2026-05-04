#!/usr/bin/env node
// Fidelity test: verifies every rule from shared/rules/IJFW.md appears in each generated file.
// Exit 0 on pass, exit 1 on any missing rule.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const GENERATED = [
  'wayland/WAYLAND.md',
  'hermes/HERMES.md',
  'claude/rules/IJFW-CLAUDE.md',
];

const MARKER = '<!-- PLATFORM_HEADER -->';

const source = readFileSync(join(ROOT, 'shared/rules/IJFW.md'), 'utf8');
const markerIdx = source.indexOf(MARKER);
if (markerIdx === -1) {
  console.error('ERROR: PLATFORM_HEADER marker not found in shared/rules/IJFW.md');
  process.exit(1);
}

const body = source.slice(markerIdx + MARKER.length).replace(/^\n/, '');

// Extract level-2 headings and the first non-empty paragraph after each
const sections = [];
const lines = body.split('\n');
let i = 0;
while (i < lines.length) {
  if (lines[i].startsWith('## ')) {
    const heading = lines[i];
    // Find first non-empty paragraph after the heading
    let sample = '';
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('## ')) {
      if (lines[j].trim().length > 0 && sample === '') {
        sample = lines[j].trim().slice(0, 40);
      }
      j++;
    }
    sections.push({ heading, sample });
  }
  i++;
}

if (sections.length === 0) {
  console.error('ERROR: no level-2 headings found in source body');
  process.exit(1);
}

let failed = false;
for (const relPath of GENERATED) {
  const outPath = join(ROOT, relPath);
  let generated;
  try {
    generated = readFileSync(outPath, 'utf8');
  } catch {
    console.error(`MISSING FILE: ${relPath}`);
    failed = true;
    continue;
  }
  for (const { heading, sample } of sections) {
    if (!generated.includes(heading)) {
      console.error(`MISSING RULE in ${relPath}: heading "${heading}" not found`);
      failed = true;
    } else if (sample && !generated.includes(sample)) {
      console.error(
        `MISSING CONTENT in ${relPath}: under "${heading}", sample text "${sample}" not found`
      );
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('rules fidelity OK');
