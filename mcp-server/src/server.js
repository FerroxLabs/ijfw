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
import { resolveBrainPaths } from './brain/paths.js';
import { migrateFactsInternalOnce } from './brain/migrate-facts-internal-once.js';
// v1.5.2.1 F1: fs-layout migration 010 (visible ijfw/ layer). NOT a SQL
// migration — runs at server startup alongside the facts relocation, gated
// by the .layout-version sentinel rather than by SQLite user_version. Async;
// awaited at top level below.
import { up as runVisibleLayerMigration } from './memory/migrations/010-visible-layer.js';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash, randomBytes } from 'crypto';

// Read version dynamically from package.json so bumps don't require a code change.
const __pkg_dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__pkg_dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();
import { checkPrompt } from './prompt-check.js';
import { handleIjfwBrain, IJFW_BRAIN_VERBS } from './handlers/brain-handler.js';
import { applyCaps, CAP_CONTENT } from './caps.js';
import { ensureSchemaHeader, SCHEMA_HEADER } from './schema.js';
import { searchCorpus } from './search-bm25.js';
// r17 (cold-tier wire-up): hybrid BM25+vector ranking when IJFW_VECTORS=on AND
// @xenova/transformers is installed. Silent BM25-only fallback otherwise.
// Lives in its own module so tests can drive the rerank helper without
// importing server.js (whose stdio bootstrap would hang the test runner).
import { maybeRerankWithVectors } from './search-hybrid.js';
import { crossProjectSearch } from './cross-project-search.js';
// R2-E -- single source of truth for markdown/HTML/control-char defanger.
import { sanitizeContent } from './sanitizer.js';
// v1.5.1 R4-H3 — secret redaction on the direct ijfw_store write path.
// The redactor is already wired into FTS5 ingest + auto-memorize; the
// direct MCP store was the one bypass, so a secret pasted into an
// ijfw_store call could land in .ijfw/memory/*.md cleartext.
import { redactSecrets } from './redactor.js';
// H5.5 / H5.6 — ingest-time fact extraction + semantic dedup. Closes
// memory-engine.md competitor gaps (mem0/Zep extract facts; Graphiti dedups).
// Both are pure-JS, zero-LLM, deterministic.
import { extractFacts, factToJsonl } from './memory/fact-extractor.js';
import { findNearDuplicate, readDedupConfig } from './memory/dedup.js';
// v1.5.0 audit H5.4 — Graphiti-style bi-temporal validity. Lets storing a
// contradictory fact close the prior's valid_to instead of accumulating.
import {
  openTemporalDbSync,
  storeFactBitemporal,
  getValidAt as temporalGetValidAt,
  getHistory as temporalGetHistory,
  getAllFactsWithWindows as temporalGetAllFactsWithWindows,
} from './memory/temporal.js';
// 1.1.6: update tools (cap 8 -> 10) -- token-issuance + OOB terminal confirm.
// Per CLAUDE.md policy: future growth triggers retirement review, not raise.
import { ijfwUpdateCheck, TOOL_DEF as UPDATE_CHECK_TOOL } from './update-check.js';
import { ijfwUpdateApply, TOOL_DEF as UPDATE_APPLY_TOOL } from './update-apply.js';
// ijfw_run: sandbox large command output to disk, return terse summary to context.
import { runCommand, detectDomain, summarize, writeToSandbox, readFromSandbox, purgeSandboxOld, stripAnsi } from './sandbox.js';
// W1B (1.3.0-alpha) -- colon-syntax dispatcher. Extends ijfw_run + ijfw_memory_search
// with compute:/index:/detect: sub-commands without registering new MCP tools.
import { parseColonCommand, dispatchRun, dispatchSearch } from './dispatch/colon-syntax.js';
// W7/B2 -- runtime sandbox mediation. With no installed extension active,
// getActiveExtension() returns null and checkPermission() allows everything
// (backwards-compat invariant). With an active extension, each MCP tool call
// is gated against its declared permissions before the handler runs.
import {
  getActiveExtension,
  checkPermission,
  logPermissionEvent,
  toolNameToActionTarget,
} from './runtime-mediator.js';
// B16/SEC-M-03 — quota tracker. The combined permission+quota gate lives
// here in server.js (NOT runtime-mediator.js, which is primitives-only).
import { checkAndIncrement as quotaCheckAndIncrement } from './extension-quota-tracker.js';
import { findInstalledManifest } from './active-extension-writer.js';

/**
 * Combined permission + quota gate (SEC-M-03).
 *
 * Single enforcement site for the MCP tool dispatch. Replaces the inline
 * `checkPermission` block. Exported so `test-server-quota-integration.js` can
 * exercise the gate directly without spinning a full MCP server.
 *
 * Back-compat: when `activeExt === null` (no active extension), returns
 * `{ allowed: true }` immediately — preserves bundled-IJFW behavior.
 *
 * Per-tool quota dimension mapping:
 *   - ijfw_memory_store → bytes_written (sum of stored payload string lengths)
 *   - ijfw_run with tool:write|edit|bash → files_written + bytes_written
 *   - wall_clock_ms: checked-not-incremented on every tool call
 *
 * @returns {Promise<{ allowed: boolean, response?: object, dimension?: string, current?: number, limit?: number, reason?: string }>}
 */
