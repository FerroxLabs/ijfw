#!/usr/bin/env node
// IJFW PostToolUse hook -- single-invocation consolidated pipeline.
// Replaces the prior shell + 2-to-3 node spawn version. Behaviour-identical:
//   - JSON payload parse + tool_response extraction
//   - ERROR/FAIL signal capture into .ijfw/.session-signals.jsonl
//   - ANSI strip, trailing-whitespace strip, blank-line collapse
//   - noise-line filter (npm warn, docker Fresh, webpack chunk, etc.)
//   - >500 line truncation with error-aware context slice
//   - detached observation-capture dispatch
//   - hookSpecificOutput envelope emit (TERMINAL stdout line)
//
// Measured: ~145ms (old 2x-node) -> target <100ms (single cold start + JS work).
// ESM (repo package.json has "type":"module").

import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

// V155-018: consult USERPROFILE / os.homedir() as fallback so Windows hooks
// don't drop log files at root-relative `/.ijfw/logs` (which then EPERMs on
// every tool call). On POSIX HOME is always set and these are no-ops.
function ijfwHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir() || '';
}

// --- 1) Read stdin payload (cap 1MB to prevent memory exhaustion) ---
let INPUT;
try {
  INPUT = fs.readFileSync(0, 'utf8');
  // 1.2.5 (B5.2): if input exceeds 1 MiB, exit cleanly with a stderr note
  // instead of slicing mid-JSON and silently failing on parse. Hooks must
  // never block, but they should not fail invisibly either.
  if (INPUT.length > 1048576) {
    process.stderr.write('[ijfw post-tool-use] tool_response > 1 MiB, skipping signal extraction\n');
    process.exit(0);
  }
} catch (e) {
  // 1.2.9: leave a breadcrumb so a payload-shape change or stdin failure is
  // diagnosable from ~/.ijfw/logs/. Previously the bare catch swallowed
  // every read failure and turned the hook into a no-op forever.
  try {
    const dir = join(ijfwHome(), '.ijfw', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(join(dir, 'post-tool-use.log'),
      `${new Date().toISOString()} stdin-read ${(e.message || String(e)).slice(0, 200)}\n`);
  } catch { /* logging is best-effort */ }
  process.exit(0);
}
if (!INPUT) process.exit(0);

// --- 2) Parse payload, extract tool_response text ---
let responseText = '';
try {
  const p = JSON.parse(INPUT);
  const r = p && p.tool_response;
  if (!r) process.exit(0);
  if (typeof r === 'string') {
    responseText = r;
  } else {
    const parts = [];
    for (const k of ['output', 'stdout', 'stderr', 'text', 'content', 'result']) {
      if (r[k] == null) continue;
      parts.push(typeof r[k] === 'string' ? r[k] : JSON.stringify(r[k]));
    }
    responseText = parts.join('\n');
  }
} catch (e) {
  // 1.2.9: payload-shape change or malformed JSON should leave a diagnostic
  // trail rather than silently turning the hook into a no-op forever.
  try {
    const dir = join(ijfwHome(), '.ijfw', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(join(dir, 'post-tool-use.log'),
      `${new Date().toISOString()} parse-fail ${(e.message || String(e)).slice(0, 200)}\n`);
  } catch { /* logging is best-effort */ }
  process.exit(0);
}
if (!responseText) process.exit(0);

// --- 3) Signal capture (ERROR/FATAL/Exception + test-fail) ---
// Scoped to tool_response only, per R2-A audit fix.
function scanFirst(text, regex, maxLen) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (regex.test(line)) return line.slice(0, maxLen);
  }
  return null;
}
const errRe  = /^(?:ERROR|FATAL|CRITICAL)|(?:^|\s)(?:Error|Exception|Traceback)[\s:]/;
const failRe = /\b(?:tests? failed|failed with|assertion (?:failed|error))\b/i;
const firstErr  = scanFirst(responseText, errRe, 200);
const firstFail = scanFirst(responseText, failRe, 200);
if (firstErr || firstFail) {
  try {
    fs.mkdirSync('.ijfw', { recursive: true });
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const rec = { ts, error: firstErr || null, fail: firstFail || null };
    fs.appendFileSync('.ijfw/.session-signals.jsonl', JSON.stringify(rec) + '\n');
  } catch {}
}

