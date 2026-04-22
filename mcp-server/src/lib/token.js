// Crypto-random confirmation token issuance for MCP update flow.
// Token is short (32 hex chars = 128 bits) and human-typeable.
// Stored server-side at ~/.ijfw/run/<session>/update-token.json with expiry.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeAtomic, readSafe } from './atomic-io.js';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

export function generateToken() {
  return randomBytes(16).toString('hex');
}

export function sessionDir(sessionId = 'default') {
  // Sanitize -- per v3 sec 2: /^[a-zA-Z0-9_-]{8,64}$/, fallback to 'default'
  const safe = /^[a-zA-Z0-9_-]{8,64}$/.test(sessionId) ? sessionId : 'default-session';
  const root = process.env.IJFW_HOME || join(homedir(), '.ijfw');
  const dir = join(root, 'run', safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function issueToken(sessionId, targetVersion, ttlMs = DEFAULT_TTL_MS) {
  const token = generateToken();
  const expiresAt = Date.now() + ttlMs;
  const dir = sessionDir(sessionId);
  const path = join(dir, 'update-token.json');
  writeAtomic(path, {
    schema_version: 1,
    token,
    target_version: targetVersion,
    issued_at: Date.now(),
    expires_at: expiresAt,
    consumed: false,
  });
  return { token, expires_at: expiresAt, path };
}

export function validateToken(sessionId, candidateToken) {
  const dir = sessionDir(sessionId);
  const path = join(dir, 'update-token.json');
  const r = readSafe(path, d => d && typeof d.token === 'string');
  if (!r.ok) return { ok: false, error: 'no-token' };
  const t = r.data;
  if (t.consumed) return { ok: false, error: 'already-consumed' };
  if (Date.now() > t.expires_at) return { ok: false, error: 'expired' };
  if (t.token !== candidateToken) return { ok: false, error: 'mismatch' };
  return { ok: true, target_version: t.target_version };
}

export function consumeToken(sessionId) {
  const dir = sessionDir(sessionId);
  const path = join(dir, 'update-token.json');
  const r = readSafe(path);
  if (!r.ok) return false;
  writeAtomic(path, { ...r.data, consumed: true, consumed_at: Date.now() });
  return true;
}

export function writePendingSentinel(sessionId, targetVersion, token) {
  const dir = sessionDir(sessionId);
  const path = join(dir, 'update-pending.json');
  writeAtomic(path, {
    schema_version: 1,
    target_version: targetVersion,
    token,
    issued_at: Date.now(),
  });
  return path;
}

export function readPendingSentinel(sessionId) {
  const dir = sessionDir(sessionId);
  const path = join(dir, 'update-pending.json');
  return readSafe(path, d => d && typeof d.token === 'string');
}

export function clearPendingSentinel(sessionId) {
  const dir = sessionDir(sessionId);
  const path = join(dir, 'update-pending.json');
  try { if (existsSync(path)) unlinkSync(path); return true; } catch { return false; }
}
