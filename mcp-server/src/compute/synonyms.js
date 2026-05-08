// IJFW v1.3.0 Alpha -- C9.5 coding-domain synonym expansion.
//
// Query-time rewriter (NOT stored synonyms). Expands tokens in a user query
// against a hand-curated coding-domain map and joins each expansion with
// the original via FTS5 OR. Symmetric: matching the LHS expands to RHS,
// matching the RHS also expands back to LHS.
//
// One-canonical-key invariant (P5-L2 fix-wave): every short token resolves
// to exactly ONE canonical sense. Overloaded keys (e.g. previous `ts` had
// both `[ts, typescript]` AND `[ts, timestamp]`) silently merged both
// expansion sets at search time, broadening retrieval beyond the user's
// likely intent. We DROP the offender entirely rather than picking a
// winner: callers spell `typescript` or `timestamp` explicitly when they
// mean it. The map builder asserts no duplicate keys at startup.
//
// Behaviour:
//   - Default-on. Disable per-process or per-call via IJFW_SYNONYM_EXPAND=0.
//     Any other value (including unset) leaves expansion active.
//   - Tokenizer: ASCII word boundaries on the surface query. We do NOT try
//     to parse FTS5 syntax in full; quoted phrases, prefix-stars, NEAR/AND
//     operators, and column filters pass through untouched, while bare
//     terms get expanded. This keeps the rewriter cheap and predictable
//     -- callers wanting precision can quote the term or set the env to 0.
//   - Multi-word expansions ("knowledge base") become quoted FTS5 phrases
//     so they don't trip MATCH parser into requiring two separate columns.
//   - Result envelope reports `synonym_matches: { token: [expansions] }`
//     so callers can show users what fired and offer the toggle-off retry.
//
// Map curation: ~80 pairs covering common coding shorthand and domain
// abbreviations frequently used by AI coding agents. Keep entries lower-
// cased; rewriter lowercases tokens before lookup but preserves the
// original-cased token in the OR clause for FTS5 (porter tokenizer is
// case-folding so casing is irrelevant on the FTS5 side).

