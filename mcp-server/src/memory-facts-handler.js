// mcp-server/src/memory-facts-handler.js
// IJFW v1.5.0 -- ijfw_memory_facts MCP verb handler.
// Surfaces the existing bi-temporal facts table through MCP.

import {
  openTemporalDbSync, getValidAt, getHistory, getAllFactsWithWindows,
} from './memory/temporal.js';
import { join } from 'node:path';
import { vetProjectRoot } from './lib/project-root-guard.js';

function resolveDbPath() {
  // wayland#755 round 2: this handler runs inside the MCP server process,
  // so a bundle-internal spawn cwd must never become the .ijfw db root.
  // (Note this surface historically reads IJFW_PROJECT_ROOT, not _DIR.)
  const root = vetProjectRoot(process.env.IJFW_PROJECT_ROOT);
  return join(root, '.ijfw', 'memory.db');
}

export async function handleMemoryFacts(
  { subject, predicate, valid_at, history } = {},
  opts = {},
) {
  if (!subject || !predicate) return { error: 'subject and predicate are required' };
  const db = opts.dbOverride || openTemporalDbSync(resolveDbPath());
  let rows;
  if (history) {
    rows = getHistory(db, subject, predicate);
  } else if (valid_at) {
    const ts = new Date(valid_at).toISOString();
    const all = getValidAt(db, ts);
    rows = all.filter((r) => r.subject === subject && r.predicate === predicate);
  } else {
    const all = getAllFactsWithWindows(db);
    rows = all.filter(
      (r) => r.subject === subject && r.predicate === predicate && r.valid_to == null,
    );
  }
  return { rows, mode: history ? 'history' : valid_at ? 'valid_at' : 'current' };
}

export default { handleMemoryFacts };
