// IJFW v1.3.0 Alpha -- A3 project-type detection (Phase 3).
//
// Goal: classify a project as software / book / content / business / design /
// mixed / unknown. Result lands in <project>/.ijfw/project.type so downstream
// surfaces (ijfw-team, ijfw-workflow think-phase, AGENTS.md frontmatter via
// the P2-B2 hoist) can read it without re-scanning.
//
// V3 invariants honoured here:
//   - V3-F2 cross-session checkpoint+resume via scan-resume.js (24h staleness
//     + 3-attempt cap)
//   - V3-F3 cold-scan async -- detect() can run with options.bg = true and
//     return immediately while a child completes the work (the colon-syntax
//     dispatcher honours --bg by spawning detect() as a detached child)
//   - V3-F4 multi-type result shape -- primary_type + secondary_types[] from
//     day one so Pillar B blackboard consumers don't have to re-shape
//   - V3 dependency-flip fix -- when C9 / FTS5 is unavailable A3 must NOT
//     halt. Falls back to the file-extension scan only, confidence capped at
//     0.7, fallback_reason: 'c9_unavailable'
//   - File-tree hash + branch hash drive cache invalidation, NOT root mtime
//     (which is unreliable as a stale-classification signal per V3 fix)
//
// Public surface:
//   detect(projectRoot, options)            -- main entry; returns full result
//   loadProjectType(projectRoot)            -- read cached .ijfw/project.type
//   writeProjectType(projectRoot, result)   -- atomic write to project.type
//
// Discipline:
//   - ESM only.
//   - ASCII only in strings (no smart quotes, no emojis).
//   - Positive framing in any user-visible text -- this module emits machine
//     JSON, not user copy, so the rule is "no negative-framed reasons" rather
//     than "no errors at all".

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  realpathSync,
  copyFileSync,
} from 'fs';
import { join, extname, isAbsolute, resolve as pathResolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import {
  loadScanState,
  writeScanState,
  shouldResume,
  clearScanState,
  acquireScanLock,
} from './scan-resume.js';
import { shouldSeedProject } from './brain/seed-gate.js';
import { isBundleInternalDeep } from './lib/project-root-guard.js';

// --- Tunables --------------------------------------------------------------

const DOMAINS = ['software', 'book', 'content', 'business', 'design', 'mixed', 'unknown'];

// Hard guardrails. A 100k-file repo is the design target; we cap the walk
// well above that, and yield checkpoint state every CHECKPOINT_EVERY files
// so a crash never loses more than that slice of progress.
const MAX_FILES = 200000;
const MAX_DEPTH = 12;
const CHECKPOINT_EVERY = 500;
// P3-M3: time-budget guardrail. The walker checks Date.now() every
// TIME_BUDGET_CHECK_EVERY entries; if elapsed > timeBudgetMs the walk
// halts with scan_incomplete=true and persists state so the next session
// resumes. Default 5000ms; overridable via IJFW_DETECT_TIME_BUDGET_MS.
const DEFAULT_TIME_BUDGET_MS = 5000;
const TIME_BUDGET_CHECK_EVERY = 1000;

// Directories we never walk into. Cuts node_modules / venv noise without
// changing the signal balance for any of the 7 domains.
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.ijfw', '.planning', '.cache',
  'node_modules', 'dist', 'build', 'out', 'target', '.next',
  '__pycache__', '.venv', 'venv', 'env',
  '.pytest_cache', '.mypy_cache', '.tox',
  '.gradle', '.idea', '.vscode',
  'vendor', 'bower_components',
]);

