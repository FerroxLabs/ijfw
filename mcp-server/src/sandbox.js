/**
 * sandbox.js -- ijfw_run sandbox module
 * Runs shell commands, caps output, summarizes for LLM context, spills full
 * output to disk so the context window isn't flooded.
 *
 * Zero external dependencies -- Node.js built-ins only.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LINES = 50_000;
const TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes

// Strip ANSI escape sequences.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[mGKHFJK]/g, ''); // eslint-disable-line no-control-regex
}

// Sanitize a label string for use as a filename.
function sanitizeLabel(label) {
  return String(label).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
}

/**
 * runCommand(command, opts) → { stdout, exitCode, signal, durationMs, lines, bytes, timedOut }
 *
 * Spawns command in a shell. Merges stdout+stderr in arrival order, capped at
 * MAX_BYTES / MAX_LINES. Kills the process after TIMEOUT_MS.
 */
export function runCommand(command, opts = {}) {
  return new Promise((resolve) => {
    const cwd = opts.cwd || process.cwd();
    const start = Date.now();
    let timedOut = false;
    let totalBytes = 0;
    let capped = false;
    const chunks = [];

    const child = spawn(command, [], {
      shell: true,
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, TIMEOUT_MS);

    function onData(chunk) {
      if (capped) return;
      const remaining = MAX_BYTES - totalBytes;
      if (chunk.length >= remaining) {
        chunks.push(chunk.slice(0, remaining));
        totalBytes += remaining;
        capped = true;
        try { child.kill('SIGKILL'); } catch {}
      } else {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const lines = raw.split('\n').length;
      const truncLines = Math.min(lines, MAX_LINES);
      // If over MAX_LINES, trim to MAX_LINES worth of lines
      const stdout = lines > MAX_LINES
        ? raw.split('\n').slice(0, MAX_LINES).join('\n')
        : raw;
      const bytes = Buffer.byteLength(stdout, 'utf8');
      resolve({
        stdout,
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
        lines: truncLines,
        bytes,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: `spawn error: ${err.message}`,
        exitCode: 1,
        signal: null,
        durationMs: Date.now() - start,
        lines: 1,
        bytes: 0,
        timedOut: false,
      });
    });
  });
}

/**
 * detectDomain(output) → 'test' | 'build' | 'grep' | 'log' | 'raw'
 * Heuristics on ANSI-stripped output.
 */
export function detectDomain(output) {
  const lines = output.split('\n');
  const sample = lines.slice(0, 500); // only inspect leading lines for speed

  // test: pass/fail keywords + test count or suite name
  if (
    /\b(PASS|FAIL|passed|failed|✓|✗|ok|not ok)\b/i.test(output) &&
    (/\d+\s+(test|spec|suite|passing|failing|pending)/i.test(output) || /^(PASS|FAIL)\s+/m.test(output))
  ) {
    return 'test';
  }

  // build: compiler/bundler error patterns
  if (/error\[E\d|ERROR TS\d|SyntaxError|\b(webpack|vite|rollup|tsc|cargo)\b/i.test(output)) {
    return 'build';
  }

  // grep: majority of lines are file:line: pattern
  const grepLike = sample.filter(l => /^[^:]+:\d+:/.test(l)).length;
  if (sample.length > 5 && grepLike / sample.length > 0.6) {
    return 'grep';
  }

  // log: majority of lines start with ISO timestamp or [INFO]/[ERROR]/[WARN]
  const logLike = sample.filter(l =>
    /^\d{4}-\d{2}-\d{2}[T ]/.test(l) ||
    /^\[?(INFO|ERROR|WARN|DEBUG)\]?[\s:]/i.test(l)
  ).length;
  if (sample.length > 5 && logLike / sample.length > 0.4) {
    return 'log';
  }

  return 'raw';
}

/**
 * summarize(output, domain, command, exitCode, durationMs) → string
 */
export function summarize(output, domain, command, exitCode, durationMs) {
  const lines = output.split('\n');
  const lineCount = lines.length;
  const header = `[ijfw_run] ${command} exit=${exitCode} ${durationMs}ms | ${lineCount} lines`;

  const parts = [header];

  if (domain === 'test') {
    // Extract pass/fail counts
    const countMatch = output.match(/(\d+)\s+(?:test|spec|suite)s?\s+(?:passed|passing)/i)
      || output.match(/Tests?:\s+(\d+)\s+passed/i);
    const failMatch = output.match(/(\d+)\s+(?:test|spec|suite)s?\s+(?:failed|failing)/i)
      || output.match(/Tests?:.*?(\d+)\s+failed/i);
    if (countMatch || failMatch) {
      const p = countMatch ? countMatch[1] : '?';
      const f = failMatch ? failMatch[1] : '0';
      parts.push(`Tests: ${p} passed, ${f} failed`);
    }
    // Failing test names
    const failLines = lines.filter(l => /\b(FAIL|✗|not ok|× )\b/.test(l) || /^\s+●/.test(l));
    if (failLines.length > 0) {
      parts.push('Failures:');
      failLines.slice(0, 10).forEach(l => parts.push('  ' + l.trim()));
    }
  } else if (domain === 'build') {
    const errorLines = lines.filter(l => /\b(error|Error|ERROR)\b/.test(l));
    parts.push(`Build errors (${errorLines.length}):`);
    errorLines.slice(0, 20).forEach(l => parts.push('  ' + l.trim()));
    parts.push(`exit: ${exitCode}`);
  } else if (domain === 'grep') {
    const paths = new Set();
    lines.forEach(l => {
      const m = l.match(/^([^:]+):\d+:/);
      if (m) paths.add(m[1]);
    });
    parts.push(`Matches: ${lineCount} lines | ${paths.size} unique files`);
    Array.from(paths).slice(0, 10).forEach(p => parts.push('  ' + p));
  } else if (domain === 'log') {
    const notable = lines.filter(l => /\b(ERROR|WARN)\b/i.test(l));
    parts.push(`Log: ${lineCount} lines | ${notable.length} ERROR/WARN`);
    notable.slice(0, 20).forEach(l => parts.push('  ' + l.trim()));
  } else {
    // raw fallback
    const first = lines.slice(0, 15);
    const last = lines.slice(-5);
    const omitted = Math.max(0, lineCount - 20);
    first.forEach(l => parts.push(l));
    if (omitted > 0) {
      parts.push(`... (${omitted} lines omitted) ...`);
      last.forEach(l => parts.push(l));
    }
  }

  // Reliability tail: always append last 10 raw lines (except for raw which already includes them)
  if (domain !== 'raw') {
    parts.push('--- last 10 lines ---');
    lines.slice(-10).forEach(l => parts.push(l));
  }

  return parts.join('\n');
}

/**
 * writeToSandbox(label, command, output, meta) → sandboxPath (the label)
 */
export function writeToSandbox(label, command, output, meta) {
  const dir = join(process.env.HOME || homedir(), '.ijfw', 'session-sandbox');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const safeLabel = sanitizeLabel(label);
  const txtPath = join(dir, `${safeLabel}.txt`);
  const jsonPath = join(dir, `${safeLabel}.json`);

  writeFileSync(txtPath, output, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(jsonPath, JSON.stringify({
    label: safeLabel,
    command,
    timestamp: new Date().toISOString(),
    exitCode: meta.exitCode,
    lines: meta.lines,
    bytes: meta.bytes,
  }), { encoding: 'utf8', mode: 0o600 });

  return safeLabel;
}

/**
 * purgeSandboxOld(maxAgeMs) — deletes .txt + .json pairs older than maxAgeMs.
 * Called on every ijfw_run invocation. Fast (stat+unlink only).
 */
export function purgeSandboxOld(maxAgeMs = 24 * 60 * 60 * 1000) {
  const dir = join(process.env.HOME || homedir(), '.ijfw', 'session-sandbox');
  if (!existsSync(dir)) return;
  const now = Date.now();
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const jsonPath = join(dir, f);
      try {
        const st = statSync(jsonPath);
        if (now - st.mtimeMs > maxAgeMs) {
          const base = f.slice(0, -5); // strip .json
          try { unlinkSync(join(dir, `${base}.txt`)); } catch {}
          try { unlinkSync(jsonPath); } catch {}
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* dir unreadable -- skip */ }
}

/**
 * readFromSandbox(label) → string | null
 */
export function readFromSandbox(label) {
  const safeLabel = sanitizeLabel(label);
  const dir = join(process.env.HOME || homedir(), '.ijfw', 'session-sandbox');
  const txtPath = join(dir, `${safeLabel}.txt`);
  if (!existsSync(txtPath)) return null;
  try {
    return readFileSync(txtPath, 'utf8');
  } catch {
    return null;
  }
}

export { stripAnsi };
