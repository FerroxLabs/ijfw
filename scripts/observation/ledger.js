#!/usr/bin/env node
/**
 * IJFW Observation Ledger
 * JSONL canonical store at ~/.ijfw/observations.jsonl
 * SQLite mirror at ~/.ijfw/observations.db (Node 22.5+ with node:sqlite).
 * Zero deps. All Node built-ins.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, statSync, rmdirSync, readdirSync, unlinkSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const IJFW_GLOBAL = join(homedir(), '.ijfw');
const JSONL_PATH  = join(IJFW_GLOBAL, 'observations.jsonl');
const LOCK_DIR    = join(IJFW_GLOBAL, '.obs-lock');
const MAX_JSONL   = 10 * 1024 * 1024; // 10MB rotation threshold
const MAX_LINE    = 8 * 1024;         // 8KB line cap

// Archive retention: keep the N most-recent observations.jsonl.<ts> files after
// rotation. Default 10 (~100MB worst-case historical ledger). Set 0 to disable
// (unbounded archives). Override via IJFW_LEDGER_ARCHIVES=<N> in the environment.
const MAX_ARCHIVES = (() => {
  const raw = parseInt(process.env.IJFW_LEDGER_ARCHIVES || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10;
})();

// ---------- mkdir-lock (mirrors session-end.sh pattern) ----------
function acquireLock(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      mkdirSync(LOCK_DIR);
      return true;
    } catch {
      // Sleep 20ms without burning CPU (Atomics.wait blocks the thread;
      // the old `while (Date.now() < end) {}` spin pegged a core).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return false;
}

function releaseLock() {
  try { rmdirSync(LOCK_DIR); } catch {}
}

// ---------- JSONL rotation + archive GC ----------
function gcArchives() {
  // MAX_ARCHIVES=0 disables GC (user opt-in to unbounded).
  if (MAX_ARCHIVES === 0) return;
  try {
    const prefix = basename(JSONL_PATH) + '.';
    const entries = readdirSync(IJFW_GLOBAL)
      .filter(n => n.startsWith(prefix) && n !== basename(JSONL_PATH))
      .map(n => {
        try { return { name: n, mtimeMs: statSync(join(IJFW_GLOBAL, n)).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    for (let i = MAX_ARCHIVES; i < entries.length; i++) {
      try { unlinkSync(join(IJFW_GLOBAL, entries[i].name)); } catch {}
    }
  } catch {}
}

function rotateIfNeeded() {
  try {
    if (!existsSync(JSONL_PATH)) return;
    const { size } = statSync(JSONL_PATH);
    if (size < MAX_JSONL) return;
    renameSync(JSONL_PATH, `${JSONL_PATH}.${Date.now()}`);
    gcArchives();
  } catch {}
}

// ---------- SQLite mirror (optional, Node 22.5+) ----------
// Opened lazily via dynamic import in mirrorToSqlite().
let _dbPromise = null;

async function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(IJFW_GLOBAL, 'observations.db'));
      db.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id          INTEGER PRIMARY KEY,
          ts          TEXT NOT NULL,
          type        TEXT NOT NULL,
          title       TEXT NOT NULL,
          files       TEXT,
          tool_name   TEXT,
          token_cost  INTEGER,
          work_tokens INTEGER,
          platform    TEXT,
          session_id  TEXT,
          project     TEXT
        );
        CREATE INDEX IF NOT EXISTS obs_session ON observations(session_id);
        CREATE INDEX IF NOT EXISTS obs_ts ON observations(ts);
      `);
      return db;
    } catch {
      return null; // older Node or sqlite unavailable
    }
  })();
  return _dbPromise;
}

async function mirrorToSqlite(record) {
  try {
    const db = await openDb();
    if (!db) return;
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO observations
        (id, ts, type, title, files, tool_name, token_cost, work_tokens, platform, session_id, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      record.id, record.ts, record.type, record.title,
      JSON.stringify(record.files || []),
      record.tool_name || null,
      record.token_cost || null,
      record.work_tokens || null,
      record.platform || null,
      record.session_id || null,
      record.project || null
    );
  } catch {
    // silent -- SQLite is acceleration cache, not canonical
  }
}

// ---------- Public API ----------

// Read only the tail of the ledger to find the last record's id. A full
// readFileSync was O(file size) -- up to MAX_JSONL -- on EVERY tool call,
// since capture.js runs per PostToolUse event.
function lastRecordId() {
  let fd = null;
  try {
    fd = openSync(JSONL_PATH, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return 0;
    // 2x the line cap guarantees the window holds at least one full line.
    const span = Math.min(size, MAX_LINE * 2);
    const buf = Buffer.alloc(span);
    const bytes = readSync(fd, buf, 0, span, size - span);
    const lines = buf.toString('utf8', 0, bytes).split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec && typeof rec.id === 'number') return rec.id;
      } catch {
        // earliest line in the window may be a partial record -- skip it
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
  }
}

/**
 * Append one observation record to the JSONL ledger.
 * Atomic for short writes at OS level (single appendFile syscall).
 * Uses mkdir-lock for serialisation across concurrent processes.
 *
 * @param {object} obs - observation record (id auto-assigned if absent)
 * @returns {object} the record as written (with assigned id)
 */
export function appendObservation(obs) {
  mkdirSync(IJFW_GLOBAL, { recursive: true });
  rotateIfNeeded();

  // Derive the id INSIDE the lock so two concurrent captures cannot read the
  // same tail and emit duplicate ids (the SQLite mirror keys on id and would
  // silently drop the second via INSERT OR IGNORE). Best-effort; gaps are fine.
  const locked = acquireLock();
  let record;
  try {
    const nextId = lastRecordId() + 1;
    record = { id: nextId, ...obs };
    let line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
      const truncated = { ...record, title: (record.title || '').slice(0, 200) };
      line = JSON.stringify(truncated) + '\n';
    }
    try {
      appendFileSync(JSONL_PATH, line, { encoding: 'utf8', flag: 'a' });
    } catch (err) {
      process.stderr.write(`[ijfw] observation append failed: ${err.message}\n`);
    }
  } finally {
    if (locked) releaseLock();
  }

  // Fire-and-forget SQLite mirror
  mirrorToSqlite(record).catch(() => {});

  return record;
}

/**
 * Read all observations for a given session_id.
 */
export function getSession(sessionId) {
  return readAll().filter(o => o.session_id === sessionId);
}

/**
 * Read the most recent N observations.
 */
export function getRecent(n = 50) {
  const all = readAll();
  return all.slice(-n);
}

/**
 * Simple substring search over title + type fields.
 */
export function search(query) {
  const q = (query || '').toLowerCase();
  return readAll().filter(o =>
    (o.title || '').toLowerCase().includes(q) ||
    (o.type  || '').toLowerCase().includes(q)
  );
}

export function readAll() {
  try {
    if (!existsSync(JSONL_PATH)) return [];
    return readFileSync(JSONL_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
