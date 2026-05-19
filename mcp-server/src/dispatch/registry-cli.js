/**
 * dispatch/registry-cli.js — IJFW v1.4.3/B14 + B17 registry CLI handlers.
 *
 * Frozen export contract (Wave A invariants):
 *   export const handlers = {
 *     '<subcommand>': async (args, ctx) => ({ ok, output?, error? }),
 *     ...
 *   };
 *   export const subcommandHelp = {
 *     '<subcommand>': 'one-line description',
 *     ...
 *   };
 *
 * Subcommands owned by this module:
 *   - registry-list
 *   - registry-add <name> <url> [<meta-key-path>]
 *   - registry-remove <name>
 *   - registry-prioritize <name> <position>
 *   - registry-status
 *   - trust-registry --emergency [<url>]
 *
 * Phase D will wire these into dispatch/extension.js via
 * `Object.entries(handlers)`. Each handler accepts a token array (already
 * tokenized + dequoted) and the dispatch ctx (cwd, homedir, etc.).
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { createPublicKey } from 'node:crypto';
// v1.5.0 audit-LOW-update-#13: shared tmp-suffix helper.
import { tmpSuffix } from '../lib/tmp-suffix.js';

import {
  loadRegistrySources,
  refreshTrustFromAllRegistries,
  readSourceCache,
  RegistrySourcesError,
  META_KEY_SENTINEL,
  IJFW_REGISTRY_META_KEY_PEM,
  SOURCE_NAME_PATTERN,
} from '../extension-registry.js';

function homedir(ctx) {
  return (ctx && ctx.homedir) || osHomedir();
}

function registriesConfigPath(ctx) {
  return join(homedir(ctx), '.ijfw', 'registries.json');
}

async function readRegistriesFile(ctx) {
  const path = registriesConfigPath(ctx);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.registries)) {
      throw new Error('registries.json: invalid shape');
    }
    return { path, doc: parsed };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        path,
        doc: { schema_version: '1.0', registries: [] },
      };
    }
    throw err;
  }
}

async function writeRegistriesFile(ctx, doc) {
  const path = registriesConfigPath(ctx);
  await mkdir(join(homedir(ctx), '.ijfw'), { recursive: true });
  // v1.5.0 audit-LOW-update-#13: consolidate tmp-suffix shape via helper.
  const tmp = `${path}.tmp.${tmpSuffix()}`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

function tokenize(args) {
  if (Array.isArray(args)) return args.filter((x) => x !== undefined && x !== null);
  const s = String(args || '').trim();
  if (!s) return [];
  // Simple whitespace split for CLI surface.
  return s.split(/\s+/);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * registry-list — print all configured registries in priority order.
 */
async function registryList(_args, _ctx) {
  let sources;
  try {
    sources = await loadRegistrySources();
  } catch (err) {
    if (err instanceof RegistrySourcesError) {
      return { ok: false, error: `registries.json invalid (${err.reason}): ${err.message}` };
    }
    throw err;
  }
  const lines = ['IJFW Registry Sources (priority order):', ''];
  for (const src of sources) {
    const usingEmbedded =
      src.meta_key_pem === IJFW_REGISTRY_META_KEY_PEM ? ' [meta_key=<embedded>]' : '';
    lines.push(`  [${src.priority}] ${src.name}`);
    lines.push(`        url: ${src.url}`);
    lines.push(
      `        ttl: publishers=${Math.round(src.publisher_ttl_ms / 1000)}s revocation=${Math.round(src.revocation_ttl_ms / 1000)}s${usingEmbedded}`,
    );
  }
  return { ok: true, output: lines.join('\n') };
}

/**
 * registry-add <name> <url> [<meta-key-path>]
 *
 * Appends to ~/.ijfw/registries.json. Validates name/url/PEM. Refuses
 * duplicate names. Persists in priority-append order.
 */
async function registryAdd(args, ctx) {
  const tokens = tokenize(args);
  if (tokens.length < 2) {
    return { ok: false, error: 'usage: registry-add <name> <url> [<meta-key-path>]' };
  }
  const [name, url, metaKeyPath] = tokens;

  if (!SOURCE_NAME_PATTERN.test(name)) {
    return { ok: false, error: `name must match /^[a-z0-9_-]+$/, got '${name}'` };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, error: `invalid URL: ${url}` };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { ok: false, error: `url must use HTTPS, got ${parsedUrl.protocol}` };
  }

  let metaKeyPem = META_KEY_SENTINEL;
  if (metaKeyPath) {
    let raw;
    try {
      raw = await readFile(metaKeyPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `cannot read meta-key at ${metaKeyPath}: ${err.message}` };
    }
    try {
      createPublicKey(raw);
    } catch (err) {
      return { ok: false, error: `meta-key PEM parse failed: ${err.message}` };
    }
    metaKeyPem = raw;
  }

  const { doc } = await readRegistriesFile(ctx);
  if (doc.registries.some((r) => r.name === name)) {
    return { ok: false, error: `registry '${name}' already exists` };
  }
  const nextPriority =
    doc.registries.reduce((max, r) => (typeof r.priority === 'number' ? Math.max(max, r.priority) : max), -1) + 1;
  doc.registries.push({
    name,
    url,
    meta_key_pem: metaKeyPem,
    priority: nextPriority,
    publisher_ttl_ms: 24 * 60 * 60 * 1000,
    revocation_ttl_ms: 5 * 60 * 1000,
  });
  await writeRegistriesFile(ctx, doc);
  return { ok: true, output: `added registry '${name}' at priority ${nextPriority}` };
}

/**
 * registry-remove <name>
 */
