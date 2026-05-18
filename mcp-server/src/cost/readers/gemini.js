/**
 * IJFW cost/readers/gemini.js
 * Reads Gemini CLI chat JSON files from ~/.gemini/tmp/<projectHash>/chats/*.json
 * Gemini CLI does not expose per-turn token counts in its chat format.
 * We estimate from message content length.
 * Data approach adapted from tokscale (junhoyeo, MIT).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GEMINI_TMP_DIR = join(homedir(), '.gemini', 'tmp');

export function readGeminiSessions(tmpDir = GEMINI_TMP_DIR) {
  if (!existsSync(tmpDir)) return [];

  const turns = [];
  let projectDirs;
  try { projectDirs = readdirSync(tmpDir); } catch { return []; }

  for (const projectHash of projectDirs) {
    const projectPath = join(tmpDir, projectHash);
    let stat;
    try { stat = statSync(projectPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const chatsDir = join(projectPath, 'chats');
    if (!existsSync(chatsDir)) continue;

    let chatFiles;
    try { chatFiles = readdirSync(chatsDir); } catch { continue; }

    for (const file of chatFiles) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(chatsDir, file);

      try {
        const raw = readFileSync(filePath, 'utf8');
        const chat = JSON.parse(raw);
        const sessionTurns = processGeminiChat(chat, projectHash);
        for (const t of sessionTurns) turns.push(t);
      } catch {
        // corrupt file -- skip
      }
    }
  }

  return turns;
}

function processGeminiChat(chat, projectHash) {
  const sessionId = chat.sessionId || projectHash;
  const startTime = chat.startTime || chat.lastUpdated || null;
  const messages  = chat.messages || [];

  // Gemini CLI chat files: messages have type 'user' or 'gemini'
  // No token counts exposed; estimate from text content
  let totalInputChars  = 0;
  let totalOutputChars = 0;
  let lastTimestamp = startTime;

  for (const msg of messages) {
    if (msg.timestamp) lastTimestamp = msg.timestamp;

    const chars = extractChars(msg.content);
    if (!chars) continue;

    if (msg.type === 'user') {
      totalInputChars += chars;
    } else {
      // 'gemini' type or model response
      totalOutputChars += chars;
      // Count thoughts as output tokens (they are billed)
      if (Array.isArray(msg.thoughts)) {
        for (const t of msg.thoughts) {
          if (t.description) totalOutputChars += t.description.length;
        }
      }
    }
  }

  const inputTokens  = Math.ceil(totalInputChars / 4);
  const outputTokens = Math.ceil(totalOutputChars / 4);

  if (!inputTokens && !outputTokens) return [];

  return [{
    platform: 'gemini',
    session_id: sessionId,
    project: projectHash,
    timestamp: lastTimestamp,
    model: 'gemini-3.1-pro', // Gemini CLI default; no model id in chat file
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_create_tokens_5m: 0,
    cache_create_tokens_1h: 0,
    cache_read_tokens: 0,
    tool_name: null,
    estimated: true,
  }];
}

function extractChars(content) {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((s, block) => s + (block && block.text ? block.text.length : 0), 0);
  }
  return 0;
}
