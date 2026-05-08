#!/usr/bin/env node
// Synthetic A3 fixture generator. Run once to materialize 50 fixtures
// (10 per domain). Each fixture is a tiny directory tree + expected.json.
// All content is synthetic placeholder text -- no PII, no proprietary
// strings. Re-running is idempotent.

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

function w(rel, body) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function expected(domain, secondary = [], floor = 0.55, opts = {}) {
  return JSON.stringify({
    primary_type: domain,
    secondary_types: secondary,
    confidence_floor: floor,
    scan_incomplete: opts.scanIncomplete === true,
    fallback_reason: opts.fallbackReason || null,
  }, null, 2) + '\n';
}

// --- software (10) ---
// 1: classic Node app
w('software/1/package.json', JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { express: '^4' } }));
for (let i = 1; i <= 8; i++) w(`software/1/src/file${i}.js`, `// fixture ${i}\nmodule.exports = ${i};\n`);
w('software/1/expected.json', expected('software', [], 0.55));

// 2: Rust crate
w('software/2/Cargo.toml', '[package]\nname = "demo"\nversion = "0.1.0"\n');
for (let i = 1; i <= 6; i++) w(`software/2/src/file${i}.rs`, `pub fn f${i}() -> i32 { ${i} }\n`);
w('software/2/expected.json', expected('software', [], 0.55));

// 3: Python project
w('software/3/pyproject.toml', '[project]\nname = "demo"\n');
for (let i = 1; i <= 7; i++) w(`software/3/src/mod${i}.py`, `def f${i}(): return ${i}\n`);
w('software/3/expected.json', expected('software', [], 0.55));

// 4: Ruby Gem
w('software/4/Gemfile', "source 'https://rubygems.org'\ngem 'rake'\n");
for (let i = 1; i <= 5; i++) w(`software/4/lib/m${i}.rb`, `class M${i}; end\n`);
w('software/4/expected.json', expected('software', [], 0.55));

// 5: Go module
w('software/5/go.mod', 'module demo\n\ngo 1.22\n');
for (let i = 1; i <= 5; i++) w(`software/5/cmd/c${i}/main.go`, `package main\nfunc main() {}\n`);
w('software/5/expected.json', expected('software', [], 0.55));

// 6: TypeScript heavy
w('software/6/package.json', JSON.stringify({ name: 't', version: '0.0.0' }));
w('software/6/tsconfig.json', '{}');
for (let i = 1; i <= 9; i++) w(`software/6/src/file${i}.ts`, `export const v${i} = ${i};\n`);
w('software/6/expected.json', expected('software', [], 0.55));

// 7: Java/Maven
w('software/7/pom.xml', '<project></project>\n');
for (let i = 1; i <= 6; i++) w(`software/7/src/main/java/A${i}.java`, `class A${i} {}\n`);
w('software/7/expected.json', expected('software', [], 0.55));

// 8: PHP/Composer
w('software/8/composer.json', '{"name":"demo/demo"}\n');
for (let i = 1; i <= 6; i++) w(`software/8/src/c${i}.php`, `<?php class C${i} {}\n`);
w('software/8/expected.json', expected('software', [], 0.55));

// 9: Swift package
w('software/9/Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n');
for (let i = 1; i <= 5; i++) w(`software/9/Sources/m${i}.swift`, `public func f${i}() {}\n`);
w('software/9/expected.json', expected('software', [], 0.55));

// 10: software with companion docs (must remain software, not flip to content)
w('software/10/package.json', JSON.stringify({ name: 'd', version: '0.0.0' }));
for (let i = 1; i <= 12; i++) w(`software/10/src/f${i}.js`, `export const v${i} = ${i};\n`);
for (let i = 1; i <= 4; i++) w(`software/10/docs/g${i}.md`, `# guide ${i}\n`);
w('software/10/expected.json', expected('software', [], 0.55));

