// v1.5.0 audit-MED-tok-M1 — Repo-map / brief-compaction for subagent dispatch.
//
// Problem: subagent briefs that "dump the source" currently consume 5-10x
// more input tokens than necessary. The orchestrator does not know which
// files matter to a given task, so it conservatively includes everything.
//
// Solution (Aider-style, simplified): walk the repo, score each file with
// TF-IDF on its symbols + path, and emit a compact map that fits in a fixed
// token budget (default 1k tokens). The brief gets prepended with this map
// so a downstream subagent can read it instead of crawling the tree.
//
// Design choices:
//   - Zero deps (no tree-sitter, no fs-walk libs). The IJFW project rule is
//     pure-Node. Symbol extraction is a regex pass (good enough for JS/TS/
//     Python/Go signatures + markdown headings). PageRank is approximated
//     with TF-IDF importance ranking — cheap, deterministic, and stable
//     across runs.
//   - Respects .gitignore via a simple parse (no glob library). The parse
//     handles the common patterns: line comments, blank lines, leading "!"
//     negations, trailing "/" directory markers, and "*" wildcards.
//   - Token budget is enforced post-rank: take the top-N files until the
//     running estimate of token cost (chars / 4) exceeds the budget.
//
// Public API:
//   buildRepoMap({ rootDir, budgetTokens=1000, maxFiles=200, extensions=[...] })
//     returns { files: [{ path, summary, importance }], totalTokens, truncated }
//
//   compactBriefForSubagent({ baseBrief, repoMap, maxPrefixTokens })
//     returns { brief: string, repoMapTokens, baseBriefTokens }

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_TOKENS = 1000;
const DEFAULT_MAX_FILES     = 200;
const TOKENS_PER_CHAR       = 1 / 4;  // ~4 chars per token (Anthropic/OpenAI average)

// File extensions considered "code" by default. Markdown/JSON ride along
// because they often carry the most-informative summaries (README, package.json).
const DEFAULT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.md', '.json', '.yaml', '.yml', '.toml',
]);

// Always-skip directory names (independent of .gitignore). These are
// universally noise for repo-map purposes.
const ALWAYS_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.svn', '.hg', '__pycache__',
  '.next', '.nuxt', '.cache', '.vercel', 'dist', 'build', 'coverage',
  '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv', 'env',
  // IJFW-specific noise
  '.ijfw', '.planning',
]);

// ---------------------------------------------------------------------------
// .gitignore parsing — minimal but covers the cases that matter.
// ---------------------------------------------------------------------------

/**
 * Parse a .gitignore file into a list of matcher objects.
 * Each matcher is { pattern, negate, dirOnly, anchored, regex }.
 *
 * @param {string} content
 * @returns {Array}
 */
export function parseGitignore(content) {
  if (typeof content !== 'string') return [];
  const matchers = [];
  for (const rawLine of content.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    line = line.replace(/\s+$/, '');
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line.length === 0) continue;
    matchers.push({ pattern: line, negate, dirOnly, anchored, regex: globToRegex(line, anchored) });
  }
  return matchers;
}

// Glob -> RegExp. Supports: *, **, ?, character classes.
function globToRegex(glob, anchored) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '|' || c === '^' || c === '$' || c === '\\') {
      re += '\\' + c;
    } else if (c === '/') {
      re += '/';
    } else {
      re += c;
    }
  }
  const prefix = anchored ? '^' : '(^|.*/)';
  const suffix = '(/.*)?$';
  return new RegExp(prefix + re + suffix);
}

/**
 * Test a relative posix-style path against parsed .gitignore matchers.
 * Returns true if the path should be IGNORED.
 *
 * @param {string} relPathPosix
 * @param {boolean} isDir
 * @param {Array} matchers
 * @returns {boolean}
 */
