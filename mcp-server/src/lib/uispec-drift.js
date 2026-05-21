// uispec-drift.js -- v1.5.0 audit-MED-design-#8 + #10.
//
// Two design-contract enforcement helpers, sharing one file because they
// read the same UI-SPEC.md.
//
//   #8  Bundle-size budget: parse `bundle_kb_budget: <N>` from UI-SPEC.md,
//       compare to a measured KB total from the shipped build output.
//
//   #10 Palette / Tailwind drift detector: parse `## 3. Color & Contrast`
//       tokens from UI-SPEC.md, scan shipped code for `class="..."` Tailwind
//       color classes, flag any color tokens NOT declared in the spec.
//
// Pure-stdlib.  Graceful-degrade on every error path.  No external network.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// ---------------------------------------------------------------------------
// UI-SPEC parser
// ---------------------------------------------------------------------------

/**
 * Parse a UI-SPEC.md text body into a structured contract.
 *
 * Looks for:
 *   - `bundle_kb_budget: <N>`           -- inline YAML-ish field, any line.
 *   - `a11y_target: <ID>`               -- e.g. `WCAG-2.2-AA`
 *   - `max_violations: <N>`             -- a11y violation budget
 *   - Color tokens of form `#rrggbb` or `rgb()` under the "Color & Contrast"
 *     section (between `## 3.` and the next `## ` header).
 *
 * @param {string} text
 * @returns {{bundleKbBudget: number|null, a11yTarget: string|null, maxViolations: number|null, paletteHex: string[], paletteTokens: string[]}}
 */
export function parseUISpec(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { bundleKbBudget: null, a11yTarget: null, maxViolations: null, paletteHex: [], paletteTokens: [] };
  }

  const fieldMatch = (pat) => {
    const m = text.match(pat);
    return m ? m[1].trim() : null;
  };

  const bundleStr = fieldMatch(/^[*\s>-]*bundle_kb_budget\s*:\s*([0-9]+)\s*$/im);
  const a11yTarget = fieldMatch(/^[*\s>-]*a11y_target\s*:\s*([A-Za-z0-9.-]+)\s*$/im);
  const violationsStr = fieldMatch(/^[*\s>-]*max_violations\s*:\s*([0-9]+)\s*$/im);

  // Color section: scan from "## 3" through next "## " or EOF.
  const colorSection = (() => {
    const i = text.search(/^##\s*3\b/m);
    if (i < 0) return '';
    const rest = text.slice(i + 1);
    const j = rest.search(/^##\s+/m);
    return j < 0 ? rest : rest.slice(0, j);
  })();

  const hex = Array.from(colorSection.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g))
    .map((m) => `#${m[1].toLowerCase()}`)
    // Normalise 3-digit -> 6-digit so comparison is stable.
    .map((c) => (c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c));

  // Tailwind-style token names declared in the section (e.g. `bg-slate-900`, `text-emerald-500`).
  const tokens = Array.from(
    colorSection.matchAll(/\b((?:bg|text|border|ring|from|to|via|fill|stroke)-[a-z]+-\d{2,3})\b/g),
  ).map((m) => m[1]);

  return {
    bundleKbBudget: bundleStr ? Number(bundleStr) : null,
    a11yTarget,
    maxViolations: violationsStr ? Number(violationsStr) : null,
    paletteHex: Array.from(new Set(hex)),
    paletteTokens: Array.from(new Set(tokens)),
  };
}

// ---------------------------------------------------------------------------
// #8 Bundle-size budget check
// ---------------------------------------------------------------------------

const DEFAULT_BUNDLE_EXTS = new Set(['.js', '.mjs', '.cjs', '.css']);
const DEFAULT_BUILD_DIRS = ['.next', 'dist', 'build', 'out', 'public/build'];

/**
 * Walk a build directory and sum sizes of JS/CSS assets.
 * Graceful: missing dir -> {totalKb: null, files: [], dir: null}.
 *
 * @param {object} opts
 * @param {string} [opts.dir]               Specific build dir; auto-detect when absent.
 * @param {string} [opts.projectRoot]       Defaults to cwd.
 * @param {Set<string>} [opts.exts]         File extensions to include.
 */
export function measureBundleSize(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const exts = opts.exts || DEFAULT_BUNDLE_EXTS;

  let dir = opts.dir;
  if (!dir) {
    for (const candidate of DEFAULT_BUILD_DIRS) {
      const abs = join(projectRoot, candidate);
      if (existsSync(abs)) {
        dir = abs;
        break;
      }
    }
  } else if (!opts.dir.startsWith('/')) {
    dir = join(projectRoot, opts.dir);
  }

  if (!dir || !existsSync(dir)) {
    return { totalKb: null, files: [], dir: dir || null, reason: 'build-dir-missing' };
  }

  const files = [];
  let totalBytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() && exts.has(extname(ent.name))) {
        try {
          const sz = statSync(abs).size;
          totalBytes += sz;
          files.push({ path: abs, bytes: sz });
        } catch {
          /* unreadable -- skip */
        }
      }
    }
  }

  return {
    totalKb: Math.round((totalBytes / 1024) * 10) / 10,
    files,
    dir,
    reason: null,
  };
}

