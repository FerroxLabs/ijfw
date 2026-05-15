// --- dispatch-planner: decides shared-branch vs worktree-isolated parallelism ---
//
// Parses a plan markdown document, finds sub-wave `Files:` declarations, and
// computes a dispatch manifest: each sub-wave is either SHARED (no file overlap
// with peers in the same wave) or WORKTREE (overlaps -> needs isolation).
//
// Pure + synchronous. ESM. Zero deps. Filesystem only touched by caller.

// eslint-disable-next-line security/detect-unsafe-regex -- plan markdown is bounded human-authored text; pattern is line-anchored and token-sized.
const WAVE_HEADER = /^###\s+Wave\s+([0-9]+[A-Z])(?:-([A-Za-z0-9_+]+))?\b/;
// Bullet sub-wave form: `- **11A-mcp**: description`. Parsed as a child of
// the most recently seen Wave header.
const BULLET_SUB   = /^\s*[-*]\s+\*\*\s*([0-9]+[A-Z])-([A-Za-z0-9_+]+)\s*\*\*\s*:/;
const FILES_LINE  = /^\s*[*-]?\s*\*{0,2}Files:\*{0,2}\s*(.+?)\s*$/i;

// Parse a plan markdown string into an array of sub-waves.
// Shape: [{ wave, sub, files: string[] }]  -- sub is optional.
// Accumulates Files: declarations (later lines append, not overwrite).
export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/);
  const subwaves = [];
  let currentWave = null;
  let currentSub = null;

  const push = (entry) => { if (entry) subwaves.push(entry); };

  for (const line of lines) {
    const h = line.match(WAVE_HEADER);
    if (h) {
      push(currentSub);
      push(currentWave && !currentSub ? currentWave : null);
      const wave = h[1];
      const sub  = h[2] ? `${wave}-${h[2]}` : null;
      currentWave = { wave, sub, files: [] };
      currentSub = sub ? currentWave : null; // header WITH sub acts as its own sub-wave
      if (sub) { currentSub = currentWave; }
      else     { currentSub = null; }
      continue;
    }

    const b = line.match(BULLET_SUB);
    if (b) {
      push(currentSub);
      const wave = b[1];
      currentSub = { wave, sub: `${wave}-${b[2]}`, files: [] };
      continue;
    }

    const target = currentSub || currentWave;
    if (!target) continue;
    const f = line.match(FILES_LINE);
    if (f) {
      const add = f[1]
        .split(/[,\s]+/)
        .map((s) => s.replace(/^`|`$/g, '').trim())
        .filter(Boolean);
      for (const a of add) if (!target.files.includes(a)) target.files.push(a);
    }
  }
  push(currentSub);
  push(currentWave && (!currentSub || currentSub !== currentWave) ? currentWave : null);

  // Deduplicate: if a wave was captured as both parent and sub, prefer the sub entry.
  const seen = new Set();
  const out = [];
  for (const sw of subwaves) {
    const key = `${sw.wave}::${sw.sub || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sw);
  }
  return out;
}

// Compute pairwise file-set overlap within the same wave.
// Returns a map: subId -> string[] of peer subIds it conflicts with.
export function computeOverlaps(subwaves) {
  const byWave = new Map();
  for (const sw of subwaves) {
    if (!byWave.has(sw.wave)) byWave.set(sw.wave, []);
    byWave.get(sw.wave).push(sw);
  }

  const overlaps = new Map();
  for (const group of byWave.values()) {
    for (const sw of group) overlaps.set(idOf(sw), []);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (intersects(a.files, b.files)) {
          overlaps.get(idOf(a)).push(idOf(b));
          overlaps.get(idOf(b)).push(idOf(a));
        }
      }
    }
  }
  return overlaps;
}

// Build the dispatch manifest.
// options: { override: 'all-worktree' | 'all-shared' | null }
// Rules:
//   1. override 'all-worktree' -> every sub-wave WORKTREE.
//   2. override 'all-shared'   -> every sub-wave SHARED (caller took the risk).
//   3. sub-wave missing Files: declaration -> WORKTREE (safe default).
//   4. sub-wave with overlap against peer  -> WORKTREE.
//   5. otherwise SHARED.
export function buildManifest(subwaves, options = {}) {
  const override = options.override || null;
  const overlaps = computeOverlaps(subwaves);

  return subwaves.map((sw) => {
    const id = idOf(sw);
    const peers = overlaps.get(id) || [];
    let mode;
    let reason;

    if (override === 'all-worktree') {
      mode = 'worktree';
      reason = 'override:all-worktree';
    } else if (override === 'all-shared') {
      mode = 'shared';
      reason = 'override:all-shared';
    } else if (sw.files.length === 0) {
      mode = 'worktree';
      reason = 'no-files-declared';
    } else if (peers.length > 0) {
      mode = 'worktree';
      reason = `overlap:${peers.join(',')}`;
    } else {
      mode = 'shared';
      reason = 'disjoint';
    }

    return {
      id,
      wave: sw.wave,
      sub: sw.sub,
      files: sw.files.slice(),
      mode,
      reason,
      overlaps_with: peers.slice(),
    };
  });
}

// One-line human summary for the workflow skill to echo before dispatch.
// Example: "Wave 12A: 3 shared + 2 worktree (overlap: 12A-mcp <-> 12A-cmd)."
export function manifestSummary(manifest) {
  if (manifest.length === 0) return 'Wave: no sub-waves found.';
  const byWave = new Map();
  for (const m of manifest) {
    if (!byWave.has(m.wave)) byWave.set(m.wave, []);
    byWave.get(m.wave).push(m);
  }
  const parts = [];
  for (const [wave, entries] of byWave) {
    const shared   = entries.filter((e) => e.mode === 'shared').length;
    const worktree = entries.filter((e) => e.mode === 'worktree').length;
    const pairs = new Set();
    for (const e of entries) {
      for (const peer of e.overlaps_with) {
        const key = [e.id, peer].sort().join(' <-> ');
        pairs.add(key);
      }
    }
    const tail = pairs.size > 0 ? ` (overlap: ${[...pairs].join('; ')})` : '';
    parts.push(`Wave ${wave}: ${shared} shared + ${worktree} worktree${tail}.`);
  }
  return parts.join(' ');
}

// Topologically ordered merge plan for worktree sub-waves.
// Current convention: merge in the order sub-waves were declared in the plan
// (no explicit `Depends:` declaration yet). Shared sub-waves are skipped since
// they already committed to the parent branch.
export function mergeOrder(manifest) {
  return manifest
    .filter((m) => m.mode === 'worktree')
    .map((m) => m.id);
}

function idOf(sw) { return sw.sub || sw.wave; }

// Glob-aware intersection. Treats `*`/`**` as wildcards so a declaration
// like `claude/commands/*.md` conflicts with `claude/commands/status.md`.
// Returns true on any exact match OR glob-vs-literal match.
function intersects(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (globsOverlap(x, y)) return true;
    }
  }
  return false;
}

function globsOverlap(x, y) {
  const xIsGlob = hasGlob(x);
  const yIsGlob = hasGlob(y);
  if (!xIsGlob && !yIsGlob) return false;
  if (xIsGlob && matchesGlob(y, x)) return true;
  if (yIsGlob && matchesGlob(x, y)) return true;
  if (xIsGlob && yIsGlob) return globsCouldOverlap(x, y);
  return false;
}

function hasGlob(s) { return /[*?]/.test(s); }

function matchesGlob(literal, glob) {
  const re = new RegExp('^' + globToRegex(glob) + '$');
  return re.test(literal);
}

// Approximate: two globs overlap if one's non-wildcard prefix is a prefix
// of the other's. Accurate enough for file-cluster declarations.
function globsCouldOverlap(a, b) {
  const ap = a.split(/[*?]/)[0];
  const bp = b.split(/[*?]/)[0];
  return ap.startsWith(bp) || bp.startsWith(ap);
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; }
      else                     { out += '[^/]*'; }
    } else if (c === '?') out += '[^/]';
    else if ('.+^$|()[]{}\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}
