// IJFW v1.3.0 Alpha -- migration 001: apply schema.sql on a fresh db.
// Idempotent (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE).
//
// Source of truth for DDL: ../schema.sql (see PLAN-alpha.md V3-B4).

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'schema.sql');

export const VERSION = 1;
export const DESCRIPTION = 'alpha v1.3.0 -- raw + raw_fts + compiled + compiled_fts + trident_run + schema_meta';

export function up(db) {
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  // db.exec runs the multi-statement DDL block from schema.sql atomically
  // when called inside the migration runner's transaction.
  db.exec(sql);
}

export default { version: VERSION, description: DESCRIPTION, up };
