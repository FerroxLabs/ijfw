// mcp-server/src/memory/layout-migrations/index.js
//
// Filesystem-layout migrations. These are NOT SQL migrations — they reshape
// on-disk directory layout (e.g., copying internal .ijfw/memory/ to visible
// ijfw/memory/) and track their version via sentinel files, not SQLite
// user_version. They live in a sibling directory to migrations/ so the SQL
// migration runner cannot accidentally load them (root cause of F1 in v1.5.2.1).
//
// To add a new fs-layout migration:
//   1. Create NNN-foo.js in this directory exporting DESCRIPTION + up(repoRoot).
//   2. Import it below and add it to LAYOUT_MIGRATIONS in version order.
//   3. The server entry-point invokes runLayoutMigrations(repoRoot) at startup.

import * as visibleLayer from './001-visible-layer.js';

// L-1 (Lens 1): defense-in-depth deep freeze. ESM namespace objects ARE
// already frozen by spec (Node throws TypeError if you Object.freeze them),
// so we rewrap each namespace import in a plain object literal exposing the
// minimal contract, then freeze that. Future refactors that swap a
// namespace import for a class instance or factory keep the immutability
// invariant rather than silently going mutable.
function wrap(ns) {
  return Object.freeze({
    DESCRIPTION: ns.DESCRIPTION,
    up: ns.up,
  });
}
export const LAYOUT_MIGRATIONS = Object.freeze([wrap(visibleLayer)]);

// L-2 (Lens 1): per-migration try/catch so one failing migration cannot
// abort subsequent independent ones. Caller decides whether to bail on
// failures (server.js __mainEntryPoint logs each failure to stderr).
// Returns an array of { description, ok, result?, error? } in invocation
// order — preserved even on partial failure for debugging.
export async function runLayoutMigrations(repoRoot) {
  const results = [];
  for (const m of LAYOUT_MIGRATIONS) {
    try {
      const result = await m.up(repoRoot);
      results.push({ description: m.DESCRIPTION, ok: true, result });
    } catch (err) {
      results.push({
        description: m.DESCRIPTION,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
  return results;
}
