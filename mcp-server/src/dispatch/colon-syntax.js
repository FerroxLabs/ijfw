// IJFW v1.3.0 Alpha -- W1B colon-syntax dispatcher.
//
// V3-B1: zero new MCP tools. Sub-commands ride existing tool surfaces via
// "<namespace>:<command> [args]" prefix. Two consumers:
//
//   1. ijfw_run dispatch:
//      - compute:python "..."   -> runCompute(language='python', script=args)
//      - compute:js "..."       -> runCompute(language='js',     script=args)
//      - index:<source> ...     -> safeWrite(raw) on per-project FTS5 db
//      - detect:project_type    -> Phase 3 wired (sync detect + cache; --bg spawns runner)
//
//   2. ijfw_memory_search dispatch:
//      - compute:<query>        -> search(raw_fts, query, k=10)
//      - anything else          -> null (caller falls through to legacy logic)
//
// Discipline:
//   - All user-facing strings positive-framed; no "AI" / "artificial intelligence" // copy-lint:allow
//     in user copy (covered by scripts/copy-lint.sh).
//   - Env reads kept inside dispatchRun so the parser stays pure.
//   - Tool count remains 10 -- this file is invoked from within existing tool
//     handlers in src/server.js; tools/list does not change.

import {
  openDb,
  safeWrite,
  search,
  closeDb,
  IntegrityError,
  SchemaVersionError,
  ComputeDbError,
} from '../compute/index.js';
import { runCompute } from '../compute/runner.js';
import { expandQuery } from '../compute/synonyms.js';
import { detect, writeProjectType } from '../project-type-detector.js';
import { extractEntities } from '../compute/extract.js';
import { writeEdges } from '../compute/edges.js';
import { bfsTraverse, bfsRelated, resolveNode } from '../compute/traverse.js';
import { acquireGraphWriteLock } from '../compute/graph-lock.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Recognised namespaces -- gates dispatchRun against typos.
// v1.4.0 (F7): added 'override', 'extension', 'domain-manifest' for the
// Open Ecosystem dispatch surface.
// v1.4.0 (W6/S13): parser now accepts hyphens in namespace ([a-z_][a-z0-9_-]*)
// so the user-facing spelling 'domain-manifest:<op>' (matching the error
// message and CLI surface) parses + routes uniformly. The set entry is the
// hyphenated form so copy-paste from the error string Just Works.
const RUN_NAMESPACES = new Set([
  'compute',
  'index',
  'detect',
  'graph',
  'override',
  'extension',
  'domain-manifest',
]);
const SEARCH_NAMESPACES = new Set(['compute', 'graph']);

// --- Parser ----------------------------------------------------------------

/**
 * parseColonCommand(input) -> { namespace, command, args } | null
 *
 * Recognises "<word>:<rest>" where <word> is [a-z_][a-z0-9_]* (ASCII, lower).
 * Returns null for any other shape so callers can fall through to legacy
 * handlers without speculating about intent.
 *
 * Splitting rules:
 *   - First ':' separates namespace from the remainder.
 *   - In the remainder, the first whitespace run separates command from args.
 *   - If the args body starts and ends with a single matching pair of quotes
 *     ("..." or '...'), strip them so callers receive the raw script body.
 *   - Trailing whitespace on args is stripped; internal whitespace preserved.
 */
export function parseColonCommand(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0) return null;

  const colon = s.indexOf(':');
  if (colon <= 0) return null;

  const namespace = s.slice(0, colon);
  // v1.4.0 (W6/S13): allow hyphens so multi-word namespaces like
  // 'domain-manifest' parse without forcing a separate normalisation step.
  if (!/^[a-z_][a-z0-9_-]*$/.test(namespace)) return null;

  const remainder = s.slice(colon + 1);
  // Empty remainder -> command present but blank; treat as malformed.
  if (remainder.length === 0) return null;

  // Split command from args at first whitespace run.
  const wsMatch = remainder.match(/\s+/);
  let command;
  let args;
  if (!wsMatch) {
    command = remainder;
    args = '';
  } else {
    const idx = wsMatch.index;
    command = remainder.slice(0, idx);
    args = remainder.slice(idx + wsMatch[0].length);
  }

  args = stripMatchingQuotes(args.replace(/\s+$/, ''));

  return { namespace, command, args };
}

