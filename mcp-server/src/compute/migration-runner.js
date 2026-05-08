// IJFW v1.3.0 Alpha -- migration runner for the compute db.
//
// Discovers migrations in ./migrations/ matching NNN-name.js, sorts by
// numeric prefix, and applies each migration whose VERSION exceeds the
// db's current PRAGMA user_version. Each migration runs inside a single
// transaction; failure rolls back and halts.
//
// Forbids downgrade: if currentVersion > targetVersion (= highest migration
// VERSION found on disk), throws SchemaVersionError so callers refuse the db
// rather than silently rebuilding it.

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export class SchemaVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

// Discover and load every migration module under ./migrations/, sorted by
// numeric prefix ascending. Each module must export VERSION (integer),
// DESCRIPTION (string), and up(db) (function).
async function loadMigrations() {
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }
  const matches = files
    .filter(f => /^\d+-.+\.js$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const out = [];
  for (const f of matches) {
    const url = pathToFileURL(join(MIGRATIONS_DIR, f)).href;
    const mod = await import(url);
    if (typeof mod.VERSION !== 'number' || typeof mod.up !== 'function') {
      throw new Error(`Migration ${f} is missing VERSION or up().`);
    }
    out.push({
      file: f,
      version: mod.VERSION,
      description: mod.DESCRIPTION || '',
      up: mod.up,
    });
  }
  // Sort by VERSION ascending and reject duplicates -- defensive against
  // mistakes in numeric prefix vs in-file VERSION.
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(`Duplicate migration VERSION: ${out[i].version} (${out[i - 1].file} and ${out[i].file}).`);
    }
  }
  return out;
}

export async function highestKnownVersion() {
  const migrations = await loadMigrations();
  return migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
}

// Apply every migration whose version is in (currentVersion, targetVersion].
// Returns the new version. Throws SchemaVersionError on downgrade.
export async function runMigrations(db, currentVersion, targetVersion) {
  if (typeof currentVersion !== 'number' || typeof targetVersion !== 'number') {
    throw new Error('runMigrations: currentVersion and targetVersion must be numbers.');
  }
  if (currentVersion > targetVersion) {
    throw new SchemaVersionError(
      `Compute db schema version ${currentVersion} is newer than this build supports (max ${targetVersion}). ` +
      `Refusing to downgrade -- upgrade IJFW or open the db with a newer build.`
    );
  }
  if (currentVersion === targetVersion) return currentVersion;

  const migrations = await loadMigrations();
  const pending = migrations.filter(m => m.version > currentVersion && m.version <= targetVersion);
  if (pending.length === 0) return currentVersion;

  let lastApplied = currentVersion;
  for (const m of pending) {
    // Each migration runs in its own transaction. We update user_version +
    // schema_meta in the same tx so a crash mid-migration leaves the db
    // recognisably at the prior version (no half-applied schema).
    //
    // BEGIN IMMEDIATE acquires the write lock at transaction start (paired
    // with PRAGMA busy_timeout=5000 in openDb). Plain BEGIN (deferred) lets
    // two concurrent writers both enter their migration tx, then one gets
    // SQLITE_BUSY when it tries to upgrade -- migration 002's FTS5
    // recreate-with-data path surfaced that race during Phase 5 audit.
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO schema_meta(version, applied_at, description) VALUES (?, ?, ?)'
      );
      stmt.run(m.version, Date.now(), m.description);
      db.exec('COMMIT');
      lastApplied = m.version;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`Migration ${m.file} (v${m.version}) failed: ${err.message}`);
    }
  }
  return lastApplied;
}

export default { runMigrations, highestKnownVersion, SchemaVersionError };
