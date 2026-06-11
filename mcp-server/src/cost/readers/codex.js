/**
 * IJFW cost/readers/codex.js
 * Reads Codex CLI JSONL session files from ~/.codex/sessions/**\/*.jsonl
 * Codex uses event_msg/token_count for rate-limit tracking (not per-turn billing).
 * For cost attribution we use session_meta (model) + response_item messages
 * and estimate tokens from content length when explicit counts unavailable.
 * Data approach adapted from tokscale (junhoyeo, MIT).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

export function readCodexSessions(sessionsDir = CODEX_SESSIONS_DIR) {
  if (!existsSync(sessionsDir)) return [];
  const turns = [];
  walkDir(sessionsDir, turns);
  return turns;
}

function walkDir(dir, turns) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      walkDir(fullPath, turns);
    } else if (entry.endsWith('.jsonl')) {
      processCodexFile(fullPath, turns);
    }
  }
}

function processCodexFile(filePath, turns) {
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }

  // Collect session metadata first
  let sessionMeta = null;
  let sessionId = null;
  let model = 'gpt-5'; // codex default

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'session_meta') {
        sessionMeta = record.payload || {};
        sessionId = sessionMeta.id || null;
        model = sessionMeta.collaboration_mode?.settings?.model ||
                sessionMeta.model || 'gpt-5';
      }
    } catch {}
  }

  if (!sessionId) {
    // Derive session id from filename (basename handles both path separators)
    sessionId = basename(filePath, '.jsonl');
  }

  // Extract timestamp from session path (YYYY/MM/DD/filename); paths are
  // join()-built, so accept either separator (backslashes on Windows).
  const dateParts = filePath.match(/(\d{4})[\\/](\d{2})[\\/](\d{2})/);
  const datePrefix = dateParts ? `${dateParts[1]}-${dateParts[2]}-${dateParts[3]}` : null;

  // Accumulate per-session totals from response_item/message content
  // Codex does not expose per-turn token counts in JSONL; we estimate from chars
  let totalInputChars = 0;
  let totalOutputChars = 0;
  let lastTimestamp = datePrefix ? datePrefix + 'T12:00:00.000Z' : null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.timestamp) lastTimestamp = record.timestamp;

      if (record.type === 'response_item' && record.payload) {
        const payload = record.payload;
        const role = payload.role;
        const content = payload.content;
        if (!Array.isArray(content)) continue;

        let chars = 0;
        for (const block of content) {
          if (block && block.text) chars += block.text.length;
        }

        if (role === 'user' || role === 'developer') {
          totalInputChars += chars;
        } else {
          totalOutputChars += chars;
        }
      }
    } catch {}
  }

  // Estimate tokens: 1 token ~= 4 chars (GPT-era heuristic)
  const inputTokens  = Math.ceil(totalInputChars / 4);
  const outputTokens = Math.ceil(totalOutputChars / 4);

  if (!inputTokens && !outputTokens) return;

  // Codex does not expose per-turn token counts or cache metrics in JSONL.
  // Tokens are estimated from content length (1 token ~= 4 chars, GPT-era heuristic).
  // cache_read_tokens is NOT included -- we cannot distinguish cached vs fresh reads
  // from Codex JSONL, and fabricating a cache_read number would inflate savings.
  turns.push({
    platform: 'codex',
    session_id: sessionId,
    project: sessionMeta?.git?.repository_url?.split('/').pop() || null,
    timestamp: lastTimestamp,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_create_tokens_5m: 0,
    cache_create_tokens_1h: 0,
    cache_read_tokens: 0, // not available from Codex JSONL; excluded from savings
    tool_name: null,
    estimated: true, // tokens derived from char heuristic, not actual API usage counts
    estimatedNote: 'Codex CLI does not log per-turn token counts locally. Tokens estimated from content length.',
  });
}
