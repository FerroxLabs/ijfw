// IJFW v1.3.0 Alpha -- compute module barrel export.
//
// Surfaces the FTS5 layer + migration runner for callers in mcp-server.
// Intentionally thin: callers should import named symbols from here, not
// reach into ./fts5.js or ./migration-runner.js directly.

export {
  openDb,
  safeWrite,
  search,
  closeDb,
  dbPathFor,
  IntegrityError,
  SchemaVersionError,
  ComputeDbError,
} from './fts5.js';

export { runMigrations, highestKnownVersion } from './migration-runner.js';
