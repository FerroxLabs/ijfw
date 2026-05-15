#!/usr/bin/env node
// hoist-frontmatter.js -- splice A3 detection into AGENTS.md YAML frontmatter.
// Pure node, ESM (matches "type": "module" in repo root + mcp-server). Read
// by hoist-frontmatter.sh; not a public surface.
//
// Args: <agents-md-path> <project-type-json> <tmp-out-path>
//
// Idempotent: writes <tmp-out-path> only when the result differs from the
// existing AGENTS.md bytes. The shell wrapper checks for the file and either
// renames into place or skips.

import fs from "node:fs";

const target = process.argv[2];
const typeFile = process.argv[3];
const out = process.argv[4];

if (!target || !typeFile || !out) {
  process.exit(0);
}

let typeData;
try {
  typeData = JSON.parse(fs.readFileSync(typeFile, "utf8"));
} catch {
  // Malformed project.type -- silent skip, do not corrupt frontmatter.
  process.exit(0);
}
if (!typeData || typeof typeData !== "object") process.exit(0);

const src = fs.readFileSync(target, "utf8");

// Detect frontmatter: file starts with "---\n", second "---" closes it.
const FM_OPEN = "---\n";
const FM_CLOSE_RE = /\n---\s*(?:\r?\n|$)/;
let fm = "";
let body = src;
if (src.startsWith(FM_OPEN)) {
  const after = src.slice(FM_OPEN.length);
  const closeMatch = after.match(FM_CLOSE_RE);
  if (closeMatch) {
    fm = after.slice(0, closeMatch.index);
    body = after.slice(closeMatch.index + closeMatch[0].length);
  }
} else {
  // No frontmatter at all -- inject a fresh one with A3 fields plus the
  // alpha defaults expected by the schema.
  fm = "ijfw_version: 1.3.2\nijfw_schema: 1\n";
}

// Parse the simple YAML lines we manage. We only touch keys we own; user
// fields and the unknown surface are passed through verbatim.
const MANAGED = new Set([
  "type", "primary_type", "secondary_types",
  "confidence", "detected_at", "signals",
]);
const lines = fm.split(/\r?\n/);
const kept = [];
let i = 0;
while (i < lines.length) {
  const ln = lines[i];
  if (ln === "") { i++; continue; }
  const km = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
  if (!km || !MANAGED.has(km[1])) {
    kept.push(ln);
    i++;
    continue;
  }
  // Skip this key + any continuation lines (YAML block list / value).
  i++;
  while (i < lines.length && /^[ \t]/.test(lines[i])) i++;
}

// Build managed-key block from typeData.
const managedOut = [];
if (typeof typeData.type === "string") {
  managedOut.push("type: " + typeData.type);
}
if (typeof typeData.primary_type === "string") {
  managedOut.push("primary_type: " + typeData.primary_type);
}
if (Array.isArray(typeData.secondary_types) && typeData.secondary_types.length) {
  managedOut.push("secondary_types:");
  for (const v of typeData.secondary_types) {
    if (typeof v === "string") managedOut.push("  - " + v);
  }
} else if (Array.isArray(typeData.secondary_types)) {
  managedOut.push("secondary_types: []");
}
if (typeof typeData.confidence === "number") {
  managedOut.push("confidence: " + typeData.confidence);
}
if (typeof typeData.detected_at === "string") {
  managedOut.push("detected_at: " + typeData.detected_at);
}
if (Array.isArray(typeData.signals) && typeData.signals.length) {
  managedOut.push("signals:");
  for (const v of typeData.signals) {
    if (typeof v === "string") {
      managedOut.push("  - " + v);
    } else if (v && typeof v === "object") {
      // P3-H1: detector emits signals as { kind, weight, value, ... }.
      // Emit each as a YAML block-sequence map: first scalar key inline
      // with the dash, remaining scalar keys indented two spaces under it.
      // Skip nested objects/arrays -- they are not part of the schema.
      const entries = [];
      for (const [k, val] of Object.entries(v)) {
        if (val === null || val === undefined) continue;
        const t = typeof val;
        if (t === "string" || t === "number" || t === "boolean") {
          entries.push([k, t === "string" ? yamlEscape(val) : String(val)]);
        } else if (Array.isArray(val) && val.every((x) => typeof x === "string" || typeof x === "number")) {
          // Inline simple scalar arrays (e.g. manifests: [package.json, Cargo.toml]).
          const flat = val.map((x) => typeof x === "string" ? yamlEscape(x) : String(x)).join(", ");
          entries.push([k, "[" + flat + "]"]);
        }
      }
      if (entries.length === 0) continue;
      managedOut.push("  - " + entries[0][0] + ": " + entries[0][1]);
      for (let j = 1; j < entries.length; j++) {
        managedOut.push("    " + entries[j][0] + ": " + entries[j][1]);
      }
    }
  }
} else if (Array.isArray(typeData.signals)) {
  managedOut.push("signals: []");
}

function yamlEscape(s) {
  // Quote when the value collides with YAML scalar parsing (leading colon,
  // newline, or matches a YAML keyword). Simple heuristic; avoids a full
  // YAML parser dependency and keeps the output ASCII.
  if (typeof s !== "string") return String(s);
  if (s === "" || /[:#\n\r]|^\s|\s$|^(?:true|false|null|yes|no|on|off)$/i.test(s)) {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  return s;
}

// Drop trailing blanks from kept block.
while (kept.length && kept[kept.length - 1] === "") kept.pop();

let newFm = "";
if (kept.length) newFm += kept.join("\n") + "\n";
if (managedOut.length) newFm += managedOut.join("\n") + "\n";

const next = "---\n" + newFm + "---\n" + body;

// Idempotent guard: skip rewrite when bytes are identical.
if (next === src) process.exit(0);

fs.writeFileSync(out, next);
