// IJFW v1.3.0 -- memory migration 001: apply schema.sql on a fresh memory db.
//
// Idempotent (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE). Runs inside
// the migration runner's BEGIN IMMEDIATE transaction so a crash mid-apply
// rolls back to user_version 0.
//
// Source of truth for DDL: ../schema.sql.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'schema.sql');

export const VERSION = 1;
export const DESCRIPTION = 'memory v1.3.0 -- memory_entries + memory_entries_fts (porter unicode61)';

export function up(db) {
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  // The sqlite driver runs the multi-statement DDL block from schema.sql
  // atomically when called inside the migration runner's transaction.
  db.exec(sql);
}

export default { version: VERSION, description: DESCRIPTION, up };
