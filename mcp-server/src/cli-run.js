#!/usr/bin/env node
/**
 * cli-run.js
 *
 * IJFW v1.4.0 / W6/S5 -- terminal shim for the colon-syntax dispatch surface.
 *
 * Why this exists:
 *   The session-start hook needs a way to fire `domain-manifest:load` (and
 *   `extension:deploy-lazy` from W6/S12) from bash without depending on the
 *   long-lived MCP server. A 30-line shim that imports dispatchRun directly
 *   keeps the dependency chain trivial: bash -> node -> dispatch/*.js.
 *
 * Usage:
 *   node cli-run.js <namespace>:<command> [--project-root <dir>] [args...]
 *
 * Examples:
 *   node cli-run.js domain-manifest:load --project-root /path/to/proj
 *   node cli-run.js extension:deploy-lazy --project-root /path/to/proj
 *
 * Contract:
 *   - Always exits 0 on a successful dispatch (even when the dispatched
 *     command reports ok:false -- that's a *result*, not a shim failure).
 *   - Exits 2 on argv-shape errors (missing colon expression).
 *   - Exits 3 on a thrown error inside the dispatcher.
 *   - Prints the JSON-stringified result to stdout. stderr stays empty on
 *     the happy path so the session-start log isn't polluted.
 *
 * Discipline:
 *   - Built-in Node only. No new deps.
 *   - ESM. ASCII strings only.
 *   - Detached fire-and-forget safe: the caller pipes stdin/stdout/stderr
 *     to /dev/null and the shim never needs an interactive TTY.
 */

import { parseColonCommand, dispatchRun } from './dispatch/colon-syntax.js';

function parseFlags(argv) {
  // argv layout: [colonExpr, ...rest] -- rest may interleave flags and
  // positional args. We only consume --project-root <value> here; anything
  // else is passed through as part of the colon-expr args via space-join.
  const out = { projectRoot: null, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--project-root') {
      out.projectRoot = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (typeof tok === 'string' && tok.startsWith('--project-root=')) {
      out.projectRoot = tok.slice('--project-root='.length);
      continue;
    }
    out.rest.push(tok);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write('cli-run: usage: node cli-run.js <namespace>:<command> [--project-root <dir>] [args...]\n');
    process.exit(2);
  }
  const colonExpr = argv[0];
  const tail = argv.slice(1);
  const { projectRoot, rest } = parseFlags(tail);

  // Glue any positional args back onto the colon expression so the
  // dispatcher's existing arg-parsing handles them. e.g.
  //   cli-run domain-manifest:load extra args  ->  parseColonCommand sees
  //   "domain-manifest:load extra args"
  const expr = rest.length ? `${colonExpr} ${rest.join(' ')}` : colonExpr;
  const parsed = parseColonCommand(expr);
  if (!parsed) {
    process.stderr.write(`cli-run: could not parse "${colonExpr}" as <namespace>:<command>\n`);
    process.exit(2);
  }

  try {
    const result = await dispatchRun(parsed, {
      projectRoot: projectRoot || process.env.IJFW_PROJECT_DIR || process.cwd(),
    });
    process.stdout.write(JSON.stringify(result == null ? { ok: false, error: 'dispatch returned null (unknown namespace)' } : result) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`cli-run: dispatch threw: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(3);
  }
}

main();
