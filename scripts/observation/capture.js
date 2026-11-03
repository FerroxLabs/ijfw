#!/usr/bin/env node
/**
 * IJFW observation capture -- reads hook JSON from stdin, classifies,
 * appends to ~/.ijfw/observations.jsonl.
 *
 * Called by observation-capture.sh / user-prompt-submit-capture.sh (async,
 * via `& disown`). Zero deps. Never crashes; all errors to stderr.
 *
 * stdin: hook JSON envelope (PostToolUse / UserPromptSubmit, or the Gemini
 *        AfterTool / BeforeAgent equivalents). Claude Code, current Codex,
 *        legacy Codex and Gemini shapes are all accepted -- see normalize.js.
 * env:
 *   IJFW_SESSION_ID  -- session UUID (set by session-start.sh)
 *   IJFW_PROJECT     -- project name (set by session-start.sh, fallback to cwd basename)
 *   IJFW_PLATFORM    -- "claude-code" | "codex" | "gemini" (default: "claude-code")
 *
 * Security (FerroxLabs/ijfw#31): every free-text field (prompt, command line,
 * tool input path, title) is passed through redactObservationText() before
 * it can reach the ledger. Tool output is never stored.
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { homedir } from 'os';
import { join } from 'path';
import { classify } from './classify.js';
import { titleize } from './titleize.js';
import { appendObservation } from './ledger.js';
import { normalizeHookPayload } from './normalize.js';
import { redactObservationText } from './redact.js';

const SESSION_FILE = join(homedir(), '.ijfw', '.current-session');

function readSessionId(payloadSessionId) {
  const envId = process.env.IJFW_SESSION_ID;
  if (envId) return envId;
  if (payloadSessionId) return payloadSessionId;
  try {
    if (existsSync(SESSION_FILE)) return readFileSync(SESSION_FILE, 'utf8').trim();
  } catch {}
  return 'unknown';
}

function main() {
  let raw = '';
  try {
    // fd 0 (not '/dev/stdin'): works for pipes, files AND sockets -- Node-based
    // hosts hand children a socketpair, which '/dev/stdin' cannot open.
    raw = readFileSync(0, 'utf8');
  } catch {
    // stdin may not be available -- exit silently
    process.exit(0);
  }

  if (!raw || !raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const ev = normalizeHookPayload(payload);
  const R = redactObservationText;

  const filePath = R(ev.filePath);
  const files = ev.files.map((f) => R(f)).filter(Boolean);

  // Classify on the raw command (keyword heuristics only, nothing stored),
  // title on redacted text only.
  const type = classify({
    tool_name: ev.toolName,
    tool_input_cmd: ev.command,
    tool_input_path: ev.filePath,
    is_new_file: ev.isNewFile,
    hook_event: ev.hookEvent,
    user_prompt: '',
  });
  const title = R(titleize({
    tool_name: ev.toolName,
    tool_input_cmd: R(ev.command),
    tool_input_path: filePath,
    is_new_file: ev.isNewFile,
    hook_event: ev.hookEvent,
    user_prompt: R(ev.prompt),
  }));

  const obs = {
    ts:         new Date().toISOString(),
    type,
    title,
    files,
    tool_name:   ev.originalToolName || ev.toolName || null,
    token_cost:  null,
    work_tokens: null,
    platform:    process.env.IJFW_PLATFORM || 'claude-code',
    session_id:  readSessionId(ev.sessionId),
    project:     process.env.IJFW_PROJECT || basename(ev.cwd || process.cwd()),
  };

  try {
    appendObservation(obs);
  } catch (err) {
    process.stderr.write(`[ijfw] capture error: ${err.message}\n`);
  }
}

main();