// File-extension classifier. Each match contributes weight to the matching
// domain bucket; ratios then drive the per-domain confidence score. "code"
// is split across software (heavy) and content/business (light) because a
// content site can carry a build script without becoming "software".
const EXT_DOMAIN = {
  // software (heavy)
  '.js': 'software', '.jsx': 'software', '.ts': 'software', '.tsx': 'software',
  '.mjs': 'software', '.cjs': 'software',
  '.py': 'software', '.rs': 'software', '.go': 'software',
  '.java': 'software', '.kt': 'software', '.scala': 'software',
  '.rb': 'software', '.php': 'software',
  '.c': 'software', '.cc': 'software', '.cpp': 'software', '.h': 'software',
  '.hpp': 'software', '.hh': 'software',
  '.swift': 'software', '.m': 'software', '.mm': 'software',
  '.cs': 'software', '.fs': 'software',
  '.lua': 'software', '.dart': 'software', '.zig': 'software',
  // book / long-form prose
  '.tex': 'book', '.bib': 'book', '.latex': 'book',
  '.epub': 'book', '.mobi': 'book',
  // content / blog / docs / marketing
  '.mdx': 'content', '.markdown': 'content', '.rst': 'content',
  // design / assets
  '.fig': 'design', '.sketch': 'design', '.xd': 'design',
  '.ai': 'design', '.psd': 'design', '.indd': 'design',
  '.svg': 'design', '.afdesign': 'design', '.afphoto': 'design',
  // business / ops
  '.xlsx': 'business', '.xls': 'business', '.csv': 'business',
  '.numbers': 'business', '.ods': 'business',
  '.pptx': 'business', '.ppt': 'business', '.key': 'business',
  '.docx': 'business', '.doc': 'business',
};

// Manifest signals. Presence at any depth <= 2 is a strong vote for software.
const SOFTWARE_MANIFESTS = [
  'package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'Gemfile',
  'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Package.swift', 'mix.exs', 'rebar.config',
  'pubspec.yaml', 'CMakeLists.txt', 'Makefile',
];

// Directory-name signals. These count when they exist near the root.
const BOOK_DIRS = ['manuscripts', 'manuscript', 'drafts', 'draft', 'chapters', 'book'];
const CONTENT_DIRS = ['content', 'posts', 'articles', 'blog', 'newsletter', 'social'];
const BUSINESS_DIRS = ['strategy', 'financials', 'finance', 'ops', 'runbooks', 'sop', 'sops', 'ops-runbooks'];
const DESIGN_DIRS = ['designs', 'design', 'assets', 'mockups', 'wireframes', 'figma'];

// Filename patterns that boost a domain (regex tested against basename).
const FILENAME_PATTERNS = [
  { re: /^chapter[-_]?\d+/i, domain: 'book', weight: 0.4 },
  { re: /^ch\d+/i,            domain: 'book', weight: 0.3 },
  { re: /^brand[-_]voice/i,   domain: 'content', weight: 0.4 },
  { re: /^seo[-_]/i,          domain: 'content', weight: 0.2 },
  { re: /^post[-_]/i,         domain: 'content', weight: 0.2 },
  { re: /^figma[-_]export/i,  domain: 'design', weight: 0.4 },
  { re: /^wireframe/i,        domain: 'design', weight: 0.3 },
];

// --- Public API ------------------------------------------------------------

/**
 * detect(projectRoot, options) -> result
 *
 * Walks projectRoot honouring SKIP_DIRS, MAX_DEPTH, MAX_FILES. Reads existing
 * AGENTS.md frontmatter + .ijfw/memory/brief.md frontmatter for higher-trust
 * signals. Returns a multi-type result shape (V3-F4):
 *
 *   {
 *     primary_type, secondary_types: [], confidence,
 *     scan_incomplete, detected_at, signals: [...],
 *     fallback_reason: null | 'c9_unavailable',
 *     type,                  // legacy "single label" alias = primary_type
 *     file_tree_hash,        // for cache invalidation
 *     branch_hash            // for cache invalidation
 *   }
 *
 * options:
 *   - explicitType   string  signal #1 (1.0 confidence)
 *   - c9Available    bool    when false, file-tree confidence caps at 0.7
 *   - maxFiles       number  override walk cap (tests use small caps)
 *   - sessionId      string  threaded into scan-state for forensics
 *   - resume         bool    honour scan-resume; default true
 */