// --- book (10) ---
// 1-5: manuscripts/ heavy
for (let n = 1; n <= 5; n++) {
  w(`book/${n}/manuscripts/preface.tex`, '\\documentclass{book}\n\\begin{document}\n\\end{document}\n');
  for (let i = 1; i <= 8; i++) {
    w(`book/${n}/manuscripts/chapter-${String(i).padStart(2, '0')}.tex`, `\\chapter{Chapter ${i}}\n\\section{Intro}\nText placeholder.\n`);
  }
  w(`book/${n}/manuscripts/refs.bib`, '@book{a, title={A}}\n');
  w(`book/${n}/expected.json`, expected('book', [], 0.55));
}
// 6-8: drafts/ + chapter-NN.md heavy
for (let n = 6; n <= 8; n++) {
  w(`book/${n}/drafts/intro.tex`, '\\chapter{Intro}\n');
  for (let i = 1; i <= 9; i++) {
    w(`book/${n}/drafts/chapter-${String(i).padStart(2, '0')}.tex`, `\\chapter{Chapter ${i}}\nText.\n`);
  }
  w(`book/${n}/expected.json`, expected('book', [], 0.55));
}
// 9: book + small companion code -> mixed (book + software)
w('book/9/manuscripts/ch01.tex', '\\chapter{One}\n');
for (let i = 1; i <= 8; i++) w(`book/9/manuscripts/chapter-${String(i).padStart(2, '0')}.tex`, `\\chapter{C${i}}\n`);
w('book/9/manuscripts/refs.bib', '@book{a,title={A}}\n');
// Add code companion of equal weight to trigger mixed
w('book/9/code/package.json', '{"name":"companion"}\n');
for (let i = 1; i <= 9; i++) w(`book/9/code/src/m${i}.js`, `export const v${i} = ${i};\n`);
w('book/9/expected.json', expected('mixed', ['software', 'book'], 0.5));

// 10: empty manuscripts/ directory edge case (must still detect book via dir name)
w('book/10/manuscripts/.keep', '');
w('book/10/drafts/chapter-01.tex', '\\chapter{One}\nText.\n');
w('book/10/drafts/chapter-02.tex', '\\chapter{Two}\nText.\n');
w('book/10/drafts/chapter-03.tex', '\\chapter{Three}\nText.\n');
w('book/10/drafts/refs.bib', '@book{a,title={A}}\n');
w('book/10/expected.json', expected('book', [], 0.4));

// --- content (10) ---
// 1-5: content/ + posts/
for (let n = 1; n <= 5; n++) {
  w(`content/${n}/brand-voice.md`, '# Brand voice\n');
  for (let i = 1; i <= 9; i++) w(`content/${n}/content/post${i}.mdx`, `# Post ${i}\nText.\n`);
  w(`content/${n}/expected.json`, expected('content', [], 0.5));
}
// 6-8: blog/articles directories
for (let n = 6; n <= 8; n++) {
  for (let i = 1; i <= 10; i++) w(`content/${n}/blog/post-${i}.mdx`, `# Post ${i}\n`);
  w(`content/${n}/seo-checklist.md`, 'SEO\n');
  w(`content/${n}/expected.json`, expected('content', [], 0.5));
}
// 9: posts dir + brand voice + seo
w('content/9/posts/p1.mdx', '# A\n');
w('content/9/posts/p2.mdx', '# B\n');
w('content/9/posts/p3.mdx', '# C\n');
w('content/9/posts/p4.mdx', '# D\n');
w('content/9/posts/p5.mdx', '# E\n');
w('content/9/posts/p6.mdx', '# F\n');
w('content/9/brand-voice.md', '# Voice\n');
w('content/9/seo-keywords.md', 'kw\n');
w('content/9/expected.json', expected('content', [], 0.5));

// 10: newsletter/ -- alternative content shape
for (let i = 1; i <= 8; i++) w(`content/10/newsletter/issue-${i}.mdx`, `# Issue ${i}\n`);
w('content/10/brand-voice.md', '# Voice\n');
w('content/10/expected.json', expected('content', [], 0.5));