export function isIgnored(relPathPosix, isDir, matchers) {
  let ignored = false;
  for (const m of matchers) {
    if (m.dirOnly && !isDir) continue;
    if (m.regex.test(relPathPosix)) {
      ignored = !m.negate;
    }
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function* walkFiles(rootDir, matchers, extensions) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(rootDir, abs).split(sep).join('/');
      if (ent.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(ent.name)) continue;
        if (isIgnored(rel, true, matchers)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        if (isIgnored(rel, false, matchers)) continue;
        if (extensions && !extensions.has(extname(ent.name).toLowerCase())) continue;
        yield { abs, rel };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Symbol extraction + TF-IDF
// ---------------------------------------------------------------------------

// Heuristic regex-based symbol extractor. Catches:
//   - JS/TS: function foo, const foo =, class Foo, export ...
//   - Python: def foo, class Foo
//   - Go: func Foo
//   - Markdown: ^# heading text
// The goal is "stable enough to rank importance", not perfect AST parsing.
const SYMBOL_PATTERNS = [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)/g,
  /(?:^|\n)\s*func\s+(?:\([^)]*\)\s+)?([A-Z][\w]*)/g,
  /(?:^|\n)#{1,3}\s+(.{1,80})/g,
];

function extractSymbols(content) {
  const symbols = [];
  for (const pat of SYMBOL_PATTERNS) {
    let m;
    pat.lastIndex = 0;
    while ((m = pat.exec(content)) !== null) {
      const s = m[1];
      if (s && s.length > 0) symbols.push(s.trim());
    }
  }
  return symbols;
}

// Build a TF-IDF importance score per file. "Document" = file's symbols +
// path components. "Corpus" = all scanned files. Files with more distinctive
// symbols (rare across the corpus) score higher.
function tfidfScore(perFileTokens) {
  const docFreq = new Map();
  for (const tokens of perFileTokens.values()) {
    const uniq = new Set(tokens);
    for (const t of uniq) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }
  const N = perFileTokens.size;
  const scores = new Map();
  for (const [path, tokens] of perFileTokens.entries()) {
    if (tokens.length === 0) { scores.set(path, 0); continue; }
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const [t, count] of tf.entries()) {
      const df = docFreq.get(t) || 1;
      const idf = Math.log((N + 1) / df) + 1;
      score += (count / tokens.length) * idf;
    }
    scores.set(path, score);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Public API: buildRepoMap
// ---------------------------------------------------------------------------

/**
 * Build a compact, importance-ranked map of the repo.
 *
 * @param {object} args
 * @param {string} args.rootDir
 * @param {number} [args.budgetTokens=1000]
 * @param {number} [args.maxFiles=200]
 * @param {Set<string>|string[]} [args.extensions]
 * @returns {{ files: Array<{path:string, summary:string, importance:number}>, totalTokens:number, truncated:boolean, scannedCount:number }}
 */
export function buildRepoMap({ rootDir, budgetTokens = DEFAULT_BUDGET_TOKENS, maxFiles = DEFAULT_MAX_FILES, extensions } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('buildRepoMap: rootDir is required');
  }
  try {
    const st = statSync(rootDir);
    if (!st.isDirectory()) throw new Error('rootDir must be a directory');
  } catch (err) {
    throw new Error(`buildRepoMap: cannot access rootDir "${rootDir}": ${err.message}`);
  }

  const extSet = extensions instanceof Set
    ? extensions
    : Array.isArray(extensions)
      ? new Set(extensions.map(e => e.toLowerCase()))
      : DEFAULT_EXTENSIONS;

  let matchers = [];
  try {
    const giContent = readFileSync(join(rootDir, '.gitignore'), 'utf8');
    matchers = parseGitignore(giContent);
  } catch {
    matchers = [];
  }

  const perFileTokens = new Map();
  const perFileSummary = new Map();
  let scannedCount = 0;
  for (const { abs, rel } of walkFiles(rootDir, matchers, extSet)) {
    scannedCount++;
    if (scannedCount > 10_000) break;
    let content = '';
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.length > 256 * 1024) content = content.slice(0, 256 * 1024);

    const symbols = extractSymbols(content);
    const pathTokens = rel.split(/[/\.]/).filter(t => t.length > 1);
    perFileTokens.set(rel, [...symbols, ...pathTokens]);

    const distinct = [...new Set(symbols)].slice(0, 3);
    const firstLine = (content.split('\n').find(l => l.trim().length > 0) || '').trim().slice(0, 80);
    const summary = distinct.length > 0
      ? `${distinct.join(', ')}${firstLine ? ` - ${firstLine}` : ''}`
      : firstLine || basename(rel);
    perFileSummary.set(rel, summary);
  }

  const scores = tfidfScore(perFileTokens);
  const ranked = [...perFileTokens.keys()]
    .map(p => ({ path: p, summary: perFileSummary.get(p) || basename(p), importance: scores.get(p) || 0 }))
    .sort((a, b) => b.importance - a.importance);

  const limited = ranked.slice(0, maxFiles);

  const out = [];
  let running = 0;
  let truncated = false;
  for (const entry of limited) {
    const line = `${entry.path}: ${entry.summary}\n`;
    const cost = Math.ceil(line.length * TOKENS_PER_CHAR);
    if (running + cost > budgetTokens) {
      truncated = true;
      break;
    }
    out.push(entry);
    running += cost;
  }

  return { files: out, totalTokens: running, truncated, scannedCount };
}

