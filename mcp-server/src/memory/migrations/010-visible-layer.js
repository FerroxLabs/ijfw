// IJFW v1.5.2 -- fs-layout migration 010: visible ijfw/ layer.
//
// NOT a SQL migration. Filesystem-only — no db arg, async, tracked via the
// .layout-version sentinel from brain/layout-sentinel.js (NOT via SQLite
// user_version, which stays at 9). NOT auto-run by the SQL migration loader;
// Task 5 (lazy MEMORY_DIR) will invoke it explicitly at server startup.
// Future SQL migrations should number from 011.
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

export const VERSION = 10;
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
      return { skipped: true, reason: 'fresh-writes-detected', freshFiles };
    }
    let copiedFiles = 0;
    const memorySrc = join(repoRoot, '.ijfw', 'memory');
    if (existsSync(memorySrc)) {
      cpSync(memorySrc, join(repoRoot, 'ijfw', 'memory'),
             { recursive: true, force: true, errorOnExist: false });
      copiedFiles += walkMd(memorySrc).length;
    }
    const sessionsSrc = join(repoRoot, '.ijfw', 'sessions');
    if (existsSync(sessionsSrc)) {
      cpSync(sessionsSrc, join(repoRoot, 'ijfw', 'sessions'),
             { recursive: true, force: true, errorOnExist: false });
      copiedFiles += walkMd(sessionsSrc).length;
    }
    for (const parts of SCAFFOLD_DIRS) {
      mkdirSync(join(repoRoot, ...parts), { recursive: true });
    }
    writeLayoutVersion(repoRoot, 2);
    return { skipped: false, version: 2, copiedFiles, scaffoldedDirs: SCAFFOLD_DIRS.length };
  });
}

export default { version: VERSION, description: DESCRIPTION, up };