function stripMatchingQuotes(s) {
  if (s.length < 2) return s;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  // 0x22 = ", 0x27 = '
  if ((first === 0x22 || first === 0x27) && first === last) {
    return s.slice(1, -1);
  }
  return s;
}

// --- ijfw_run dispatch -----------------------------------------------------

/**
 * dispatchRun(parsed, ctx) -> Promise<{ ok, ... }>
 *
 * ctx may carry { projectRoot, sessionId } -- both have safe defaults.
 * Returns a plain JSON-serialisable object so the server.js handler can wrap
 * it for MCP transport.
 *
 * Returns null if the namespace is not one this dispatcher owns; callers
 * should treat null as "fall through to legacy ijfw_run".
 */
export async function dispatchRun(parsed, ctx = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!RUN_NAMESPACES.has(parsed.namespace)) return null;

  const projectRoot = String(ctx.projectRoot || process.env.IJFW_PROJECT_DIR || process.cwd());
  const sessionId = String(ctx.sessionId || process.env.IJFW_SESSION_ID || 'unknown');
  // C9.6: provenance pointer (file path / observation kind / skill name).
  // Optional -- callers that don't supply it leave raw.source NULL.
  const provenance = ctx.source != null ? String(ctx.source) : null;

  if (parsed.namespace === 'compute') {
    return dispatchCompute(parsed, { projectRoot, sessionId, provenance });
  }
  if (parsed.namespace === 'index') {
    return dispatchIndex(parsed, { projectRoot, sessionId, provenance });
  }
  if (parsed.namespace === 'detect') {
    return dispatchDetect(parsed, { projectRoot, sessionId });
  }
  if (parsed.namespace === 'graph') {
    return dispatchGraph(parsed, { projectRoot, sessionId });
  }
  if (parsed.namespace === 'override') {
    const m = await import('./override.js');
    return m.overrideDispatch({ command: parsed.command, args: parsed.args, projectRoot });
  }
  if (parsed.namespace === 'extension') {
    const m = await import('./extension.js');
    return m.extensionDispatch({ command: parsed.command, args: parsed.args, projectRoot });
  }
  if (parsed.namespace === 'domain-manifest') {
    const m = await import('./domain-manifest.js');
    return m.domainManifestDispatch({ command: parsed.command, args: parsed.args, projectRoot });
  }

  return {
    ok: false,
    error: 'Unknown ijfw_run sub-command. Supported: compute:python, compute:js, index:<source>, detect:project_type, graph:traverse, override:<op>, extension:<op>, domain-manifest:<op>',
  };
}

async function dispatchCompute(parsed, { projectRoot, sessionId /*, provenance unused for compute runs */ }) {
  const cmd = parsed.command;
  if (cmd !== 'js' && cmd !== 'python') {
    return {
      ok: false,
      error: `Unknown compute language "${cmd}". Supported: compute:js, compute:python.`,
    };
  }
  const script = parsed.args;
  if (!script) {
    return { ok: false, error: `compute:${cmd} requires a script body.` };
  }

  const vmOnly = parseBoolEnv(process.env.IJFW_COMPUTE_VM_ONLY);
  const allowNet = parseBoolEnv(process.env.IJFW_COMPUTE_NET);
  const timeoutMs = parseIntEnv(process.env.IJFW_COMPUTE_TIMEOUT_MS);

  try {
    const result = await runCompute({
      language: cmd,
      script,
      projectRoot,
      timeoutMs,
      allowNet,
      vmOnly,
      sessionId,
    });
    // L1: audit-log compute runs that opted into the host network. Forensic
    // questions ("which run hit the network and when") become a single FTS5
    // query instead of a per-session log scrape.
    if (allowNet) {
      try { await logNetAllowed({ projectRoot, sessionId, cmd, script, result }); }
      catch { /* audit log is best-effort; never block the run on it */ }
    }
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      sandbox: result.sandbox,
    };
  } catch (err) {
    return {
      ok: false,
      error: `compute:${cmd} did not complete: ${err && err.message ? err.message : String(err)}`,
      code: err && err.code ? err.code : null,
    };
  }
}

