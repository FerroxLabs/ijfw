#!/usr/bin/env node
// IJFW v1.4.1 B7 -- shared extension permission checker.
//
// Reads ~/.ijfw/state/active-extension.json. Accepts a JSON payload on stdin
// with shape { hook_event_name, tool_name, tool_input } (Claude/Codex shape --
// callers reshape platform-specific payloads before piping here).
//
// Exit 0 = allow. Exit 1 = deny (stderr message emitted).
// With no active-extension.json: always exit 0 (backwards-compat invariant).
//
// Also appends one JSON line per check to ~/.ijfw/state/permission-events.jsonl
// (best-effort: failures are swallowed so logging never breaks tool dispatch).

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function emitEvent(home, extensionName, toolName, allowed, reason) {
  try {
    const stateDir = join(home, '.ijfw', 'state');
    await mkdir(stateDir, { recursive: true });
    const event = { ts: new Date().toISOString(), extension: extensionName, tool: toolName, allowed };
    if (reason) event.reason = reason;
    await appendFile(join(stateDir, 'permission-events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // Best-effort: swallow all errors.
  }
}

const home = process.env.HOME || process.env.USERPROFILE || homedir();
const stateFile = join(home, '.ijfw', 'state', 'active-extension.json');

let active;
try {
  const raw = await readFile(stateFile, 'utf8');
  active = JSON.parse(raw);
  if (!active || typeof active !== 'object' || !active.name || !active.permissions) {
    process.stderr.write('ijfw extension permission check: malformed active-extension state\n');
    process.exit(1);
  }
} catch (err) {
  if (err.code === 'ENOENT') process.exit(0); // no active extension -- allow
  process.stderr.write(`ijfw extension permission check: ${err.message}\n`);
  process.exit(1);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const payload_str = chunks.join('');
if (!payload_str.trim()) process.exit(0);

let req;
try { req = JSON.parse(payload_str); } catch { process.exit(0); }

const tool = req.tool_name || '';
const writes = new Set(active.permissions.writes || []);
const reads = new Set(active.permissions.reads || []);
const writeTools = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash']);
const readTools = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);

const has = (set, want) =>
  set.has(want) ||
  set.has('*') ||
  [...set].some((p) => p.endsWith(':*') && want.startsWith(p.slice(0, -1)));

if (writeTools.has(tool) && !has(writes, `tool:${tool.toLowerCase()}`) && !has(writes, 'tool:*')) {
  const reason = `not in permissions.writes`;
  process.stderr.write(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.writes)\n`);
  await emitEvent(home, active.name, tool, false, reason);
  process.exit(1);
}
if (readTools.has(tool) && !has(reads, `tool:${tool.toLowerCase()}`) && !has(reads, 'tool:*')) {
  const reason = `not in permissions.reads`;
  process.stderr.write(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.reads)\n`);
  await emitEvent(home, active.name, tool, false, reason);
  process.exit(1);
}
await emitEvent(home, active.name, tool, true);
process.exit(0);