// --- business (10) ---
// 1-4: strategy/ + financials/
for (let n = 1; n <= 4; n++) {
  w(`business/${n}/strategy/q1-plan.docx`, 'placeholder');
  w(`business/${n}/strategy/q2-plan.docx`, 'placeholder');
  w(`business/${n}/financials/budget.xlsx`, 'placeholder');
  w(`business/${n}/financials/forecast.xlsx`, 'placeholder');
  w(`business/${n}/financials/p&l.csv`, 'rev,cost\n100,50\n');
  w(`business/${n}/runbooks/onboarding.docx`, 'placeholder');
  w(`business/${n}/expected.json`, expected('business', [], 0.5));
}
// 5-7: ops-runbooks/
for (let n = 5; n <= 7; n++) {
  for (let i = 1; i <= 5; i++) w(`business/${n}/ops/runbook-${i}.docx`, 'placeholder');
  w(`business/${n}/financials/p&l-2026.xlsx`, 'placeholder');
  w(`business/${n}/financials/budget.xlsx`, 'placeholder');
  w(`business/${n}/strategy/north-star.pptx`, 'placeholder');
  w(`business/${n}/expected.json`, expected('business', [], 0.5));
}
// 8: SOP heavy
for (let i = 1; i <= 8; i++) w(`business/8/sops/sop-${i}.docx`, 'placeholder');
w('business/8/financials/budget.xlsx', 'placeholder');
w('business/8/expected.json', expected('business', [], 0.5));

// 9: pure spreadsheets
for (let i = 1; i <= 10; i++) w(`business/9/financials/q${i}.xlsx`, 'placeholder');
w('business/9/strategy/plan.pptx', 'placeholder');
w('business/9/expected.json', expected('business', [], 0.5));

// 10: business + content companion (newsletter) -> still business primary
for (let i = 1; i <= 6; i++) w(`business/10/strategy/plan-${i}.pptx`, 'placeholder');
for (let i = 1; i <= 6; i++) w(`business/10/financials/q${i}.xlsx`, 'placeholder');
w('business/10/runbooks/ops.docx', 'placeholder');
w('business/10/expected.json', expected('business', [], 0.45));

// --- design (10) ---
// 1-4: designs/ heavy
for (let n = 1; n <= 4; n++) {
  for (let i = 1; i <= 6; i++) w(`design/${n}/designs/screen-${i}.fig`, 'placeholder');
  for (let i = 1; i <= 4; i++) w(`design/${n}/assets/icon-${i}.svg`, '<svg/>');
  w(`design/${n}/expected.json`, expected('design', [], 0.5));
}
// 5-7: figma-export/
for (let n = 5; n <= 7; n++) {
  for (let i = 1; i <= 8; i++) w(`design/${n}/figma-export/screen-${i}.svg`, '<svg/>');
  for (let i = 1; i <= 3; i++) w(`design/${n}/assets/logo-${i}.psd`, 'placeholder');
  w(`design/${n}/expected.json`, expected('design', [], 0.5));
}
// 8: wireframes/
for (let i = 1; i <= 8; i++) w(`design/8/wireframes/wf-${i}.fig`, 'placeholder');
for (let i = 1; i <= 4; i++) w(`design/8/mockups/m-${i}.sketch`, 'placeholder');
w('design/8/expected.json', expected('design', [], 0.5));

// 9: assets/ + svg heavy
for (let i = 1; i <= 12; i++) w(`design/9/assets/v-${i}.svg`, '<svg/>');
w('design/9/designs/main.fig', 'placeholder');
w('design/9/expected.json', expected('design', [], 0.5));

// 10: design + light docs
for (let i = 1; i <= 8; i++) w(`design/10/designs/screen-${i}.fig`, 'placeholder');
w('design/10/designs/spec.indd', 'placeholder');
w('design/10/assets/logo.ai', 'placeholder');
w('design/10/expected.json', expected('design', [], 0.5));

console.log('fixtures generated');
