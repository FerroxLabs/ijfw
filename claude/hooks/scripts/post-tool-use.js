#!/usr/bin/env node
// IJFW PostToolUse hook -- single-invocation consolidated pipeline.
//   - JSON payload parse + tool_response extraction
//   - ERROR/FAIL signal capture into .ijfw/.session-signals.jsonl
//   - detached observation-capture dispatch
//   - hookSpecificOutput envelope emit (TERMINAL stdout line)
//
// W5.1 (v1.6.0): the hook no longer re-emits the tool output as
// additionalContext. additionalContext is ADDITIVE in Claude Code -- it
// appends to what the model already received, it cannot replace it -- so
// echoing the (cleaned) output back duplicated every tool result in context,
// a measurable driver of premature compaction. We now emit NOTHING on success
// (the model already has the output) and a single-line breadcrumb on failure
// (preserves error-surfacing at ~1 line instead of hundreds). This also
// retired the ANSI-strip / noise-filter / >500-line truncation machinery whose
// only consumer was the removed echo -- the hook is leaner and faster as a
// result. Signal capture (to disk) and the detached obs-capture child are
// unchanged; neither reads stdout.
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
    // mode 0o600: error/fail excerpts can carry sensitive content -- keep them
    // owner-only, not world-readable (privacy audit finding).
    fs.appendFileSync('.ijfw/.session-signals.jsonl', JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {}
}

// --- 3b) S4 edit-delta capture: the CORRECTION LOOP (the HEART). ---
// On an Edit/Write tool, the diff between what the agent PROPOSED and what
// actually got committed is the cleanest personalization signal there is (per
// the cross-audit: that diff IS the citation). We record it as a metadata-
// minimized evidence row in .ijfw/.session-edits.jsonl via the profile capture
// module. Best-effort + fail-soft: a parse/resolve/import error here must NEVER
// block a tool — wrapped in try/catch and a detached dynamic import so the hook
// returns within its latency budget regardless.
//
//   Edit  tool_input: { file_path, old_string (the PROPOSED prior span),
//                       new_string (the COMMITTED span) }
//   Write tool_input: { file_path, content (the COMMITTED body) } — no prior
//                       span on the payload, so the first Write is recorded as
//                       a landed proposal (accept); a LATER Edit to the same
//                       file is the user's correction (edit-after).
try {
  const payload = JSON.parse(INPUT);
  const toolName = String(payload && payload.tool_name || '');
  const ti = (payload && payload.tool_input) || {};
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') && ti && ti.file_path) {
    // Resolve the profile capture module the same way session-end.sh does.
    let captureMod = null;
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
    const candidates = [
      pluginRoot ? join(pluginRoot, '..', 'mcp-server', 'src', 'profile', 'capture.js') : '',
      join(ijfwHome(), '.ijfw', 'mcp-server', 'src', 'profile', 'capture.js'),
      join(process.cwd(), 'mcp-server', 'src', 'profile', 'capture.js'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) { captureMod = c; break; }
    }
    if (captureMod) {
      // MultiEdit carries an `edits[]` array; Edit/Write carry a single span.
      const spans = Array.isArray(ti.edits) && ti.edits.length
        ? ti.edits.map((e) => ({ proposed: e.old_string, committed: e.new_string }))
        : [{
          proposed: ti.old_string,
          committed: ti.new_string !== undefined ? ti.new_string : ti.content,
        }];
      const sessionId = (payload && (payload.session_id || payload.sessionId)) || null;
      // Dynamic import is async; we intentionally do not await — fire-and-forget
      // so the hook never adds import latency to the tool's critical path. Any
      // failure is swallowed (best-effort capture).
      import('file://' + captureMod).then((mod) => {
        if (!mod || typeof mod.captureEditDelta !== 'function') return;
        for (const s of spans) {
          try {
            mod.captureEditDelta({
              sessionId,
              filePath: ti.file_path,
              proposed: s.proposed,
              committed: s.committed,
              ts: Date.now(),
              cwd: process.cwd(),
              env: process.env,
            });
          } catch { /* per-span best-effort */ }
        }
      }).catch(() => { /* import best-effort */ });
    }
  }
} catch { /* edit-delta capture is best-effort; never block the tool */ }

// --- 4) Dispatch observation capture as detached child (fire-and-forget) ---
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

// --- 5) Emit (TERMINAL stdout line) ---
// Success: emit nothing. The model already received the full tool_response;
// additionalContext can only ADD, so any success emit is pure duplication.
// Failure: a single-line breadcrumb keeps the error visible without echoing
// hundreds of lines. firstErr/firstFail were already scanned in step 3.
if (firstErr || firstFail) {
  const detail = String(firstErr || firstFail).replace(/\s+/g, ' ').trim().slice(0, 200);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[ijfw] tool reported an issue: ${detail}`
    }
  }));
}
