#!/usr/bin/env node

/**
 * IJFW Memory Server -- Cross-platform MCP memory for AI coding agents
 * By Sean Donahoe | "It Just Fucking Works"
 *
 * 4 tools: recall, store, search, status
 * Storage: append-only markdown (hot layer, zero dependencies)
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 *
 * Hardened against: prompt injection via stored content, cross-project worming,
 * non-atomic writes, silent storage failures, Windows path traversal.
 */

import { createInterface } from 'readline';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  appendFileSync, readdirSync, statSync, renameSync, unlinkSync,
  openSync, closeSync, fsyncSync, realpathSync
} from 'fs';
import { join, resolve, isAbsolute, normalize, basename, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';

// Read version dynamically from package.json so bumps don't require a code change.
const __pkg_dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__pkg_dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();
import { checkPrompt } from './prompt-check.js';
import { applyCaps, CAP_CONTENT } from './caps.js';
import { ensureSchemaHeader, SCHEMA_HEADER } from './schema.js';
import { searchCorpus } from './search-bm25.js';
import { crossProjectSearch } from './cross-project-search.js';
// R2-E -- single source of truth for markdown/HTML/control-char defanger.
import { sanitizeContent } from './sanitizer.js';
// 1.1.6: update tools (cap 8 -> 10) -- token-issuance + OOB terminal confirm.
// Per CLAUDE.md policy: future growth triggers retirement review, not raise.
import { ijfwUpdateCheck, TOOL_DEF as UPDATE_CHECK_TOOL } from './update-check.js';
import { ijfwUpdateApply, TOOL_DEF as UPDATE_APPLY_TOOL } from './update-apply.js';
// ijfw_run: sandbox large command output to disk, return terse summary to context.
import { runCommand, detectDomain, summarize, writeToSandbox, readFromSandbox, purgeSandboxOld, stripAnsi } from './sandbox.js';
const SANDBOX_DIR = join(process.env.HOME || homedir(), '.ijfw', 'session-sandbox');

// --- Constants ---
const SCHEMA_VERSION = 1;
const MAX_STORE_LENGTH = CAP_CONTENT;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 50;
const MAX_SEARCH_RESULTS = 20;
const MAX_FILE_READ = 5_000_000;       // 5MB -- large enough that unbounded growth doesn't hit during normal lifetime
const VALID_MEMORY_TYPES = ['decision', 'observation', 'pattern', 'handoff', 'preference'];

// --- Project root resolution (path-traversal-safe; cross-platform) ---
// Strategy:
//   1. IJFW_PROJECT_DIR env (explicit) -- validated for traversal, used as-is.
//   2. CLAUDE_PROJECT_DIR env (set by Claude Code when project known) -- same validation.
//   3. process.cwd() -- used ONLY if writable. Claude Code sometimes spawns
//      MCP servers in directories the user can't write to (/, /tmp).
//   4. os.homedir() -- final fallback. Always writable for the user.
//
// Picking a writable root at startup eliminates the EACCES-on-mkdir failure
// mode that corrupts the MCP stdio handshake (any stderr byte during init
// can make the client mark the server as failed).
function validatePath(raw) {
  if (!raw) return null;
  const resolved = resolve(raw);
  const normalized = normalize(resolved);
  if (!isAbsolute(normalized)) return null;
  const parts = normalized.split(/[\\/]+/);
  if (parts.includes('..')) return null;
  return normalized;
}

function isWritable(dir) {
  try {
    if (!existsSync(dir)) {
      // Try to create it; if that works it's writable.
      mkdirSync(dir, { recursive: true });
      return true;
    }
    // Exists -- probe with a tmp file.
    const probe = join(dir, `.ijfw-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function safeProjectDir() {
  // 1. Explicit IJFW_PROJECT_DIR wins (user or installer set it deliberately).
  const fromIjfw = validatePath(process.env.IJFW_PROJECT_DIR);
  if (fromIjfw && isWritable(fromIjfw)) return fromIjfw;

  // 2. CLAUDE_PROJECT_DIR (set by some Claude Code versions).
  const fromClaude = validatePath(process.env.CLAUDE_PROJECT_DIR);
  if (fromClaude && isWritable(fromClaude)) return fromClaude;

  // 3. CWD if writable -- normal case for shell-invoked use and Claude Code
  //    sessions rooted in a project.
  const cwd = process.cwd();
  if (isWritable(cwd)) return cwd;

  // 4. HOME fallback -- always writable for the user. Memory becomes
  //    user-global but we stay alive instead of crashing.
  return homedir();
}

const PROJECT_DIR = safeProjectDir();
const PROJECT_HASH = createHash('sha256').update(PROJECT_DIR).digest('hex').slice(0, 12);
const IJFW_DIR = join(PROJECT_DIR, '.ijfw');
const MEMORY_DIR = join(IJFW_DIR, 'memory');
const SESSIONS_DIR = join(IJFW_DIR, 'sessions');
const GLOBAL_DIR = join(homedir(), '.ijfw', 'memory');
// Legacy single-file location (pre-Phase 2). Still read for backward compat
// but new writes go to the faceted structure.
const LEGACY_GLOBAL_FILE = join(GLOBAL_DIR, 'global-knowledge.md');
// Faceted global memory (Phase 2). Each file is bounded, human-readable, git-friendly.
const GLOBAL_FACETS_DIR = join(GLOBAL_DIR, 'global');
const GLOBAL_FACETS = ['preferences', 'patterns', 'stack', 'anti-patterns', 'lessons'];
const DEFAULT_FACET = 'preferences';
// Phase 3: cross-project registry. Session-start hooks append one line per
// known IJFW project. Used by search(scope:'all') and recall(from_project:X).
const REGISTRY_FILE = join(homedir(), '.ijfw', 'registry.md');
// Phase 3 #8: team memory tier. Project-local, faceted, committed alongside
// personal memory but distinguished as shared decisions/patterns/stack/members.
// Precedence: team > personal > global. Empty by default -- no behavior change
// until user creates .ijfw/team/<facet>.md (commits it for teammates).
const TEAM_DIR_NAME = 'team';
const TEAM_FACETS = ['decisions', 'patterns', 'stack', 'members'];

// Claude Code's native auto-memory lives at ~/.claude/projects/<encoded>/memory/
// where <encoded> is the project path with `/` → `-`. IJFW reads these files
// and surfaces them via MCP so all platforms (not just Claude) see the same
// memories -- no fighting Claude's native "Remember X" handler.
const NATIVE_CLAUDE_DIR = join(
  homedir(), '.claude', 'projects',
  PROJECT_DIR.replace(/\//g, '-'),
  'memory'
);

// --- Bootstrap directories ---
// Project dirs are required; global is best-effort (HOME may be read-only on CI).
// Failures here do NOT write to stderr during startup -- any stderr byte during
// MCP handshake can make strict clients (incl. Claude Code) mark the server
// as failed. Subsequent store/read calls surface structured errors instead.
try {
  [MEMORY_DIR, SESSIONS_DIR].forEach(dir => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  });
} catch { /* handleStore/recall surface structured errors on first use */ }
try {
  if (!existsSync(GLOBAL_DIR)) mkdirSync(GLOBAL_DIR, { recursive: true });
} catch { /* handleStore reports on attempted write */ }

// R2-E -- sanitizeContent moved to mcp-server/src/sanitizer.js so MCP stores
// and auto-memorize stores share a single implementation. Imported above.

// --- Atomic write (write to .tmp, fsync, rename) ---
//
// Eliminates partial-write corruption on crash and makes concurrent writers
// from two server instances on the same project safe at the file level
// (last writer wins atomically, no interleaved bytes).
function atomicWrite(filepath, content) {
  const tmp = `${filepath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, filepath);
    return { ok: true };
  } catch (err) {
    if (fd != null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return { ok: false, code: err.code || 'EUNKNOWN', message: err.message };
  }
}

// --- Read with explicit error reporting ---
//
// Returns { ok: true, content } on success including empty file.
// Returns { ok: false, reason } so callers can distinguish "absent" from
// "permission denied" / "too big" / "I/O error" -- silent null was the
// previous root of multiple bugs.
function readMarkdownFile(filepath) {
  if (!existsSync(filepath)) return { ok: false, reason: 'absent' };
  let stats;
  try {
    stats = statSync(filepath);
  } catch (err) {
    return { ok: false, reason: err.code || 'stat-failed' };
  }
  if (stats.size > MAX_FILE_READ) return { ok: false, reason: 'too-large', size: stats.size };
  try {
    return { ok: true, content: readFileSync(filepath, 'utf-8') };
  } catch (err) {
    return { ok: false, reason: err.code || 'read-failed' };
  }
}

// Convenience wrapper: returns string ('' if absent or unreadable) for the
// recall hot-path where we just need text. Logs unexpected failures.
function readOr(filepath, fallback = '') {
  const r = readMarkdownFile(filepath);
  if (r.ok) return r.content;
  if (r.reason !== 'absent') {
    process.stderr.write(`IJFW: read ${basename(filepath)}: ${r.reason}\n`);
  }
  return fallback;
}

// --- Append helper (atomic for entries < PIPE_BUF; append-only growth) ---
//
// We rely on POSIX O_APPEND atomicity for entries under 4KB. Sanitized
// entries are bounded at MAX_STORE_LENGTH=5000 chars, but the entry header
// keeps each *line* well under 4KB after sanitization (single-line collapse).
function appendLine(filepath, line) {
  try {
    if (!existsSync(filepath)) {
      // First write seeds the schema header (audit R1). Best-effort atomic.
      const seed = `${SCHEMA_HEADER}\n# ${basename(filepath, '.md')}\n${line}\n`;
      const r = atomicWrite(filepath, seed);
      if (!r.ok) return r;
      return { ok: true };
    }
    // Existing file: migrate if it predates the schema header.
    try { ensureSchemaHeader(filepath); } catch { /* best-effort; append still runs */ }
    appendFileSync(filepath, line + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code || 'EUNKNOWN', message: err.message };
  }
}

// --- Recall observation emitter ---
// Appends a lightweight "memory-recall" entry to ~/.ijfw/observations.jsonl
// so the dashboard recall-counter can track per-file recall frequency.
// Best-effort: never throws, never blocks the recall response.
function emitRecallObservation({ context_hint, from_project } = {}) {
  try {
    const obsPath = join(homedir(), '.ijfw', 'observations.jsonl');
    // Derive a plausible file_path from context_hint if it looks like a filename
    const fp = (context_hint && context_hint.includes('.md'))
      ? join(GLOBAL_DIR, context_hint)
      : null;
    const obs = {
      type:       'memory-recall',
      ts:         new Date().toISOString(),
      tool_name:  'ijfw_memory_recall',
      context_hint: context_hint || null,
      file_path:  fp,
      from_project: from_project || null,
      platform:   'mcp',
    };
    appendFileSync(obsPath, JSON.stringify(obs) + '\n');
  } catch { /* best-effort */ }
}

// --- Storage helpers ---
function appendToJournal(entry) {
  const journalPath = join(MEMORY_DIR, 'project-journal.md');
  const ts = new Date().toISOString();
  const line = `- [${ts}] ${entry}`;
  return appendLine(journalPath, line);
}

// Structured append for decisions/patterns -- produces a richer frontmatter block
// similar to Claude's native auto-memory format: YAML frontmatter plus a body with
// Why / How-to-apply sections. This is the format users retrieve well from.
function appendStructuredToKnowledge({ type, summary, content, why, howToApply, tags }) {
  const filepath = join(MEMORY_DIR, 'knowledge.md');
  const ts = new Date().toISOString();
  const tagLine = tags && tags.length ? tags.join(', ') : '';
  const block = [
    '',
    '---',
    `type: ${type}`,
    `summary: ${summary}`,
    `stored: ${ts}`,
    tagLine ? `tags: [${tagLine}]` : '',
    '---',
    content,
    why ? `\n**Why:** ${why}` : '',
    howToApply ? `\n**How to apply:** ${howToApply}` : '',
    ''
  ].filter(l => l !== '').join('\n') + '\n';

  try {
    if (!existsSync(filepath)) {
      const seed = `${SCHEMA_HEADER}\n# Knowledge Base\n${block}`;
      return atomicWrite(filepath, seed);
    }
    try { ensureSchemaHeader(filepath); } catch { /* best-effort */ }
    appendFileSync(filepath, block);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code || 'EUNKNOWN', message: err.message };
  }
}

// Per-project namespacing prevents cross-project worming. A poisoned preference
// stored from project A is namespaced to A's hash, so project B never reads it
// as if it were its own preference.
//
// Phase 2: writes go to faceted files. facet is inferred from tags when present
// (tag matches facet name → that facet; else preferences). Legacy global file is
// read but not written -- future migration can merge it into facets.
function appendToGlobalPrefs(entry, tags = []) {
  try {
    if (!existsSync(GLOBAL_FACETS_DIR)) mkdirSync(GLOBAL_FACETS_DIR, { recursive: true });
  } catch { /* best-effort -- if HOME is RO we can't write global */ }
  const facet = GLOBAL_FACETS.find(f => tags.some(t => t.toLowerCase() === f)) || DEFAULT_FACET;
  const namespaced = `[ns:${PROJECT_HASH}] ${entry}`;
  return appendLine(join(GLOBAL_FACETS_DIR, `${facet}.md`), namespaced);
}

function readKnowledgeBase() {
  return readOr(join(MEMORY_DIR, 'knowledge.md'));
}
function readHandoff() {
  return readOr(join(MEMORY_DIR, 'handoff.md'));
}
// Read Claude Code native auto-memory for this project. Returns concatenated
// sanitized content of all project_*.md files (skipping MEMORY.md index).
// This lets IJFW surface Claude-native memories to other platforms that don't
// have an equivalent built-in system.
function readNativeClaudeMemory() {
  try {
    if (!existsSync(NATIVE_CLAUDE_DIR)) return '';
    const files = readdirSync(NATIVE_CLAUDE_DIR)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      .sort();
    const parts = [];
    for (const f of files) {
      const r = readMarkdownFile(join(NATIVE_CLAUDE_DIR, f));
      if (!r.ok) continue;
      // Strip YAML frontmatter for brevity in prelude -- keep the body that
      // already includes the **Why:** / **How to apply:** sections.
      const body = r.content.replace(/^---[\s\S]*?---\n/, '').trim();
      if (body) parts.push(body);
    }
    return parts.join('\n\n---\n\n');
  } catch {
    return '';
  }
}

// Phase 3 #8: team memory -- shared, project-local, committed. Read-only here.
// Faceted (decisions/patterns/stack/members) for parity with global tier;
// each facet is a plain markdown file that teammates edit via PR.
function readTeamKnowledge() {
  const teamDir = join(IJFW_DIR, TEAM_DIR_NAME);
  if (!existsSync(teamDir)) return '';
  const out = [];
  for (const facet of TEAM_FACETS) {
    const raw = readOr(join(teamDir, `${facet}.md`));
    if (raw) out.push(`### ${facet} (team)\n${raw}`);
  }
  return out.join('\n\n');
}

// Global prefs are filtered to entries matching this project's namespace OR
// entries with no namespace (legacy/manual entries). Cross-project prefs are
// not exposed by default. Phase 2: reads both faceted files and legacy flat.
function readGlobalKnowledge() {
  const sources = [];
  // Faceted files (Phase 2)
  if (existsSync(GLOBAL_FACETS_DIR)) {
    for (const facet of GLOBAL_FACETS) {
      const p = join(GLOBAL_FACETS_DIR, `${facet}.md`);
      const raw = readOr(p);
      if (raw) sources.push(`### ${facet}\n${raw}`);
    }
  }
  // Legacy single-file (pre-Phase 2) -- still surface if present, unfaceted
  const legacy = readOr(LEGACY_GLOBAL_FILE);
  if (legacy) sources.push(`### legacy\n${legacy}`);

  if (sources.length === 0) return '';

  // Filter to entries matching this project's namespace (or unnamespaced).
  return sources.map(section =>
    section.split('\n').filter(line => {
      if (!line.startsWith('[ns:')) return true;
      return line.startsWith(`[ns:${PROJECT_HASH}]`);
    }).join('\n')
  ).join('\n\n');
}

function getSessionCount() {
  try {
    if (!existsSync(SESSIONS_DIR)) return 0;
    return readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function getDecisionCount() {
  const journal = readOr(join(MEMORY_DIR, 'project-journal.md'));
  if (!journal) return 0;
  // Match only journal entry lines (we now prefix with - [timestamp]) -- not
  // arbitrary list bullets that might appear in seeded content.
  return (journal.match(/^- \[\d{4}-\d{2}-\d{2}T/gm) || []).length;
}

function getRecentJournalEntries(count = 5) {
  const journal = readOr(join(MEMORY_DIR, 'project-journal.md'));
  if (!journal) return '';
  const entries = journal.split('\n').filter(l => /^- \[\d{4}-/.test(l));
  return entries.slice(-count).join('\n');
}

// --- Cross-project registry (Phase 3) ---
//
// Registry lines look like: <abs-path> | <sha256-12> | <first-seen-iso>
// Returns [{path, hash, iso}]. Skips malformed lines; excludes current project.
function readRegistry({ includeCurrent = false } = {}) {
  const r = readMarkdownFile(REGISTRY_FILE);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.content.split('\n')) {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 3) continue;
    const [path, hash, iso] = parts;
    if (!path || !isAbsolute(path)) continue;
    if (!includeCurrent && path === PROJECT_DIR) continue;
    out.push({ path, hash, iso });
  }
  return out;
}

// Resolve a from_project arg (path OR 12-char hash) to a registry entry.
function resolveProject(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const all = readRegistry({ includeCurrent: true });
  const trimmed = spec.trim();
  // Try absolute path first, then hash, then basename suffix match.
  return all.find(e => e.path === trimmed)
      || all.find(e => e.hash === trimmed)
      || all.find(e => basename(e.path) === trimmed)
      || null;
}

// Read this-project-shape memory for an arbitrary project root. Mirrors the
// sources the local search uses, but isolated to that project's directory.
function readProjectMemory(projectPath) {
  const memDir = join(projectPath, '.ijfw', 'memory');
  return {
    knowledge: readOr(join(memDir, 'knowledge.md')),
    journal:   readOr(join(memDir, 'project-journal.md')),
    handoff:   readOr(join(memDir, 'handoff.md'))
  };
}

function searchAcrossProjects(query, limit) {
  const queryLower = String(query).toLowerCase();
  const keywords = queryLower.split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) return [];

  const results = [];
  for (const entry of readRegistry()) {
    const tag = basename(entry.path);
    const mem = readProjectMemory(entry.path);
    for (const [src, content] of Object.entries(mem)) {
      if (!content) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) continue;
        const score = keywords.filter(k => line.toLowerCase().includes(k)).length;
        if (score > 0) {
          results.push({
            source: `${src}@${tag}`,
            line: i + 1,
            content: `[project:${tag}] ${line.trim().substring(0, 200)}`,
            score
          });
        }
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --- Search ---
// P5.1 / H4 -- BM25 ranking over line-level docs. Source tags and line
// numbers preserved so callers get the same output shape; scoring is
// BM25 (IDF + TF + length-normalized) with per-source boost. Team tier
// ranks first via a score bump for ties.
function searchMemory(query, limit = 10, scope = 'project') {
  limit = Math.min(Math.max(1, limit | 0), MAX_SEARCH_RESULTS);
  if (scope === 'all') return searchAcrossProjects(query, limit);

  const sources = [
    { name: 'team',          content: readTeamKnowledge(),                          boost: 1.25 },
    { name: 'knowledge',     content: readKnowledgeBase(),                          boost: 1.15 },
    { name: 'journal',       content: readOr(join(MEMORY_DIR, 'project-journal.md')), boost: 1.0  },
    { name: 'handoff',       content: readHandoff(),                                boost: 1.1  },
    { name: 'global',        content: readGlobalKnowledge(),                        boost: 0.95 },
    { name: 'claude-native', content: readNativeClaudeMemory(),                     boost: 0.95 },
  ];

  const docs = [];
  const meta = new Map();
  for (const src of sources) {
    if (!src.content) continue;
    const lines = src.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const id = `${src.name}:${i + 1}`;
      docs.push({ id, text: line });
      meta.set(id, { source: src.name, line: i + 1, boost: src.boost });
    }
  }
  if (docs.length === 0) return [];

  const ranked = searchCorpus(query, docs, { limit: limit * 3 });
  if (ranked.length === 0) return [];

  const boosted = ranked.map(r => {
    const m = meta.get(r.id);
    return {
      source: m.source,
      line: m.line,
      content: (r.snippet || '').substring(0, 200),
      score: r.score * (m.boost || 1),
    };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted.slice(0, limit);
}

// --- DESIGN picker (1.2.0 Phase 5) ---
// MCP-only delivery of the 12-template design catalog for OpenCode / Qwen
// Code / Kimi Code / OpenClaw / Aider. No new tool -- served via existing
// ijfw_memory_recall using context_hint colon-syntax:
//   'design_template'         -> catalog of 12 names + descriptions
//   'design_template:<name>'  -> full template body
const DESIGN_TEMPLATES_DIR = join(__pkg_dirname, '..', 'templates', 'design');
const DESIGN_TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const DESIGN_TEMPLATE_CATALOG = [
  ['bento-grid',            'Modular card grid with varied sizes; Apple/Notion-style product pages.'],
  ['brutalist-luxe',        'Raw concrete textures + luxury editorial restraint; fashion and architecture brands.'],
  ['cinematic-dark',        'Film-grade dark UI with dramatic contrast; streaming, media, portfolio.'],
  ['data-dense-dashboard',  'Monitoring/BI layout optimized for information density.'],
  ['editorial-warm',        'Magazine feel in warm off-white; newsletters, blogs, long-form content.'],
  ['glassmorphic',          'Frosted translucency with soft blur; creative SaaS and fintech premium.'],
  ['magazine-editorial',    'Print-magazine hierarchy with bold display type; publishing, agency work.'],
  ['maximalist-vibrant',    'Saturated palettes, bold pattern, high energy; consumer lifestyle brands.'],
  ['neo-swiss-tech',        'Updated Swiss style with accent color and modern sans; dev tools, SaaS.'],
  ['swiss-minimal',         'Classical Swiss typographic school; developer-facing and documentation sites.'],
  ['terminal-native',       'Monospaced terminal aesthetic; CLIs, infra tools, hacker-brand products.'],
  ['warm-organic',          'Soft curves and earthy tones; wellness, sustainable brands, lifestyle.'],
];

function designCatalogText() {
  const lines = DESIGN_TEMPLATE_CATALOG.map(([n, d]) => `- ${n} -- ${d}`);
  lines.push('');
  lines.push('Pick one with: ijfw_memory_recall({context_hint: "design_template:<name>"}).');
  return `# DESIGN templates (12)\n${lines.join('\n')}`;
}

function handleDesignTemplate(hint) {
  // Catalog mode: bare 'design_template'.
  if (hint === 'design_template') {
    return { text: designCatalogText() };
  }
  // Body mode: 'design_template:<name>'.
  const name = hint.slice('design_template:'.length);
  const catalogNames = DESIGN_TEMPLATE_CATALOG.map(([n]) => n).join(', ');
  if (!DESIGN_TEMPLATE_NAME_RE.test(name)) {
    return { text: `Unknown template: ${name}. Catalog: ${catalogNames}`, isError: true };
  }
  const file = join(DESIGN_TEMPLATES_DIR, `${name}.md`);
  // Defence-in-depth: realpath both sides so a symlink inside templates/design/
  // can't escape the directory. Regex already blocks raw `..`, NUL, URL-encoded
  // traversal; this closes the symlink hole caught by codex Round-4 audit.
  try {
    const baseReal = realpathSync.native(DESIGN_TEMPLATES_DIR);
    const resolvedReal = realpathSync.native(file);
    const expected = join(baseReal, `${name}.md`);
    if (resolvedReal !== expected) {
      return { text: `Unknown template: ${name}. Catalog: ${catalogNames}`, isError: true };
    }
    const body = readFileSync(resolvedReal, 'utf8');
    return { text: body };
  } catch {
    return { text: `Unknown template: ${name}. Catalog: ${catalogNames}`, isError: true };
  }
}

// --- MCP Tool Definitions ---
const TOOLS = [
  {
    name: 'ijfw_memory_recall',
    description: 'Wake up with project context intact -- past decisions, handoff state, and knowledge base in one call. Use at session start or when you need to remember why something was built a certain way. Pass from_project to pull from a different IJFW project by basename (simplest), 12-char hash, or absolute path. Also accepts context_hint "design_template" (12-template catalog) or "design_template:<name>" (full template body) for the DESIGN picker.',
    inputSchema: {
      type: 'object',
      properties: {
        context_hint: {
          type: 'string',
          description: 'What context is needed: "session_start" for wake-up injection, "handoff" for last session state, "decisions" for recent decisions, "design_template" for the 12-template DESIGN picker catalog, "design_template:<name>" for a specific template body, or a natural language query.'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'standard', 'full'],
          description: 'Level of detail. Summary: ~200 tokens. Standard: recent context. Full: everything.'
        },
        from_project: {
          type: 'string',
          description: 'Optional. Pull from a different IJFW project by absolute path, 12-char hash, or basename. Project must exist in the registry (~/.ijfw/registry.md).'
        }
      },
      required: ['context_hint']
    }
  },
  {
    name: 'ijfw_memory_store',
    description: 'Persist a decision, observation, or session state so it survives context resets. For decisions and patterns, add summary/why/how_to_apply for a richer knowledge-base entry. Returns isError on storage failure.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full statement of what to remember. Max 5000 chars. Sanitised on storage.' },
        type: { type: 'string', enum: VALID_MEMORY_TYPES, description: 'Memory tier: decision or pattern -> knowledge base (frontmatter). handoff -> overwrites handoff.md. preference -> project-namespaced global. observation -> journal only.' },
        summary: { type: 'string', description: 'Optional 1-line summary (≤80 chars). Used as the frontmatter name for decisions/patterns.' },
        why: { type: 'string', description: 'Optional rationale -- why this decision was made. Populates the Why section in the knowledge base entry.' },
        how_to_apply: { type: 'string', description: 'Optional guidance -- when and how to apply this. Populates the How-to-apply section.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 20 tags, 50 chars each.' }
      },
      required: ['content', 'type']
    }
  },
  {
    name: 'ijfw_memory_search',
    description: 'Keyword search across memory sources. Up to 20 results. Scope defaults to current project; pass scope:"all" to search across every IJFW project ever opened on this machine (results tagged [project:<name>]). Pass scope:"sandbox" to retrieve sandboxed ijfw_run output -- include label to get the full output of a specific run, or omit label to list all available sandbox entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query. Not required when scope is "sandbox".' },
        limit: { type: 'number', description: 'Max results (default 10, max 20).' },
        scope: { type: 'string', enum: ['project', 'all', 'sandbox'], description: 'project (default) = this project only. all = every known IJFW project on this machine. sandbox = retrieve sandboxed ijfw_run output.' },
        label: { type: 'string', description: 'Sandbox entry label to retrieve. Only used when scope is "sandbox". Omit to list all available entries.' }
      },
      required: []
    }
  },
  {
    name: 'ijfw_memory_prelude',
    description: 'CALL THIS AT SESSION START. Returns all relevant project memory in one pass -- knowledge base, handoff state, recent activity. Eliminates the need to grep/search/recall separately. Call once at the start of a session before answering the user.',
    inputSchema: {
      type: 'object',
      properties: {
        detail_level: {
          type: 'string',
          enum: ['summary', 'standard', 'full'],
          description: 'summary ≈ 200 tokens (defaults). standard ≈ 500 tokens. full = everything available.'
        }
      },
      required: []
    }
  },
  {
    name: 'ijfw_prompt_check',
    description: 'Call on the first turn when the user prompt is short (<30 tokens) or likely vague. Returns whether the prompt is under-specified and a sharpening suggestion. Deterministic regex detector -- no LLM call. Use for Codex/Cursor/Windsurf/Copilot/Gemini where pre-prompt hooks are not available.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full user prompt text.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'ijfw_metrics',
    description: 'See tokens/spend, model routing mix, and session totals -- the receipts behind your IJFW sessions. Aggregates from .ijfw/metrics/sessions.jsonl. Tolerates mixed v1/v2 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'Time window (default 7d).' },
        metric: { type: 'string', enum: ['tokens', 'cost', 'sessions', 'routing'], description: 'Which metric to render (default tokens).' }
      },
      required: []
    }
  },
  {
    name: 'ijfw_cross_project_search',
    description: 'BM25-ranked search across every IJFW project ever opened on this machine. Results tagged [project:<basename>] with line numbers + snippets. Use when you need to recall how a similar problem was solved in another project. Reads ~/.ijfw/registry.md as the source of truth.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search query. Supports plain words and "quoted phrases". Use BM25 relevance ranking.' },
        limit: { type: 'number', description: 'Max results (default 10, max 50).' }
      },
      required: ['pattern']
    }
  },
  UPDATE_CHECK_TOOL,
  UPDATE_APPLY_TOOL,
  {
    name: 'ijfw_run',
    description: 'Run a shell command. For commands likely to produce large output (builds, test suites, grep -r, log tails), use this instead of Bash -- full output is sandboxed to disk and a smart summary is returned to context. For git/nav/quick ops, use Bash directly.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        label: { type: 'string', description: 'Optional label for sandbox retrieval. Auto-generated if omitted.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to process.cwd().' },
      },
      required: ['command'],
    },
  }
];

