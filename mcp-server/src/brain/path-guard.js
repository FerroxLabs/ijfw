// IJFW v1.5.2.1 -- shared safe-write path guard (F-LENS2-05, F-LENS2-06, F-LENS2-10).
//
// validateSafeRepoPath(repoRoot, targetPath) returns:
//   { ok: true, resolved }
//   { ok: false, error: 'repoRoot-missing' | 'outFile-escapes-repo' | 'outFile-reserved-name', ... }
//
// Why a shared helper:
//   - F-LENS2-05: wiki.export's guard was the only callsite. wiki.compile,
//     wiki.shareReadme, dream/budget logs all wrote without containment.
//   - F-LENS2-06: the reserved-name regex missed Windows trailing-dot /
//     trailing-space / NTFS-stream variants ("CON ", "CON.", "CON:Stream1")
//     because Windows itself trims those before opening the device.
//   - F-LENS2-10: the previous guard threw if repoRoot didn't exist on disk
//     (realpathSync on a missing dir). Tests sometimes pass a not-yet-created
//     repoRoot — return a structured rejection instead.
//
// The reserved-name check normalises basename via the same trim Windows
// applies: strip trailing dots/whitespace, then drop NTFS alternate-data-
// stream suffix (everything after the first ':'). The tightened character
// class is `com[1-9]|lpt[1-9]` (1-9, not 0-9) per Microsoft's documented set.

import { realpathSync, lstatSync } from 'node:fs';
import {
  resolve as pathResolve,
  relative as pathRelative,
  dirname as pathDirname,
  basename as pathBasename,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
} from 'node:path';

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function validateSafeRepoPath(repoRoot, targetPath) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    return { ok: false, error: 'repoRoot-missing', repoRoot };
  }
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: 'outFile-missing', targetPath };
  }
  let resolvedRoot;
  try {
    resolvedRoot = realpathSync(pathResolve(repoRoot));
  } catch {
    return { ok: false, error: 'repoRoot-missing', repoRoot };
  }
  let resolved = pathResolve(targetPath);
  // Walk UP toward the root to find the closest existing ancestor, realpath
  // THAT, then re-attach the not-yet-created suffix. Why: macOS /tmp is a
  // symlink to /private/tmp; resolvedRoot becomes /private/var/folders/...
  // but pathResolve(targetPath) gives /var/folders/.../ijfw/wiki/... — the
  // bare-lexical containment check would then claim the path "escapes" the
  // repo. Canonicalising the deepest-existing ancestor unmasks the symlink
  // chain symmetrically with resolvedRoot.
  {
    let ancestor = resolved;
    const suffix = [];
    // Bound the walk so a pathological input can't spin: at most 64 levels
    // (far deeper than any realistic project layout).
    for (let i = 0; i < 64; i++) {
      try {
        ancestor = realpathSync(ancestor);
        break;
      } catch {
        const parent = pathDirname(ancestor);
        if (parent === ancestor) break; // reached '/' or drive root
        suffix.unshift(pathBasename(ancestor));
        ancestor = parent;
      }
    }
    resolved = suffix.length ? pathJoin(ancestor, ...suffix) : ancestor;
  }
  const rel = pathRelative(resolvedRoot, resolved);
  if (rel === '' || rel.startsWith('..') || pathIsAbsolute(rel)) {
    return { ok: false, error: 'outFile-escapes-repo', resolved, repoRoot: resolvedRoot };
  }
  // Windows trims trailing dots/whitespace and treats `name:stream` as the
  // bare `name` device. Normalise the basename the same way before checking.
  const baseRaw = pathBasename(resolved);
  const baseTrimmed = baseRaw.replace(/[.\s]+$/, '');
  const stem = baseTrimmed.split(':')[0].split('.')[0];
  if (WIN_RESERVED.test(stem)) {
    return { ok: false, error: 'outFile-reserved-name', resolved };
  }
  // F-LENS2-07: TOCTOU hardening. Even after parent-ancestor canonicalization,
  // an attacker could create the TARGET itself as a symlink between this
  // guard and the writeFileSync. lstatSync (does NOT follow symlinks) catches
  // an existing symlink at the resolved path. Pre-existing regular file is
  // fine — writers either overwrite or 'wx'-fail on their own. The residual
  // TOCTOU window between this check and the writer's open is microseconds
  // and requires a same-uid attacker; documented threat model.
  try {
    const st = lstatSync(resolved);
    if (st.isSymbolicLink()) {
      return { ok: false, error: 'outFile-is-symlink', resolved };
    }
  } catch {
    // ENOENT — target doesn't exist yet; the most common case. OK to proceed.
  }
  return { ok: true, resolved };
}

export default { validateSafeRepoPath };