// L1 helper: write an audit_finding row when allowNet=true. Body is a
// compact JSON envelope -- script preview (first 240 chars) + result
// summary (exit, duration, truncation, sandbox kind).
async function logNetAllowed({ projectRoot, sessionId, cmd, script, result }) {
  let db;
  try {
    db = await openDb(projectRoot);
    const preview = String(script || '').slice(0, 240);
    const body = JSON.stringify({
      lang: cmd,
      preview,
      exit: result.exitCode,
      duration_ms: result.durationMs,
      timed_out: !!result.timedOut,
      truncated: !!result.truncated,
      sandbox_kind: result.sandbox && result.sandbox.kind,
      sandbox_degraded: !!(result.sandbox && result.sandbox.degraded),
    });
    safeWrite(db, 'raw', {
      source_kind: 'audit_finding',
      session_id: sessionId,
      project_root: projectRoot,
      event_type: 'compute_net_allowed',
      body,
      ts: Date.now(),
    });
  } finally {
    closeDb(db);
  }
}

async function dispatchIndex(parsed, { projectRoot, sessionId, provenance }) {
  const source = parsed.command;
  if (!source) {
    return { ok: false, error: 'index:<source> requires a source label after the colon.' };
  }
  // index:<kind> [--source=<provenance>] body...
  // The --source= flag attaches a provenance pointer to the row (C9.6).
  // When omitted, raw.source stays NULL. Inline-flag form keeps backward
  // compatibility with `index:<kind> body` callers.
  const { provenanceFlag, body } = extractProvenanceFlag(parsed.args);
  if (!body) {
    return { ok: false, error: `index:${source} requires content to index.` };
  }
  const provenancePointer = provenanceFlag != null ? provenanceFlag
                          : provenance != null ? provenance
                          : null;

  let db;
  try {
    db = await openDb(projectRoot);
    const row = {
      source_kind: mapSourceKind(source),
      session_id: sessionId,
      project_root: projectRoot,
      event_type: 'output',
      body,
      ts: Date.now(),
    };
    if (provenancePointer != null) row.source = provenancePointer;
    const inserted = safeWrite(db, 'raw', row);
    return {
      ok: true,
      source,
      provenance: provenancePointer,
      session_id: sessionId,
      id: inserted && inserted.id != null ? inserted.id : null,
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  } catch (err) {
    const code = err instanceof IntegrityError ? 'INTEGRITY'
              : err instanceof SchemaVersionError ? 'SCHEMA_VERSION'
              : err instanceof ComputeDbError ? 'COMPUTE_DB'
              : null;
    return {
      ok: false,
      error: `index:${source} did not complete: ${err && err.message ? err.message : String(err)}`,
      code,
    };
  } finally {
    closeDb(db);
  }
}

async function dispatchDetect(parsed, { projectRoot, sessionId }) {
  const cmd = parsed.command;
  if (cmd !== 'project_type') {
    return {
      ok: false,
      error: `Unknown detect sub-command "${cmd}". Supported: detect:project_type.`,
    };
  }

  // Parse args -- recognised flags: --bg (fire-and-forget background scan),
  // --no-c9 (force file-extension fallback), --max-files=N (test override).
  const args = String(parsed.args || '').trim();
  const tokens = args.length ? args.split(/\s+/) : [];
  const flags = { bg: false, c9Available: true, maxFiles: null };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--bg' || t === '--background') flags.bg = true;
    else if (t === '--no-c9') flags.c9Available = false;
    else if (t === '--max-files') flags.maxFiles = Number(tokens[++i]);
    else if (t.startsWith('--max-files=')) flags.maxFiles = Number(t.slice('--max-files='.length));
  }

  // V3-F3: --bg path spawns a detached child runner so the dispatcher
  // returns immediately. Result lands in <project>/.ijfw/project.type async.
  if (flags.bg) {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const runner = join(dirname(__filename), '..', 'cold-scan-runner.mjs');
      const childArgs = [runner, '--project-root', projectRoot];
      if (!flags.c9Available) childArgs.push('--no-c9');
      if (flags.maxFiles) childArgs.push('--max-files', String(flags.maxFiles));
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, IJFW_SESSION_ID: sessionId || '' },
      });
      child.unref();
      return { ok: true, mode: 'bg', spawned: true, pid: child.pid, projectRoot };
    } catch (err) {
      return {
        ok: false,
        error: `detect:project_type --bg did not spawn: ${err && err.message ? err.message : String(err)}`,
      };
    }
  }

  // Foreground sync path -- returns the full result + writes the cached
  // .ijfw/project.type so subsequent reads short-circuit. P3-M1: cache
  // even when scan_incomplete=true so /ijfw doctor + post-mortem grep can
  // see the partial signal -- loadProjectType() returns null on cached
  // scan_incomplete=true so consumers don't silently trust a partial walk.
  try {
    const result = detect(projectRoot, {
      c9Available: flags.c9Available,
      maxFiles: flags.maxFiles || undefined,
      sessionId,
    });
    try { writeProjectType(projectRoot, result); } catch { /* best-effort cache */ }
    return { ok: true, mode: 'sync', result };
  } catch (err) {
    return {
      ok: false,
      error: `detect:project_type did not complete: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

// --- ijfw_run graph:* dispatch --------------------------------------------

// dispatchGraph(parsed, ctx) -> { ok, ... }
//
// Sub-commands:
//   graph:traverse   -- BFS from a start node id (or kind+name).
//                       args: JSON or "<kind>:<name> [depth=N] [edge_kinds=k1,k2]"
//   graph:index      -- extract entities from `args` body and write to graph.
//                       (Internal helper used by dream cycle / index pipeline.)
async function dispatchGraph(parsed, { projectRoot, sessionId }) {
  const cmd = parsed.command;
  if (cmd === 'traverse') return dispatchGraphTraverse(parsed, { projectRoot });
  if (cmd === 'index') return dispatchGraphIndex(parsed, { projectRoot, sessionId });
  return {
    ok: false,
    error: `Unknown graph sub-command "${cmd}". Supported: graph:traverse, graph:index.`,
  };
}

// graph:traverse args formats:
//   1. JSON object: '{"start_node":"file:src/X","depth":2,"edge_kinds":["co_occurs"]}'
//      Also accepts {"kind":"file","name":"src/X","depth":2,...}
//   2. Plain "<kind>:<name>" -- defaults depth=2, edge_kinds=['co_occurs']
async function dispatchGraphTraverse(parsed, { projectRoot }) {
  const raw = String(parsed.args || '').trim();
  if (!raw) return { ok: false, error: 'graph:traverse requires args.' };

  let kind = null, name = null;
  let depth = 2;
  let edgeKinds = ['co_occurs'];
  let weightThreshold = 0.5;
  let startNodeId = null;

  if (raw.startsWith('{')) {
    let parsedJson;
    try { parsedJson = JSON.parse(raw); }
    catch (err) {
      return { ok: false, error: `graph:traverse JSON parse failed: ${err.message}` };
    }
    if (parsedJson.start_node && typeof parsedJson.start_node === 'string') {
      const colon = parsedJson.start_node.indexOf(':');
      if (colon > 0) {
        kind = parsedJson.start_node.slice(0, colon);
        name = parsedJson.start_node.slice(colon + 1);
      } else {
        name = parsedJson.start_node;
      }
    }
    if (parsedJson.kind) kind = String(parsedJson.kind);
    if (parsedJson.name) name = String(parsedJson.name);
    if (Number.isFinite(parsedJson.start_node_id)) startNodeId = Number(parsedJson.start_node_id);
    if (Number.isFinite(parsedJson.depth)) depth = Number(parsedJson.depth);
    if (Array.isArray(parsedJson.edge_kinds)) edgeKinds = parsedJson.edge_kinds.map(String);
    if (Number.isFinite(parsedJson.weight_threshold)) weightThreshold = Number(parsedJson.weight_threshold);
  } else {
    // Plain "<kind>:<name>" + optional flags.
    const colon = raw.indexOf(':');
    if (colon > 0) {
      kind = raw.slice(0, colon).split(/\s/)[0];
      const rest = raw.slice(colon + 1);
      // Pull off depth=N / edge_kinds=k1,k2 flags.
      const flagRe = /(depth|edge_kinds|weight_threshold)=(\S+)/g;
      let nameRest = rest;
      for (const m of rest.matchAll(flagRe)) {
        if (m[1] === 'depth') depth = Number(m[2]);
        else if (m[1] === 'edge_kinds') edgeKinds = m[2].split(',').filter(Boolean);
        else if (m[1] === 'weight_threshold') weightThreshold = Number(m[2]);
        nameRest = nameRest.replace(m[0], '');
      }
      name = nameRest.trim();
    } else {
      name = raw;
    }
  }

  let db;
  try {
    db = await openDb(projectRoot);
    let resolvedId = startNodeId;
    if (!resolvedId && kind && name) {
      const node = resolveNode(db, kind, name);
      if (!node) {
        return { ok: false, error: `graph:traverse no node matching ${kind}:${name}.` };
      }
      resolvedId = node.id;
    }
    if (!resolvedId && name) {
      // Try across all kinds for "name" alone.
      const row = db.prepare(`SELECT id FROM kg_nodes WHERE name = ? LIMIT 1`).get(name);
      if (!row) return { ok: false, error: `graph:traverse no node matching name=${name}.` };
      resolvedId = Number(row.id);
    }
    if (!resolvedId) {
      return { ok: false, error: 'graph:traverse requires start_node, kind+name, or start_node_id.' };
    }
    const result = bfsTraverse(db, resolvedId, depth, edgeKinds, { weightThreshold });
    return {
      ok: true,
      start_node_id: resolvedId,
      depth,
      edge_kinds: edgeKinds,
      weight_threshold: weightThreshold,
      ...result,
    };
  } catch (err) {
    return {
      ok: false,
      error: `graph:traverse did not complete: ${err && err.message ? err.message : String(err)}`,
      code: err && err.code ? err.code : null,
    };
  } finally {
    closeDb(db);
  }
}

// graph:index args: body text (free-form). Extracts entities, writes
// kg_nodes + kg_edges. Acquires .graph-write.lock for the write phase.
async function dispatchGraphIndex(parsed, { projectRoot, sessionId }) {
  const body = String(parsed.args || '').trim();
  if (!body) return { ok: false, error: 'graph:index requires a body to index.' };

  const entities = extractEntities(body, { minMentions: 1 });
  if (entities.length === 0) {
    return { ok: true, entities_extracted: 0, edges_added: 0, edges_updated: 0 };
  }

  let db;
  let lock;
  try {
    db = await openDb(projectRoot);
    lock = acquireGraphWriteLock(projectRoot);
    const tx = db.txn(() => {
      const result = writeEdges(db, sessionId || null, entities);
      return result;
    });
    const result = tx();
    return {
      ok: true,
      entities_extracted: entities.length,
      nodes_upserted: result.nodes.length,
      edges_added: result.edgesAdded,
      edges_updated: result.edgesUpdated,
      redacted_skipped: result.redactedSkipped,
    };
  } catch (err) {
    return {
      ok: false,
      error: `graph:index did not complete: ${err && err.message ? err.message : String(err)}`,
      code: err && err.code ? err.code : null,
    };
  } finally {
    if (lock) lock.released();
    closeDb(db);
  }
}

// --- ijfw_memory_search dispatch ------------------------------------------

/**
 * dispatchSearch(parsed, ctx) -> { ok, hits } | null
 *
 * - compute:<query>     -> opens FTS5 db, returns top-k rows from raw_fts.
 * - any other namespace -> returns null so the caller falls through to the
 *                          existing memory-search handler.
 */
export async function dispatchSearch(parsed, ctx = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!SEARCH_NAMESPACES.has(parsed.namespace)) return null;

  if (parsed.namespace === 'graph') {
    return dispatchSearchGraph(parsed, ctx);
  }

  if (parsed.namespace === 'compute') {
    const projectRoot = String(ctx.projectRoot || process.env.IJFW_PROJECT_DIR || process.cwd());
    // FTS5 query is the command + args glued back together so phrase queries
    // like `compute:foo bar` work without forcing the caller to quote.
    const queryParts = [parsed.command, parsed.args].filter(Boolean);
    const rawQuery = queryParts.join(' ').trim();
    if (!rawQuery) {
      return { ok: false, error: 'compute:<query> requires a query body.' };
    }

    // C9.6: optional `--session=<id>` flag scopes search to a single
    // session. Stripped from the query before FTS5 sees it.
    const sessionFilter = extractSessionFilter(rawQuery);
    const queryAfterFilter = sessionFilter.remaining;

    // C9.5: synonym expansion, default-on. Honours per-call ctx.synonym
    // override (treated as IJFW_SYNONYM_EXPAND env value), then process
    // env. `synonym_matches` is reported back to the caller so users can
    // see what fired and disable expansion if precision matters more.
    const envOverride = ctx.synonym !== undefined ? String(ctx.synonym) : undefined;
    const expansion = expandQuery(queryAfterFilter, { env: envOverride });
    const finalQuery = expansion.expanded;

    const k = parseIntEnv(ctx.limit, 10);
    let db;
    try {
      db = await openDb(projectRoot);
      const ftsHits = search(db, 'raw', finalQuery, k);
      // C9.6: surface source + session_id on every hit. Apply session
      // filter post-FTS (cheaper than rebuilding the SQL for one column).
      let hits = ftsHits.map(h => ({
        ...h,
        source: h.source != null ? h.source : null,
        session_id: h.session_id != null ? h.session_id : null,
      }));
      if (sessionFilter.sessionId) {
        hits = hits.filter(h => h.session_id === sessionFilter.sessionId);
      }
      return {
        ok: true,
        hits,
        synonym_matches: expansion.synonym_matches,
        synonym_applied: expansion.applied,
        query: finalQuery,
        session_filter: sessionFilter.sessionId || null,
      };
    } catch (err) {
      const code = err instanceof SchemaVersionError ? 'SCHEMA_VERSION'
                : err instanceof ComputeDbError ? 'COMPUTE_DB'
                : null;
      return {
        ok: false,
        error: `compute:${rawQuery} did not complete: ${err && err.message ? err.message : String(err)}`,
        code,
      };
    } finally {
      closeDb(db);
    }
  }

  return null;
}

// dispatchSearchGraph: graph:related <query>
//
// Resolves a query string to a kg_nodes entry (exact name match, then
// case-insensitive substring), runs BFS, and returns merged FTS5 + graph
// hits. The FTS5 hits use the same query unchanged so the caller's
// "search across memory" promise still holds; graph results are tagged
// with `source: 'graph'` so the caller can render them differently.
async function dispatchSearchGraph(parsed, ctx) {
  const cmd = parsed.command;
  if (cmd !== 'related') {
    return { ok: false, error: `Unknown graph search sub-command "${cmd}". Supported: graph:related.` };
  }
  const projectRoot = String(ctx.projectRoot || process.env.IJFW_PROJECT_DIR || process.cwd());
  const query = String(parsed.args || '').trim();
  if (!query) return { ok: false, error: 'graph:related requires a query.' };

  const k = parseIntEnv(ctx.limit, 10);
  let db;
  try {
    db = await openDb(projectRoot);

    // FTS5 hits over raw_fts -- same surface as compute:<query>.
    let ftsHits = [];
    try {
      ftsHits = search(db, 'raw', query, k).map(h => ({
        ...h,
        source_type: 'fts5',
      }));
    } catch { /* FTS5 may fail on syntax; degrade to graph-only. */ }

    // Graph hits -- BFS related.
    const graphResult = bfsRelated(db, query);
    const graphHits = graphResult.nodes.map(n => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      first_seen: n.first_seen,
      last_seen: n.last_seen,
      redacted: !!n.redacted,
      source_type: 'graph',
    }));

    return {
      ok: true,
      query,
      resolved: graphResult.resolved || null,
      fts_hits: ftsHits,
      graph_hits: graphHits,
      graph_edges: graphResult.edges,
      graph_traversal_path: graphResult.traversal_path,
    };
  } catch (err) {
    const code = err instanceof SchemaVersionError ? 'SCHEMA_VERSION'
              : err instanceof ComputeDbError ? 'COMPUTE_DB'
              : null;
    return {
      ok: false,
      error: `graph:related did not complete: ${err && err.message ? err.message : String(err)}`,
      code,
    };
  } finally {
    closeDb(db);
  }
}

// --- helpers ---------------------------------------------------------------

function parseBoolEnv(v) {
  if (v === undefined || v === null || v === '') return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function parseIntEnv(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Map a colloquial source label into the schema's source_kind enum.
// Unknown labels collapse to 'tool_result' -- the catch-all for caller-side
// indexing per schema.sql.
function mapSourceKind(source) {
  switch (source) {
    case 'compute_output':
    case 'compute':
      return 'compute_output';
    case 'memory_dump':
    case 'memory':
      return 'memory_dump';
    case 'audit_finding':
    case 'audit':
      return 'audit_finding';
    case 'tool_result':
    case 'source':
    default:
      return 'tool_result';
  }
}

// Pull a leading `--source=<value>` flag from an args body for index:*.
// The flag must be the first whitespace-delimited token; everything after
// the first whitespace run becomes the indexed body. Both quoted and bare
// values are supported. Returns { provenanceFlag, body }.
function extractProvenanceFlag(args) {
  if (typeof args !== 'string') return { provenanceFlag: null, body: '' };
  const s = args.replace(/^\s+/, '');
  if (!s.startsWith('--source=')) {
    return { provenanceFlag: null, body: args };
  }
  // Find the end of the flag value -- first whitespace not inside quotes.
  let i = '--source='.length;
  let value = '';
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    i++;
    while (i < s.length && s[i] !== q) { value += s[i]; i++; }
    if (i < s.length) i++; // skip closing quote
  } else {
    while (i < s.length && !/\s/.test(s[i])) { value += s[i]; i++; }
  }
  // Skip whitespace, the rest is body.
  while (i < s.length && /\s/.test(s[i])) i++;
  return { provenanceFlag: value || null, body: s.slice(i) };
}

// Pull a leading or trailing `--session=<id>` filter from a query string.
// Strips the flag before passing the query to FTS5 -- otherwise FTS5
// would try to match `--session=...` literally. Returns { sessionId, remaining }.
function extractSessionFilter(query) {
  if (typeof query !== 'string') return { sessionId: null, remaining: '' };
  // Match `--session=<value>` where value is unquoted up to whitespace,
  // or quoted up to the matching quote. Anchored to word boundaries so
  // we don't strip a literal `--session=...` inside a quoted phrase.
  const re = /(?:^|\s)--session=("([^"]*)"|'([^']*)'|(\S+))(?=\s|$)/;
  const m = query.match(re);
  if (!m) return { sessionId: null, remaining: query };
  const sessionId = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
  const before = query.slice(0, m.index);
  const after = query.slice(m.index + m[0].length);
  const remaining = (before + ' ' + after).replace(/\s+/g, ' ').trim();
  return { sessionId, remaining };
}

export const __test = { stripMatchingQuotes, mapSourceKind, extractProvenanceFlag, extractSessionFilter };