// --- Tool Handlers ---

function handleRecall({ context_hint, detail_level = 'standard', from_project }) {
  // Cross-project explicit pull. We bypass current-project sources and read
  // the target project's knowledge/handoff/journal directly. Search queries
  // are routed through searchAcrossProjects via scope:'all' on the search tool;
  // recall here is for "give me everything from X."
  if (from_project) {
    const target = resolveProject(from_project);
    if (!target) {
      return { text: `No registered IJFW project matches: ${from_project}`, isError: true };
    }
    const mem = readProjectMemory(target.path);
    const tag = basename(target.path);
    const out = [];
    if (mem.knowledge) out.push(`## Knowledge [${tag}]\n${mem.knowledge}`);
    if (mem.handoff)   out.push(`## Handoff [${tag}]\n${mem.handoff}`);
    if (mem.journal && (context_hint === 'decisions' || detail_level === 'full')) {
      out.push(`## Journal [${tag}]\n${mem.journal}`);
    }
    return { text: out.join('\n\n') || `No memory found in project: ${tag}` };
  }

  // 1.2.0 Phase 5: DESIGN picker -- MCP-only delivery of the 12-template
  // catalog to platforms without a skills tree (OpenCode/Qwen/Kimi/OpenClaw)
  // or with MCP-less rules (Aider + CONVENTIONS.md).
  if (typeof context_hint === 'string'
      && (context_hint === 'design_template' || context_hint.startsWith('design_template:'))) {
    return handleDesignTemplate(context_hint);
  }

  const parts = [];

  if (context_hint === 'session_start' || detail_level === 'summary') {
    const knowledge = readKnowledgeBase();
    const handoff = readHandoff();
    const global = readGlobalKnowledge();

    if (knowledge) parts.push(`## Knowledge\n${knowledge.split('\n').slice(0, 20).join('\n')}`);
    if (handoff) parts.push(`## Last Session\n${handoff.split('\n').slice(0, 15).join('\n')}`);
    if (global) parts.push(`## Preferences\n${global.split('\n').slice(0, 10).join('\n')}`);

    return { text: parts.join('\n\n') || 'First session on this project. No memory stored yet.' };
  }

  if (context_hint === 'handoff') {
    return { text: readHandoff() || 'No handoff from previous session.' };
  }

  if (context_hint === 'decisions') {
    return { text: getRecentJournalEntries(10) || 'No decisions recorded yet.' };
  }

  const results = searchMemory(context_hint);
  if (results.length === 0) return { text: `No memories matching: ${context_hint}` };
  return { text: results.map(r => `[${r.source}] ${r.content}`).join('\n') };
}

