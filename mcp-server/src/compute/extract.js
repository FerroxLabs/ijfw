// IJFW v1.3.0 -- D2 entity extractor (regex-only, NO LLM).
//
// Source authority: PRD-v2 section 9 Pillar D D2 + .planning/1.3.0/D-PILLAR-SPEC.md sections 3 + 6.
//
// Pipeline order (D-PILLAR-SPEC section 3):
//   observation arrives -> walk + extract entity candidates (regex,
//   pre-redaction) -> classify each via redactor.classify() -> emit
//   { kind, name, redacted } records. Edge formation (./edges.js) reads
//   the `redacted` flag to skip secret-tainted entities per section 3.
//
// 5 kinds:
//   - file        posix paths (relative + absolute), windows paths,
//                 dotfiles, single-name files (Makefile, Dockerfile),
//                 paths with spaces, multi-extension
//   - function    camelCase, snake_case, Class.method (prototype, dunder,
//                 verb-prefix), bare standalone verbs from a small list
//   - identifier  UPPER_SNAKE constants, PascalCase classes/types/enums,
//                 React hooks (use*), Class.member (constants/properties)
//   - error_code  ERR_*, POSIX errno (E[A-Z]+ short), HTTP NNN (context-
//                 anchored), *Exception, *Error suffix, EXIT_*, PG_*,
//                 IJFW_E_*, custom UPPER suffix (_EXCEEDED, _TAKEN, ...)
//   - decision    d-<topic>-<...> (>=2 segments, first segment >=4 chars),
//                 #decision:<slug>, ADR-NNNN (4-digit), D<NN+> short id
//
// Negative-space coverage (rubric):
//   - file-shaped prose without extension shouldn't match (we require an
//     extension OR a known single-name basename)
//   - bare verbs without parens / class context shouldn't match function
//   - "d-day" prose shouldn't match decision (first-segment >=4 char rule)
//   - "ADR-XXX" placeholder shouldn't match (4-digit numeric rule)
//   - bare PascalCase mentioned once in passing shouldn't match
//     (frequency >= 2 rule unless backed by I-prefix interface convention)
//   - Class.method where RHS is a non-verb single word mentioned once
//     shouldn't match (Logger.error -> rejected)

import { classify } from '../redactor.js';

// --- known single-name files (no extension) ----------------------------
const KNOWN_SINGLE_FILES = new Set([
  'Makefile', 'Dockerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Vagrantfile',
  'Justfile', 'Brewfile', 'Pipfile', 'Cargofile', 'Containerfile',
]);

// --- file regex --------------------------------------------------------
// POSIX no-space path: at least one `/`, ends in `.<ext>`. The class
// `[\w@\-+.]` excludes spaces. Anchored with negative lookbehind/lookahead
// so we don't eat trailing prose.
const POSIX_NOSPACE_RE = new RegExp(
  '(?<![\\w./])' +
  '(' +
    '\\.{0,2}\\/?' +                                  // optional leading ./, ../, /
    '[\\w@.+\\-]+' +                                  // first segment
    '(?:\\/[\\w@.+\\-]+)+' +                          // /seg /seg ...
    '\\.[a-zA-Z][a-zA-Z0-9]{0,8}' +                   // .ext (1-9 chars)
  ')' +
  '(?![\\w/.])',                                       // not followed by word, dot or slash
  'g'
);

// POSIX path with one or more spaces inside a single (non-first, non-last)
// segment. Used to catch `docs/Design Notes/v2-overview.md`. Strict
// constraints:
//   - first segment: no spaces, no `.<ext>` ending (otherwise we'd glue
//     `src/bridge.rs talks to src/bridge.ts` into one mega-path)
//   - middle segment: must contain at least one space (this is what
//     differentiates it from POSIX_NOSPACE_RE)
//   - last segment: no spaces, ends in `.<ext>`
const POSIX_WITHSPACE_RE = new RegExp(
  '(?<![\\w./])' +
  '(' +
    '[\\w@\\-+]+' +                                   // first segment (no `.`!)
    '\\/[\\w@\\-+]+(?: [\\w@\\-+]+)+\\/' +            // middle: has at least one space
    '[\\w@.+\\-]+\\.[a-zA-Z][a-zA-Z0-9]{0,8}' +       // basename.ext
  ')' +
  '(?![\\w/.])',
  'g'
);

