#!/usr/bin/env node
/**
 * Vendor the README's Lucide icons into docs/img/icons/, recolored to the brand
 * accent so they read on BOTH GitHub light and dark themes (GitHub strips inline
 * <svg> and won't theme an <img>-referenced SVG, so we bake the color in).
 * Lucide is ISC-licensed (free, no attribution required in output). Re-run only
 * when the icon set changes.
 *
 *   node scripts/fetch-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'img', 'icons');
const ACCENT = '#ff6b35';

// pillar / section -> Lucide icon name
const ICONS = [
  'brain',          // unified memory
  'route',          // disciplined workflow / build discipline
  'shield-check',   // multi-AI cross-audit
  'users',          // specialist teams + skills
  'wallet',         // token economy
  'bar-chart-3',    // observability / dashboard / proof
  'git-compare',    // learns you (correction loop)
  'palette',        // design contract
  'layers',         // works under everything
  'lock',           // it's yours (local + control)
  'terminal',       // quickstart
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const name of ICONS) {
    const url = `https://unpkg.com/lucide-static@latest/icons/${name}.svg`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
    let svg = await res.text();
    // Lucide strokes with currentColor; bake the brand accent in.
    svg = svg.replace(/currentColor/g, ACCENT);
    writeFileSync(join(OUT, `${name}.svg`), svg);
    console.log(`wrote docs/img/icons/${name}.svg`);
  }
  console.log(`\n${ICONS.length} icons vendored, stroked ${ACCENT}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
