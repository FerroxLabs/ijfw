// IJFW v1.5.2 -- brain wiki section sentinels (Trident F-F2).
//
// Wiki pages carry LLM-managed regions delimited by HTML comments:
//   <!-- ijfw:auto:begin section="current-state" -->
//   ...AUTO content (replaced by the compiler)...
//   <!-- ijfw:auto:end section="current-state" -->
//
// Everything OUTSIDE these blocks is operator-owned ("NOTES") and the
// compiler MUST preserve it verbatim. extractSections() returns the AUTO
// regions; replaceSection() swaps a named region's body while preserving
// the NOTES content and all other AUTO regions unchanged.

const SECTION_RE = /<!--\s*ijfw:auto:begin\s+section="([^"]+)"\s*-->([\s\S]*?)<!--\s*ijfw:auto:end\s+section="\1"\s*-->/g;

export function extractSections(md) {
  if (typeof md !== 'string') return [];
  const out = [];
  for (const m of md.matchAll(SECTION_RE)) {
    out.push({ name: m[1], body: m[2] });
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function makeBlock(name, body) {
  return `<!-- ijfw:auto:begin section="${name}" -->\n${body}\n<!-- ijfw:auto:end section="${name}" -->`;
}

export function replaceSection(md, name, newBody) {
  if (typeof md !== 'string') md = '';
  const escaped = escapeRe(name);
  const targetRe = new RegExp(
    `<!--\\s*ijfw:auto:begin\\s+section="${escaped}"\\s*-->[\\s\\S]*?<!--\\s*ijfw:auto:end\\s+section="${escaped}"\\s*-->`
  );
  const replacement = makeBlock(name, newBody);
  if (targetRe.test(md)) {
    return md.replace(targetRe, replacement);
  }
  // Section absent -- append it. If md ends without trailing newline, add one.
  const sep = md.length === 0 || md.endsWith('\n') ? '' : '\n';
  return md + sep + '\n' + replacement + '\n';
}