export function detect(projectRoot, options = {}) {
  const root = String(projectRoot || process.cwd());
  // issue #26: detect()'s ONLY on-disk side effect is scan-state checkpointing
  // (writeScanState/acquireScanLock on an incomplete walk). That is exactly the
  // ".ijfw litter in a non-project dir" the seed gate exists to prevent, and it
  // fired even when the caller gated only the project.type cache (the colon
  // detect:project_type sync path) or didn't gate at all (domain-manifest,
  // gate-result). Gate persistence here so every detect() caller is covered at
  // once: detection still RETURNS its result in any dir; only the disk
  // checkpoint is suppressed outside a real, non-bundle project.
  const mayPersistScanState = shouldSeedProject(root) && !isBundleInternalDeep(root);
  // P3-M2: when the caller doesn't pass c9Available explicitly, run a
  // sync availability probe (existsSync of compute/fts5.js) so the
  // confidence cap auto-engages on installs that ship without the C9
  // backend. Cached for the session lifetime.
  const c9Available = options.c9Available === false
    ? false
    : (options.c9Available === true ? true : isC9AvailableSync());
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0
    ? options.maxFiles
    : MAX_FILES;

  const signals = [];
  const fallbackReason = c9Available ? null : 'c9_unavailable';

  // --- Signal #1: explicit user declaration (1.0) -------------------------
  if (options.explicitType && DOMAINS.includes(String(options.explicitType))) {
    signals.push({ kind: 'user_declaration', weight: 1.0, value: options.explicitType });
    return finalize({
      primary: options.explicitType,
      secondary: [],
      score: 1.0,
      signals,
      scanIncomplete: false,
      fallbackReason,
      treeHash: '',
      branchHash: branchHash(root),
    });
  }

  // --- Signal #2: AGENTS.md frontmatter (0.9) -----------------------------
  const fmAgents = readFrontmatterType(join(root, 'AGENTS.md'));
  if (fmAgents && DOMAINS.includes(fmAgents)) {
    signals.push({ kind: 'agents_md_frontmatter', weight: 0.9, value: fmAgents });
  }

  // --- Signal #3: brief.md frontmatter (0.8) ------------------------------
  const fmBrief = readFrontmatterType(join(root, '.ijfw', 'memory', 'brief.md'));
  if (fmBrief && DOMAINS.includes(fmBrief)) {
    signals.push({ kind: 'brief_md_frontmatter', weight: 0.8, value: fmBrief });
  }

  // --- Signal #4: file-tree walk (0.6 - 0.75 raw; capped 0.7 in fallback) -
  const timeBudgetMs = resolveTimeBudgetMs(options);
  const walk = walkProject(root, { maxFiles, maxDepth: MAX_DEPTH, options, timeBudgetMs, mayPersist: mayPersistScanState });
  const treeHash = fileTreeHash(walk.fingerprint);

  // Manifest votes -- presence is a strong software signal.
  if (walk.manifestsFound.length > 0) {
    signals.push({
      kind: 'manifest',
      weight: 0.9,
      manifests: walk.manifestsFound.slice(0, 6),
    });
  }

  // Directory-name votes.
  for (const d of walk.dirHits.book) signals.push({ kind: 'dir_book', weight: 0.4, name: d });
  for (const d of walk.dirHits.content) signals.push({ kind: 'dir_content', weight: 0.4, name: d });
  for (const d of walk.dirHits.business) signals.push({ kind: 'dir_business', weight: 0.4, name: d });
  for (const d of walk.dirHits.design) signals.push({ kind: 'dir_design', weight: 0.4, name: d });

  // File-extension ratio -- the workhorse fallback signal.
  const totals = walk.extTotals;
  const totalClassified = Object.values(totals).reduce((a, b) => a + b, 0);
  if (totalClassified > 0) {
    for (const [domain, count] of Object.entries(totals)) {
      const ratio = count / totalClassified;
      if (ratio >= 0.05) {
        signals.push({
          kind: 'file_extension_ratio',
          weight: 0.7,
          domain,
          ratio: Number(ratio.toFixed(3)),
          count,
        });
      }
    }
  }

  // Filename pattern boosts.
  for (const hit of walk.patternHits) {
    signals.push({ kind: 'filename_pattern', weight: hit.weight, domain: hit.domain, name: hit.name });
  }

  // --- Score reconciliation ----------------------------------------------
  const scoreboard = scoreSignals(signals);
  const ranked = rankDomains(scoreboard);

  let primary;
  let secondary = [];
  let confidence;

  if (ranked.length === 0) {
    primary = 'unknown';
    confidence = 0;
  } else {
    primary = ranked[0].domain;
    confidence = ranked[0].score;
    secondary = ranked
      .slice(1)
      .filter((r) => r.score >= 0.4 && r.domain !== primary)
      .map((r) => r.domain);
    // Two distinct strong domains -> "mixed" surfaces as primary, with the
    // two top contributors as secondary so consumers retain the detail.
    // Threshold: top score >= 0.55, second score >= 0.5, AND second is
    // within 25% of top. The third clause keeps a clearly-dominant primary
    // out of mixed (e.g. a software repo with light docs stays "software").
    if (
      ranked.length >= 2 &&
      ranked[0].score >= 0.55 &&
      ranked[1].score >= 0.5 &&
      ranked[1].score / ranked[0].score >= 0.75
    ) {
      const topTwo = [ranked[0].domain, ranked[1].domain];
      secondary = topTwo;
      primary = 'mixed';
      confidence = Math.min(0.85, (ranked[0].score + ranked[1].score) / 2);
    }
  }

  // V3 fallback cap: when C9 is unavailable, file-tree-only confidence caps
  // at 0.7 so downstream consumers see "ask the user" territory. High-trust
  // signals (user declaration, frontmatter) bypass the cap.
  const highTrust = signals.some(
    (s) =>
      s.kind === 'user_declaration' ||
      s.kind === 'agents_md_frontmatter' ||
      s.kind === 'brief_md_frontmatter',
  );
  if (!c9Available && !highTrust && confidence > 0.7) confidence = 0.7;

  // scan_incomplete flag -- if the walker tripped a guardrail, downstream
  // surfaces should prompt the user rather than silently trust the result.
  const scanIncomplete = walk.incomplete;

  // Persist scan state on incomplete walks so the next session can resume.
  // P3-H3: persist accumulated partial state so resume continues to add to
  // counters/lists rather than restarting at zero. P3-M6: acquire the
  // scan-state lock so two concurrent detect() calls never RMW the
  // attempts counter unsafely. If the lock is held by another live
  // writer, skip the persist -- their write covers the same forward
  // progress just as accurately.
  if (scanIncomplete && mayPersistScanState) {
    const lock = acquireScanLock(root);
    if (lock) {
      try {
        const prior = loadScanState(root) || {};
        writeScanState(root, {
          scan_id: prior.scan_id || newScanId(),
          started_at: prior.started_at || new Date().toISOString(),
          last_path_walked: walk.lastPathWalked,
          files_scanned: walk.filesScanned,
          total_estimate: walk.totalEstimate,
          attempts: (prior.attempts || 0) + 1,
          incomplete: true,
          session_id: options.sessionId || null,
          partial: snapshotPartial(walk),
        });
      } catch { /* best-effort; never throw from detect() */ }
      finally { lock.released(); }
    }
  } else {
    try { clearScanState(root); } catch { /* best-effort */ }
  }

  return finalize({
    primary,
    secondary,
    score: confidence,
    signals,
    scanIncomplete,
    fallbackReason,
    treeHash,
    branchHash: branchHash(root),
  });
}