// ---------------------------------------------------------------------------
// Public API: compactBriefForSubagent
// ---------------------------------------------------------------------------

/**
 * Inject a repo-map prefix block in front of a subagent brief.
 *
 * @param {object} args
 * @param {string} args.baseBrief
 * @param {object} args.repoMap                 - output of buildRepoMap()
 * @param {number} [args.maxPrefixTokens=1000]
 * @returns {{ brief: string, repoMapTokens: number, baseBriefTokens: number }}
 */
export function compactBriefForSubagent({ baseBrief, repoMap, maxPrefixTokens = DEFAULT_BUDGET_TOKENS } = {}) {
  if (typeof baseBrief !== 'string') {
    throw new TypeError('compactBriefForSubagent: baseBrief must be a string');
  }
  if (!repoMap || !Array.isArray(repoMap.files)) {
    return {
      brief: baseBrief,
      repoMapTokens: 0,
      baseBriefTokens: Math.ceil(baseBrief.length * TOKENS_PER_CHAR),
    };
  }

  const header = '--- REPO MAP (importance-ranked, regex-extracted) ---\n';
  const footer = '--- END REPO MAP ---\n\n';
  const fixedCost = Math.ceil((header.length + footer.length) * TOKENS_PER_CHAR);
  let budget = Math.max(0, maxPrefixTokens - fixedCost);

  const lines = [];
  let running = 0;
  for (const f of repoMap.files) {
    const line = `${f.path}: ${f.summary}\n`;
    const cost = Math.ceil(line.length * TOKENS_PER_CHAR);
    if (running + cost > budget) break;
    lines.push(line);
    running += cost;
  }

  const prefix = lines.length > 0
    ? header + lines.join('') + footer
    : '';

  const brief = prefix + baseBrief;
  return {
    brief,
    repoMapTokens: prefix.length > 0 ? Math.ceil(prefix.length * TOKENS_PER_CHAR) : 0,
    baseBriefTokens: Math.ceil(baseBrief.length * TOKENS_PER_CHAR),
  };
}

// Constants exported for tests + docs.
export const REPO_MAP_DEFAULTS = {
  budgetTokens: DEFAULT_BUDGET_TOKENS,
  maxFiles: DEFAULT_MAX_FILES,
  tokensPerChar: TOKENS_PER_CHAR,
  extensions: DEFAULT_EXTENSIONS,
};
