/**
 * merge-block-aware.js — v1.5.0 T8: in-process port of the block-aware
 * AGENTS.md merger (formerly `claude/skills/ijfw-agents-md/scripts/
 * merge-block-aware.sh`).
 *
 * RATIONALE — why this lives in mcp-server/src/orchestrator and not in the
 * skill scripts dir:
 *   The shell script was invoked under `withFsLock(.AGENTS.md.lock)` via
 *   `execFile('bash', …)`. Holding an `fs-lock` across a subprocess spawn is a
 *   STATE-SDK-CONTRACT §3 violation:
 *     "No lock is held across a subprocess spawn. `merge-block-aware.sh` is
 *      ported to in-process JS (T8) …"
 *   This module is that port. The shell script remains on disk for parity
 *   testing in this commit; T14 (SDK grep-gate sweep) decides its long-term
 *   fate.
 *
 * SCOPE
 *   - Pure-JS replacement for the byte-stable marker-block replacement that
 *     the shell script did with a here-doc `node -e '…'` payload. Same
 *     marker pattern (`<!-- IJFW-<BLOCK>-START -->` / `…-END -->`), same
 *     append-on-missing-pair fallback, same content-wrapping (`\n…\n`).
 *   - Atomic write via `writeAtomic` (lib/atomic-io.js) — tmp + rename — so
 *     `mergeFile()` can be called inside a `withFsLock` critical section.
 *   - Template seeding (copies AGENTS.md.tmpl when the target is absent).
 *   - Backup retention (last 3 per project-hash under
 *     `~/.ijfw/state/agents-md/backups/<hash>/`), matching shell parity.
 *
 * NON-GOALS
 *   - Frontmatter handling — the shell script delegated to
 *     `hoist-frontmatter.sh`. Marker-block merge ONLY (parity).
 *   - YAML schema validation — owned by the ijfw-agents-md skill's ajv path.
 *   - Multi-tier lock acquisition — callers acquire the §3 #8 AGENTS.md lock
 *     before calling `mergeFile`. This module never holds a lock itself.
 *
 * RESERVED BLOCK NAMES
 *   Matches the shell script verbatim:
 *     MEMORY | ROUTING | AGENTS | BLACKBOARD | FRONTMATTER
 *
 * ESM, Node ≥18, zero new prod deps.
 */

