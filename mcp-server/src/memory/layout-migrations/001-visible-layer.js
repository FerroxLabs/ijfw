// IJFW v1.5.2.1 -- fs-layout migration 001: visible ijfw/ layer.
//
// Lives in src/memory/layout-migrations/ (NOT src/memory/migrations/). This
// directory is reserved for filesystem-layout migrations — they reshape on-disk
// directory layout and track version via sentinel files (see
// brain/layout-sentinel.js), NOT via SQLite user_version. The SQL
// migration-runner deliberately rejects files declaring SQL=false (F3 root
// cause: when SQL and fs-layout migrations coexist, an accidental copy-paste
// can brick schema migrations). These files are statically registered in
// layout-migrations/index.js and invoked by server.js at startup.
//
// Trident F-B3 safety:
//  - acquires withLayoutLock (serializes concurrent migrations)
//  - freshness gate refuses if any .md mtime < 30s old (concurrent writer)
//  - sentinel flipped LAST so a crash mid-copy leaves v1 + a recoverable retry
//  - copy-not-move keeps legacy .ijfw/ paths intact for one-version fallback

import {
  existsSync, mkdirSync, statSync, readdirSync, cpSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  readLayoutVersion, writeLayoutVersion, withLayoutLock,
} from '../../brain/layout-sentinel.js';

const FRESHNESS_MS = 30_000;

const SCAFFOLD_DIRS = [
  ['ijfw', 'dump', 'inbox'],
  ['ijfw', 'dump', 'processed'],
  ['ijfw', 'wiki', 'concepts'],
  ['ijfw', 'wiki', 'entities'],
  ['ijfw', 'wiki', 'decisions'],
  ['ijfw', 'wiki', 'milestones'],
];

function walkMd(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(p));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function findFreshFiles(repoRoot) {
  const cutoff = Date.now() - FRESHNESS_MS;
  const candidates = [
    ...walkMd(join(repoRoot, '.ijfw', 'memory')),
    ...walkMd(join(repoRoot, '.ijfw', 'sessions')),
  ];
  return candidates.filter((p) => statSync(p).mtimeMs >= cutoff);
}

export const DESCRIPTION =
  'fs-layout v2 -- visible ijfw/ + scaffolded dump/wiki dirs (NOT a SQL migration)';

export async function up(repoRoot) {
  if (readLayoutVersion(repoRoot) >= 2) {
    return { skipped: true, reason: 'already-migrated' };
  }
  return await withLayoutLock(repoRoot, async () => {
    if (readLayoutVersion(repoRoot) >= 2) {
      return { skipped: true, reason: 'already-migrated' };
    }
    // F4: freshness gate runs INSIDE the lock so a writer cannot sneak in
    // between gate-pass and lock-acquire. The lock holds the freshness
    // contract for the entire copy phase.
    const freshFiles = findFreshFiles(repoRoot);
    if (freshFiles.length > 0) {
      // v1.5.2.1 F2: observability — surface the deferral to stderr so an
      // operator running `ijfw doctor` or watching server logs can see why
      // the visible layer hasn't materialised yet. Silent skip leaves the
      // operator wondering what happened.
      try {
        process.stderr.write(
          `[ijfw layout-migrate] deferred: ${freshFiles.length} file(s) written ` +
          `< ${FRESHNESS_MS}ms ago in .ijfw/memory or .ijfw/sessions; ` +
          `will retry on next server start\n`
        );
      } catch { /* stderr may be detached */ }
      return { skipped: true, reason: 'fresh-writes-detected', freshFiles };
    }
    // v1.5.2.1 F4: detect operator downgrade. If sentinel is 1 but the visible
    // layer destination already has .md content, the operator probably flipped
    // .ijfw/.layout-version back to 1 manually (e.g. attempting downgrade to
    // v1.5.1). cpSync({force:false}) would silently skip the existing files
    // and leave drift between the two layers. Refuse, log, keep sentinel at 1
    // so the operator resolves the conflict manually.
    const memoryDst = join(repoRoot, 'ijfw', 'memory');
    const sessionsDst = join(repoRoot, 'ijfw', 'sessions');
    if (walkMd(memoryDst).length > 0 || walkMd(sessionsDst).length > 0) {
      try {
        process.stderr.write(
          `[ijfw layout-migrate] aborted: visible layer (ijfw/memory or ijfw/sessions) ` +
          `already populated but sentinel=1 (downgrade detected). Resolve manually, ` +
          `then set .ijfw/.layout-version to 2.\n`
        );
      } catch { /* stderr may be detached */ }
      return { skipped: true, reason: 'downgrade-conflict' };
    }
    let copiedFiles = 0;
    // FLAG-4: force:false preserves any user-authored content already at the
    // visible-layer destination (e.g. operator following the README's
    // "commit ijfw/ to git" advice before migration runs). errorOnExist:false
    // means existing destination files cause the COPY of THAT file to skip
    // silently, but the rest of the tree still copies. Behaviour: union of
    // existing visible files (winner) + legacy hidden files (filler).
    const memorySrc = join(repoRoot, '.ijfw', 'memory');
    if (existsSync(memorySrc)) {
      cpSync(memorySrc, memoryDst,
             { recursive: true, force: false, errorOnExist: false });
      copiedFiles += walkMd(memorySrc).length;
    }
    const sessionsSrc = join(repoRoot, '.ijfw', 'sessions');
    if (existsSync(sessionsSrc)) {
      cpSync(sessionsSrc, sessionsDst,
             { recursive: true, force: false, errorOnExist: false });
      copiedFiles += walkMd(sessionsSrc).length;
    }
    for (const parts of SCAFFOLD_DIRS) {
      mkdirSync(join(repoRoot, ...parts), { recursive: true });
    }
    writeLayoutVersion(repoRoot, 2);
    return { skipped: false, version: 2, copiedFiles, scaffoldedDirs: SCAFFOLD_DIRS.length };
  });
}

export default { description: DESCRIPTION, up };
