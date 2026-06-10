/**
 * profile/exemplar-capture.js — Voice exemplar capture (V1).
 *
 * Turns a raw piece of the USER's OWN natural-language writing (their prompt
 * text, or a git commit message subject+body) into a bounded, PII-scrubbed
 * Exemplar and appends it to the transient exemplar store. This is the capture
 * side of the "draft in your voice" FEATURE — it is NOT a stylometry/authorship
 * detector. No statistical ruler, no corpus, no LLM, no network.
 *
 * What we DELIBERATELY skip (don't pollute the voice set):
 *   - empties / whitespace-only;
 *   - slash-commands, IJFW control prompts (`*`, `/`, `#` leading, "ijfw off");
 *   - pasted MACHINE OUTPUT — fenced code blocks, stack traces, diffs, JSON/log
 *     dumps. We want the user's natural-language writing, not code they pasted;
 *   - near-duplicates already in the store (dedup-by-id covers exact repeats;
 *     we also normalize trivially so "Fix it." and "fix it" collapse).
 *
 * Best-effort + fully isolated: every entrypoint is wrapped so a malformed
 * payload or a store write error NEVER throws into the caller (the hook must
 * never crash Claude Code). Zero deps, Node built-ins only. NO LLM calls.
 */

import { appendExemplar, exemplarId, EXEMPLAR_TEXT_MAX } from './exemplar-store.js';

// Direct-identifier patterns scrubbed before persist. Mirrors capture.js
// EDIT_PII_PATTERNS in spirit (kept LOCAL on purpose so this module's import
// graph stays zero-LLM/zero-network and independent of capture.js internals).
// Keep deliberately in sync if either list grows.
const PII_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,            // email
  /\b\d{3}-\d{2}-\d{4}\b/g,                              // US SSN shape
  /\b(?:\d[ -]?){13,19}\b/g,                             // card-ish long digit run
  /(?:\+?\d[\s().-]?){7,}\d/g,                           // phone-ish run of digits
  /\b[A-Za-z0-9_-]*(?:secret|token|api[_-]?key|password|passwd|bearer)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi, // assigned secret
  // Absolute homedir paths leak the OS username (/Users/<name>/, /home/<name>/,
  // C:\Users\<name>\). Replace the user segment, keep the tail shape.
  /(?:\/Users\/|\/home\/)[^/\s]+/g,                      // unix homedir
  /[A-Za-z]:\\Users\\[^\\\s]+/g,                         // windows homedir
];

/** PII-scrub: replace direct identifiers with a placeholder token. */
function scrub(text) {
  let s = String(text == null ? '' : text);
  for (const re of PII_PATTERNS) s = s.replace(re, ' ');
  return s;
}

/**
 * Looks like pasted machine output rather than natural-language writing.
 * Heuristic — conservative (better to skip a borderline snippet than capture a
 * log dump as "voice"). Triggers on: a fenced code block, a unified diff, a
 * stack-trace frame, a shell-prompt dump, or a body that is mostly non-prose
 * (high ratio of braces/semicolons/symbols to words).
 */