// --- 4) Trim noise ---
// 4a: ANSI escape strip + trailing whitespace strip per line.
const rawLines = responseText
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  .split('\n')
  .map(l => l.replace(/\s+$/, ''));

// 4b: Collapse consecutive blank lines (match awk state machine).
const collapsed = [];
let prevBlank = false;
for (const line of rawLines) {
  if (line === '') {
    if (!prevBlank) collapsed.push('');
    prevBlank = true;
  } else {
    collapsed.push(line);
    prevBlank = false;
  }
}

// 4c: Drop noise patterns (same set as prior sed pipeline).
const drop = [
  /^\s*PASS /,
  /^\s*\.\.\.\./,
  /^collecting/,
  /^\s*npm (?:warn|notice)/,
  /^added \d+ packages/,
  /^Requirement already satisfied/,
  /^Downloading /,
  /^Installing collected/,
  /^\s*--->/,
  /^Removing intermediate container/,
  /^\s*\[internal\]/,
  /^chunk \{/,
  /^asset [a-f0-9]/,
  /^\s*(?:Compiling|Downloading|Fresh) /
];
const filtered = collapsed.filter(line => !drop.some(re => re.test(line)));

// --- 5) Truncate if > 500 lines ---
let out;
if (filtered.length > 500) {
  const hasErrMarker =
    filtered.some(l => /^(?:ERROR|WARN|FAIL|CRITICAL|FATAL|Traceback|\s*at [A-Z])/.test(l)) ||
    filtered.some(l => /\berror\b|\bwarn(?:ing)?\b|\bfailed\b/i.test(l));
  if (hasErrMarker) {
    const head = filtered.slice(0, 100);
    const tail = filtered.slice(-30);
    // Extract error context: each match + 1-before + 1-after, cap 120 lines total.
    const errCtx = [];
    const errCap = 120;
    for (let i = 0; i < filtered.length && errCtx.length < errCap; i++) {
      if (/\b(?:error|warn(?:ing)?|failed|traceback|fatal|critical)\b/i.test(filtered[i])) {
        if (i > 0) errCtx.push(filtered[i - 1]);
        errCtx.push(filtered[i]);
        if (i < filtered.length - 1) errCtx.push(filtered[i + 1]);
      }
    }
    out = `[ijfw] Output condensed: ${filtered.length} lines to key sections\n\n${head.join('\n')}\n\n${errCtx.join('\n')}\n\n... tail ...\n\n${tail.join('\n')}\n`;
  } else {
    const head = filtered.slice(0, 250);
    const tail = filtered.slice(-50);
    out = `[ijfw] Output condensed: ${filtered.length} lines to key sections\n\n${head.join('\n')}\n\n${tail.join('\n')}\n`;
  }
} else {
  out = filtered.join('\n');
}

// --- 6) Dispatch observation capture as detached child (fire-and-forget) ---
// Invariant: this spawns BEFORE the envelope emit so there's no interleave risk.
// Child inherits a piped stdin; parent closes it and unref()s so it outlives us.
const obsScript = process.argv[2];
if (obsScript && fs.existsSync(obsScript)) {
  try {
    const logDir = join(ijfwHome(), '.ijfw', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFd = fs.openSync(join(logDir, 'obs-capture.log'), 'a');
    const child = spawn(process.execPath, [obsScript], {
      stdio: ['pipe', logFd, logFd],
      detached: true
    });
    child.stdin.write(INPUT);
    child.stdin.end();
    child.unref();
  } catch {}
}

// --- 7) Emit hookSpecificOutput envelope (TERMINAL stdout line) ---
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: out
  }
}));