function handleStore({ content, type, tags = [], summary, why, how_to_apply }) {
  // --- Input Validation ---
  if (!content || typeof content !== 'string') {
    return { text: 'content is required and must be a string.', isError: true };
  }
  if (content.length > MAX_STORE_LENGTH) {
    return { text: `content exceeds ${MAX_STORE_LENGTH} character limit (got ${content.length}). Summarize and retry.`, isError: true };
  }
  if (!VALID_MEMORY_TYPES.includes(type)) {
    return { text: `type must be one of: ${VALID_MEMORY_TYPES.join(', ')}`, isError: true };
  }
  if (!Array.isArray(tags)) tags = [];
  // S2 -- tag whitelist. Rejects path-traversal / null bytes / punctuation
  // in tag values that are later used as grep arguments or filenames.
  tags = tags
    .filter(t => typeof t === 'string')
    .slice(0, MAX_TAGS)
    .map(t => sanitizeContent(t).substring(0, MAX_TAG_LEN))
    .map(t => t.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(t => t.length > 0);

  // Enforce per-field caps before sanitize (audit S1). content is rejected
  // above at the MAX_STORE_LENGTH gate so callers aren't silently truncated.
  // why/how/summary are truncated rather than rejected so structured stores
  // never silently drop the whole entry over one long field.
  const capped = applyCaps({ summary, why, how_to_apply });
  summary = capped.summary;
  why = capped.why;
  how_to_apply = capped.how_to_apply;

  // Sanitize ALL text fields -- never store raw user/agent text in markdown
  // that gets re-injected into a future LLM context.
  const safeContent = sanitizeContent(content);
  if (!safeContent) {
    return { text: 'content was empty after sanitisation (only control/format chars).', isError: true };
  }
  const safeSummary = summary ? sanitizeContent(summary).substring(0, 120) : '';
  const safeWhy = why ? sanitizeContent(why) : '';
  const safeHow = how_to_apply ? sanitizeContent(how_to_apply) : '';

  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const journalEntry = `**${type}**${tagStr}: ${safeSummary || safeContent.substring(0, 200)}`;

  // 1. Always append to journal (one-line timeline). Hard failure → report.
  const journalResult = appendToJournal(journalEntry);
  if (!journalResult.ok) {
    return { text: `Memory journal is not writable (${journalResult.code}) -- check .ijfw/ directory permissions and retry.`, isError: true };
  }

  // 2. Type-specific secondary writes. Each tracked so we report partial
  // success accurately rather than lying about "stored."
  const failures = [];

  if (type === 'decision' || type === 'pattern') {
    // Richer frontmatter block for retrieval-quality entries.
    const r = appendStructuredToKnowledge({
      type,
      summary: safeSummary || safeContent.substring(0, 80),
      content: safeContent,
      why: safeWhy,
      howToApply: safeHow,
      tags
    });
    if (!r.ok) failures.push(`knowledge base (${r.code})`);
  }

  if (type === 'preference') {
    const r = appendToGlobalPrefs(`**preference**${tagStr}: ${safeContent}`, tags);
    if (!r.ok) failures.push(`global preferences (${r.code})`);
  }

  if (type === 'handoff') {
    const handoffPath = join(MEMORY_DIR, 'handoff.md');
    const prior = readMarkdownFile(handoffPath);
    if (prior.ok && prior.content.trim()) {
      appendToJournal(`prior-handoff-archived: ${sanitizeContent(prior.content).substring(0, 500)}`);
    }
    const r = atomicWrite(handoffPath, safeContent + '\n');
    if (!r.ok) failures.push(`handoff (${r.code})`);
  }

  if (failures.length > 0) {
    return {
      text: `Stored ${type} to journal. Secondary writes failed: ${failures.join(', ')}`,
      isError: true
    };
  }

  return { text: `Stored ${type}${tagStr}` };
}

// Universal first-turn recall -- call once at session start to hydrate context.
// Returns a compact, structured block that agents on any platform can ingest
// without cascading into multiple exploratory tool calls.
// 1.1.6 update-nudge composer for cross-platform prelude parity.
// Reads ~/.ijfw/state.json + ~/.ijfw/cache/update-check.json. Returns the
// terse nudge line, or '' when up-to-date / re-entrancy / no cache.
function composeUpdateNudge() {
  try {
    const root = process.env.IJFW_HOME || join(homedir(), '.ijfw');
    let state, cache;
    try { state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')); }
    catch { state = {}; }
    try { cache = JSON.parse(readFileSync(join(root, 'cache', 'update-check.json'), 'utf8')); }
    catch { cache = {}; }
    if (!cache.last_latest_seen) return '';
    const installed = state.installed_version || '0.0.0';
    const lastApplied = state.last_applied_version;
    // Re-entrancy: if we just applied this version, don't nudge
    if (lastApplied && cmpSemverPrelude(lastApplied, cache.last_latest_seen) >= 0) return '';
    if (cmpSemverPrelude(installed, cache.last_latest_seen) >= 0) return '';
    return `## IJFW update available\n` +
      `Installed: v${installed} -- latest: v${cache.last_latest_seen}.\n` +
      `Run 'ijfw update' in your TERMINAL to upgrade. ` +
      `(I cannot run this for you -- the MCP path is air-gapped from code execution.)`;
  } catch { return ''; }
}

function cmpSemverPrelude(a, b) {
  const parse = v => {
    const [main, pre] = String(v).split('-', 2);
    const nums = main.split('.').map(n => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || null };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return A.pre < B.pre ? -1 : 1;
}

function handlePrelude({ detail_level = 'summary' } = {}) {
  const KB_LINES = detail_level === 'full' ? 200 : detail_level === 'standard' ? 80 : 40;
  const HO_LINES = detail_level === 'full' ? 80  : detail_level === 'standard' ? 30 : 15;
  const JN_LINES = detail_level === 'full' ? 20  : detail_level === 'standard' ? 10 : 5;

  const TM_LINES = detail_level === 'full' ? 200 : detail_level === 'standard' ? 60 : 20;

  const parts = ['<ijfw-memory>'];
  parts.push('Project memory hydrated. Treat as background context -- no further recall needed unless the user asks something not covered here.');
  parts.push('');

  // 1.1.6: surface update availability for cross-platform parity.
  // Claude Code shows this in statusLine; Codex/Gemini/Cursor/Windsurf/
  // Copilot/Hermes/Wayland surface it here in the first-turn prelude.
  // Re-entrancy: suppressed when last_applied_version >= last_latest_seen.
  const updateNudge = composeUpdateNudge();
  if (updateNudge) parts.push(updateNudge, '');

  // 1.2.0 Phase 5: surface the DESIGN picker to platforms without a skills tree.
  // Skip when the project already has a DESIGN.md (contract exists; no picker).
  try {
    if (!existsSync(join(PROJECT_DIR, 'DESIGN.md'))) {
      const names = DESIGN_TEMPLATE_CATALOG.map(([n]) => n);
      parts.push('## Design picker');
      parts.push('No DESIGN.md in project. 12 curated templates available:');
      parts.push(names.slice(0, 5).join(', ') + ',');
      parts.push(names.slice(5, 10).join(', ') + ',');
      parts.push(names.slice(10).join(', ') + '.');
      parts.push('');
      parts.push('Pick one: ijfw_memory_recall({context_hint: "design_template:<name>"}).');
      parts.push('Full catalog with descriptions: ijfw_memory_recall({context_hint: "design_template"}).');
      parts.push('');
    }
  } catch { /* cwd unreadable -- skip picker block */ }

  // Team knowledge first -- shared decisions/patterns/stack rank above personal.
  const team = readTeamKnowledge();
  if (team) {
    const body = team.split('\n').slice(0, TM_LINES).join('\n').trim();
    if (body) parts.push('## Team knowledge', body, '');
  }

  const knowledge = readKnowledgeBase();
  if (knowledge) {
    const body = knowledge.split('\n')
      .filter(l => !l.startsWith('<!-- ijfw'))
      .filter(l => !/^#[^#]/.test(l))
      .slice(0, KB_LINES)
      .join('\n')
      .trim();
    if (body) parts.push('## Knowledge base', body, '');
  }

  // Claude Code's native auto-memory -- Claude's own skill writes here on
  // "Remember X". Surfacing it via IJFW makes those memories available to
  // Codex/Gemini/Cursor too, fulfilling the cross-platform promise without
  // fighting Claude's native handler.
  const nativeMem = readNativeClaudeMemory();
  if (nativeMem) {
    const body = nativeMem.split('\n').slice(0, KB_LINES).join('\n').trim();
    if (body) parts.push('## Claude-native project memory', body, '');
  }

  const handoff = readHandoff();
  if (handoff) {
    const body = handoff.split('\n')
      .filter(l => !l.startsWith('<!-- ijfw'))
      .slice(0, HO_LINES)
      .join('\n')
      .trim();
    if (body) parts.push('## Last session handoff', body, '');
  }

  const recent = getRecentJournalEntries(JN_LINES);
  if (recent) parts.push('## Recent activity', recent, '');

  const global = readGlobalKnowledge();
  if (global) {
    const body = global.split('\n').slice(0, 10).join('\n').trim();
    if (body) parts.push('## Project preferences', body, '');
  }

  parts.push('</ijfw-memory>');

  const text = parts.join('\n');
  if (text.length < 60) {
    return { text: 'Fresh project -- no memory stored yet. Proceed normally.' };
  }
  return { text };
}

function handleSearch({ query, limit = 10, scope = 'project', label }) {
  if (scope === 'sandbox') {
    if (label) {
      const content = readFromSandbox(label);
      if (content === null) return { text: `Sandbox entry not found: ${label}` };
      return { text: content };
    }
    // List available sandbox entries.
    if (!existsSync(SANDBOX_DIR)) return { text: 'No sandbox entries found.' };
    let files;
    try { files = readdirSync(SANDBOX_DIR).filter(f => f.endsWith('.json')); }
    catch { return { text: 'No sandbox entries found.' }; }
    if (files.length === 0) return { text: 'No sandbox entries found.' };
    const entries = [];
    for (const f of files) {
      try {
        const meta = JSON.parse(readFileSync(join(SANDBOX_DIR, f), 'utf8'));
        entries.push(`${meta.label} | ${meta.command} | exit=${meta.exitCode} | ${meta.lines} lines | ${meta.timestamp}`);
      } catch { /* skip malformed */ }
    }
    return { text: entries.length > 0 ? entries.join('\n') : 'No sandbox entries found.' };
  }

  if (!query || typeof query !== 'string') {
    return { text: 'query is required and must be a string.', isError: true };
  }
  if (query.length > 500) query = query.substring(0, 500);
  if (scope !== 'project' && scope !== 'all') scope = 'project';
  const results = searchMemory(query, limit, scope);
  if (results.length === 0) {
    const where = scope === 'all' ? ' across all projects' : '';
    return { text: `No results for: "${query}"${where}` };
  }
  return { text: results.map(r => `[${r.source}:L${r.line}] ${r.content}`).join('\n') };
}

// Phase 12 / Wave 12B (R1): BM25-ranked cross-project search. Distinct from
// handleSearch(scope:'all') which is a naive keyword-count scan retained for
// backward compat. This handler is the canonical cross-project path.
function handleCrossProjectSearch({ pattern, limit = 10 } = {}) {
  if (!pattern || typeof pattern !== 'string') {
    return { text: 'pattern is required and must be a string.', isError: true };
  }
  if (pattern.length > 500) pattern = pattern.substring(0, 500);
  const projects = readRegistry();
  if (projects.length === 0) {
    return { text: 'No other IJFW projects on record. Open one more project to enable cross-project search.' };
  }
  const hits = crossProjectSearch(pattern, projects, readProjectMemory, { limit });
  if (hits.length === 0) {
    return { text: `No matches for "${pattern}" across ${projects.length} project${projects.length === 1 ? '' : 's'}.` };
  }
  const body = hits.map(h => `[${h.source}:L${h.line}] (score ${h.score}) ${h.snippet}`).join('\n');
  return { text: body };
}

// Phase 3 #6: aggregate session metrics. Reads .ijfw/metrics/sessions.jsonl,
// tolerates v1 lines (treats missing token/cost fields as 0), groups by day,
// renders compact text. Positive-framed zero-state when no sessions logged yet.
function handleMetrics({ period = '7d', metric = 'tokens' } = {}) {
  const file = join(IJFW_DIR, 'metrics', 'sessions.jsonl');
  const r = readMarkdownFile(file);
  if (!r.ok) {
    return { text: 'Ready to track -- run a session and metrics will populate here.' };
  }

  const lines = r.content.split('\n').filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  if (rows.length === 0) {
    return { text: 'Ready to track -- run a session and metrics will populate here.' };
  }

  // Window filter (UTC day comparison via ISO prefix).
  const now = Date.now();
  const cutoff = period === 'today' ? now - 24 * 3600e3
              : period === '7d'    ? now - 7 * 24 * 3600e3
              : period === '30d'   ? now - 30 * 24 * 3600e3
              : 0;
  const within = rows.filter(row => {
    if (!row.timestamp) return false;
    const t = Date.parse(row.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (within.length === 0) {
    return { text: `Window ${period}: no sessions yet. Earlier history available -- try period: 'all'.` };
  }

  if (metric === 'sessions') {
    const handoffs = within.filter(r => r.handoff).length;
    const memEntries = within.reduce((s, r) => s + (r.memory_stores || 0), 0);
    return { text: [
      `Sessions in ${period}: ${within.length}`,
      `Handoffs preserved: ${handoffs} (${Math.round(100 * handoffs / within.length)}%)`,
      `Memory entries logged: ${memEntries}`
    ].join('\n') };
  }

  if (metric === 'routing') {
    const counts = {};
    for (const r of within) counts[r.routing || 'native'] = (counts[r.routing || 'native'] || 0) + 1;
    return { text: ['Routing mix:'].concat(
      Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`)
    ).join('\n') };
  }

  // Group by UTC day for tokens / cost.
  const byDay = {};
  for (const row of within) {
    const day = String(row.timestamp).slice(0, 10);
    byDay[day] = byDay[day] || { in: 0, out: 0, cr: 0, cc: 0, cost: 0, n: 0 };
    byDay[day].in   += row.input_tokens || 0;
    byDay[day].out  += row.output_tokens || 0;
    byDay[day].cr   += row.cache_read_tokens || 0;
    byDay[day].cc   += row.cache_creation_tokens || 0;
    byDay[day].cost += row.cost_usd || 0;
    byDay[day].n    += 1;
  }

  const days = Object.keys(byDay).sort();
  if (metric === 'cost') {
    const total = days.reduce((s, d) => s + byDay[d].cost, 0);
    const lines = ['Day        | sessions | cost (USD)'];
    for (const d of days) lines.push(`${d} | ${String(byDay[d].n).padStart(8)} | $${byDay[d].cost.toFixed(4)}`);
    lines.push(`Total: $${total.toFixed(4)} across ${within.length} session(s) -- clean session-ends only.`);
    return { text: lines.join('\n') };
  }

  // tokens (default)
  const totals = days.reduce((acc, d) => {
    acc.in += byDay[d].in; acc.out += byDay[d].out; acc.cr += byDay[d].cr; acc.cc += byDay[d].cc;
    return acc;
  }, { in: 0, out: 0, cr: 0, cc: 0 });
  const out = ['Day        | sessions | input | output | cache-read'];
  for (const d of days) {
    const r = byDay[d];
    out.push(`${d} | ${String(r.n).padStart(8)} | ${r.in.toLocaleString().padStart(7)} | ${r.out.toLocaleString().padStart(7)} | ${r.cr.toLocaleString().padStart(10)}`);
  }
  out.push(`Total: ${(totals.in + totals.out).toLocaleString()} tokens (${totals.in.toLocaleString()} in / ${totals.out.toLocaleString()} out / ${totals.cr.toLocaleString()} cache-read).`);
  return { text: out.join('\n') };
}

function handleStatus() {
  const sessionCount = getSessionCount();
  const decisionCount = getDecisionCount();
  const hasKnowledge = existsSync(join(MEMORY_DIR, 'knowledge.md'));
  const hasHandoff = existsSync(join(MEMORY_DIR, 'handoff.md'));
  const hasGlobal = readGlobalKnowledge().trim().length > 0;

  const parts = [];
  if (hasKnowledge) {
    const kb = readKnowledgeBase();
    const kbLines = kb.split('\n').filter(l => l.trim().startsWith('**')).length;
    parts.push(`Knowledge: ${kbLines} entries`);
  }
  if (sessionCount > 0 || decisionCount > 0) {
    parts.push(`History: ${sessionCount} sessions, ${decisionCount} decisions`);
  }
  if (hasHandoff) {
    const handoff = readHandoff();
    const statusLine = handoff.split('\n').find(l => l.trim().length > 0 && !l.startsWith('<!--') && !l.startsWith('#'));
    if (statusLine) parts.push(`Last: ${statusLine.trim().substring(0, 150)}`);
  }
  if (hasGlobal) parts.push('Project preferences loaded');

  return { text: parts.join('\n') || 'Fresh project -- no memory yet.' };
}

// --- MCP Protocol Handler (JSON-RPC 2.0 over stdio) ---

function createResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function createError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(msg) {
  const { method, params, id } = msg;

  switch (method) {
    case 'initialize':
      return createResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'ijfw-memory', version: PKG_VERSION, schemaVersion: SCHEMA_VERSION }
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'tools/list':
      return createResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      // ijfw_run is async; wrap the entire case in a Promise so the caller
      // can await it. All other cases resolve synchronously via Promise.resolve().
      return (async () => {
      let result;
      try {
        switch (name) {
          case 'ijfw_update_check': {
            const r = ijfwUpdateCheck(args || {});
            result = { text: JSON.stringify(r, null, 2), isError: !!(r && r.error) };
            break;
          }
          case 'ijfw_update_apply': {
            const r = ijfwUpdateApply(args || {});
            result = { text: JSON.stringify(r, null, 2), isError: r && r.status === 'error' };
            break;
          }
          case 'ijfw_memory_recall':
            result = handleRecall(args || {});
            emitRecallObservation(args || {});
            break;
          case 'ijfw_memory_store':
            result = handleStore(args || {});
            break;
          case 'ijfw_memory_search':
            result = handleSearch(args || {});
            break;
          case 'ijfw_memory_status':
            result = handleStatus();
            break;
          case 'ijfw_memory_prelude':
            result = handlePrelude(args || {});
            break;
          case 'ijfw_metrics':
            result = handleMetrics(args || {});
            break;
          case 'ijfw_cross_project_search':
            result = handleCrossProjectSearch(args || {});
            break;
          case 'ijfw_prompt_check': {
            const pc = checkPrompt((args && args.prompt) || '');
            const text = pc.vague
              ? `vague: yes\nsignals: ${pc.signals.join(', ')}\nsuggestion: ${pc.suggestion}`
              : `vague: no${pc.bypass_reason ? ` (bypass: ${pc.bypass_reason})` : pc.signals.length ? ` (signals: ${pc.signals.join(', ')} -- below threshold)` : ''}`;
            result = { text };
            break;
          }
          case 'ijfw_run': {
            purgeSandboxOld();
            const { command, label: userLabel, cwd } = args || {};
            if (!command || typeof command !== 'string') {
              result = { text: 'command is required and must be a string.', isError: true };
              break;
            }
            const runResult = await runCommand(command, { cwd });
            const { stdout, exitCode, durationMs, lines, bytes, timedOut } = runResult;

            const INLINE_LINES = 40;
            const INLINE_BYTES = 50 * 1024;

            if (lines <= INLINE_LINES && bytes <= INLINE_BYTES && !timedOut) {
              result = { text: stdout || '(no output)', isError: exitCode !== 0 };
              break;
            }

            const stripped = stripAnsi(stdout);
            const domain = detectDomain(stripped);
            const label = userLabel || `run-${Date.now()}`;
            const summary = summarize(stripped, domain, command, exitCode, durationMs);
            writeToSandbox(label, command, stripped, { exitCode, lines, bytes });

            result = {
              text: summary + '\n\nFull output sandboxed. Retrieve: ijfw_memory_search({ scope: "sandbox", label: "' + label + '" })',
              isError: exitCode !== 0,
            };
            break;
          }
          default:
            return createError(id, -32601, `Unknown tool: ${name}`);
        }

        // Handlers now return {text, isError?}. Forward both to the MCP client
        // so failures aren't silently labelled as success.
        return createResponse(id, {
          content: [{ type: 'text', text: String(result.text) }],
          isError: result.isError === true
        });
      } catch (err) {
        return createResponse(id, {
          content: [{ type: 'text', text: `Internal error: ${err.message}` }],
          isError: true
        });
      }
      })(); // end async IIFE for tools/call
    }

    case 'resources/list':
      return createResponse(id, { resources: [] });
    case 'resources/read':
      return createError(id, -32601, 'No resources available');
    case 'resources/templates/list':
      return createResponse(id, { resourceTemplates: [] });
    case 'prompts/list':
      return createResponse(id, { prompts: [] });
    case 'prompts/get':
      return createError(id, -32601, 'No prompts available');
    case 'ping':
      return createResponse(id, {});

    default:
      if (id) return createError(id, -32601, `Method not found: ${method}`);
      return null;
  }
}

// --- stdio Transport ---
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' }
    }) + '\n');
    return;
  }
  try {
    const response = handleMessage(msg);
    if (response && typeof response.then === 'function') {
      response.then(r => { if (r) process.stdout.write(r + '\n'); }).catch(err => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg && msg.id ? msg.id : null,
          error: { code: -32603, message: `Internal error: ${err.message}` }
        }) + '\n');
      });
    } else if (response) {
      process.stdout.write(response + '\n');
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg && msg.id ? msg.id : null,
      error: { code: -32603, message: `Internal error: ${err.message}` }
    }) + '\n');
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => {
  process.stderr.write(`IJFW: uncaught: ${err.stack || err.message}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`IJFW: unhandled rejection: ${err}\n`);
});

// Export for tests (Node ESM allows this -- only consumed when imported, not on stdio run)
export { sanitizeContent, atomicWrite, readMarkdownFile, PROJECT_HASH };