/**
 * loadProjectType(projectRoot) -> object | null
 *
 * Reads <project>/.ijfw/project.type if present and parseable. P3-H2:
 * recomputes the cheap-tier hashes (top-level path sample + branch hash)
 * and compares to the cached values; mismatch returns null so the caller
 * forces a re-detect. P3-M1: a cached scan_incomplete=true result is
 * surfaced for debugging via the file but loadProjectType returns null
 * so consumers don't silently trust a partial walk.
 */
export function loadProjectType(projectRoot) {
  const root = String(projectRoot);
  const path = join(root, '.ijfw', 'project.type');
  if (!existsSync(path)) return null;
  let parsed = null;
  try {
    const raw = readFileSync(path, 'utf8');
    parsed = JSON.parse(raw);
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  // P3-M1: incomplete walks are kept on disk for forensic inspection but
  // never returned to consumers as a fresh result.
  if (parsed.scan_incomplete === true) return null;

  // P3-H2: cheap-tier cache invalidation. File-tree fingerprint is the
  // first 4096 entries of a sorted relative-path walk -- bounded, fast,
  // exactly the input fileTreeHash() consumed when the cache was written.
  // Branch hash is the .git/HEAD content (or worktree pointer per P3-M5).
  try {
    if (typeof parsed.file_tree_hash === 'string' && parsed.file_tree_hash.length > 0) {
      const liveTree = cheapTreeHash(root);
      if (liveTree && liveTree !== parsed.file_tree_hash) return null;
    }
    if (typeof parsed.branch_hash === 'string' && parsed.branch_hash.length > 0) {
      const liveBranch = branchHash(root);
      if (liveBranch && liveBranch !== parsed.branch_hash) return null;
    }
  } catch { /* invalidation is best-effort; on error trust the cache */ }

  return parsed;
}

/**
 * writeProjectType(projectRoot, result) -> string (path)
 *
 * Atomic tmp + rename. Creates .ijfw/ if missing. POSIX rename(2) is atomic
 * on the same filesystem, so a kill mid-write leaves the prior file intact.
 * P3-H5: cross-mount symlink layouts (.ijfw/ pointing to a different fs)
 * raise EXDEV from rename; we fall back to copyFile + unlink so dotfile
 * setups still get a durable write.
 */
export function writeProjectType(projectRoot, result) {
  const root = String(projectRoot);
  const dir = join(root, '.ijfw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, 'project.type');
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(result, null, 2) + '\n';
  writeFileSync(tmpPath, json, 'utf8');
  atomicRename(tmpPath, finalPath);
  return finalPath;
}

// P3-H5: shared rename-with-EXDEV-fallback helper. Same behaviour as
// renameSync on a same-fs target, falls back to copy+unlink on EXDEV.
function atomicRename(tmpPath, finalPath) {
  try {
    renameSync(tmpPath, finalPath);
    return;
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
  }
  try {
    copyFileSync(tmpPath, finalPath);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

// --- Internals -------------------------------------------------------------

function finalize({ primary, secondary, score, signals, scanIncomplete, fallbackReason, treeHash, branchHash: bh }) {
  const confidence = Number(Math.max(0, Math.min(1, score)).toFixed(3));
  const out = {
    type: primary,                              // single-label alias for hoist
    primary_type: primary,
    secondary_types: Array.isArray(secondary) ? secondary : [],
    confidence,
    scan_incomplete: !!scanIncomplete,
    detected_at: new Date().toISOString(),
    signals,
    fallback_reason: fallbackReason,
    file_tree_hash: treeHash || '',
    branch_hash: bh || '',
  };
  return out;
}

function readFrontmatterType(path) {
  if (!existsSync(path)) return null;
  let src;
  try { src = readFileSync(path, 'utf8'); } catch { return null; }
  if (!src.startsWith('---\n')) return null;
  const after = src.slice(4);
  const closeIdx = after.search(/\n---\s*(?:\r?\n|$)/);
  if (closeIdx < 0) return null;
  const fm = after.slice(0, closeIdx);
  for (const ln of fm.split(/\r?\n/)) {
    const m = ln.match(/^type\s*:\s*(\S+)\s*$/);
    if (m) {
      const v = m[1].replace(/^["']|["']$/g, '');
      return v;
    }
  }
  return null;
}

function walkProject(root, { maxFiles, maxDepth, options, timeBudgetMs, mayPersist = true }) {
  const out = {
    filesScanned: 0,
    totalEstimate: 0,
    incomplete: false,
    lastPathWalked: '',
    fingerprint: [],
    manifestsFound: [],
    dirHits: { book: [], content: [], business: [], design: [] },
    extTotals: {},
    patternHits: [],
  };

  // P3-H3: resume merges accumulated state. shouldResume() gates on
  // incomplete + young + under attempt cap; if the prior state has a
  // sentinel that is no longer reachable, the walk simply never sees it
  // and produces a fresh full pass (the "restart from scratch" branch).
  let resumeFrom = null;
  let priorState = null;
  if (options.resume !== false) {
    const state = loadScanState(root);
    if (state && shouldResume(state)) {
      resumeFrom = state.last_path_walked || null;
      priorState = state;
    }
  }
  // Hydrate accumulated counters/lists from the prior partial scan so the
  // resumed walk continues to add to them rather than starting at zero.
  if (priorState && priorState.partial && typeof priorState.partial === 'object') {
    const p = priorState.partial;
    out.filesScanned = Number.isFinite(p.files_scanned) ? p.files_scanned : 0;
    out.totalEstimate = Number.isFinite(p.total_estimate) ? p.total_estimate : out.filesScanned;
    if (Array.isArray(p.fingerprint)) out.fingerprint = p.fingerprint.slice(0, 4096);
    if (Array.isArray(p.manifestsFound)) out.manifestsFound = p.manifestsFound.slice();
    if (p.dirHits && typeof p.dirHits === 'object') {
      for (const k of ['book', 'content', 'business', 'design']) {
        if (Array.isArray(p.dirHits[k])) out.dirHits[k] = p.dirHits[k].slice();
      }
    }
    if (p.extTotals && typeof p.extTotals === 'object') out.extTotals = { ...p.extTotals };
    if (Array.isArray(p.patternHits)) out.patternHits = p.patternHits.slice();
  }
  let resumed = !resumeFrom;

  // P3-M4: track visited real-paths so circular symlinks never loop.
  const visitedDirs = new Set();
  try {
    visitedDirs.add(realpathSync.native(root));
  } catch { /* root may not resolve in odd test setups; tolerate */ }

  // P3-M3: time-budget guardrail.
  const startedAt = Date.now();
  const budget = Number.isFinite(timeBudgetMs) && timeBudgetMs > 0 ? timeBudgetMs : DEFAULT_TIME_BUDGET_MS;
  let entriesSinceTimeCheck = 0;

  // Iterative DFS so we don't blow the stack on deep trees.
  const stack = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const { path, depth } = stack.pop();
    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch { continue; }

    // Sort for deterministic walks -- same inputs produce identical
    // file_tree_hash + same lastPathWalked checkpoint sequence.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const childPath = join(path, entry.name);

      if (!resumed) {
        if (childPath === resumeFrom) resumed = true;
        // Skip ahead until we reach the resume sentinel; record the entry so
        // we keep producing identical fingerprints across resumes.
        continue;
      }

      out.lastPathWalked = childPath;

      // P3-M3: poll the wall clock periodically. Every TIME_BUDGET_CHECK_EVERY
      // entries we compare elapsed to budget; on overrun we mark incomplete
      // and return. Persisting state happens up in detect().
      entriesSinceTimeCheck += 1;
      if (entriesSinceTimeCheck >= TIME_BUDGET_CHECK_EVERY) {
        entriesSinceTimeCheck = 0;
        if (Date.now() - startedAt > budget) {
          out.incomplete = true;
          return out;
        }
      }

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // P3-M4: skip directories whose real-path we've already visited.
        try {
          const real = realpathSync.native(childPath);
          if (visitedDirs.has(real)) continue;
          visitedDirs.add(real);
        } catch { /* unreadable; let the readdir error path handle it */ }
        recordDirHit(out, entry.name, depth);
        stack.push({ path: childPath, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;

      out.filesScanned += 1;
      out.totalEstimate = Math.max(out.totalEstimate, out.filesScanned);

      // Fingerprint: cheap sample to keep the hash stable but cap memory.
      // We keep the relative path only -- mtime is intentionally excluded.
      if (out.fingerprint.length < 4096) {
        out.fingerprint.push(childPath.slice(root.length + 1));
      }

      // Manifest detection (depth <= 2).
      if (depth <= 2 && SOFTWARE_MANIFESTS.includes(entry.name)) {
        out.manifestsFound.push(entry.name);
      }

      // Filename pattern.
      for (const p of FILENAME_PATTERNS) {
        if (p.re.test(entry.name)) {
          out.patternHits.push({ name: entry.name, domain: p.domain, weight: p.weight });
          break;
        }
      }

      // Extension classifier.
      const ext = extname(entry.name).toLowerCase();
      const dom = EXT_DOMAIN[ext];
      if (dom) {
        out.extTotals[dom] = (out.extTotals[dom] || 0) + 1;
      }

      // Periodic checkpoint write so a crash never loses more than
      // CHECKPOINT_EVERY files of progress. P3-H3: persist accumulated
      // partial state so the resumed walk can keep adding to it.
      // issue #26: suppressed outside a real project (no .ijfw litter).
      if (mayPersist && out.filesScanned % CHECKPOINT_EVERY === 0) {
        try {
          writeScanState(root, {
            scan_id: newScanId(),
            started_at: new Date().toISOString(),
            last_path_walked: childPath,
            files_scanned: out.filesScanned,
            total_estimate: out.totalEstimate,
            attempts: 1,
            incomplete: true,
            partial: snapshotPartial(out),
          });
        } catch { /* best-effort */ }
      }

      if (out.filesScanned >= maxFiles) {
        out.incomplete = true;
        return out;
      }
    }
  }
  return out;
}

function snapshotPartial(out) {
  // Compact serialisable view of the accumulated walk state. Keeps the
  // checkpoint readable without bloating scan-state.json.
  return {
    files_scanned: out.filesScanned,
    total_estimate: out.totalEstimate,
    fingerprint: out.fingerprint.slice(0, 4096),
    manifestsFound: out.manifestsFound.slice(0, 32),
    dirHits: {
      book: out.dirHits.book.slice(0, 32),
      content: out.dirHits.content.slice(0, 32),
      business: out.dirHits.business.slice(0, 32),
      design: out.dirHits.design.slice(0, 32),
    },
    extTotals: { ...out.extTotals },
    patternHits: out.patternHits.slice(0, 64),
  };
}

function resolveTimeBudgetMs(options) {
  if (Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs > 0) {
    return options.timeBudgetMs;
  }
  const env = process.env.IJFW_DETECT_TIME_BUDGET_MS;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIME_BUDGET_MS;
}

function recordDirHit(out, name, depth) {
  // Dir hits only count near the root; deeper hits add noise without
  // shifting domain confidence reliably.
  if (depth > 2) return;
  const lower = name.toLowerCase();
  if (BOOK_DIRS.includes(lower)) out.dirHits.book.push(lower);
  if (CONTENT_DIRS.includes(lower)) out.dirHits.content.push(lower);
  if (BUSINESS_DIRS.includes(lower)) out.dirHits.business.push(lower);
  if (DESIGN_DIRS.includes(lower)) out.dirHits.design.push(lower);
}

function scoreSignals(signals) {
  const board = {
    software: 0, book: 0, content: 0, business: 0, design: 0, mixed: 0, unknown: 0,
  };
  // Per-domain cap on cumulative filename_pattern contribution. Without
  // this, a book with 8 "chapter-NN" files dominates over a same-sized
  // companion code tree even when the user clearly authored both. Cap at
  // 0.8 -- one or two pattern hits is the signal; more is repetition.
  const patternBudget = { software: 0.8, book: 0.8, content: 0.8, business: 0.8, design: 0.8, mixed: 0.8, unknown: 0.8 };
  // Cap on cumulative dir-name contribution per domain. A repo with both
  // 'book' and 'manuscripts' shouldn't double-count; cap mirrors a single
  // hit.
  const dirBudget = { software: 0.6, book: 0.6, content: 0.6, business: 0.6, design: 0.6, mixed: 0.6, unknown: 0.6 };
  for (const s of signals) {
    if (s.kind === 'user_declaration' && s.value) board[s.value] += 1.0;
    else if (s.kind === 'agents_md_frontmatter' && s.value) board[s.value] += 0.9;
    else if (s.kind === 'brief_md_frontmatter' && s.value) board[s.value] += 0.8;
    else if (s.kind === 'manifest') board.software += 0.9;
    else if (s.kind === 'dir_book') {
      const add = Math.min(0.4, dirBudget.book);
      board.book += add; dirBudget.book -= add;
    } else if (s.kind === 'dir_content') {
      const add = Math.min(0.4, dirBudget.content);
      board.content += add; dirBudget.content -= add;
    } else if (s.kind === 'dir_business') {
      const add = Math.min(0.4, dirBudget.business);
      board.business += add; dirBudget.business -= add;
    } else if (s.kind === 'dir_design') {
      const add = Math.min(0.4, dirBudget.design);
      board.design += add; dirBudget.design -= add;
    } else if (s.kind === 'file_extension_ratio') {
      // Ratio acts as a multiplier so a 0.78 software-extension share lands
      // near the manifest weight without dwarfing it.
      const m = s.ratio || 0;
      board[s.domain] = (board[s.domain] || 0) + 0.7 * m;
    } else if (s.kind === 'filename_pattern') {
      const add = Math.min(s.weight, patternBudget[s.domain] || 0);
      if (add > 0) {
        board[s.domain] = (board[s.domain] || 0) + add;
        patternBudget[s.domain] -= add;
      }
    }
  }
  return board;
}

function rankDomains(board) {
  const arr = Object.entries(board)
    .filter(([d]) => d !== 'mixed' && d !== 'unknown')
    .map(([domain, raw]) => ({ domain, raw }));
  if (arr.length === 0) return [];

  // Normalize: divide each raw by the max so the top score lands at 1.0
  // and others scale relative to it. Confidence is then re-anchored against
  // a logistic-ish curve so a single weak signal doesn't accidentally read
  // as 1.0 confidence.
  const maxRaw = arr.reduce((m, e) => Math.max(m, e.raw), 0);
  if (maxRaw <= 0) return [];
  for (const e of arr) {
    e.score = anchor(e.raw, maxRaw);
  }
  arr.sort((a, b) => b.score - a.score);
  return arr;
}

function anchor(raw, maxRaw) {
  // Top score reflects raw magnitude (capped at 0.95); others scale linearly.
  // A raw of 1.0+ from manifest or strong frontmatter lands near 0.9+. A
  // raw of 0.4 lands around 0.55.
  if (raw <= 0) return 0;
  const top = Math.min(0.95, 0.4 + 0.55 * Math.tanh(raw));
  return Number((top * (raw / maxRaw)).toFixed(3));
}

function fileTreeHash(paths) {
  if (!paths || paths.length === 0) return '';
  const h = createHash('sha256');
  for (const p of paths) h.update(p + '\n');
  return h.digest('hex').slice(0, 16);
}

function branchHash(root) {
  // Best-effort git branch read. Falls back to the empty string when git is
  // unavailable or the project is not a git repo -- consumers treat empty
  // as "no branch signal", not an error. P3-M5: worktrees use a `.git`
  // file that contains a `gitdir: <path>` pointer to the actual git dir;
  // resolve through it so HEAD reads succeed in worktrees.
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return '';

    let headPath = null;
    let st;
    try { st = statSync(dotGit); } catch { return ''; }

    if (st.isDirectory()) {
      headPath = join(dotGit, 'HEAD');
    } else if (st.isFile()) {
      const ptr = readFileSync(dotGit, 'utf8');
      const m = ptr.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return '';
      const target = m[1];
      const gitDir = isAbsolute(target) ? target : pathResolve(root, target);
      headPath = join(gitDir, 'HEAD');
    } else {
      return '';
    }

    if (!headPath || !existsSync(headPath)) return '';
    const head = readFileSync(headPath, 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    const branch = m ? m[1] : head;
    return createHash('sha256').update(branch).digest('hex').slice(0, 16);
  } catch { /* best-effort */ }
  return '';
}

// Cheap-tier file-tree hash for cache invalidation (P3-H2). Mirrors the
// input that fileTreeHash() consumed when the result was first written:
// up to 4096 sorted relative paths from a breadth-bounded walk.
function cheapTreeHash(root) {
  const collected = [];
  const limit = 4096;
  // Iterative DFS bounded by the same MAX_DEPTH + SKIP_DIRS as the full
  // walker so results are byte-identical to the original write.
  const stack = [{ path: root, depth: 0 }];
  while (stack.length > 0 && collected.length < limit) {
    const { path, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push({ path: childPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      collected.push(childPath.slice(root.length + 1));
      if (collected.length >= limit) break;
    }
  }
  return fileTreeHash(collected);
}

// P3-M2: lightweight C9 availability probe. The detector defaults to
// c9Available=true, but a missing FTS5 backend should auto-flip the flag
// so the caller doesn't silently get an unfiltered confidence score.
// Cached for the session's lifetime -- the probe is best-effort and the
// answer doesn't change once a process is running.
let _c9AvailableCache = null;
export async function isC9Available() {
  if (_c9AvailableCache !== null) return _c9AvailableCache;
  try {
    await import('./compute/fts5.js');
    _c9AvailableCache = true;
  } catch {
    _c9AvailableCache = false;
  }
  return _c9AvailableCache;
}

// Sync sibling for the synchronous detect() entrypoint -- existsSync of
// the compute/fts5.js module is a cheap proxy that matches the dynamic
// import outcome on every install layout we ship.
function isC9AvailableSync() {
  if (_c9AvailableCache !== null) return _c9AvailableCache;
  try {
    const here = fileURLToPath(import.meta.url);
    const fts5Path = join(dirname(here), 'compute', 'fts5.js');
    _c9AvailableCache = existsSync(fts5Path);
  } catch {
    _c9AvailableCache = false;
  }
  return _c9AvailableCache;
}

function newScanId() {
  return createHash('sha256')
    .update(String(process.pid) + ':' + String(Date.now()) + ':' + Math.random())
    .digest('hex')
    .slice(0, 12);
}

// Test-only export surface.
export const __test = {
  scoreSignals,
  rankDomains,
  readFrontmatterType,
  walkProject,
  fileTreeHash,
  EXT_DOMAIN,
  SKIP_DIRS,
};