export async function gatePermissionAndQuota({ toolName, args, activeExt, home, manifestQuotas }) {
  if (activeExt === null || activeExt === undefined) {
    return { allowed: true };
  }
  const mapping = toolNameToActionTarget(toolName, args || {});
  if (!mapping) {
    return { allowed: true };
  }
  const permCheck = checkPermission(mapping.action, mapping.target, activeExt);
  if (!permCheck.allowed) {
    // Log permission deny — preserves the v1.4.1 audit-trail behavior.
    await logPermissionEvent({
      tool: toolName,
      extension: activeExt && activeExt.name ? activeExt.name : null,
      action: mapping.action,
      target: mapping.target,
      allowed: false,
      reason: permCheck.reason,
      ts: new Date().toISOString(),
    }).catch(() => {});
    return {
      allowed: false,
      reason: permCheck.reason,
      response: {
        content: [{ type: 'text', text: `extension permission denied: ${permCheck.reason}` }],
        isError: true,
      },
    };
  }

  // Quota enforcement only kicks in when the active extension declared quotas.
  // Manifest quotas are passed in by the caller (resolved from the installed
  // extension manifest). When manifestQuotas is missing/empty, this short-
  // circuits — back-compat path.
  const quotas = manifestQuotas && typeof manifestQuotas === 'object' ? manifestQuotas : {};
  const limits = {
    files_written: typeof quotas.max_files_written === 'number' ? quotas.max_files_written : null,
    bytes_written: typeof quotas.max_bytes_written === 'number' ? quotas.max_bytes_written : null,
    wall_clock_ms: typeof quotas.max_wall_clock_ms === 'number' ? quotas.max_wall_clock_ms : null,
  };

  // wall_clock_ms — always checked (no-op if limit is null).
  if (limits.wall_clock_ms !== null) {
    const wc = await quotaCheckAndIncrement(activeExt.name, 'wall_clock_ms', 0, limits.wall_clock_ms, { homeDir: home });
    if (!wc.allowed) {
      const reason = `quota:wall_clock_ms ${wc.current}/${wc.limit}`;
      await logPermissionEvent({
        tool: toolName, extension: activeExt.name, action: mapping.action, target: mapping.target,
        allowed: false, reason, ts: new Date().toISOString(),
      }).catch(() => {});
      return {
        allowed: false, dimension: 'wall_clock_ms', current: wc.current, limit: wc.limit, reason,
        response: {
          content: [{ type: 'text', text: `extension "${activeExt.name}" exceeded quota wall_clock_ms (${wc.current}/${wc.limit})` }],
          isError: true,
        },
      };
    }
  }

  // Per-tool counter mapping.
  let inc = null;
  if (toolName === 'ijfw_memory_store') {
    let payloadBytes = 0;
    try {
      if (args && typeof args.content === 'string') payloadBytes += args.content.length;
      if (args && typeof args.context === 'string') payloadBytes += args.context.length;
    } catch { /* defensive */ }
    inc = { dim: 'bytes_written', count: payloadBytes, limit: limits.bytes_written, path: null };
  } else if (toolName === 'ijfw_run') {
    // Only run-with-write-tools consume files/bytes quota. We sniff the
    // command for a `tool:write|edit|bash|notebookedit` leading token and
    // an inline path arg (best-effort; absolute path is used for dedupe).
    const cmd = args && typeof args.command === 'string' ? args.command : '';
    const m = cmd.match(/^\s*tool:(write|edit|bash|notebookedit)\b/i);
    if (m) {
      // Pull first absolute-looking path arg, if any.
      const pm = cmd.match(/\b(\/[^\s'"]+|[A-Za-z]:\\[^\s'"]+)/);
      const absPath = pm ? pm[1] : null;
      const sizeArg = args && typeof args.input === 'string' ? args.input.length : 0;
      inc = { dim: 'files_written', count: 1, limit: limits.files_written, path: absPath, bytesCount: sizeArg, bytesLimit: limits.bytes_written };
    }
  }

  if (inc !== null) {
    if (inc.limit !== null) {
      const r = await quotaCheckAndIncrement(activeExt.name, inc.dim, inc.count, inc.limit, { homeDir: home, path: inc.path });
      if (!r.allowed) {
        const reason = `quota:${inc.dim} ${r.current + inc.count}/${r.limit}`;
        await logPermissionEvent({
          tool: toolName, extension: activeExt.name, action: mapping.action, target: mapping.target,
          allowed: false, reason, ts: new Date().toISOString(),
        }).catch(() => {});
        return {
          allowed: false, dimension: inc.dim, current: r.current, limit: r.limit, reason,
          response: {
            content: [{ type: 'text', text: `extension "${activeExt.name}" exceeded quota ${inc.dim} (${r.current + inc.count}/${r.limit})` }],
            isError: true,
          },
        };
      }
    }
    // Bytes side-counter (paired with files_written for ijfw_run write tools).
    if (inc.bytesLimit !== null && typeof inc.bytesCount === 'number' && inc.bytesCount > 0) {
      const r2 = await quotaCheckAndIncrement(activeExt.name, 'bytes_written', inc.bytesCount, inc.bytesLimit, { homeDir: home });
      if (!r2.allowed) {
        const reason = `quota:bytes_written ${r2.current + inc.bytesCount}/${r2.limit}`;
        await logPermissionEvent({
          tool: toolName, extension: activeExt.name, action: mapping.action, target: mapping.target,
          allowed: false, reason, ts: new Date().toISOString(),
        }).catch(() => {});
        return {
          allowed: false, dimension: 'bytes_written', current: r2.current, limit: r2.limit, reason,
          response: {
            content: [{ type: 'text', text: `extension "${activeExt.name}" exceeded quota bytes_written (${r2.current + inc.bytesCount}/${r2.limit})` }],
            isError: true,
          },
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Resolve `manifest.quotas` for the currently active extension by reading the
 * installed manifest. Best-effort: returns {} if the installed manifest can't
 * be found.
 */
async function resolveActiveManifestQuotas(activeExt, projectRoot, home) {
  if (!activeExt || !activeExt.name) return {};
  try {
    const r = await findInstalledManifest(activeExt.name, projectRoot, { homeDir: home });
    if (r && r.ok && r.manifest && r.manifest.quotas && typeof r.manifest.quotas === 'object') {
      return r.manifest.quotas;
    }
  } catch { /* best-effort */ }
  return {};
}
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
// REPO_ROOT is the parent of .ijfw/ — required by resolveBrainPaths.
const REPO_ROOT = dirname(IJFW_DIR);
// paths() re-reads the layout sentinel on every call so a long-running server
// process picks up the migration-010 sentinel flip without restart.
function paths() { return resolveBrainPaths(REPO_ROOT); }
// v1.5.2 F5: one-shot move of FACTS_FILE / FACTS_DB_FILE from the legacy
// .ijfw/memory/ location into the .ijfw/ internal-only location they were
// designed for. Sync + idempotent — safe at every module-load. Must run
// BEFORE FACTS_FILE / FACTS_DB_FILE consts evaluate so they pick up the
// new path.
migrateFactsInternalOnce(REPO_ROOT);
// v1.5.2.1 F1: invoke the fs-layout migration explicitly. Was previously
// auto-discovered by the SQL migration runner and would crash every
// memory-db open with `TypeError: Path must be a string. Received <Database>`
// because runMigrations passes a db handle as the first arg but 010 expects
// repoRoot. The SQL=false export in 010 now opts it out of the SQL runner;
// this top-level await is its only invocation path. Best-effort: a failure
// here must not block the rest of server startup, so the catch logs to
// stderr and continues (the operator can re-run on next boot once the
// underlying fs issue is resolved).
//
// Entry-point gate (v1.5.2.1 follow-up): only fire when server.js is the
// Node entry point. Without this gate, any module that imports server.js
// (tests, the dashboard backend, future helpers) would trigger the
// visible-layer scaffold against the importer's cwd — creating stray
// `ijfw/` trees in places that aren't IJFW projects (test artifacts,
// CI scratch dirs, etc.). The visible layer is a real feature for
// end-user projects (this is where users drop files into dump/inbox and
// where the wiki appears for sharing) — it MUST be created when a user
// actually launches the MCP server in their project, but it MUST NOT
// be created as a side effect of an import.
const __isServerEntryPoint = (() => {
  try {
    const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
    return entry === import.meta.url;
  } catch { return false; }
})();
if (__isServerEntryPoint) {
  try {
    await runVisibleLayerMigration(REPO_ROOT);
  } catch (e) {
    try {
      process.stderr.write(`[ijfw layout-migrate] failed: ${e && e.message ? e.message : e}\n`);
    } catch { /* stderr may be detached during smoke tests */ }
  }
}
// Back-compat values for the line-2349 re-export. New code MUST use paths().memoryDir / paths().sessionsDir.
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
  [paths().memoryDir, paths().sessionsDir].forEach(dir => {
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
// entries are bounded at MAX_STORE_LENGTH=4096 chars (CAP_CONTENT in caps.js),
// but the entry header keeps each *line* well under 4KB after sanitization
// (single-line collapse). Audit MED #8 / F-COR-1: doc-vs-code parity fix --
// the prior text said 5000, which had drifted from the actual cap.

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
  const journalPath = join(paths().memoryDir, 'project-journal.md');
  const ts = new Date().toISOString();
  const line = `- [${ts}] ${entry}`;
  return appendLine(journalPath, line);
}

// Structured append for decisions/patterns -- produces a richer frontmatter block
// similar to Claude's native auto-memory format: YAML frontmatter plus a body with
// Why / How-to-apply sections. This is the format users retrieve well from.
function appendStructuredToKnowledge({ type, summary, content, why, howToApply, tags }) {
  const filepath = join(paths().memoryDir, 'knowledge.md');
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
  return readOr(join(paths().memoryDir, 'knowledge.md'));
}
function readHandoff() {
  return readOr(join(paths().memoryDir, 'handoff.md'));
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

function getRecentJournalEntries(count = 5) {
  const journal = readOr(join(paths().memoryDir, 'project-journal.md'));
  if (!journal) return '';
  const entries = journal.split('\n').filter(l => /^- \[\d{4}-/.test(l));
  return entries.slice(-count).join('\n');
}

// H5.6 — dedup needs `recents` shaped as { id, content } for findNearDuplicate.
// We synthesize id from the timestamp (project-journal entries are unique by ts
// down to ms; collisions would only happen on near-simultaneous writes which
// our atomic-append + fs flush ordering already serialise).
function getRecentMemoriesForDedup(limit = 50) {
  const journal = readOr(join(paths().memoryDir, 'project-journal.md'));
  if (!journal) return [];
  const lines = journal.split('\n').filter(l => /^- \[\d{4}-/.test(l));
  // Most-recent-last in the file → reverse so findNearDuplicate sees newest first.
  const slice = lines.slice(-limit).reverse();
  return slice.map(line => {
    // Format: "- [<iso>] <body>"   →   { id: iso, content: body }
    const m = line.match(/^- \[([^\]]+)\]\s*(.*)$/);
    if (!m) return null;
    return { id: m[1], content: m[2] };
  }).filter(Boolean);
}

// H5.5 — sidecar file for structured facts (one JSON object per line).
// Append-only; consumed by handleRecall({context_hint:'facts'}).
// v1.5.2 F5: now resolves via paths().factsJsonl (.ijfw/facts.jsonl) — internal
// hidden location per Task 3 design. The one-shot migrateFactsInternalOnce()
// call above relocated existing data from the legacy .ijfw/memory/ location.
const FACTS_FILE = paths().factsJsonl;

// Stable short id for joining a fact back to its journal entry. We don't have
// a uuid; the journal-line text itself + ts is unique enough for cross-ref.
function factMemoryIdFor(journalEntryText) {
  return 'm-' + createHash('sha256')
    .update(String(journalEntryText) + ':' + Date.now())
    .digest('hex')
    .slice(0, 10);
}

function appendFactsToSidecar(facts, meta) {
  if (!Array.isArray(facts) || facts.length === 0) return { ok: true, written: 0 };
  try {
    const lines = facts.map(f => factToJsonl(f, meta)).join('\n') + '\n';
    appendFileSync(FACTS_FILE, lines);
    return { ok: true, written: facts.length };
  } catch (err) {
    // Non-fatal: facts are augmentation, not source-of-truth. Journal already
    // captured the raw memory.
    return { ok: false, code: err.code || 'EUNKNOWN', message: err.message };
  }
}

// v1.5.0 audit H5.4 — sibling SQL store for bi-temporal facts. Lives next to
// facts.jsonl so the JSONL sidecar (append-only timeline log) and the SQL
// table (queryable point-in-time view) stay co-located. Lazy-opened on first
// use so a project that never stores a memory never pays the better-sqlite3
// load cost.
// v1.5.2 F5: now resolves via paths().indexDb (.ijfw/index/memory.db) — internal
// hidden location per Task 3 design. Data migrated by migrateFactsInternalOnce().
const FACTS_DB_FILE = paths().indexDb;
let _factsDbHandle = null;
function getFactsDb() {
  if (_factsDbHandle) return _factsDbHandle;
  try {
    _factsDbHandle = openTemporalDbSync(FACTS_DB_FILE);
    return _factsDbHandle;
  } catch (err) {
    // Non-fatal. JSONL sidecar still gets written; we just lose the bi-temporal
    // SQL view for this process. Surface via stderr so operators see the
    // degradation but the user-facing store result still says "ok".
    try {
      process.stderr.write(`[ijfw temporal] facts.db unavailable (${err.code || err.message}); SQL fact view degraded\n`);
    } catch { /* stderr may be detached */ }
    return null;
  }
}

// writeFactsBitemporal -- for each extracted fact, close any prior currently-
// valid fact with the same (subject, predicate) but different object, then
// insert the new fact. Wrapped in a per-fact transaction inside temporal.js's
// storeFactBitemporal helper. Best-effort: a SQL failure logs to stderr but
// never breaks the journal-or-JSONL path.
function writeFactsBitemporal(facts, meta) {
  if (!Array.isArray(facts) || facts.length === 0) return { ok: true, written: 0, invalidated: 0 };
  const db = getFactsDb();
  if (!db) return { ok: false, code: 'ENOFACTSDB', written: 0, invalidated: 0 };
  let written = 0;
  let invalidated = 0;
  for (const f of facts) {
    try {
      const r = storeFactBitemporal(db, {
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence,
        memory_id: meta && meta.memory_id,
        source: meta && meta.source,
      }, meta && meta.ts);
      invalidated += r.invalidated;
      if (!r.deduped) written += 1;
    } catch (err) {
      try {
        process.stderr.write(`[ijfw temporal] storeFactBitemporal failed: ${err.message}\n`);
      } catch { /* stderr may be detached */ }
    }
  }
  return { ok: true, written, invalidated };
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

// v1.5.1 H1.5 (audit memory-engine.md F-FUN-4): the legacy naive-keyword-count
// `searchAcrossProjects` was removed. `scope:'all'` now routes to the BM25-
// ranked `crossProjectSearch` in cross-project-search.js (which already
// returns the same `{ source, line, content, score }` shape via the
// `[project:<name>]` content prefix). Two parallel cross-project surfaces
// existed; the worse one was the default. Now there is one.

// --- Search ---
// P5.1 / H4 -- BM25 ranking over line-level docs. Source tags and line
// numbers preserved so callers get the same output shape; scoring is
// BM25 (IDF + TF + length-normalized) with per-source boost. Team tier
// ranks first via a score bump for ties.
//
// r17 (cold-tier wire-up): when IJFW_VECTORS=on AND @xenova/transformers is
// installed AND the model is loadable, the BM25 top-K is reranked via cosine
// similarity over the snippet text (blended weights wBm25=0.6, wVec=0.4 from
// vectors.js defaults). Async because embedder load + embed() are async. The
// `opts.embedder` parameter lets tests inject a mock embedder without
// installing @xenova/transformers.

// v1.5.0 wire-W1.C — lazy memory.db handle for the embedding cache.
// Opens once per process and reuses thereafter. Returns null when the
// project has no .ijfw/index/memory.db (e.g. fresh checkout that never
// stored a memory) so the rerank still falls back to live embed.
let _memoryDbForRerank = null;
async function getMemoryDbForRerank() {
  if (_memoryDbForRerank) return _memoryDbForRerank;
  try {
    const { openDb } = await import('./memory/fts5.js');
    _memoryDbForRerank = await openDb(PROJECT_DIR);
    return _memoryDbForRerank;
  } catch {
    _memoryDbForRerank = null;
    return null;
  }
}

async function searchMemory(query, limit = 10, scope = 'project', opts = {}) {
  limit = Math.min(Math.max(1, limit | 0), MAX_SEARCH_RESULTS);
  if (scope === 'all') {
    // v1.5.1 H1.5 (audit memory-engine.md F-FUN-4): use BM25-ranked
    // crossProjectSearch, not the legacy naive keyword-count scan.
    const projects = readRegistry();
    if (projects.length === 0) return [];
    return crossProjectSearch(query, projects, readProjectMemory, { limit });
  }

  const sources = [
    { name: 'team',          content: readTeamKnowledge(),                          boost: 1.25, path: join(paths().memoryDir, 'team-knowledge.md') },
    { name: 'knowledge',     content: readKnowledgeBase(),                          boost: 1.15, path: join(paths().memoryDir, 'knowledge.md') },
    { name: 'journal',       content: readOr(join(paths().memoryDir, 'project-journal.md')), boost: 1.0,  path: join(paths().memoryDir, 'project-journal.md') },
    { name: 'handoff',       content: readHandoff(),                                boost: 1.1,  path: join(paths().memoryDir, 'handoff.md') },
    { name: 'global',        content: readGlobalKnowledge(),                        boost: 0.95, path: null },
    { name: 'claude-native', content: readNativeClaudeMemory(),                     boost: 0.95, path: null },
  ];

  // v1.5.0 audit MED #12 (memory-engine.md F-FUN-5): recency decay on the
  // boosted map. Each source file has an mtime; per-result age (days since
  // mtime) feeds Math.exp(-ageDays / 90), so a 90-day-old source decays
  // by ~1/e (0.37) and a 1-year-old source by ~0.018. Fresh entries
  // (< 1 day) stay essentially unchanged (~0.99). Sources without a file
  // (global, claude-native) get no decay (multiplier 1.0).
  const RECENCY_HALFLIFE_DAYS = 90;
  const nowMs = Date.now();
  const sourceDecay = new Map();
  for (const src of sources) {
    if (!src.path) { sourceDecay.set(src.name, 1); continue; }
    let ageDays = 0;
    try {
      const st = statSync(src.path);
      ageDays = Math.max(0, (nowMs - st.mtimeMs) / 86400000);
    } catch { ageDays = 0; }
    sourceDecay.set(src.name, Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS));
  }

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

  // r17: cold-tier hybrid rerank. Pure no-op when vectors disabled OR
  // embedder unavailable. Never throws into the caller.
  //
  // v1.5.0 wire-W1.C: when the caller didn't supply a db handle but the
  // memory.db exists for this project, open it lazily + thread through so
  // the embedding cache backs the rerank. The default modelId mirrors
  // vectors.js DEFAULT_MODEL so first-call writes match cache reads from
  // the same process on later calls.
  //
  // r20-MED fix: previously the lazy-open was SKIPPED whenever opts.embedder
  // was supplied (intended as a test-seam guard). That meant any caller
  // passing a custom embedder (e.g. an HTTP-backed one) lost the cache.
  // Now: always lazy-open when !opts.db. Tests that want to disable the
  // cache pass opts.db = null explicitly.
  const rerankOpts = { ...opts };
  if (!rerankOpts.db && rerankOpts.db !== null) {
    try {
      rerankOpts.db = await getMemoryDbForRerank();
    } catch { /* memory db unavailable -- skip cache, fall back to live embed */ }
  }
  if (!rerankOpts.modelId) {
    rerankOpts.modelId = process.env.IJFW_VECTORS_MODEL || 'Xenova/all-MiniLM-L6-v2';
  }
  const reranked = await maybeRerankWithVectors(query, ranked, rerankOpts);

  const boosted = reranked.map(r => {
    const m = meta.get(r.id);
    const decay = sourceDecay.get(m.source) ?? 1;
    return {
      source: m.source,
      line: m.line,
      content: (r.snippet || '').substring(0, 200),
      score: r.score * (m.boost || 1) * decay,
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
        content: { type: 'string', description: 'Full statement of what to remember. Max 4096 chars. Sanitised on storage.' },
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
    description: 'Keyword search across memory sources. Up to 20 results. Scope defaults to current project; pass scope:"all" to search across every IJFW project ever opened on this machine (results tagged [project:<name>]). Pass scope:"sandbox" to retrieve sandboxed ijfw_run output -- include label to get the full output of a specific run, or omit label to list all available sandbox entries. The query field also accepts colon-namespaced commands: "compute:<query>" hits the per-project FTS5 index, "graph:<query>" routes through the knowledge-graph search.',
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
    // v1.5.0 M5 (INT.6) -- bi-temporal facts MCP surface.
    name: 'ijfw_memory_facts',
    description: 'Query the bi-temporal facts table (subject/predicate/object timeline with valid_from / valid_to). Default: current-valid rows only. Pass history=true for full timeline; pass valid_at=<ISO-8601> for point-in-time. Subject + predicate are required.',
    inputSchema: {
      type: 'object',
      properties: {
        subject:   { type: 'string', description: 'Fact subject (e.g. "v1.5.0").' },
        predicate: { type: 'string', description: 'Fact predicate (e.g. "ship_date").' },
        valid_at:  { type: 'string', description: 'Optional ISO-8601 timestamp. Returns rows whose validity window covers this instant.' },
        history:   { type: 'boolean', description: 'If true, return all rows (current + invalidated) ordered DESC by valid_from.' }
      },
      required: ['subject', 'predicate']
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
        period: { type: 'string', enum: ['today', '7d', '30d', 'all'], default: '7d', description: 'Time window (default 7d).' },
        metric: { type: 'string', enum: ['tokens', 'cost', 'sessions', 'routing'], default: 'tokens', description: 'Which metric to render (default tokens).' }
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
    description: 'Run a shell command. For commands likely to produce large output (builds, test suites, grep -r, log tails), use this instead of Bash -- full output is sandboxed to disk and a smart summary is returned to context. For git/nav/quick ops, use Bash directly. Also accepts colon-namespaced commands instead of a shell line: "compute:python", "compute:js", "index:<source>", "detect:project_type".',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        label: { type: 'string', description: 'Optional label for sandbox retrieval. Auto-generated if omitted.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to process.cwd().' },
      },
      required: ['command'],
    },
  },
  {
    // v1.5.2 T24-27+T29: ijfw_brain — combined brain-query tool (slot 14/14).
    // Replaces what would have been 4 standalone tools; combined-tool pattern
    // keeps the cap raise to +1 instead of +4.
    name: 'ijfw_brain',
    description: 'IJFW Brain — query, links, wiki, conflict-resolve in one combined tool. verb=' + IJFW_BRAIN_VERBS.join('|'),
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', enum: IJFW_BRAIN_VERBS, description: 'Brain verb: think|links|wiki.get|wiki.compile|wiki.promote|wiki.export|wiki.shareReadme|conflict.resolve' },
        args: { type: 'object', description: 'Verb-specific arguments (see verb docs).' },
      },
      required: ['verb'],
    },
  },
  {
    // v1.5.0 T13: ijfw_state — single MCP face for the state-SDK verb facade.
    // Absorbs the retired ijfw_subagent_post_done tool (post-done IS a state
    // transition → reachable as the `subagent.post-done` verb). All 20 frozen
    // verbs from STATE-SDK-CONTRACT §7 are reachable through this one tool,
    // keeping the MCP cap at 13/13. The same `query(verb, payload, ctx)` core
    // is also exposed as a JS import and a CLI colon-namespace (`ijfw state:<verb>`).
    name: 'ijfw_state',
    description: 'State-SDK verb facade — invoke any of the 20 frozen verbs over the canonical physical state files. The 20 verbs: workflow.get, workflow.set-phase, wave.get, wave.advance, wave.record-task, phase.plan-check, phase.complete, subagent.dispatch, subagent.checkpoint, subagent.post-done, event.emit, telemetry.record, roster.synthesize, roster.record, extension.set-active, decision.add, blocker.add, blocker.resolve, state.replay, state.validate. Single MCP face for the state-SDK; subagent.post-done is the verb that absorbed the retired ijfw_subagent_post_done tool. Returns the verb result with `ok` + `verbId` + verb-specific fields (see STATE-SDK-CONTRACT §7).',
    inputSchema: {
      type: 'object',
      properties: {
        verb:        { type: 'string', description: 'Verb name from the frozen 20-verb registry (e.g. "workflow.get", "wave.advance", "subagent.post-done", "state.validate").' },
        payload:     { type: 'object', description: 'Verb-specific payload (see STATE-SDK-CONTRACT §7 for each verb signature). Defaults to {} when omitted.' },
        projectRoot: { type: 'string', description: 'Project root for ctx (defaults to process.cwd()).' },
        subagentId:  { type: 'string', description: 'Subagent id stamped on event/telemetry records (defaults to "parent").' },
        homeDir:     { type: 'string', description: 'Home dir override for the homedir-scope active-extension file (defaults to process.env.HOME / USERPROFILE / os.homedir()).' },
      },
      required: ['verb'],
    },
  },
  {
    // v1.5.0-major W12-C N03: Trident-as-a-service.  Multi-lens consensus
    // convergence (lock-in #47 — canonical Phase E).  Dispatches all 3 lenses
    // (codex/gemini/claude by default) in parallel; if verdicts diverge,
    // re-runs with a CYCLE_SUMMARY of the disagreement until consensus or
    // maxIterations (default 3).  Stall breaker halts on byte-identical
    // iterations.  Slot 12 of the 13/13 tool cap.
    name: 'ijfw_cross_audit_converge',
    description: 'Multi-lens Trident audit with consensus convergence loop. Dispatches codex/gemini/claude in parallel against a commit range, detects verdict divergence, and re-runs with a cycle summary until consensus or maxIterations. Returns {verdict, iterations, findings, divergence?, stalled?}. Verdict: PASS / CONDITIONAL / FAIL / consensus_failed / UNREACHABLE.',
    inputSchema: {
      type: 'object',
      properties: {
        commitRange:   { type: 'string',  description: 'Git commit range to audit (e.g. "HEAD~1..HEAD", "main..feature/x"). Required.' },
        maxIterations: { type: 'number',  minimum: 1, maximum: 10, description: 'Max convergence iterations (default 3, capped at 10). 1 → single-shot (fallback mode).' },
        lenses:        { type: 'array',   items: { type: 'string' }, description: 'Lens ids to dispatch (default ["codex","gemini","claude"]).' },
        autoFix:       { type: 'boolean', description: 'v1.5.1 (T27) — opt-in consensus auto-fix. When true, after a non-PASS convergence the consensus code-fixer AUTOMATICALLY MODIFIES CODE: it runs an atomic per-finding fix loop (one revertable git commit per fix) over HIGH findings that 2+ lenses agreed on. SAFETY BOUNDS: the fixer can only write files inside the audited project root (path-containment guard refuses out-of-root paths) and touches at most 10 distinct files per run (change cap — beyond it it stops and reports rather than mass-rewriting). Logic bugs are deferred to humans, never auto-patched. Results surface on result.autoFix without changing the verdict. Default false — the audit is read-only unless you explicitly opt in.' },
      },
      required: ['commitRange'],
    },
  }
];

// --- Tool Handlers ---

function handleRecall({ context_hint, detail_level = 'standard', from_project }) {
  // Cross-project explicit pull. We bypass current-project sources and read
  // the target project's knowledge/handoff/journal directly. Search queries
  // are routed through crossProjectSearch (BM25) via scope:'all' on the
  // search tool; recall here is for "give me everything from X."
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

  // H5.5 / v1.5.0 H5.4 — structured facts feed.
  //   context_hint === 'facts'         -> only currently-valid facts (SQL
  //                                       getValidAt(now)); fallback to raw
  //                                       facts.jsonl if the SQL table is
  //                                       empty/unavailable (back-compat for
  //                                       pre-H5.4 installations).
  //   context_hint === 'facts:history' -> full timeline including invalidated
  //                                       rows (with their valid_from/valid_to
  //                                       windows). If the hint is followed by
  //                                       ":subject/predicate" we narrow to
  //                                       that pair; otherwise return every
  //                                       row.
  if (context_hint === 'facts' || (typeof context_hint === 'string' && context_hint.startsWith('facts:history'))) {
    const isHistory = typeof context_hint === 'string' && context_hint.startsWith('facts:history');
    try {
      const db = getFactsDb();
      if (db) {
        if (isHistory) {
          // Optional ":subject/predicate" narrow-down. Spec: "if subject+
          // predicate keys can be inferred from the recall query; else return
          // all facts with their validity windows".
          const tail = context_hint.slice('facts:history'.length).replace(/^:/, '').trim();
          let rows;
          if (tail) {
            const [subj, pred] = tail.split('/').map(s => s && s.trim()).filter(Boolean);
            if (subj && pred) {
              rows = temporalGetHistory(db, subj, pred);
            } else {
              rows = temporalGetAllFactsWithWindows(db);
            }
          } else {
            rows = temporalGetAllFactsWithWindows(db);
          }
          if (!rows || rows.length === 0) {
            return { text: 'No structured facts extracted yet. Store memories with key:value lines, "X uses Y", or "decided to ..." phrases to populate.' };
          }
          const lines = rows.map(r => JSON.stringify({
            subject: r.subject,
            predicate: r.predicate,
            object: r.object,
            confidence: r.confidence,
            valid_from: r.valid_from,
            valid_to: r.valid_to,
            memory_id: r.memory_id,
            source: r.source,
          }));
          if (detail_level === 'summary') {
            const tailLines = lines.slice(-5).join('\n');
            return { text: `## Fact history (${lines.length} rows)\n${tailLines}` };
          }
          return { text: `## Fact history (${lines.length} rows)\n${lines.join('\n')}` };
        }
        // Default: currently-valid facts only.
        const rows = temporalGetValidAt(db, new Date().toISOString());
        if (rows && rows.length > 0) {
          const lines = rows.map(r => JSON.stringify({
            subject: r.subject,
            predicate: r.predicate,
            object: r.object,
            confidence: r.confidence,
            valid_from: r.valid_from,
            memory_id: r.memory_id,
            source: r.source,
          }));
          if (detail_level === 'summary') {
            const tail = lines.slice(-5).join('\n');
            return { text: `## Currently-valid facts (${lines.length})\n${tail}` };
          }
          return { text: `## Currently-valid facts (${lines.length})\n${lines.join('\n')}` };
        }
        // SQL table empty -- fall through to JSONL back-compat path below.
      }
      if (!existsSync(FACTS_FILE)) {
        return { text: 'No structured facts extracted yet. Store memories with key:value lines, "X uses Y", or "decided to ..." phrases to populate.' };
      }
      const raw = readFileSync(FACTS_FILE, 'utf8');
      // detail_level === 'summary' → just count + a sample tail. Keeps token
      // usage bounded for session-start hydration.
      if (detail_level === 'summary') {
        const lines = raw.split('\n').filter(Boolean);
        const tail = lines.slice(-5).join('\n');
        return { text: `## Structured facts (${lines.length} total)\n${tail}` };
      }
      return { text: raw || 'No structured facts extracted yet.' };
    } catch (err) {
      return { text: `Facts feed unreadable: ${err.code || err.message}`, isError: true };
    }
  }

  const results = searchMemory(context_hint);
  if (results.length === 0) return { text: `No memories matching: ${context_hint}` };
  return { text: results.map(r => `[${r.source}] ${r.content}`).join('\n') };
}

// v1.5.1 R4-H2 — wire the v1.5.0 memory-moat to the real write path.
//
// M1 (Obsidian wikilink/tag/meta indexing -> memory_links/_tags/_meta) and
// M2 (A-Mem auto-linking) only fire inside memory/fts5.js#indexEntry. But the
// production memory writers never called indexEntry: handleStore wrote the
// markdown journal only, and search.js#autoIndex did a raw INSERT. So the
// memory-moat's flagship — "memory that learns about you" — ran ONLY in the
// benchmark harness. This helper routes a real ijfw_store through indexEntry,
// which in one atomic INSERT also fires M1 (synchronous, idempotent) + M2
// (fire-and-forget, env-gated via IJFW_AUTOLINK_OFF, budget-capped).
//
// Best-effort + fire-and-forget: handleStore stays synchronous and a missing
// driver / unmigrated schema / DB error never breaks the markdown-or-JSONL
// store path. The journal markdown remains the source of truth (hot tier);
// the FTS5 row is the warm-tier mirror. Dedup safety: handleStore previously
// did NO DB INSERT at all, so this is a NEW row, not a duplicate of an
// existing write. search.js#autoIndex only batch-rebuilds when the FTS table
// is empty (rowCount === 0) — it will skip an already-populated table — so a
// store followed by a search cannot double-index the same entry.
async function indexStoredEntryToFts5({ body, source, sessionId }) {
  if (typeof body !== 'string' || body.length === 0) return null;
  const fts5Mod = await import('./memory/fts5.js');
  const root = process.env.IJFW_PROJECT_DIR || PROJECT_DIR;
  const db = await fts5Mod.openDb(root);
  try {
    // indexEntry runs the ingest scrub gate + M1 indexObsidianRelations +
    // M2 autoLink internally. body is already sanitised + redacted by the
    // handleStore caller; the scrub gate re-running over already-clean text
    // is idempotent.
    const inserted = fts5Mod.indexEntry(db, {
      body,
      source: source || 'memory_store',
      session_id: sessionId || null,
    });
    // indexEntry dispatches M2 autoLink + the D2 graph auto-index as
    // fire-and-forget promises that still hold the db handle. We own the
    // handle here, so we MUST let those settle before closing the db —
    // otherwise autoLink races into a "database connection is not open"
    // error. Capture the promise references SYNCHRONOUSLY right after
    // indexEntry returns (no await in between) so an interleaved store
    // can't overwrite the module-level statics before we read them. Both
    // promises swallow their own failures, so awaiting them never rejects.
    // This keeps M2 wired on the real store path without changing
    // handleStore's fire-and-forget contract (the caller already treats
    // this whole function as fire-and-forget).
    const autoLinkP = fts5Mod.indexEntry.__lastAutoLinkPromise;
    const autoIndexP = typeof fts5Mod.__getLastAutoIndexPromise === 'function'
      ? fts5Mod.__getLastAutoIndexPromise()
      : null;
    try { await autoLinkP; } catch { /* swallowed by indexEntry */ }
    try { await autoIndexP; } catch { /* swallowed by indexEntry */ }
    return inserted;
  } finally {
    try { fts5Mod.closeDb(db); } catch { /* best-effort */ }
  }
}

// Diagnostic hook for tests — holds the most recent FTS5/M1/M2 indexing
// promise fired by handleStore so end-to-end tests can await deterministic
// completion before asserting on memory_links / memory_tags. Production
// callers do not read this.
handleStore.__lastIndexPromise = null;

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
  //
  // v1.5.1 R4-H3 — secret redaction. sanitizeContent strips prompt-injection
  // control chars but does NOT scrub secret-shaped tokens (API keys, OAuth
  // secrets). Without this, a secret pasted into a direct ijfw_store call
  // lands in .ijfw/memory/*.md cleartext and re-injects into every future
  // recall. The redactor is already wired into the FTS5 ingest path
  // (memory/fts5.js#indexEntry) and the auto-memorize path; this closes the
  // direct MCP store as the one remaining bypass. Redact AFTER sanitize so
  // the redaction labels ([REDACTED:*]) are never themselves scrubbed.
  const safeContent = redactSecrets(sanitizeContent(content));
  if (!safeContent) {
    return { text: 'content was empty after sanitisation (only control/format chars).', isError: true };
  }
  const safeSummary = summary ? redactSecrets(sanitizeContent(summary)).substring(0, 120) : '';
  const safeWhy = why ? redactSecrets(sanitizeContent(why)) : '';
  const safeHow = how_to_apply ? redactSecrets(sanitizeContent(how_to_apply)) : '';

  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const journalEntry = `**${type}**${tagStr}: ${safeSummary || safeContent.substring(0, 200)}`;

  // H5.6 — Semantic dedup BEFORE append. If this memory is a near-duplicate
  // of one already in the last N journal entries, short-circuit and return
  // the existing entry's id. handoff is exempt (always overwrites a single
  // file by design; deduping would silently drop a handoff swap).
  const dedupCfg = readDedupConfig();
  if (dedupCfg.enabled && type !== 'handoff') {
    const recents = getRecentMemoriesForDedup(dedupCfg.windowSize);
    // Dedup against the FULL journal-entry line shape -- that's what the next
    // call would see in `recents`, so comparing apples to apples.
    const dup = findNearDuplicate(journalEntry, recents);
    if (dup) {
      // Spec: emit a stderr line so the user/agent sees the elision.
      try {
        process.stderr.write(`[ijfw memory] dedup'd similar entry; keeping prior ${dup.match.id}\n`);
      } catch { /* stderr may be detached in test harness */ }
      return {
        text: `Dedup'd: similar memory already exists (${dup.match.id}, similarity=${dup.similarity.toFixed(2)}). Not appended.`,
        deduped: true,
        existing_id: dup.match.id,
        similarity: dup.similarity,
      };
    }
  }

  // 1. Always append to journal (one-line timeline). Hard failure → report.
  const journalResult = appendToJournal(journalEntry);
  if (!journalResult.ok) {
    return { text: `Memory journal is not writable (${journalResult.code}) -- check .ijfw/ directory permissions and retry.`, isError: true };
  }

  // v1.5.1 R4-H2 — mirror the stored entry into the FTS5 warm tier, which
  // also fires M1 (Obsidian indexing) + M2 (A-Mem auto-linking). Index the
  // full content (already sanitised + redacted above) so [[wikilinks]],
  // #tags and [key:: value] metadata land in memory_links/_tags/_meta and
  // the auto-linker sees the real body. Fire-and-forget: handleStore stays
  // synchronous and a DB failure never breaks the markdown store. The
  // promise is exposed for tests that need deterministic completion.
  try {
    handleStore.__lastIndexPromise = indexStoredEntryToFts5({
      body: safeContent,
      source: `memory_store:${type}`,
      sessionId: null,
    }).catch((e) => {
      try { console.error('[ijfw memory] FTS5/M1/M2 index failed:', e?.message || e); } catch { /* never throw */ }
      return null;
    });
  } catch (e) {
    handleStore.__lastIndexPromise = null;
    try { console.error('[ijfw memory] FTS5 index dispatch failed:', e?.message || e); } catch { /* never throw */ }
  }

  // H5.5 — Fact extraction AFTER successful append. Best-effort: a failure
  // here is logged in the return text but does NOT poison the store result.
  // Memory-id ties facts.jsonl rows back to their journal entry.
  const factMeta = {
    ts: new Date().toISOString(),
    memory_id: factMemoryIdFor(journalEntry),
    source: `memory_store:${type}`,
  };
  const facts = extractFacts(safeContent);
  appendFactsToSidecar(facts, factMeta);
  // v1.5.0 audit H5.4 — mirror to bi-temporal SQL store. For each fact,
  // closes any prior currently-valid fact with the same (subject, predicate)
  // but different object before inserting. Same-object stores are a no-op.
  // Wrapped in a per-fact transaction inside temporal.js. Best-effort: any
  // failure is logged to stderr but never breaks the journal-or-JSONL path.
  writeFactsBitemporal(facts, factMeta);

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
    const handoffPath = join(paths().memoryDir, 'handoff.md');
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

async function handlePrelude({ detail_level = 'summary' } = {}) {
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

  // v1.5.0 memory-moat M3 (INT.4): surface top-K recently-successful skills
  // at session start. The Wayland-pattern "more-you-use-it-better-it-gets"
  // feedback loop: every skill execution writes to skill_telemetry via the
  // state-SDK telemetry.record verb (INT.3); this block reads top-5 by
  // success-count and surfaces them as a hint to the model. Best-effort:
  // an unmigrated db, empty telemetry, or read failure all skip the block
  // silently — never breaks the prelude.
  try {
    const { topKSuccessfulSkills } = await import('./orchestrator/skill-telemetry.js');
    const Database = (await import('better-sqlite3')).default;
    const { join: joinP } = await import('node:path');
    const root = process.env.IJFW_PROJECT_DIR || process.cwd();
    const dbPath = joinP(root, '.ijfw', 'index', 'memory.db');
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const top = topKSuccessfulSkills(db, { k: 5 });
        if (top.length > 0) {
          const names = top.map((r) => `${r.skill_id} (${r.success_count}×)`).join(', ');
          parts.push(
            '<ijfw-recommended-skills>',
            `Observed success this project: ${names}`,
            '</ijfw-recommended-skills>',
            '',
          );
        }
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort; never block the prelude */ }

  // 1.2.0 Phase 5: surface the DESIGN picker to platforms without a skills tree.
  // Skip when the project already has a DESIGN.md (contract exists; no picker).
  // Built into a standalone block so the abstention path below can re-emit it:
  // a fresh project with no memory AND no DESIGN.md is exactly when the picker
  // matters most, so it must survive the thin-memory short-circuit.
  let designPickerBlock = '';
  try {
    if (!existsSync(join(PROJECT_DIR, 'DESIGN.md'))) {
      const names = DESIGN_TEMPLATE_CATALOG.map(([n]) => n);
      designPickerBlock = [
        '## Design picker',
        'No DESIGN.md in project. 12 curated templates available:',
        names.slice(0, 5).join(', ') + ',',
        names.slice(5, 10).join(', ') + ',',
        names.slice(10).join(', ') + '.',
        '',
        'Pick one: ijfw_memory_recall({context_hint: "design_template:<name>"}).',
        'Full catalog with descriptions: ijfw_memory_recall({context_hint: "design_template"}).',
      ].join('\n');
    }
  } catch { /* project dir unreadable -- skip picker block */ }
  if (designPickerBlock) parts.push(designPickerBlock, '');

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

  // t14: cross-project override-use intelligence. Reads the current project's
  // active overrides from ~/.ijfw/state/active-overrides.json and asks the
  // override-use-registry whether N+ other projects share the set. Wrapped
  // in a single try/catch — a registry failure must NEVER fail the prelude.
  try {
    const activePath = join(homedir(), '.ijfw', 'state', 'active-overrides.json');
    let currentOverrides = [];
    if (existsSync(activePath)) {
      try {
        const parsed = JSON.parse(readFileSync(activePath, 'utf8'));
        const entry = parsed && parsed.projects && parsed.projects[PROJECT_DIR];
        if (entry && Array.isArray(entry.active_overrides)) {
          currentOverrides = entry.active_overrides
            .filter((o) => o && typeof o.preset === 'string')
            .map((o) => o.preset);
        }
      } catch {
        // malformed json -- treat as no overrides, fall through silently
      }
    }
    if (currentOverrides.length > 0) {
      const { getPromoteSuggestion } = await import('./override-use-registry.js');
      const suggestion = await getPromoteSuggestion(PROJECT_DIR, currentOverrides, {});
      if (suggestion) {
        parts.push('## Cross-project intelligence');
        parts.push(suggestion.message);
        parts.push(`Projects: ${suggestion.projects.join(', ')}`);
        parts.push('Run: `' + suggestion.suggestion + '`');
        parts.push('');
      }
    }
  } catch {
    // Registry failures are non-fatal -- the prelude must always succeed.
  }

  // B3 (1.4.0/W7): memory-feedback pattern hints. Reads gate-receipts and
  // surfaces "N of last M flagged on artifact:type" hints. Wrapped in a
  // single try/catch -- pattern detection failure must NEVER fail the prelude.
  try {
    const { getFeedbackSuggestions } = await import('./memory-feedback.js');
    const suggestions = await getFeedbackSuggestions(PROJECT_DIR);
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      parts.push('## Pattern hints');
      for (const s of suggestions) parts.push(`- ${s}`);
      parts.push('');
    }
  } catch {
    // Best-effort; never fail the prelude on memory-feedback issues.
  }

  // v1.5.0 audit-MED-update-M8 (F-REL-2): surface the last-N partial-deploy
  // alerts so a half-deployed extension is visible at next session-start.
  // Wrapped in try/catch — alert read failure must NEVER fail the prelude.
  try {
    const { renderDeployAlertsForPrelude } = await import('./deploy-alerts.js');
    const block = await renderDeployAlertsForPrelude({ limit: 10 });
    if (block && typeof block === 'string' && block.length > 0) {
      parts.push(block);
    }
  } catch {
    // Best-effort; never fail the prelude on deploy-alert read issues.
  }

  parts.push('</ijfw-memory>');

  const text = parts.join('\n');
  if (text.length < 60) {
    return { text: 'Fresh project -- no memory stored yet. Proceed normally.' };
  }

  // v1.5.0 audit MED #11 (memory-engine.md F-FUN-7): abstention.
  // If memory exists but the body content is thin AND there are no recent
  // journal entries, surface an honest abstention so the LLM doesn't try
  // to over-fit a half-page of stale frontmatter to the user's prompt.
  // Threshold: total content chars below MIN_CONTENT_CHARS for the
  // knowledge/team/handoff sources combined AND zero recent journal lines.
  const MIN_CONTENT_CHARS = 200;
  const knowledgeChars = (knowledge ? knowledge.length : 0) + (team ? team.length : 0) + (handoff ? handoff.length : 0);
  const recentLines = recent ? recent.split('\n').filter(l => l.trim()).length : 0;
  if (knowledgeChars < MIN_CONTENT_CHARS && recentLines === 0) {
    const abstain = [
      '<ijfw-memory>',
      'Memory present but nothing relevant to your prompt -- proceed and I\'ll store any decisions you make.',
    ];
    // The DESIGN picker is independent of memory richness — preserve it
    // through the abstention path, otherwise a fresh project never sees it.
    if (designPickerBlock) abstain.push('', designPickerBlock);
    abstain.push('</ijfw-memory>');
    return { text: abstain.join('\n') };
  }

  // v1.5.2 brain context injection — env-gated (IJFW_BRAIN_INJECT=auto|always|never).
  // Default 'never' keeps existing behavior unchanged; opt-in surfaces the
  // top-N most-recently-touched wiki pages to the prelude. Best-effort —
  // any failure is swallowed so prelude never breaks.
  let injectedText = text;
  try {
    const mode = process.env.IJFW_BRAIN_INJECT || 'never';
    if (mode === 'auto' || mode === 'always') {
      const { buildContextInjection } = await import('./brain/context-injection.js');
      const injection = buildContextInjection(REPO_ROOT, { mode });
      if (injection) injectedText = text + injection;
    }
  } catch { /* swallow — injection is best-effort */ }

  return { text: injectedText };
}

async function handleSearch({ query, limit = 10, scope = 'project', label }) {
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

  // v1.5.0 memory-moat M1 (INT.5): "dv:" prefix routes to the declarative
  // Dataview-grade query mode. Returns structured rows from the FTS5 +
  // memory_links/_tags/_meta join populated at write time by M1.3 /
  // INT.1. Best-effort: errors fall through to the standard NL/FTS5 path
  // so the new mode never breaks existing callers.
  if (query.startsWith('dv:')) {
    try {
      const body = query.slice(3).trim();
      const dvMod = await import('./memory/query-dataview.js');
      const fts5Mod = await import('./memory/fts5.js');
      const root = process.env.IJFW_PROJECT_DIR || process.cwd();
      const db = await fts5Mod.openDb(root);
      try {
        const parsed = dvMod.parseDataviewQuery(body);
        const result = dvMod.runDataviewQuery(db, parsed);
        const rows = result.rows.slice(0, limit);
        if (rows.length === 0) {
          return { text: `No results for dataview query: "${body}"`, mode: 'dataview', parsed };
        }
        // Render in the existing text shape so MCP clients that expect
        // a single string field keep working.
        return {
          text: rows
            .map((r) => `[id:${r.id} source:${r.source || '?'} created:${r.created_at}] ${(r.body || '').slice(0, 200)}`)
            .join('\n'),
          mode: 'dataview',
          parsed,
          rowCount: rows.length,
        };
      } finally {
        try { fts5Mod.closeDb(db); } catch { /* best-effort */ }
      }
    } catch (e) {
      return {
        text: `Dataview query failed: ${e && e.message ? e.message : String(e)}`,
        mode: 'dataview',
        isError: true,
      };
    }
  }

  const results = await searchMemory(query, limit, scope);
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
        // W7/B2 -- tier-1 runtime mediation. If an extension is active,
        // gate the call against its declared permissions before any handler
        // runs. With no extension active (bundled IJFW context), activeExt
        // is null and the gate is a no-op -- preserving the backwards-compat
        // invariant. Malformed state is fail-closed (denied).
        let activeExt = null;
        try {
          activeExt = await getActiveExtension();
        } catch {
          activeExt = { __malformed: true };
        }
        if (activeExt !== null) {
          // B16/SEC-M-03: combined permission + quota gate via exported helper.
          const home = process.env.HOME || process.env.USERPROFILE || homedir();
          const manifestQuotas = await resolveActiveManifestQuotas(
            activeExt,
            (args && typeof args.projectRoot === 'string') ? args.projectRoot : undefined,
            home,
          );
          const gate = await gatePermissionAndQuota({
            toolName: name,
            args: args || {},
            activeExt,
            home,
            manifestQuotas,
          });
          if (!gate.allowed && gate.response) {
            return createResponse(id, gate.response);
          }
        }
        switch (name) {
          case 'ijfw_update_check': {
            const r = await ijfwUpdateCheck(args || {});
            result = { text: JSON.stringify(r, null, 2), isError: !!(r && r.error) };
            break;
          }
          case 'ijfw_brain': {
            // v1.5.2 T24-27+T29: combined brain verb facade.
            const a = args || {};
            if (typeof a.verb !== 'string' || a.verb.length === 0) {
              result = { text: JSON.stringify({ ok: false, error: 'verb (string) is required' }), isError: true };
              break;
            }
            try {
              const r = await handleIjfwBrain({
                verb: a.verb,
                args: (a.args && typeof a.args === 'object') ? a.args : {},
                db: getFactsDb(),
                repoRoot: REPO_ROOT,
                env: process.env,
              });
              result = { text: JSON.stringify(r, null, 2), isError: r.ok === false };
            } catch (err) {
              const msg = err && err.message ? err.message : String(err);
              result = { text: JSON.stringify({ ok: false, error: msg }), isError: true };
            }
            break;
          }
          case 'ijfw_state': {
            // v1.5.0 T13: single MCP face for the state-SDK. Routes every call
            // into the same `query(verb, payload, ctx)` core that the JS module
            // (`./orchestrator/state-sdk.js`) and the CLI colon-namespace
            // (`ijfw state:<verb>`) use. The retired `ijfw_subagent_post_done`
            // tool is now reachable as the `subagent.post-done` verb.
            const a = args || {};
            if (typeof a.verb !== 'string' || a.verb.length === 0) {
              result = { text: JSON.stringify({ ok: false, error: 'verb (string) is required' }), isError: true };
              break;
            }
            try {
              const { query } = await import('./orchestrator/state-sdk.js');
              const payload = (a.payload && typeof a.payload === 'object') ? a.payload : {};
              const ctx = {
                projectRoot: typeof a.projectRoot === 'string' && a.projectRoot.length > 0
                  ? a.projectRoot
                  : process.cwd(),
              };
              if (typeof a.subagentId === 'string' && a.subagentId.length > 0) ctx.subagentId = a.subagentId;
              if (typeof a.homeDir === 'string' && a.homeDir.length > 0) ctx.homeDir = a.homeDir;
              const r = await query(a.verb, payload, ctx);
              // A verdict-fail refusal (Model 4) is the verb's correct hard-block —
              // surface `isError: true` so the orchestrator-LLM treats it as a
              // hard stop rather than an advisory note (mirrors the prior
              // ijfw_subagent_post_done `block: true` contract).
              const refused = r && r.refused === true;
              result = { text: JSON.stringify(r, null, 2), isError: !!refused };
            } catch (err) {
              const msg = err && err.message ? err.message : String(err);
              result = { text: JSON.stringify({ ok: false, error: msg }), isError: true };
            }
            break;
          }
          case 'ijfw_update_apply': {
            const r = ijfwUpdateApply(args || {});
            result = { text: JSON.stringify(r, null, 2), isError: r && r.status === 'error' };
            break;
          }
          case 'ijfw_cross_audit_converge': {
            // v1.5.0-major W12-C N03: Trident-as-a-service.
            const a = args || {};
            if (!a.commitRange || typeof a.commitRange !== 'string') {
              result = { text: JSON.stringify({ error: 'commitRange (string) is required' }), isError: true };
              break;
            }
            const { runPhaseEConverge, defaultConvergeDispatch } = await import('./cross-orchestrator.js');
            try {
              const r = await runPhaseEConverge({
                commitRange: a.commitRange,
                maxIterations: typeof a.maxIterations === 'number' ? a.maxIterations : 3,
                lenses: Array.isArray(a.lenses) && a.lenses.length > 0 ? a.lenses : undefined,
                dispatch: defaultConvergeDispatch,
                projectRoot: process.cwd(),
                // v1.5.1 R4-H4 — opt-in consensus auto-fix (T27). Threaded
                // from the tool schema so the code-fixer can genuinely fire;
                // default false so the audit stays non-mutating unless the
                // caller explicitly asks for it.
                autoFix: a.autoFix === true,
              });
              const isErr = r.verdict === 'consensus_failed' || r.verdict === 'FAIL' || r.verdict === 'UNREACHABLE';
              // v1.5.1 W2.D — emit a canonical gate-result block through the
              // gate-result-formatter so this Trident-as-a-service surface is
              // consistent with the Trident gate (dispatch.js) and preflight
              // gates. appendGateResult guarantees the fenced block is the
              // LAST content emitted and is idempotent. Failure to format the
              // block must NOT clobber the verdict payload — observability,
              // not correctness.
              let convergeText = JSON.stringify(r, null, 2);
              try {
                const { emitGateResult } = await import('./gate-result.js');
                const { appendGateResult } = await import('./gate-result-formatter.js');
                // Map the converge verdict onto a schema-valid gate status.
                const VERDICT_TO_STATUS = {
                  PASS: 'PASS',
                  CONDITIONAL: 'CONDITIONAL',
                  WARN: 'WARN',
                  FLAG: 'FLAG',
                  FAIL: 'FAIL',
                  consensus_failed: 'FAIL',
                  UNREACHABLE: 'FAIL',
                  INCONCLUSIVE: 'FLAG',
                };
                const gateStatus = VERDICT_TO_STATUS[r.verdict] || 'FLAG';
                const block = await emitGateResult(
                  {
                    gate: 'cross-audit',
                    status: gateStatus,
                    lenses: [],
                    affected_artifacts: [],
                    accounting: {
                      duration_ms:
                        typeof r.duration_ms === 'number' ? r.duration_ms : 0,
                      lenses_invoked: Array.isArray(a.lenses)
                        ? a.lenses.length
                        : 0,
                      cost_usd: null,
                    },
                    remediation: [],
                  },
                  { projectRoot: process.cwd() },
                );
                // emitGateResult returns the fenced block as a string; the
                // formatter validates it back into an object before append.
                const parsed = JSON.parse(
                  block.replace(/^```gate-result\n/, '').replace(/\n```$/, ''),
                );
                convergeText = appendGateResult(convergeText, parsed);
              } catch (gateErr) {
                try {
                  const msg =
                    gateErr && gateErr.message
                      ? gateErr.message
                      : String(gateErr);
                  process.stderr.write(
                    `ijfw: cross_audit_converge gate-result emit failed: ${msg}\n`,
                  );
                } catch {
                  /* never crash the tool on a logging-channel failure */
                }
              }
              result = { text: convergeText, isError: isErr };
            } catch (err) {
              result = { text: JSON.stringify({ error: err && err.message ? err.message : String(err) }), isError: true };
            }
            break;
          }
          case 'ijfw_memory_recall':
            result = handleRecall(args || {});
            emitRecallObservation(args || {});
            break;
          case 'ijfw_memory_store':
            result = handleStore(args || {});
            break;
          case 'ijfw_memory_search': {
            // W1B (1.3.0-alpha): colon-syntax dispatch. compute:<query> hits
            // the per-project FTS5 db; anything else falls through to the
            // legacy keyword search.
            const searchArgs = args || {};
            const parsedQuery = typeof searchArgs.query === 'string'
              ? parseColonCommand(searchArgs.query)
              : null;
            if (parsedQuery && (parsedQuery.namespace === 'compute' || parsedQuery.namespace === 'graph')) {
              const dispatched = await dispatchSearch(parsedQuery, {
                projectRoot: searchArgs.projectRoot,
                limit: searchArgs.limit,
              });
              if (dispatched !== null) {
                result = {
                  text: JSON.stringify(dispatched, null, 2),
                  isError: dispatched.ok === false,
                };
                break;
              }
            }
            result = await handleSearch(searchArgs);
            break;
          }
          case 'ijfw_memory_prelude':
            result = await handlePrelude(args || {});
            break;
          case 'ijfw_memory_facts': {
            // v1.5.0 M5 (INT.6) -- surface bi-temporal facts read path.
            const mod = await import('./memory-facts-handler.js');
            result = await mod.handleMemoryFacts(args || {});
            break;
          }
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
            // W1B (1.3.0-alpha): colon-syntax dispatch. compute:python /
            // compute:js / index:<source> / detect:project_type ride this
            // tool surface so we don't grow tool count past 10.
            // L2: trust dispatcher's null contract -- the redundant
            // namespace tuple here would drift if dispatch adds new ones.
            // dispatchRun() returns null for unrecognized namespaces and a
            // result object for owned ones.
            const parsedRun = parseColonCommand(command);
            if (parsedRun) {
              const dispatched = await dispatchRun(parsedRun, {
                projectRoot: cwd,
                sessionId: process.env.IJFW_SESSION_ID,
              });
              if (dispatched !== null) {
                result = {
                  text: JSON.stringify(dispatched, null, 2),
                  isError: dispatched.ok === false,
                };
                break;
              }
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

// --- B17 WebSocket revocation client (dynamic-import gate) ---
// extension-registry-ws.js is dormant by default. Its docstring contract:
// "Imported via `await import(...)` ONLY when `process.env.IJFW_REGISTRY_WS_URL`
// is set at startup." Firing the gate here at MCP startup keeps the module out
// of the import graph entirely unless the operator opts in via the env var, so
// MCP startup never opens a socket for the common (unset) case. Best-effort:
// a failed WS bind must never block the stdio transport.
if (process.env.IJFW_REGISTRY_WS_URL || process.env.IJFW_REGISTRY_WS_SOURCE) {
  (async () => {
    try {
      const { initWsClient } = await import('./extension-registry-ws.js');
      const res = await initWsClient();
      if (!res.ok) {
        process.stderr.write(`IJFW: WS revocation client not started: ${res.error}\n`);
      }
    } catch (err) {
      process.stderr.write(`IJFW: WS revocation client init failed: ${err && err.message ? err.message : err}\n`);
    }
  })();
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
// gatePermissionAndQuota is exported inline at its declaration above (B16/SEC-M-03)
// so test-server-quota-integration.js can drive it without spinning a server.
// H5.5 / H5.6 — expose handleStore/handleRecall + path/helpers so the ingest
// integration test can drive the full pipeline without spawning a subprocess.
export {
  sanitizeContent, atomicWrite, readMarkdownFile, PROJECT_HASH,
  handleStore, handleRecall, handleSearch, handlePrelude,
  MEMORY_DIR, FACTS_FILE, FACTS_DB_FILE,
  getFactsDb,
  paths,
};
