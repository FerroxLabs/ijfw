/**
 * deploy-alerts.js — v1.5.0 audit-MED-update-M8 (F-REL-2).
 *
 * When `extension-installer.installExtension` exits with `deploy_partial: true`,
 * the failure detail used to be returned in the install reply only — the next
 * prelude had no way to surface "you have a half-deployed extension somewhere".
 *
 * This module persists each partial deploy to a jsonl tail at
 * `~/.ijfw/state/deploy-failures.jsonl` so the memory prelude (handlePrelude in
 * `server.js`) can read the last N entries and emit a "Deploy alerts" line.
 *
 * File contract:
 *   - JSONL, one record per line.
 *   - Each record:
 *       {
 *         ts: ISO8601,
 *         extension: <manifest.name>,
 *         scope: 'project' | 'org' | 'user',
 *         failures: Array<{platform, skillName, error}>,
 *       }
 *   - Soft cap: 200 lines. Older lines drop off via a one-shot trim on write.
 *   - Append-only and atomic in the common case (single writeFile call); the
 *     trim path rewrites the whole tail under the same atomic shape.
 *   - Failure to write is non-fatal — alert path is best-effort observability.
 *
 * The reader is bounded at N=10 by default — short-tail "what's wrong right
 * now" surfacing, not an audit log.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALERT_FILE_NAME = 'deploy-failures.jsonl';
const MAX_LINES_ON_DISK = 200;
const DEFAULT_READ_TAIL = 10;

function statePath() {
  return join(homedir(), '.ijfw', 'state');
}

export function deployFailuresPath() {
  return join(statePath(), ALERT_FILE_NAME);
}

/**
 * Record a partial-deploy event.
 *
 * @param {object} record
 * @param {string} record.extension
 * @param {'project'|'org'|'user'} record.scope
 * @param {Array<{platform:string, skillName?:string, error:string}>} record.failures
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
export async function recordDeployFailure(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'record must be an object' };
  }
  if (typeof record.extension !== 'string' || record.extension.length === 0) {
    return { ok: false, error: 'extension is required' };
  }
  if (!Array.isArray(record.failures)) {
    return { ok: false, error: 'failures must be an array' };
  }

  const entry = {
    ts: new Date().toISOString(),
    extension: record.extension,
    scope: record.scope || 'project',
    failures: record.failures.map((f) => ({
      platform: typeof f && f.platform ? String(f.platform) : 'unknown',
      skillName: f && f.skillName ? String(f.skillName) : null,
      error: f && f.error ? String(f.error).slice(0, 500) : 'unknown',
    })),
  };

  const path = deployFailuresPath();
  try {
    await mkdir(statePath(), { recursive: true });
    // Trim-on-overflow: if existing file already > cap, rewrite the tail.
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      existing = '';
    }
    const lines = existing ? existing.split('\n').filter((l) => l.trim()) : [];
    lines.push(JSON.stringify(entry));
    const trimmed = lines.slice(-MAX_LINES_ON_DISK);
    await writeFile(path, trimmed.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Read the last N deploy-failure records (default 10). Returns oldest-first.
 *
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array>}
 */
export async function readDeployFailures(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_READ_TAIL;
  let raw;
  try {
    raw = await readFile(deployFailuresPath(), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-limit);
  const out = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // skip malformed line — don't fail the read
    }
  }
  return out;
}

/**
 * Render the last N entries as terse prelude lines. Empty array → empty string.
 *
 * @param {{limit?:number}} [opts]
 * @returns {Promise<string>}
 */
export async function renderDeployAlertsForPrelude(opts = {}) {
  const entries = await readDeployFailures(opts);
  if (entries.length === 0) return '';
  const lines = ['## Deploy alerts'];
  for (const e of entries) {
    const fcount = Array.isArray(e.failures) ? e.failures.length : 0;
    const platforms = Array.isArray(e.failures)
      ? Array.from(new Set(e.failures.map((f) => f.platform).filter(Boolean))).join(',')
      : '';
    const head = `- ${e.ts} — ${e.extension} (scope=${e.scope || 'project'}): ${fcount} failure${fcount === 1 ? '' : 's'}${platforms ? ` [${platforms}]` : ''}`;
    lines.push(head);
  }
  lines.push('');
  return lines.join('\n');
}
