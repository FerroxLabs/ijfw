// --- Content sanitizer (defense against prompt-injection via stored memory) ---
//
// Stored content is read back and injected into LLM context on every recall.
// An attacker who can write to .ijfw/memory/ (rogue dep, malicious teammate
// commit, compromised plugin) controls future sessions unless we neutralize
// the structural and semantic markdown features they could weaponize.
//
// Extracted from server.js in Phase 6 (audit finding X2) so ijfw-memorize
// and any other memory writer can apply the same defang before append.

export function sanitizeContent(s) {
  if (typeof s !== 'string') return '';
  let out = s;

  // 1. Strip C0/C1 control characters (incl. NUL) except tab and newline.
  // oxlint-disable-next-line no-control-regex -- intentional: sanitize control chars from stored content
  out = out.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');

  // 2. Strip Unicode bidi/zero-width/format chars used to hide payloads.
  // U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');

  // 2b. Strip Unicode tag-block chars (U+E0000-U+E007F) \u2014 the "ASCII Smuggler"
  // prompt-injection vector. These codepoints are invisible to humans but map
  // 1:1 to printable ASCII (U+E0041 = "A", U+E0061 = "a", etc.) and many LLMs
  // interpret them as the corresponding text. An attacker can hide an
  // instruction like "ignore all prior" inside otherwise-benign memory content.
  // v1.5.1 H1.4 (audit memory-engine.md F-SEC-3).
  // Ref: https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/
  out = out.replace(/[\u{E0000}-\u{E007F}]/gu, '');

  // 3. Defang ANY heading prefix (1+ hashes, optional whitespace) -- entry must
  // never produce a structural ## section that mimics a journal timestamp.
  out = out.replace(/^[ \t]*#+[ \t]+/gm, '> ');

  // 4. Defang setext-style headings (=== or --- under a line) -- strip the underline.
  out = out.replace(/^[ \t]*[=-]{3,}[ \t]*$/gm, '');

  // 5. Neutralize fenced code blocks (``` and ~~~) so attacker can't open a fence
  // that swallows surrounding journal structure as "code".
  out = out.replace(/^[ \t]*(```|~~~).*$/gm, '> $1');

  // 6. Neutralize HTML/XML-style tags that LLMs may parse as instructions
  // (<system>, </assistant>, <instructions>, etc.) -- escape angle brackets.
  out = out.replace(/[<>]/g, ch => (ch === '<' ? '&lt;' : '&gt;'));

  // 7. Collapse to single line -- multi-line stored content can't fake new
  // journal sections. Newlines become " | " for readability.
  out = out.replace(/\r\n?|\n/g, ' | ');

  return out;
}

export function sanitizeForSandbox(s) {
  if (typeof s !== 'string') return '';
  let out = s;

  // 1. Strip ANSI escape codes (colors, cursor movement).
  // oxlint-disable-next-line no-control-regex -- intentional: strip ANSI from sandbox output
  out = out.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');

  // 2. Strip lines starting with # (headings) -- defang prompt-injection via markdown headings.
  out = out.replace(/^[ \t]*#+[ \t].*/gm, '');

  // 3. Neutralize fenced code blocks (``` and ~~~).
  out = out.replace(/^[ \t]*(```|~~~).*$/gm, '');

  // 4. Strip <system>, <prompt>, <assistant> tag patterns (open and close).
  out = out.replace(/<\/?(system|prompt|assistant)[^>]*>/gi, '');

  // 5. Truncate any single line exceeding 2000 chars (minified JS, base64 blobs).
  out = out
    .split('\n')
    .map(line => (line.length > 2000 ? line.slice(0, 200) + '...[truncated]' : line))
    .join('\n');

  return out;
}