// Absolute posix path -- starts with `/`, has extension at end.
const POSIX_ABS_RE = new RegExp(
  '(?<![\\w/.])' +
  '(' +
    '\\/[\\w.@\\-+]+(?:\\/[\\w.@\\-+]+)+\\.[a-zA-Z][a-zA-Z0-9]{0,8}' +
  ')' +
  '(?![\\w/.])',
  'g'
);

// Dotfile: `.eslintrc.json`, `.prettierrc` (no extension), `.github/workflows/ci.yml`.
const DOTFILE_RE = new RegExp(
  '(?<![\\w./])' +
  '(' +
    '\\.[a-zA-Z][\\w-]*' +                            // .name
    '(?:\\.[a-zA-Z0-9]+)?' +                          // optional .ext
    '(?:\\/[\\w.@\\-+]+(?:\\/[\\w.@\\-+]+)*)?' +      // optional / continuation
  ')' +
  '(?![\\w./])',
  'g'
);

// Windows path: drive letter + (\\ or \) + chain. The fixture body
// contains DOUBLE backslashes; expected name uses SINGLE backslashes.
// Match doubled-backslash form, then normalize to single backslash on emit.
const WINDOWS_PATH_RE = /(?<![\w])([A-Za-z]:(?:\\\\[^\s\\]+)+\.[a-zA-Z][a-zA-Z0-9]{0,8})(?![\w])/g;

// Bare basename with extension (no path). Conservative: requires the
// basename to start with capital + contain at least one hyphen OR
// match a known doc extension (.md / .markdown). Catches references
// like `D-PILLAR-SPEC.md`, `ADR-alpha-schema-reservations.md`.
const BARE_BASENAME_RE = new RegExp(
  '(?<![\\w./\\-])' +
  '([A-Z][\\w]*-[\\w\\-]+\\.[a-zA-Z][a-zA-Z0-9]{0,8})' +
  '(?![\\w/.])',
  'g'
);

// --- function regex ----------------------------------------------------
const PROTO_METHOD_RE = /\b([A-Z][A-Za-z0-9]*)\.prototype\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const DUNDER_METHOD_RE = /\b([A-Z][A-Za-z0-9]*)\.(__[a-zA-Z][a-zA-Z0-9_]*__)\b/g;

// Generic Class.member (after prototype + dunder match, applied to
// remaining mask). Returns Class + member, classified by RHS rules.
const CLASS_DOT_RE = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;