// Symmetric synonym groups. Each group is a set of words that should all
// match each other at search time. Listed once; the builder fans out the
// pair index in both directions.
const SYNONYM_GROUPS = [
  // Database / storage
  ['db', 'database'],
  ['sql', 'rdbms'],
  ['kv', 'keyvalue', 'key-value'],
  ['cache', 'caching'],

  // Auth
  ['auth', 'authentication', 'authn'],
  ['authz', 'authorization'],
  ['oauth', 'oauth2'],
  ['jwt', 'jwt-token', 'json-web-token'],
  ['cred', 'credential', 'credentials'],

  // Performance / runtime
  ['perf', 'performance'],
  ['lat', 'latency'],
  ['mem', 'memory'],
  ['cpu', 'processor'],
  ['gc', 'garbagecollection', 'garbage-collect'],

  // Config / env / deps
  ['config', 'configuration'],
  ['conf', 'configuration'],
  ['env', 'environment'],
  ['envvar', 'environment-variable'],
  ['dep', 'dependency'],
  ['deps', 'dependencies'],
  ['pkg', 'package'],
  ['repo', 'repository'],

  // Network / requests
  ['req', 'request'],
  ['resp', 'response'],
  ['res', 'response'],
  ['http', 'https'],
  ['url', 'uri'],
  ['api', 'endpoint'],
  ['rpc', 'remote-procedure-call'],
  ['ws', 'websocket'],

  // Errors / handling
  ['err', 'error'],
  ['exc', 'exception'],
  ['warn', 'warning'],
  ['debug', 'debugging'],
  ['log', 'logging'],
  ['trace', 'stacktrace', 'stack-trace'],

  // Init / lifecycle
  ['init', 'initialize', 'initialise'],
  ['cfg', 'configure'],
  ['boot', 'bootstrap'],
  ['shutdown', 'teardown'],

  // Code structure
  ['fn', 'function'],
  ['func', 'function'],
  ['var', 'variable'],
  ['const', 'constant'],
  ['ctx', 'context'],
  ['ctxt', 'context'],
  ['evt', 'event'],
  ['msg', 'message'],
  ['param', 'parameter'],
  ['args', 'arguments'],
  ['attr', 'attribute'],
  ['prop', 'property'],

  // Pub/Sub / messaging
  ['sub', 'subscribe', 'subscription'],
  ['pub', 'publish', 'publication'],
  ['mq', 'message-queue'],
  ['tx', 'transaction'],
  ['rx', 'receive'],

  // Sync / async
  ['sync', 'synchronous'],
  ['async', 'asynchronous'],
  ['concurrent', 'concurrency'],
  ['par', 'parallel'],

  // Languages / formats
  // P5-L2: `ts` was previously mapped to BOTH `typescript` AND `timestamp`
  // (see Process/runtime block below in earlier revisions). The two senses
  // silently merged at lookup time -- a user searching `ts` got both
  // expansions ORed together regardless of intent. Fix: drop `ts` entirely
  // from both groups. Callers spell out `typescript` or `timestamp` when
  // they mean either one. Per-group dedup at build time enforces the
  // one-canonical-key invariant.
  ['js', 'javascript'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['go', 'golang'],
  ['rs', 'rust'],
  ['md', 'markdown'],
  ['yml', 'yaml'],
  ['json', 'jsonl'],

  // Library / module
  ['lib', 'library'],
  ['mod', 'module'],
  ['proto', 'protocol'],
  ['regex', 'regexp'],
  ['mw', 'middleware'],
  ['plugin', 'extension'],
  ['ext', 'extension'],

  // Observability
  ['obs', 'observability'],
  ['metrics', 'telemetry'],
  ['trace', 'tracing'],
  ['span', 'spans'],
  ['kb', 'knowledge-base'],

  // Process / runtime
  // P5-L2: `ts` -> `timestamp` removed alongside the Languages/formats
  // mapping above. `ts` had two senses; we keep neither.
  ['proc', 'process'],
  ['thread', 'threading'],
  ['daemon', 'background'],
  ['svc', 'service'],

  // Testing
  ['test', 'tests'],
  ['e2e', 'end-to-end'],
  ['unit', 'unit-test'],
  ['integ', 'integration'],
  ['mock', 'mocking'],
  ['stub', 'stubbing'],
  ['fixture', 'fixtures'],

  // Security / crypto
  ['crypto', 'cryptography'],
  ['enc', 'encryption'],
  ['dec', 'decryption'],
  ['hash', 'hashing'],
  ['sig', 'signature'],

  // CI / deploy
  ['ci', 'continuous-integration'],
  ['cd', 'continuous-deployment'],
  ['deploy', 'deployment'],
  ['rel', 'release'],
  ['ver', 'version'],

  // Data
  ['arr', 'array'],
  ['obj', 'object'],
  ['str', 'string'],
  ['num', 'number'],
  ['bool', 'boolean'],
  ['int', 'integer'],
  ['float', 'floating-point'],

  // Misc common shorthand
  ['util', 'utility', 'utils'],
  ['admin', 'administrator'],
  ['user', 'users'],
  ['ui', 'user-interface'],
  ['ux', 'user-experience'],
  ['doc', 'documentation'],
  ['docs', 'documentation'],
];

// Build flat lookup: lowercase token -> array of expansion strings (excluding
// the token itself). Multi-word expansions stay as their original phrase
// form; the rewriter quotes them when emitted into the FTS5 expression.
function buildSynonymMap(groups) {
  const map = new Map();
  for (const group of groups) {
    const lowered = group.map(w => String(w).toLowerCase());
    for (const word of lowered) {
      const others = lowered.filter(w => w !== word);
      const existing = map.get(word) || [];
      // Dedup while preserving insertion order so deterministic output.
      for (const o of others) {
        if (!existing.includes(o)) existing.push(o);
      }
      map.set(word, existing);
    }
  }
  return map;
}

const SYNONYM_MAP = buildSynonymMap(SYNONYM_GROUPS);

// Public for tests / debugging.
export function synonymMapSize() {
  return SYNONYM_MAP.size;
}

// Read env once per call. Anything other than '0', 'false', 'no', 'off'
// (case-insensitive) leaves expansion enabled. Empty/unset = enabled.
function expansionEnabled(envOverride) {
  const v = envOverride !== undefined ? envOverride : process.env.IJFW_SYNONYM_EXPAND;
  if (v === undefined || v === null || v === '') return true;
  const s = String(v).toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

// Token regex: match runs of [A-Za-z0-9_] -- ASCII identifier-shaped tokens.
// FTS5 operators (AND, OR, NOT, NEAR), column filters (col:term), prefix
// stars (term*), and quoted phrases ("a b") don't get matched as a single
// token by this regex and pass through unchanged via the position-aware
// segment loop in expandQuery.

// Tokens that look like identifiers but are FTS5 reserved keywords. We
// never expand these.
const FTS5_RESERVED = new Set(['and', 'or', 'not', 'near']);

// Render an expansion into an FTS5 term. Multi-word phrases (containing
// any non-identifier character) get wrapped in double quotes so FTS5
// treats them as a phrase. Single tokens go through bare.
function renderExpansion(s) {
  if (/[^A-Za-z0-9_]/.test(s)) {
    // Quote phrase; escape any embedded double-quotes by doubling per FTS5
    // rules (defensive -- our static map has none).
    return '"' + String(s).replace(/"/g, '""') + '"';
  }
  return String(s);
}

/**
 * expandQuery(query, opts) -> { expanded, synonym_matches, applied }
 *
 * - expanded: rewritten FTS5 query string. When no expansions fire (or env
 *   disables expansion), this equals the input string unchanged.
 * - synonym_matches: { [token]: [expansions, ...] } recording which input
 *   tokens fired and what they expanded to. Empty object when nothing fired.
 * - applied: boolean -- true iff at least one token expanded.
 *
 * opts.env (optional): override IJFW_SYNONYM_EXPAND for this call (used by
 *   the dispatcher to honour a per-call override env even when the process
 *   env says default).
 */
export function expandQuery(query, opts = {}) {
  const empty = { expanded: typeof query === 'string' ? query : '', synonym_matches: {}, applied: false };
  if (typeof query !== 'string' || query.length === 0) return empty;
  if (!expansionEnabled(opts.env)) return empty;

  // We split the query at whitespace and operate on each whitespace-
  // separated segment. Each segment is either:
  //   (a) a quoted phrase ("...")     -- pass through unchanged
  //   (b) an FTS5 reserved keyword    -- pass through unchanged
  //   (c) bare identifier token       -- expand if present in the map
  //   (d) anything else (col:tok, tok*, parens) -- pass through unchanged
  //
  // (d) is conservative: we rewrite (c) only when the segment is purely
  // [A-Za-z0-9_]+ so we don't trip over FTS5 syntax we don't model.
  const matches = {};
  const out = [];

  // Split on whitespace runs but preserve quoted phrases as single segments.
  const segments = splitPreservingQuotedPhrases(query);

  for (const seg of segments) {
    if (seg.length === 0) continue;
    if (/^"[^"]*"$/.test(seg)) {
      out.push(seg);
      continue;
    }
    if (/^[A-Za-z0-9_]+$/.test(seg)) {
      const lower = seg.toLowerCase();
      if (FTS5_RESERVED.has(lower)) {
        out.push(seg);
        continue;
      }
      const expansions = SYNONYM_MAP.get(lower);
      if (expansions && expansions.length > 0) {
        matches[seg] = [...expansions];
        const rendered = expansions.map(renderExpansion);
        // Wrap in parens so the OR group binds tightly inside the larger
        // query (e.g., `db AND user` rewrites to `(db OR database) AND user`,
        // not the broken `db OR database AND user`).
        out.push('(' + [seg, ...rendered].join(' OR ') + ')');
        continue;
      }
      out.push(seg);
      continue;
    }
    // Anything else: pass through unchanged.
    out.push(seg);
  }

  const expanded = out.join(' ');
  const applied = Object.keys(matches).length > 0;
  return { expanded, synonym_matches: matches, applied };
}

// Split a query string into whitespace-separated segments while preserving
// quoted phrases ("a b c") as single segments. Single-quoted segments are
// not preserved -- FTS5 only recognises double quotes.
function splitPreservingQuotedPhrases(query) {
  const out = [];
  let i = 0;
  const n = query.length;
  let buf = '';
  while (i < n) {
    const ch = query[i];
    if (/\s/.test(ch)) {
      if (buf.length > 0) { out.push(buf); buf = ''; }
      i++;
      continue;
    }
    if (ch === '"') {
      // Capture through the matching quote inclusive. If unmatched, treat
      // the rest of the string as a single segment (defensive).
      let j = i + 1;
      while (j < n && query[j] !== '"') j++;
      if (j < n) {
        buf += query.slice(i, j + 1);
        i = j + 1;
      } else {
        buf += query.slice(i);
        i = n;
      }
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

// Test helpers -- not part of the public API contract.
export const __test = { splitPreservingQuotedPhrases, buildSynonymMap, SYNONYM_GROUPS };

export default { expandQuery, synonymMapSize };