async function registryRemove(args, ctx) {
  const tokens = tokenize(args);
  if (tokens.length < 1) {
    return { ok: false, error: 'usage: registry-remove <name>' };
  }
  const name = tokens[0];
  const { doc } = await readRegistriesFile(ctx);
  const idx = doc.registries.findIndex((r) => r.name === name);
  if (idx === -1) {
    return { ok: false, error: `registry '${name}' not found` };
  }
  doc.registries.splice(idx, 1);
  await writeRegistriesFile(ctx, doc);
  return { ok: true, output: `removed registry '${name}'` };
}

/**
 * registry-prioritize <name> <position>
 */
async function registryPrioritize(args, ctx) {
  const tokens = tokenize(args);
  if (tokens.length < 2) {
    return { ok: false, error: 'usage: registry-prioritize <name> <position>' };
  }
  const [name, posRaw] = tokens;
  const position = Number.parseInt(posRaw, 10);
  if (!Number.isFinite(position)) {
    return { ok: false, error: `position must be a non-negative integer, got '${posRaw}'` };
  }
  const { doc } = await readRegistriesFile(ctx);
  const target = doc.registries.find((r) => r.name === name);
  if (!target) {
    return { ok: false, error: `registry '${name}' not found` };
  }
  target.priority = position;
  doc.registries.sort((a, b) => (a.priority || 0) - (b.priority || 0));
  // Renumber to ensure unique priorities.
  doc.registries.forEach((r, i) => {
    r.priority = i;
  });
  await writeRegistriesFile(ctx, doc);
  return { ok: true, output: `set '${name}' to priority ${position} (renumbered)` };
}

/**
 * registry-status — per-source cache age + fetch state.
 */
async function registryStatus(_args, _ctx) {
  let sources;
  try {
    sources = await loadRegistrySources();
  } catch (err) {
    if (err instanceof RegistrySourcesError) {
      return { ok: false, error: `registries.json invalid (${err.reason}): ${err.message}` };
    }
    throw err;
  }
  const lines = ['IJFW Registry Status:', ''];
  for (const src of sources) {
    const { cache, corrupt, reason } = await readSourceCache(src);
    lines.push(`  [${src.priority}] ${src.name} (${src.url})`);
    if (corrupt) {
      lines.push(`        CORRUPT (${reason}) — next refresh will rebuild`);
      continue;
    }
    const pubAt = cache.publishers_fetched_at || '(never)';
    const revAt = cache.revocation_fetched_at || '(never)';
    const pubCount = cache.publishers ? Object.keys(cache.publishers).length : 0;
    const revCount = Array.isArray(cache.revoked) ? cache.revoked.length : 0;
    lines.push(`        publishers_fetched_at: ${pubAt} (${pubCount} entries)`);
    lines.push(`        revocation_fetched_at: ${revAt} (${revCount} revoked)`);
  }
  return { ok: true, output: lines.join('\n') };
}

/**
 * trust-registry --emergency [<url>] — bypass caches; force fresh fetch.
 *
 * Without --emergency, fall through to the regular split-TTL path.
 */
async function trustRegistry(args, _ctx) {
  const tokens = tokenize(args);
  const emergency = tokens.includes('--emergency');
  const remaining = tokens.filter((t) => t !== '--emergency');

  // Optional URL arg post-emergency. With a URL we target only that single
  // source via loadRegistrySources()'s back-compat fall-back. Without, full
  // federation refresh.
  const url = remaining[0];

  const opts = { emergency };
  if (url) {
    // Synthesize a one-shot source descriptor.
    opts.sources = [
      {
        name: 'cli',
        url,
        meta_key_pem: IJFW_REGISTRY_META_KEY_PEM,
        priority: 0,
        publisher_ttl_ms: 24 * 60 * 60 * 1000,
        revocation_ttl_ms: 5 * 60 * 1000,
      },
    ];
  }

  let result;
  try {
    result = await refreshTrustFromAllRegistries(opts);
  } catch (err) {
    if (err instanceof RegistrySourcesError) {
      return { ok: false, error: `registries.json invalid (${err.reason}): ${err.message}` };
    }
    return { ok: false, error: err.message };
  }
  if (!result.ok) {
    return { ok: false, error: result.error || 'refresh failed' };
  }
  const summary = result.multi
    ? `sources=${result.multi.sources.length} global_revocations=${result.multi.global_revocations.length} conflicts=${result.multi.conflicts.length}`
    : 'no diff';
  const warnings = result.warnings && result.warnings.length > 0
    ? `\nwarnings:\n${result.warnings.map((w) => `  - ${w}`).join('\n')}`
    : '';
  return {
    ok: true,
    output: `trust-registry${emergency ? ' --emergency' : ''}: ${summary}${warnings}`,
  };
}

// ---------------------------------------------------------------------------
// Frozen exports (Wave-A invariant)
// ---------------------------------------------------------------------------

export const handlers = Object.freeze({
  'registry-list': registryList,
  'registry-add': registryAdd,
  'registry-remove': registryRemove,
  'registry-prioritize': registryPrioritize,
  'registry-status': registryStatus,
  'trust-registry': trustRegistry,
});

export const subcommandHelp = Object.freeze({
  'registry-list': 'list configured registries in priority order',
  'registry-add': 'add <name> <url> [<meta-key-path>] — append a registry source',
  'registry-remove': 'remove <name> — remove a registry source by name',
  'registry-prioritize': 'prioritize <name> <position> — change a source\'s priority',
  'registry-status': 'show per-source cache state (publishers + revocation TTLs)',
  'trust-registry': 'refresh trust from all sources; --emergency bypasses cache',
});

// Helper for tests
export const _testInternals = Object.freeze({
  registriesConfigPath,
  readRegistriesFile,
  writeRegistriesFile,
});

// Avoid an "unused" lint hit on `stat` (kept for future use).
void stat;