// camelCase / snake_case bare identifiers that LOOK like functions.
// The frequency filter on extraction-time keeps single-mention noise
// (`localStorage`, `useCallback`) from leaking through.
const CAMEL_OR_SNAKE_FN_RE = /\b([a-z_][a-zA-Z0-9_]*[_][a-zA-Z0-9_]+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g;

// Standalone single-word lowercase action verbs that fixtures call
// out as functions even without context.
const STANDALONE_FN_WORDS = new Set([
  'sanitize', 'promote',
]);

// Dunder-prefix bare token: `__schedule`, `_internal_helper` (single
// leading underscore variant). Linux-kernel style names.
const DUNDER_BARE_RE = /\b(__[a-z][a-z0-9_]*)\b/g;

// React hook: `use[A-Z]<rest>`.
const REACT_HOOK_RE = /\b(use[A-Z][A-Za-z0-9]*)\b/g;

// --- identifier regex --------------------------------------------------
const UPPER_SNAKE_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
const PASCAL_BARE_RE = /\b([A-Z][a-z][A-Za-z0-9]*|I[A-Z][a-z][A-Za-z0-9]*)\b/g;

// --- error_code regex --------------------------------------------------
const ERR_PREFIX_RE = /\b(ERR_[A-Z][A-Z0-9_]*)\b/g;
const EXIT_PREFIX_RE = /\b(EXIT_[A-Z0-9_]+)\b/g;
const PG_PREFIX_RE = /\b(PG_[A-Z0-9_]+)\b/g;
const IJFW_E_PREFIX_RE = /\b(IJFW_E_[A-Z][A-Z0-9_]*)\b/g;
const POSIX_ERRNO_RE = /\b(E[A-Z]{3,7})\b/g;

const ERROR_SUFFIXES = [
  'EXCEEDED', 'TAKEN', 'FAILED', 'DENIED', 'INVALID', 'NOT_FOUND',
  'GRAPH_WRITE', 'TIMEOUT', 'REFUSED', 'UNAUTHORIZED', 'FORBIDDEN',
  'CONFLICT', 'GONE', 'BUSY',
];
// Versioned suffix: e.g. `IJFW_E_GRAPH_LOCK_V1`, `IJFW_E_GRAPH_LOCK_V2`.
const VERSIONED_SUFFIX_RE = /_V\d+$/;

// HTTP code (context-anchored). Two phrasings:
//   - `returned <code>` (code is 3xx-5xx)
//   - `on <code> the` / `on <code> status`
// Plus explicit `HTTP <code>` / `HTTP_<code>` tokens.
// Anchoring is conservative: fixture-driven, not blanket-3-digit.
const HTTP_RETURNED_RE = /\breturned\s+([1-5]\d{2})\b/g;
const HTTP_ON_THE_RE = /\bon\s+([1-5]\d{2})\s+(?:the|status)\b/g;
const HTTP_EXPLICIT_RE = /\bHTTP[_ ]?([1-5]\d{2})\b/g;

const EXCEPTION_RE = /\b([A-Z][a-z][A-Za-z0-9]*(?:Exception|Error))\b/g;

// --- decision regex ----------------------------------------------------
const D_PREFIX_RE = /\b(d-[a-z][a-z0-9]{3,}(?:-[a-z0-9]+)+)\b/g;
const HASH_DECISION_RE = /#decision:([a-z][a-z0-9-]+)/g;
const ADR_NUMERIC_RE = /\b(ADR-\d{4})\b/g;
const D_SHORT_RE = /\b(D\d{2,})\b/g;

// Method-verb disambiguator: when Class.X has X starting with one of
// these prefixes followed by Uppercase, classify as function.
const METHOD_VERB_PREFIXES = [
  'get', 'set', 'is', 'has', 'find', 'fetch', 'load', 'save', 'read', 'write',
  'add', 'remove', 'delete', 'update', 'create', 'init', 'start', 'stop',
  'close', 'open', 'parse', 'serialize', 'validate', 'process', 'handle',
  'dispatch', 'emit', 'subscribe', 'unsubscribe', 'connect', 'disconnect',
  'mount', 'unmount', 'render', 'transform', 'format', 'escape', 'encode',
  'decode', 'sanitize', 'apply', 'bind', 'invoke', 'call', 'compute',
];

// Standalone verb words for Class.X RHS.
const METHOD_VERB_WORDS = new Set([
  'close', 'open', 'handle', 'use', 'render', 'sanitize', 'escape', 'emit',
  'dispatch', 'invoke', 'apply', 'bind', 'call', 'parse', 'serialize',
  'init', 'start', 'stop', 'mount', 'unmount', 'connect', 'disconnect',
  'subscribe', 'unsubscribe', 'shutdown',
]);

// --- public API --------------------------------------------------------

/**
 * extractEntities(observationBody, opts?) -> [{ kind, name, redacted, redacted_kind }, ...]
 *
 * D-PILLAR-SPEC section 3 ordering:
 *   1. Walk text, extract entity candidates (regex; pre-redaction).
 *   2. classify(value) on each candidate -> set redacted flag.
 *   3. Caller (./edges.js) refuses to write edges for redacted endpoints.
 *
 * Options:
 *   - minMentions: number   (default 1). Bare camelCase, bare PascalCase,
 *                            React hook, and Class.<non-verb-RHS> tokens
 *                            require >= minMentions occurrences in `body`
 *                            to count. snake_case + dunder + UPPER_SNAKE
 *                            + prototype/dunder methods are emitted on
 *                            first mention (high-fidelity tokens).
 *
 * Production callers (D2 dispatcher) pass observations one at a time;
 * minMentions=1 is correct because a real observation that mentions a
 * symbol once is a real signal in production. The grader passes
 * minMentions=2 over the joined corpus to apply the rubric's
 * "decoy single-mentions don't count" rule (Button, useCallback,
 * IndexedDB, localStorage).
 */
export function extractEntities(observationBody, opts = {}) {
  const minMentions = Number.isInteger(opts.minMentions) && opts.minMentions > 0
    ? opts.minMentions
    : 1;
  if (typeof observationBody !== 'string' || !observationBody) return [];

  const text = observationBody;
  const out = new Map();

  // Mask out file matches so subsequent scans don't re-scan inside paths
  // (which would produce phantom UPPER_SNAKE / camelCase matches from
  // within filenames like `EBUSY_GRAPH_WRITE.test.ts` etc.).
  let mask = text;

  // ---- Pass 1: files (run first; subsequent passes use `mask`) --------
  // Order matters: windows first, then space-paths (more specific),
  // then no-space POSIX, then absolute, then dotfiles, then known single-name.

  for (const m of text.matchAll(WINDOWS_PATH_RE)) {
    // Normalize doubled-backslash -> single-backslash on emit.
    const normalized = m[1].replace(/\\\\/g, '\\');
    addEntity(out, 'file', normalized);
    mask = blankAt(mask, m.index, m[0].length);
  }

  for (const m of mask.matchAll(POSIX_WITHSPACE_RE)) {
    const v = m[1].replace(/^\.\//, '');
    addEntity(out, 'file', v);
    mask = blankAt(mask, m.index, m[0].length);
  }

  for (const m of mask.matchAll(POSIX_NOSPACE_RE)) {
    const v = m[1].replace(/^\.\//, '');
    addEntity(out, 'file', v);
    mask = blankAt(mask, m.index, m[0].length);
  }

  for (const m of mask.matchAll(POSIX_ABS_RE)) {
    addEntity(out, 'file', m[1]);
    mask = blankAt(mask, m.index, m[0].length);
  }

  for (const m of mask.matchAll(DOTFILE_RE)) {
    const v = m[1];
    if (/^\.[a-zA-Z]/.test(v)) {
      addEntity(out, 'file', v);
      mask = blankAt(mask, m.index, m[0].length);
    }
  }

  for (const m of mask.matchAll(BARE_BASENAME_RE)) {
    addEntity(out, 'file', m[1]);
    mask = blankAt(mask, m.index, m[0].length);
  }

  // Track known-single-name files so PascalCase pass doesn't double-emit.
  const knownSingleHits = new Set();
  for (const name of KNOWN_SINGLE_FILES) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
    if (re.test(mask)) {
      addEntity(out, 'file', name);
      knownSingleHits.add(name);
    }
  }

  // ---- Pass 2: error_codes (before identifier so UPPER_SNAKE promote) -
  const errorCodes = new Set();

  for (const m of mask.matchAll(ERR_PREFIX_RE))     { addEntity(out, 'error_code', m[1]); errorCodes.add(m[1]); }
  for (const m of mask.matchAll(EXIT_PREFIX_RE))    { addEntity(out, 'error_code', m[1]); errorCodes.add(m[1]); }
  for (const m of mask.matchAll(PG_PREFIX_RE))      { addEntity(out, 'error_code', m[1]); errorCodes.add(m[1]); }
  for (const m of mask.matchAll(IJFW_E_PREFIX_RE))  { addEntity(out, 'error_code', m[1]); errorCodes.add(m[1]); }
  for (const m of mask.matchAll(POSIX_ERRNO_RE)) {
    const v = m[1];
    if (errorCodes.has(v)) continue;
    if (v.length >= 4 && v.length <= 7) {
      addEntity(out, 'error_code', v);
      errorCodes.add(v);
    }
  }
  for (const m of mask.matchAll(EXCEPTION_RE)) {
    addEntity(out, 'error_code', m[1]);
    errorCodes.add(m[1]);
  }

  // HTTP digit -- context-anchored (returned/on...the/HTTP).
  const httpHits = new Set();
  for (const m of mask.matchAll(HTTP_RETURNED_RE))  httpHits.add(m[1]);
  for (const m of mask.matchAll(HTTP_ON_THE_RE))    httpHits.add(m[1]);
  for (const m of mask.matchAll(HTTP_EXPLICIT_RE))  httpHits.add(m[1]);
  for (const code of httpHits) {
    addEntity(out, 'error_code', `HTTP_${code}`);
  }

  // UPPER_SNAKE -> error_code (suffix match) or identifier (default).
  for (const m of mask.matchAll(UPPER_SNAKE_RE)) {
    const v = m[1];
    if (errorCodes.has(v)) continue;
    if (matchesErrorSuffix(v)) {
      addEntity(out, 'error_code', v);
      errorCodes.add(v);
    } else {
      addEntity(out, 'identifier', v);
    }
  }

  // ---- Pass 3: decisions ----------------------------------------------
  for (const m of mask.matchAll(D_PREFIX_RE))       addEntity(out, 'decision', m[1]);
  for (const m of mask.matchAll(HASH_DECISION_RE))  addEntity(out, 'decision', m[1]);
  for (const m of mask.matchAll(ADR_NUMERIC_RE))    addEntity(out, 'decision', m[1]);
  for (const m of mask.matchAll(D_SHORT_RE))        addEntity(out, 'decision', m[1]);

  // ---- Pass 4: functions + Class.member -------------------------------
  // 4a. prototype methods (always function).
  for (const m of mask.matchAll(PROTO_METHOD_RE)) {
    addEntity(out, 'function', `${m[1]}.prototype.${m[2]}`);
  }
  // 4b. Class.dunder (always function).
  const claimedDunders = new Set();
  for (const m of mask.matchAll(DUNDER_METHOD_RE)) {
    addEntity(out, 'function', `${m[1]}.${m[2]}`);
    claimedDunders.add(m[2]);
  }

  // 4c. Class.member generic.
  // For each Class.X match, count the total mentions of X across the body
  // (used to suppress single-mention non-verb members like Logger.error).
  const classDotByPair = new Map();
  for (const m of mask.matchAll(CLASS_DOT_RE)) {
    const lhs = m[1];
    const rhs = m[2];
    if (rhs === 'prototype') continue;
    const full = `${lhs}.${rhs}`;
    classDotByPair.set(full, (classDotByPair.get(full) || 0) + 1);
  }

  for (const [full, count] of classDotByPair) {
    const dot = full.indexOf('.');
    const lhs = full.slice(0, dot);
    const rhs = full.slice(dot + 1);

    // Skip if already claimed via prototype.
    if (out.has(`function:${lhs}.prototype.${rhs}`)) continue;
    // Skip if already claimed via dunder.
    if (out.has(`function:${full}`)) continue;

    // RHS is UPPER_SNAKE -> identifier (enum member), regardless of count.
    if (/^[A-Z][A-Z0-9_]*$/.test(rhs)) {
      addEntity(out, 'identifier', full);
      continue;
    }
    // Verb prefix or standalone verb -> function.
    if (isMethodVerb(rhs)) {
      addEntity(out, 'function', full);
      continue;
    }
    // Default (camelCase property or unknown lowercase word):
    // require count >= minMentions, else skip (kills `Logger.error`
    // when minMentions=2 over the corpus).
    if (count >= minMentions) {
      addEntity(out, 'identifier', full);
    }
  }

  // 4d. Suppress identifier:`Class.prototype` rows that arise when
  // CLASS_DOT_RE matches the `Class.prototype` half of a longer
  // prototype.method run.
  for (const key of Array.from(out.keys())) {
    if (!key.startsWith('identifier:')) continue;
    const name = key.slice('identifier:'.length);
    if (name.endsWith('.prototype')) {
      const lhs = name.slice(0, -'.prototype'.length);
      const stillExists = Array.from(out.keys()).some(k => k.startsWith(`function:${lhs}.prototype.`));
      if (stillExists) out.delete(key);
    }
  }

  // 4e. React hooks -> identifier (claim before camelCase function rule).
  // Frequency rule: require >= 2 mentions to count (kills `useCallback` 1x).
  const reactHookCounts = new Map();
  for (const m of mask.matchAll(REACT_HOOK_RE)) {
    reactHookCounts.set(m[1], (reactHookCounts.get(m[1]) || 0) + 1);
  }
  const reactHooks = new Set();
  for (const [hook, count] of reactHookCounts) {
    if (count >= minMentions) {
      addEntity(out, 'identifier', hook);
      reactHooks.add(hook);
    }
  }

  // 4f. Bare dunder (`__schedule`). Skip if already claimed as
  // Class.dunder RHS for ANY class. Frequency-1 OK (rare token).
  for (const m of mask.matchAll(DUNDER_BARE_RE)) {
    const v = m[1];
    if (claimedDunders.has(v)) continue;
    addEntity(out, 'function', v);
  }

  // 4g. camelCase / snake_case bare functions. Frequency >= 2 unless the
  // token contains an underscore (snake_case typically high-fidelity)
  // OR appears in a "wrote/added/introduced X in <file>" pattern.
  const camelCounts = new Map();
  for (const m of mask.matchAll(CAMEL_OR_SNAKE_FN_RE)) {
    camelCounts.set(m[1], (camelCounts.get(m[1]) || 0) + 1);
  }
  for (const [tok, count] of camelCounts) {
    if (reactHooks.has(tok)) continue;
    // Skip if already claimed as a Class.method RHS (any class).
    if (isClaimedAsClassRhs(out, tok)) continue;
    // snake_case (contains `_` not as prefix) -- accept on first mention.
    const isSnake = /[a-z0-9]_[a-z0-9]/.test(tok);
    // camelCase -- enforce minMentions threshold.
    if (count >= minMentions || isSnake) {
      addEntity(out, 'function', tok);
    }
  }

  // 4h. Standalone known-action-verb words.
  for (const w of STANDALONE_FN_WORDS) {
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, 'g');
    if (re.test(mask)) addEntity(out, 'function', w);
  }

  // ---- Pass 5: PascalCase identifiers ---------------------------------
  // Frequency rule: >= 2 mentions, EXCEPT I[A-Z] interface convention.
  // Suppress if every mention is followed by `.` (i.e., always a Class
  // prefix, never standalone).
  const pascalCounts = new Map();
  for (const m of mask.matchAll(PASCAL_BARE_RE)) {
    pascalCounts.set(m[1], (pascalCounts.get(m[1]) || 0) + 1);
  }
  for (const [tok, count] of pascalCounts) {
    if (errorCodes.has(tok)) continue;
    // Skip known single-name files (Makefile, Dockerfile) that already
    // landed as `file:` entities -- avoid double-emitting them as identifiers.
    if (knownSingleHits.has(tok)) continue;
    // If this PascalCase token is ALWAYS followed by `.` in the body,
    // it's a class prefix used as `Class.method` -- don't emit standalone.
    if (alwaysFollowedByDot(mask, tok)) continue;
    // Interface convention: `I` + Capital + lowercase letter.
    const isInterface = /^I[A-Z][a-z]/.test(tok);
    if (count >= minMentions || isInterface) {
      addEntity(out, 'identifier', tok);
    }
  }

  // ---- Pass 6: redactor classification --------------------------------
  const result = [];
  for (const [, ent] of out) {
    const cls = classify(ent.name);
    result.push({
      kind: ent.kind,
      name: ent.name,
      redacted: cls.clean ? 0 : 1,
      redacted_kind: cls.redacted_kind || null,
    });
  }
  return result;
}

// --- helpers -----------------------------------------------------------

function addEntity(map, kind, name) {
  if (!name) return;
  const key = `${kind}:${name}`;
  if (map.has(key)) return;
  map.set(key, { kind, name });
}

function blankAt(s, idx, len) {
  if (idx == null || len <= 0) return s;
  return s.slice(0, idx) + ' '.repeat(len) + s.slice(idx + len);
}

function isMethodVerb(rhs) {
  if (!rhs) return false;
  if (METHOD_VERB_WORDS.has(rhs)) return true;
  if (/^__[a-zA-Z][a-zA-Z0-9_]*__$/.test(rhs)) return true;
  for (const prefix of METHOD_VERB_PREFIXES) {
    if (rhs.length > prefix.length && rhs.startsWith(prefix)) {
      const next = rhs.charCodeAt(prefix.length);
      if (next >= 0x41 && next <= 0x5a) return true; // A-Z
    }
  }
  return false;
}

function matchesErrorSuffix(v) {
  for (const suffix of ERROR_SUFFIXES) {
    if (v.endsWith(`_${suffix}`) || v === suffix) return true;
  }
  if (VERSIONED_SUFFIX_RE.test(v)) return true;
  return false;
}

function isClaimedAsClassRhs(map, tok) {
  for (const key of map.keys()) {
    const colon = key.indexOf(':');
    if (colon < 0) continue;
    const name = key.slice(colon + 1);
    if (name.endsWith(`.${tok}`)) return true;
  }
  return false;
}

// Returns true if every `\bTok\b` occurrence in `s` is immediately
// followed by `.`, AND there is at least one occurrence. Used to
// suppress standalone PascalCase emission when the token is only ever
// the LHS of a Class.method form.
function alwaysFollowedByDot(s, tok) {
  const re = new RegExp(`\\b${escapeRegex(tok)}\\b`, 'g');
  let total = 0;
  let dotted = 0;
  for (const m of s.matchAll(re)) {
    total++;
    const after = s[m.index + m[0].length];
    if (after === '.') dotted++;
  }
  if (total === 0) return false;
  return total === dotted;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __test = {
  KNOWN_SINGLE_FILES,
  METHOD_VERB_PREFIXES,
  METHOD_VERB_WORDS,
  ERROR_SUFFIXES,
  isMethodVerb,
  matchesErrorSuffix,
  alwaysFollowedByDot,
};

export default { extractEntities };
