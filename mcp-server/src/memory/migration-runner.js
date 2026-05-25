// IJFW v1.3.0 -- migration runner for the memory db.
//
// Mirrors src/compute/migration-runner.js shape so future structural
// alignment between the two tiers stays trivial. The memory db has its
// OWN user_version sequence -- it does not share state with the compute
// db at <projectRoot>/.ijfw/index/compute.db.
//
// Discovers migrations in ./migrations/ matching NNN-name.js, sorts by
// numeric prefix, and applies each migration whose VERSION exceeds the
// db's current PRAGMA user_version. Each migration runs inside a single
// BEGIN IMMEDIATE transaction (per the Phase 5 fix that landed in the
// compute migration runner -- racing writers must serialise via the
// RESERVED lock at txn start instead of upgrading mid-txn).

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
// numeric prefix ascending. Each module MUST export VERSION (number),
// DESCRIPTION (string), and up(db) (function). The filename's numeric prefix
// MUST equal the exported VERSION (enforced below).
//
// SQL=false is REJECTED — fs-layout migrations live in ../layout-migrations/
// (see v1.5.2.1 F3). The runner used to silently skip SQL=false; that escape
// hatch was a runtime workaround for a directory-structure mistake and is
// gone. If a file in this directory declares SQL=false, the runner fails
// loudly so the structural error is caught at startup, not at the next
// schema-bricking copy-paste.
//
// Exported (v1.5.1 W3.B) so search.js (and any other consumer that needs
// the sync migration pipeline) can reuse the SAME discovery path instead
// of maintaining a parallel hardcoded list. Single source of truth: drop
// a new NNN-name.js into ./migrations/ and every consumer sees it.
export async function loadMigrations() {
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
    // v1.5.2.1 F3: SQL=false is no longer an in-directory escape hatch. The
    // fs-layout migrations live in ../layout-migrations/ and are statically
    // registered there. If anything in this directory still declares
    // SQL=false it's a structural error (likely a misplaced fs-layout
    // migration). Fail loudly rather than silently skip.
    if (mod.SQL === false) {
      throw new Error(
        `Memory migration ${f} declares SQL=false — fs-layout migrations belong in ` +
        `layout-migrations/, not migrations/. Move the file or remove SQL=false.`
      );
    }
    if (typeof mod.VERSION !== 'number' || typeof mod.up !== 'function') {
      throw new Error(`Memory migration ${f} is missing VERSION or up().`);
    }
    // v1.5.2.1 F3.2: filename numeric prefix MUST equal exported VERSION.
    // Catches reordering / rename mistakes immediately rather than at the
    // next user_version comparison (where the failure mode is silent).
    const filenamePrefix = parseInt(f.match(/^(\d+)/)[1], 10);
    if (filenamePrefix !== mod.VERSION) {
      throw new Error(
        `Memory migration ${f}: filename prefix ${filenamePrefix} does not match ` +
        `exported VERSION ${mod.VERSION}. Rename the file or fix the VERSION.`
      );
    }
    out.push({
      file: f,
      version: mod.VERSION,
      description: mod.DESCRIPTION || '',
      up: mod.up,
    });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(
        `Duplicate memory migration VERSION: ${out[i].version} ` +
        `(${out[i - 1].file} and ${out[i].file}).`
      );
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
      `Memory db schema version ${currentVersion} is newer than this build supports (max ${targetVersion}). ` +
      `Refusing to downgrade -- upgrade IJFW or open the db with a newer build.`
    );
  }
  if (currentVersion === targetVersion) return currentVersion;

  const migrations = await loadMigrations();
  const pending = migrations.filter(m => m.version > currentVersion && m.version <= targetVersion);
  if (pending.length === 0) return currentVersion;

  let lastApplied = currentVersion;
  for (const m of pending) {
    // BEGIN IMMEDIATE acquires the write lock at transaction start. Plain
    // BEGIN (deferred) lets two concurrent writers both enter their migration
    // tx and then the loser gets SQLITE_BUSY when it tries to upgrade. The
    // compute migration runner caught this in Phase 5; the memory runner
    // ships with the fix in place from day one.
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
      try { db.exec('ROLLBACK'); } catch { /* nothing */ }
      throw new Error(`Memory migration ${m.file} (v${m.version}) failed: ${err.message}`);
    }
  }
  return lastApplied;
}

export default { runMigrations, highestKnownVersion, SchemaVersionError };
