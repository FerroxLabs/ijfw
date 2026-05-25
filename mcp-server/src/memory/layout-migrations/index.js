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

export const LAYOUT_MIGRATIONS = Object.freeze([visibleLayer]);

export async function runLayoutMigrations(repoRoot) {
  const results = [];
  for (const m of LAYOUT_MIGRATIONS) {
    results.push(await m.up(repoRoot));
  }
  return results;
}