/**
 * Compose a budget verdict from a parsed spec + a bundle measurement.
 *
 * @param {{bundleKbBudget:number|null}} spec
 * @param {{totalKb:number|null, dir:string|null}} measurement
 * @returns {{pass: boolean|null, actualKb: number|null, budgetKb: number|null, reason: string}}
 */
export function evaluateBundleBudget(spec, measurement) {
  if (!spec || spec.bundleKbBudget == null) {
    return { pass: null, actualKb: measurement?.totalKb ?? null, budgetKb: null, reason: 'no-budget-declared' };
  }
  if (!measurement || measurement.totalKb == null) {
    return { pass: null, actualKb: null, budgetKb: spec.bundleKbBudget, reason: measurement?.reason || 'no-measurement' };
  }
  const pass = measurement.totalKb <= spec.bundleKbBudget;
  return {
    pass,
    actualKb: measurement.totalKb,
    budgetKb: spec.bundleKbBudget,
    reason: pass
      ? 'within-budget'
      : `bundle ${measurement.totalKb} KB > budget ${spec.bundleKbBudget} KB`,
  };
}

// ---------------------------------------------------------------------------
// #10 Palette drift detector
// ---------------------------------------------------------------------------

const CODE_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.html', '.vue', '.svelte', '.css', '.scss', '.mdx']);

/**
 * Walk a source scope and return Tailwind color tokens + raw hex values
 * found in `class="..."` / `className="..."` / inline `style="color:..."`.
 *
 * @param {string|string[]} scope  Single dir or list of dirs (absolute or relative to projectRoot).
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @returns {{tokens: string[], hex: string[], files: number}}
 */
export function scanCodeForTailwind(scope, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const dirs = Array.isArray(scope) ? scope : [scope];
  const tokens = new Set();
  const hex = new Set();
  let files = 0;

  for (const d of dirs) {
    const abs = d.startsWith('/') ? d : join(projectRoot, d);
    if (!existsSync(abs)) continue;

    const stack = [abs];
    while (stack.length > 0) {
      const cur = stack.pop();
      let entries;
      try {
        entries = readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const nxt = join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(nxt);
        } else if (ent.isFile() && CODE_EXTS.has(extname(ent.name))) {
          let body;
          try {
            body = readFileSync(nxt, 'utf8');
          } catch {
            continue;
          }
          files += 1;
          // Tailwind color tokens, e.g. bg-slate-900, text-rose-500/50.
          // eslint-disable-next-line security/detect-unsafe-regex -- scans developer-authored Tailwind class strings in local source files; bounded {2,3} digit count
          for (const m of body.matchAll(/\b((?:bg|text|border|ring|from|to|via|fill|stroke)-[a-z]+-\d{2,3})(?:\/\d+)?\b/g)) {
            tokens.add(m[1]);
          }
          // Raw hex.
          for (const m of body.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
            const c = m[1].length === 3
              ? `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`
              : `#${m[1].toLowerCase()}`;
            hex.add(c);
          }
        }
      }
    }
  }

  return {
    tokens: Array.from(tokens).sort(),
    hex: Array.from(hex).sort(),
    files,
  };
}

/**
 * Compute drift = tokens/hex used in code but NOT declared in UI-SPEC.
 *
 * @param {ReturnType<typeof parseUISpec>} spec
 * @param {ReturnType<typeof scanCodeForTailwind>} scan
 * @returns {Array<{type:'token'|'hex',value:string,severity:'flag'|'block',declared:string[]}>}
 */
export function diffPaletteDrift(spec, scan) {
  const declaredTokens = new Set(spec.paletteTokens || []);
  const declaredHex = new Set(spec.paletteHex || []);

  const findings = [];

  // Color-bearing utilities are the ones we lock to the palette.
  // Spacing/layout utilities (bg-* with color names like 'transparent'/'current'/
  // 'inherit') do not appear with -\d+ suffix so are not in scope.
  for (const tok of scan.tokens) {
    if (!declaredTokens.has(tok)) {
      findings.push({
        type: 'token',
        value: tok,
        severity: declaredTokens.size === 0 ? 'flag' : 'block',
        declared: Array.from(declaredTokens),
      });
    }
  }
  for (const c of scan.hex) {
    if (!declaredHex.has(c)) {
      findings.push({
        type: 'hex',
        value: c,
        severity: declaredHex.size === 0 ? 'flag' : 'block',
        declared: Array.from(declaredHex),
      });
    }
  }

  return findings;
}

/**
 * Read a UI-SPEC.md file from disk. Returns {ok, spec, error}.
 */
export function loadUISpec(uiSpecPath) {
  if (!uiSpecPath || !existsSync(uiSpecPath)) {
    return { ok: false, spec: null, error: 'ui-spec-missing' };
  }
  let body;
  try {
    body = readFileSync(uiSpecPath, 'utf8');
  } catch (e) {
    return { ok: false, spec: null, error: `read-failed: ${e.code || e.message}` };
  }
  return { ok: true, spec: parseUISpec(body), error: null };
}
