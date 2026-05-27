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
  existsSync, mkdirSync, statSync, readdirSync, cpSync, lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  readLayoutVersion, writeLayoutVersion, withLayoutLock,
} from '../../brain/layout-sentinel.js';

const FRESHNESS_MS = 30_000;

// V155-056 (v1.5.5): bound walkMd recursion + skip symlinks. A same-uid
// attacker who plants `.ijfw/memory/loop -> ..` would otherwise drive walkMd
// into an infinite loop (or, worse, a symlink to `/var/log/syslog` could leak
// external paths into deferral stderr). Cap depth at 8 — real .ijfw trees are
// only 2-3 deep — and refuse to follow symlinks at directory entries.
const MAX_WALK_DEPTH = 8;

const SCAFFOLD_DIRS = [
  ['ijfw', 'dump', 'inbox'],
  ['ijfw', 'dump', 'processed'],
  ['ijfw', 'wiki', 'concepts'],
  ['ijfw', 'wiki', 'entities'],
  ['ijfw', 'wiki', 'decisions'],
  ['ijfw', 'wiki', 'milestones'],
];

function walkMd(dir, depth = 0) {
  if (!existsSync(dir)) return [];
  if (depth > MAX_WALK_DEPTH) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    // V155-056: skip any symlink entry — both files and dirs. Symlink targets
    // are NOT walked; this avoids the cycle/loop attack and keeps the report
    // honest about what's actually inside the .ijfw tree.
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walkMd(p, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * V155-035 (v1.5.5): pre-scan a source subtree for symlinks. cpSync's Node
 * default is `dereference:false` (writes are safe — the destination becomes
 * a symlink), but the subsequent visible-layer reads via `walkMd` follow
 * symlinks under their feet. Refusing symlinks in the source tree closes
 * that read-time leak before the migration commits.
 *
 * Returns the first symlink path found, or null when the subtree is clean.
 * Honors MAX_WALK_DEPTH so a malicious deep tree can't burn the call stack.
 */
function findSymlinkInTree(dir, depth = 0) {
  if (!existsSync(dir)) return null;
  if (depth > MAX_WALK_DEPTH) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    let lst;
    try { lst = lstatSync(p); }
    catch { continue; }
    if (lst.isSymbolicLink()) return p;
    if (entry.isDirectory()) {
      const found = findSymlinkInTree(p, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findFreshFiles(repoRoot) {
  const cutoff = Date.now() - FRESHNESS_MS;
  const candidates = [
    ...walkMd(join(repoRoot, '.ijfw', 'memory')),
    ...walkMd(join(repoRoot, '.ijfw', 'sessions')),
  ];
  return candidates.filter((p) => {
    try { return statSync(p).mtimeMs >= cutoff; }
    catch { return false; }
  });
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
    //
    // V155-035 (v1.5.5): pre-scan each source subtree for symlinks BEFORE
    // committing the migration. cpSync's default does not follow symlinks
    // (`dereference:false` per Node docs), so the write itself is safe — but
    // the visible-layer reads via walkMd would follow them and leak the
    // target's content into LLM context. We refuse the migration outright
    // when a symlink is present in the source tree so the operator can
    // resolve it before the layout flips to v2. `dereference: false` is
    // also stated explicitly on the cpSync calls for forensic clarity.
    const memorySrc = join(repoRoot, '.ijfw', 'memory');
    const sessionsSrc = join(repoRoot, '.ijfw', 'sessions');
    for (const src of [memorySrc, sessionsSrc]) {
      const sym = findSymlinkInTree(src);
      if (sym) {
        try {
          process.stderr.write(
            `[ijfw layout-migrate] aborted: symlink in source tree (${sym}) ` +
            `would leak external content into the visible layer. ` +
            `Remove or replace with a copy, then re-run.\n`
          );
        } catch { /* stderr may be detached */ }
        return { skipped: true, reason: 'symlink-source-rejected', sample: sym };
      }
    }
    if (existsSync(memorySrc)) {
      cpSync(memorySrc, memoryDst,
             { recursive: true, force: false, errorOnExist: false, dereference: false });
      copiedFiles += walkMd(memorySrc).length;
    }
    if (existsSync(sessionsSrc)) {
      cpSync(sessionsSrc, sessionsDst,
             { recursive: true, force: false, errorOnExist: false, dereference: false });
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