import {
  readFileSync, existsSync, copyFileSync, mkdirSync, statSync, readdirSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { writeAtomic } from '../lib/atomic-io.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The frozen set of block names the merger accepts. Matches the shell
 * script's `is_pair_form` + arg-validation case statements. An unknown block
 * name yields `ERR_BAD_BLOCK` (the same exit-2 the shell script returns).
 */
export const RESERVED_BLOCKS = Object.freeze([
  'MEMORY', 'ROUTING', 'AGENTS', 'BLACKBOARD', 'FRONTMATTER',
]);

const RESERVED_BLOCK_SET = new Set(RESERVED_BLOCKS);

/** Retention cap on backup files per project-hash (shell parity: keep 3). */
const BACKUP_RETAIN = 3;

/**
 * Default template path (relative to this module). Used when `mergeFile` is
 * called without `templatePath` and the target file does not exist.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_TEMPLATE = pathResolve(
  __dirname,
  '..', '..', '..', 'claude', 'skills', 'ijfw-agents-md', 'templates',
  'AGENTS.md.tmpl',
);

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Typed error so callers can distinguish bad-input refusal from an IO error.
 * `code` mirrors the shell script's exit-code semantics:
 *   - 'ERR_BAD_BLOCK'        — block name not in RESERVED_BLOCKS (sh: exit 2)
 *   - 'ERR_TEMPLATE_MISSING' — target absent + no template available (sh: 3)
 *   - 'ERR_BAD_PAYLOAD'      — pairs argument malformed (sh: 2)
 */
export class MergeBlockAwareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MergeBlockAwareError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Core merge — pure string → string. The hot path that the shell script's
// here-doc `node -e '…'` payload performed verbatim. Held under no lock.
// ---------------------------------------------------------------------------

/**
 * Apply each `{block, content}` pair to `src`, producing the new file body.
 *
 * Semantics (verbatim port of merge-block-aware.sh's node here-doc):
 *   - If `<!-- IJFW-<block>-START -->` and `…-END -->` both exist AND the
 *     end-marker appears after the start-marker, replace the bytes BETWEEN
 *     them with `\n<content>\n` (or just `\n` when content is empty/null).
 *     Marker-positioning rules are identical to the shell port: `indexOf`
 *     for both markers, `endIdx > startIdx` to accept.
 *   - Otherwise (markers absent or out of order), APPEND a fresh marker pair
 *     containing the new content to the end of `src`. A leading newline is
 *     inserted if `src` does not already end with one (parity with the
 *     `sep = src.endsWith("\n") ? "" : "\n"` ternary).
 *   - Pairs are applied in order; the result of pair N becomes input to N+1.
 *     (Matches the shell loop `for (let i = 0; i < count; i++) …`.)
 *
 * Pure function: no I/O, no spawn, no locks. Idempotent on the same input.
 *
 * @param {string} src   the current file contents (utf-8)
 * @param {Array<{block: string, content: string}>} pairs
 * @returns {string}     the new file contents
 * @throws {MergeBlockAwareError} on an unknown block name
 */
export function mergeBlocks(src, pairs) {
  if (typeof src !== 'string') {
    throw new MergeBlockAwareError(
      'ERR_BAD_PAYLOAD', `mergeBlocks: src must be a string (got ${typeof src})`,
    );
  }
  if (!Array.isArray(pairs)) {
    throw new MergeBlockAwareError(
      'ERR_BAD_PAYLOAD', 'mergeBlocks: pairs must be an array',
    );
  }
  let out = src;
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') {
      throw new MergeBlockAwareError(
        'ERR_BAD_PAYLOAD', 'mergeBlocks: each pair must be an object',
      );
    }
    const block = pair.block;
    if (typeof block !== 'string' || !RESERVED_BLOCK_SET.has(block)) {
      throw new MergeBlockAwareError(
        'ERR_BAD_BLOCK',
        `mergeBlocks: block name reserved set: ${RESERVED_BLOCKS.join(' ')} (got ${JSON.stringify(block)})`,
      );
    }
    const content = (pair.content === undefined || pair.content === null)
      ? ''
      : String(pair.content);

    const startM = `<!-- IJFW-${block}-START -->`;
    const endM = `<!-- IJFW-${block}-END -->`;
    const startIdx = out.indexOf(startM);
    const endIdx = out.indexOf(endM);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = out.slice(0, startIdx + startM.length);
      const after = out.slice(endIdx);
      const inner = content && content.length ? `\n${content}\n` : '\n';
      out = before + inner + after;
    } else {
      const sep = out.endsWith('\n') ? '' : '\n';
      const inner = content && content.length ? `\n${content}\n` : '\n';
      out = `${out}${sep}\n${startM}${inner}${endM}\n`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backup retention — parity with the shell `node -e '…'` block that the script
// invokes alongside `cp`. Pure, deterministic, swallows io errors (best-effort
// in parity with the shell `2>/dev/null || true`).
// ---------------------------------------------------------------------------

/** sha256(targetDir).slice(0, 12) — matches the shell script's project-hash. */
export function projectHash(targetDir) {
  return createHash('sha256').update(String(targetDir)).digest('hex').slice(0, 12);
}

/**
 * Compute the canonical backup directory for `targetAbsPath`.
 *
 * Shell parity: `~/.ijfw/state/agents-md/backups/<projectHash(targetDir)>/`
 * where `<targetDir>` is the realpath of `dirname(targetAbsPath)` and
 * `<hash>` is sha256 hex (12 chars).
 */
export function backupDirFor(targetAbsPath, opts = {}) {
  const targetDir = dirname(pathResolve(targetAbsPath));
  const home = opts.homeDir || homedir();
  return join(home, '.ijfw', 'state', 'agents-md', 'backups', projectHash(targetDir));
}

/**
 * Take a millisecond-timestamped backup of `targetAbsPath` into the canonical
 * backup directory, then prune older entries past `retain` (newest-first).
 *
 * Mirrors the shell script's `cp` + `node -e '…sort by mtime…'` block. Best-
 * effort: any IO failure is swallowed so a backup hiccup never blocks the
 * merge (the shell script does `2>/dev/null || true`).
 *
 * @param {string} targetAbsPath  absolute path of the target being merged
 * @param {{homeDir?: string, retain?: number, now?: () => number}} [opts]
 * @returns {{taken: boolean, path?: string, pruned: number}}
 */
export function rotateBackups(targetAbsPath, opts = {}) {
  const retain = typeof opts.retain === 'number' ? opts.retain : BACKUP_RETAIN;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  try {
    if (!existsSync(targetAbsPath)) return { taken: false, pruned: 0 };
    const st = statSync(targetAbsPath);
    if (!st || !st.size) return { taken: false, pruned: 0 };
    const dir = backupDirFor(targetAbsPath, opts);
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    const backupName = `AGENTS.md.bak.${String(now())}`;
    const backupPath = join(dir, backupName);
    try { copyFileSync(targetAbsPath, backupPath); } catch { return { taken: false, pruned: 0 }; }

    // Retention — keep newest `retain`, unlink the rest. mtime-sorted to
    // match the shell node payload's `sort((a,b) => b.mt - a.mt)`.
    let pruned = 0;
    try {
      const entries = readdirSync(dir)
        .filter((n) => n.startsWith('AGENTS.md.bak.'))
        .map((n) => {
          try { return { n, mt: statSync(join(dir, n)).mtimeMs }; }
          catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mt - a.mt);
      for (const e of entries.slice(retain)) {
        try { unlinkSync(join(dir, e.n)); pruned += 1; } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }

    return { taken: true, path: backupPath, pruned };
  } catch {
    return { taken: false, pruned: 0 };
  }
}

// ---------------------------------------------------------------------------
// mergeFile — the high-level call. Reads, merges, writes-atomically.
// Held under no lock itself; the caller is expected to wrap it in
// `withFsLock` if concurrent writers are possible. (`agents-md-blackboard.js`
// does exactly that, under the §3 #8 AGENTS.md lock.)
// ---------------------------------------------------------------------------

/**
 * Apply `pairs` to the file at `targetAbsPath` and rewrite atomically.
 *
 * Semantics (verbatim parity with merge-block-aware.sh):
 *   - If the target is absent, seed from `opts.templatePath` (default:
 *     `claude/skills/ijfw-agents-md/templates/AGENTS.md.tmpl` resolved
 *     relative to this module). A missing template throws
 *     ERR_TEMPLATE_MISSING.
 *   - Take a backup + prune older entries (best-effort).
 *   - Apply `mergeBlocks` to the current contents.
 *   - Write atomically via `writeAtomic` (tmp + rename).
 *
 * No subprocess at any point — the shell script's `cp` + `node -e '…'`
 * pipeline is fully expressed in JS here.
 *
 * @param {string} targetAbsPath  absolute path to the merge target
 * @param {Array<{block: string, content: string}>} pairs
 * @param {{
 *   templatePath?: string,
 *   homeDir?: string,
 *   retain?: number,
 *   now?: () => number,
 *   backups?: boolean,
 * }} [opts]
 * @returns {{ ok: true, path: string, bytes: number, backup?: string, seeded: boolean }}
 */
export function mergeFile(targetAbsPath, pairs, opts = {}) {
  if (typeof targetAbsPath !== 'string' || !targetAbsPath) {
    throw new MergeBlockAwareError(
      'ERR_BAD_PAYLOAD', 'mergeFile: targetAbsPath must be a non-empty string',
    );
  }
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new MergeBlockAwareError(
      'ERR_BAD_PAYLOAD', 'mergeFile: pairs must be a non-empty array',
    );
  }
  const abs = pathResolve(targetAbsPath);

  // Seed from template if absent. Shell script behaviour: `cp <template> <target>`
  // on missing target.
  let seeded = false;
  if (!existsSync(abs)) {
    const templatePath = opts.templatePath || DEFAULT_TEMPLATE;
    if (!existsSync(templatePath)) {
      throw new MergeBlockAwareError(
        'ERR_TEMPLATE_MISSING',
        `mergeFile: template missing at ${templatePath}`,
      );
    }
    const dir = dirname(abs);
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    copyFileSync(templatePath, abs);
    seeded = true;
  }

  // Backup + retention (best-effort, defaults on). `opts.backups === false`
  // suppresses (used by some tests to keep tmp clean).
  let backup;
  if (opts.backups !== false) {
    const rot = rotateBackups(abs, opts);
    if (rot.taken && rot.path) backup = rot.path;
  }

  const src = readFileSync(abs, 'utf8');
  const next = mergeBlocks(src, pairs);
  const res = writeAtomic(abs, next, { mode: 0o644, ensureDir: true });
  return {
    ok: true, path: res.path, bytes: res.bytes, backup, seeded,
  };
}

// ---------------------------------------------------------------------------
// Convenience: extract the inner content of a marker block from a string.
// Used by tests + parity checks; not part of the write path.
// ---------------------------------------------------------------------------

/**
 * Extract the inner content of `block` from `src`, exclusive of marker bytes.
 * Returns null when the markers are absent or in the wrong order.
 *
 * @param {string} src
 * @param {string} block  one of RESERVED_BLOCKS
 * @returns {string | null}
 */
export function readBlock(src, block) {
  if (!RESERVED_BLOCK_SET.has(block)) return null;
  const startM = `<!-- IJFW-${block}-START -->`;
  const endM = `<!-- IJFW-${block}-END -->`;
  const s = src.indexOf(startM);
  const e = src.indexOf(endM);
  if (s === -1 || e === -1 || e <= s) return null;
  return src.slice(s + startM.length, e);
}