function looksMachine(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/```/.test(s)) return true;                         // fenced code block
  if (/^\s*(?:diff --git|@@ -\d|index [0-9a-f]{7})/m.test(s)) return true; // diff
  if (/^\s*(?:at\s+\S+\s+\(.*:\d+:\d+\)|Traceback \(most recent call last\))/m.test(s)) return true; // stack trace
  if (/^\s*[$#>]\s+\S+/m.test(s) && /\n/.test(s)) return true; // shell session dump
  // JSON / structured dump: starts like an object/array and is bracket-heavy.
  const trimmed = s.trim();
  if (/^[[{]/.test(trimmed) && /[}\]]\s*$/.test(trimmed)) {
    try { JSON.parse(trimmed); return true; } catch { /* not strict JSON */ }
  }
  // Symbol density: count "code-ish" chars vs alphabetic word chars. A natural
  // sentence is mostly letters/spaces; a code paste is dense with {};()=<>/.
  // A short single-line paste like `const x = {a:1, b:()=>{...}};` has few
  // multi-letter words but many symbols, so the floor is low (>=2 words) and the
  // trigger is symbols >= words (a natural sentence has far more words).
  const words = (s.match(/[A-Za-z]{2,}/g) || []).length;
  const symbols = (s.match(/[{}();=<>/\\|&]/g) || []).length;
  if (words >= 2 && symbols >= words) return true;
  // Many lines that each look like code (end in ; or { or }) and few sentences.
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length >= 3) {
    const codeish = lines.filter((l) => /[;{}]\s*$/.test(l.trim())).length;
    if (codeish / lines.length > 0.5) return true;
  }
  return false;
}

/** IJFW control / non-voice prompt prefixes we never capture as writing. */
function isControlPrompt(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/^[*/#]/.test(s)) return true;            // slash-command / skip / comment
  if (/\bijfw\s+off\b/i.test(s)) return true;   // disable phrase
  return false;
}

/** Collapse whitespace; used for length/heuristic measurement (not stored raw). */
function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * register(text, source) -> one of 'terse' | 'casual' | 'formal' | 'commit' | 'doc'.
 *
 * SIMPLE heuristic (no ML):
 *   - source === 'commit-msg'                       → 'commit'
 *   - markdown headers / list-y prose / multi-para  → 'doc'
 *   - short + lowercase + light punctuation          → 'terse'
 *   - long, multi-sentence, properly capitalized     → 'formal'
 *   - everything else                                → 'casual'
 */
export function classifyRegister(text, source) {
  if (source === 'commit-msg') return 'commit';
  const raw = String(text || '');
  const flat = collapse(raw);

  // doc: markdown structure or genuine multi-paragraph prose.
  const hasMarkdown = /(^|\n)\s{0,3}#{1,6}\s+\S/.test(raw) ||
    /(^|\n)\s*[-*+]\s+\S/.test(raw) ||
    /(^|\n)\s*\d+\.\s+\S/.test(raw) ||
    /\n\s*\n/.test(raw.trim());
  if (hasMarkdown && flat.length > 80) return 'doc';

  const len = flat.length;
  const sentences = (flat.match(/[.!?](?:\s|$)/g) || []).length;
  const isLowercaseStart = /^[a-z]/.test(flat);
  const punctRuns = (flat.match(/[.,;:!?]/g) || []).length;

  // terse: short AND informal — either a lowercase start ("fix the typo") or no
  // sentence-ending punctuation at all. A short but properly-capitalized,
  // properly-punctuated question/request reads as casual, not terse.
  const hasSentenceEnd = /[.!?]/.test(flat);
  if (len <= 60 && (isLowercaseStart || !hasSentenceEnd) && punctRuns <= 1) return 'terse';

  // formal: longish, multiple full sentences, capitalized opening. The length
  // floor (110) separates a single capitalized request ("casual") from genuine
  // multi-sentence prose with structure.
  if (len >= 110 && sentences >= 2 && /^[A-Z]/.test(flat)) return 'formal';

  return 'casual';
}

/**
 * buildExemplar({ text, source, ts }) -> Exemplar | null.
 *
 * Pure. Returns a fully-formed Exemplar record, or null when the input should
 * be skipped (empty, control prompt, machine output, or scrubs to nothing).
 * The text is PII-scrubbed and bounded to EXEMPLAR_TEXT_MAX before the id is
 * computed (so the id is stable over the FINAL stored text).
 */
export function buildExemplar({ text, source = 'prompt', ts } = {}) {
  const original = String(text == null ? '' : text);
  if (!original.trim()) return null;
  if (source !== 'commit-msg' && isControlPrompt(original)) return null;
  if (looksMachine(original)) return null;

  // Scrub, then bound. We keep original line structure (don't collapse) so the
  // stored snippet still reads like the user's writing, but cap the length.
  let finalText = scrub(original).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!finalText) return null;
  if (finalText.length > EXEMPLAR_TEXT_MAX) {
    finalText = finalText.slice(0, EXEMPLAR_TEXT_MAX).trim();
  }
  // After scrub+bound the snippet must still carry SOME natural-language signal
  // (at least a couple of word characters). A snippet that scrubbed down to
  // punctuation/placeholders is not worth keeping as voice.
  if ((finalText.match(/[A-Za-z]{2,}/g) || []).length < 2) return null;

  const src = source === 'commit-msg' ? 'commit-msg' : 'prompt';
  return {
    id: exemplarId(finalText),
    text: finalText,
    register: classifyRegister(finalText, src),
    source: src,
    ts: ts ? new Date(ts).toISOString() : new Date().toISOString(),
  };
}

/**
 * captureMessage({ text, ts, opts }) -> { ok, skipped?, id? } | { ok:false }.
 *
 * Best-effort capture of the user's OWN prompt text as a 'prompt'-source
 * exemplar. Fully isolated: never throws. A skipped input (empty/control/
 * machine) returns { ok:true, skipped:true }. Mirrors the call shape the
 * pre-prompt hook already uses for capture.js's captureMessage.
 */
export function captureMessage({ text, ts, opts } = {}) {
  try {
    const ex = buildExemplar({ text, source: 'prompt', ts });
    if (!ex) return { ok: true, skipped: true };
    const r = appendExemplar(ex, opts || {});
    if (!r.ok) return { ok: false, code: r.code, message: r.message };
    return { ok: true, id: ex.id, removed: r.removed };
  } catch (err) {
    // Never surface into the hook caller.
    return { ok: false, code: 'ECAPTURE', message: err && err.message };
  }
}

/**
 * captureCommitMessage(msg, opts?) -> { ok, skipped?, id? } | { ok:false }.
 *
 * Best-effort capture of a git commit message (subject + body) as a 'commit-msg'
 * exemplar. `msg` may be the raw `git log -1 --format=%B` style string. We strip
 * trailers (Co-Authored-By, Signed-off-by, the IJFW 🤖 line) and comment lines
 * so the captured voice is the user's actual prose, not boilerplate. Wiring this
 * into a real git hook is OUT OF SCOPE for V1 — this function is the seam.
 * Fully isolated: never throws.
 */
export function captureCommitMessage(msg, opts = {}) {
  try {
    const raw = String(msg == null ? '' : msg);
    if (!raw.trim()) return { ok: true, skipped: true };
    // Drop comment lines (git's `#`-prefixed scissor lines) and known trailers.
    const cleaned = raw
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (t.startsWith('#')) return false;
        if (/^(?:Co-Authored-By|Signed-off-by|Co-authored-by):/i.test(t)) return false;
        if (/Generated with \[Claude Code\]/i.test(t)) return false;
        if (/^🤖/.test(t)) return false;
        return true;
      })
      .join('\n');
    const ex = buildExemplar({ text: cleaned, source: 'commit-msg', ts: opts.ts });
    if (!ex) return { ok: true, skipped: true };
    const r = appendExemplar(ex, opts || {});
    if (!r.ok) return { ok: false, code: r.code, message: r.message };
    return { ok: true, id: ex.id, removed: r.removed };
  } catch (err) {
    return { ok: false, code: 'ECAPTURE', message: err && err.message };
  }
}
