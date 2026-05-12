/**
 * runner.js -- Subprocess sandbox for the IJFW compute lever.
 *
 * Public API:
 *   runCompute({ language, script, projectRoot, timeoutMs, allowNet, vmOnly,
 *                allowedPaths, sessionId })
 *     -> { stdout, stderr, exitCode, signal, durationMs, timedOut, truncated,
 *          logPath, sandbox: { kind, available, degraded } }
 *
 * Behavior summary (V3-B1, V3-B2, V3-B3, V3-F6):
 *   - language must be 'js' or 'python'.
 *   - vmOnly + language='js' -> delegate to runner-vm.js (vm.Script path).
 *     vmOnly + language='python' -> throw VmOnlyJsError.
 *   - Per-invocation temp dir created; subprocess cwd points at it (NOT the
 *     project root by default -- temp dir keeps writes contained even if the
 *     OS-level wrapper is unavailable).
 *   - Env scrubbed to allowlist: PATH, HOME, IJFW_*, NODE_*, LANG, LC_*, TZ.
 *   - spawn(detached=true) so we can SIGKILL the entire process group on
 *     timeout (no orphaned children).
 *   - Hard timeout: timeoutMs param > IJFW_COMPUTE_TIMEOUT_MS env > 30_000ms.
 *     Hard cap: 300_000ms.
 *   - Output cap: 100 MB (truncated to caller; full preserved on disk).
 *   - Network defaults DENY. allowNet=true -> opt-in (set by IJFW_COMPUTE_NET=1
 *     at the caller layer).
 *   - Allowlist filesystem path-prefix check + OS sandbox wrapper:
 *     OS wrapper does the real enforcement. The path-prefix check is only a
 *     warning surface for callers that pass extra allowedPaths.
 *
 * All user-facing strings use "operation" / "task" / "compute" -- never "AI" // copy-lint:allow
 * (Sean's no-AI-in-user-copy rule). // copy-lint:allow
 *
 * Zero external deps.
 */

import { spawn } from 'child_process';
import {
  existsSync, mkdirSync, writeFileSync, appendFileSync,
  realpathSync, rmSync,
} from 'fs';
import { join, isAbsolute, resolve, sep } from 'path';
import { homedir, tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { detectSandbox } from './sandbox-detect.js';
import { runVm, VmOnlyJsError } from './runner-vm.js';
import { resolvePython } from './python-resolver.js';

// --- Constants ----------------------------------------------------------
const HARD_CAP_MS = 300_000;
const DEFAULT_MS = 30_000;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;   // 100 MB
const MAX_RETURNED_BYTES = 1 * 1024 * 1024;   // 1 MB returned to caller
const ENV_ALLOW_PREFIXES = ['IJFW_', 'NODE_'];
const ENV_ALLOW_KEYS = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
]);

// --- Errors -------------------------------------------------------------
export class ComputeLanguageError extends Error {
  constructor(language) {
    super(`[ijfw compute] Unsupported language "${language}". Use 'js' or 'python'.`);
    this.name = 'ComputeLanguageError';
    this.code = 'COMPUTE_BAD_LANGUAGE';
  }
}
export { VmOnlyJsError };

// --- Helpers ------------------------------------------------------------
function clampTimeout(t) {
  const fromEnv = Number(process.env.IJFW_COMPUTE_TIMEOUT_MS || 0);
  let ms = Number(t || 0) || fromEnv || DEFAULT_MS;
  if (!Number.isFinite(ms) || ms <= 0) ms = DEFAULT_MS;
  if (ms > HARD_CAP_MS) ms = HARD_CAP_MS;
  return Math.floor(ms);
}

// M2: env vars to ALWAYS drop even if they match the allow prefix list. These
// expose code-loading or debugging surfaces an untrusted compute child must
// not inherit (e.g. NODE_OPTIONS=--require could load a host module).
const ENV_DENY_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'NODE_PATH',
  'NODE_REPL_HISTORY',
]);

function scrubEnv() {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (ENV_DENY_KEYS.has(k)) continue; // M2: explicit drop list
    if (ENV_ALLOW_KEYS.has(k)) { out[k] = v; continue; }
    if (ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) { out[k] = v; continue; }
  }
  // Always mark as a sandboxed compute run so children can branch behavior.
  out.IJFW_COMPUTE_SANDBOXED = '1';
  return out;
}

function newSessionId() {
  return randomBytes(8).toString('hex');
}

function newRunId() {
  return Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
}

// H1: log-root resolution with a fallback chain so an unwritable HOME does
// not hard-fail the runner. Order:
//   1) IJFW_COMPUTE_LOG_ROOT (explicit override)
//   2) ~/.ijfw/run/<sessionId>/compute
//   3) <projectRoot>/.ijfw/run/<sessionId>/compute
//   4) <os.tmpdir>/ijfw-run/<sessionId>/compute
// Returns { dir, ok } where ok=false signals "log to in-memory buffer only".
function resolveLogDir(sessionId, projectRoot) {
  const candidates = [];
  if (process.env.IJFW_COMPUTE_LOG_ROOT) {
    candidates.push(join(process.env.IJFW_COMPUTE_LOG_ROOT, sessionId, 'compute'));
  }
  candidates.push(join(process.env.HOME || homedir(), '.ijfw', 'run', sessionId, 'compute'));
  if (projectRoot) {
    candidates.push(join(projectRoot, '.ijfw', 'run', sessionId, 'compute'));
  }
  candidates.push(join(tmpdir(), 'ijfw-run', sessionId, 'compute'));

  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Probe write permission with an O_CREAT touch.
      const probe = join(dir, '.write-probe');
      writeFileSync(probe, '', { mode: 0o600 });
      try { rmSync(probe, { force: true }); } catch { /* nothing */ }
      return { dir, ok: true };
    } catch { /* try next */ }
  }
  return { dir: null, ok: false };
}

function canonicalPath(p) {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithin(pathname, root) {
  if (!pathname || !root) return false;
  const child = resolve(pathname);
  const parent = resolve(root);
  return child === parent || child.startsWith(parent + sep);
}

// Normalize caller-supplied write allow-list paths before they reach the OS
// sandbox. Symlinks are resolved first so a project-local link to /tmp or $HOME
// cannot smuggle an outside write root into sandbox-exec/nsjail/bwrap.
function normalizeAllowedPaths({ projectRoot, cwd, allowedPaths }) {
  const warnings = [];
  const safePaths = [];
  const projectReal = projectRoot ? canonicalPath(projectRoot) : null;
  const cwdReal = cwd ? canonicalPath(cwd) : null;

  for (const p of allowedPaths || []) {
    if (!isAbsolute(p)) {
      warnings.push(`allowedPaths entry "${p}" is not absolute -- ignoring.`);
      continue;
    }

    const requested = resolve(p);
    const norm = canonicalPath(requested);
    const inProject = isPathWithin(norm, projectReal);
    const inCwd = isPathWithin(norm, cwdReal);
    if (!inProject && !inCwd) {
      warnings.push(
        `allowedPaths entry "${requested}" resolves outside cwd and projectRoot -- ignoring.`
      );
      continue;
    }
    safePaths.push(norm);
  }

  return { allowedPaths: Array.from(new Set(safePaths)), warnings };
}

function makeTempDir() {
  const root = tmpdir();
  const name = 'ijfw-compute-' + newRunId();
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Truncate buffer to at most `cap` bytes, preserving valid UTF-8 boundary.
function truncateUtf8(buf, cap) {
  if (buf.length <= cap) return { out: buf, truncated: false };
  // Step back if we landed in the middle of a multi-byte UTF-8 sequence.
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { out: buf.subarray(0, end), truncated: true };
}

// --- Public API ---------------------------------------------------------

/**
 * runCompute(opts) -> Promise<result>
 *
 * Required: language, script.
 * Optional: projectRoot (defaults cwd), timeoutMs, allowNet (default false),
 *           vmOnly (default false), allowedPaths, sessionId.
 */
export async function runCompute(opts = {}) {
  const language = (opts.language || '').toLowerCase();
  if (language !== 'js' && language !== 'python') {
    throw new ComputeLanguageError(opts.language);
  }
  const script = String(opts.script || '');
  if (!script) throw new TypeError('runCompute: `script` is required.');

  const projectRoot = resolve(opts.projectRoot || process.cwd());
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const allowNet = !!opts.allowNet;
  const vmOnly = !!opts.vmOnly;
  const sessionId = String(opts.sessionId || newSessionId());

  // vm.Script JS-only path -- short-circuit before spawn.
  if (vmOnly) {
    if (language !== 'js') {
      throw new VmOnlyJsError(
        '[ijfw compute] vmOnly mode supports JavaScript only. ' +
        `Got "${language}". For Python, run without vmOnly to use the subprocess sandbox.`
      );
    }
    const r = runVm({ script, timeoutMs, projectRoot });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: 0,
      signal: null,
      durationMs: r.durationMs,
      timedOut: false,
      truncated: false,
      logPath: null,
      sandbox: { kind: 'vm.Script', available: true, degraded: false },
    };
  }

  // --- Subprocess path ---------------------------------------------------
  const tempDir = makeTempDir();
  const runId = newRunId();
  // H1: never hard-fail on log dir creation. Walk the fallback chain; if
  // every candidate is unwritable, fall back to an in-memory log buffer.
  const logResolution = resolveLogDir(sessionId, projectRoot);
  let logPath = null;
  let logBuffer = null;     // in-memory fallback if disk write fails
  if (logResolution.ok && logResolution.dir) {
    logPath = join(logResolution.dir, `${runId}.log`);
    try {
      writeFileSync(logPath, '', { mode: 0o600 });
    } catch {
      // Last-resort: degrade to memory.
      logPath = null;
      logBuffer = [];
      // Silent on success per IJFW rule -- but a degraded path warrants stderr.
      try { process.stderr.write('[ijfw compute] log path unavailable; using in-memory buffer.\n'); } catch { /* nothing */ }
    }
  } else {
    logBuffer = [];
    try { process.stderr.write('[ijfw compute] no writable log directory; using in-memory buffer.\n'); } catch { /* nothing */ }
  }
  // Wrapper so the rest of the runner can append regardless of mode.
  const writeLog = (chunk) => {
    if (logPath) {
      try { appendFileSync(logPath, chunk); } catch { /* disk full -- skip */ }
    } else if (logBuffer) {
      try { logBuffer.push(typeof chunk === 'string' ? chunk : String(chunk)); } catch { /* nothing */ }
    }
  };

  // Resolve interpreter for the chosen language.
  let baseCmd;
  let baseArgs;
  let scriptPath;
  if (language === 'js') {
    // Run via process.execPath so we always use the same Node we're running on.
    scriptPath = join(tempDir, 'script.js');
    writeFileSync(scriptPath, script, { mode: 0o600 });
    baseCmd = process.execPath;
    baseArgs = ['--no-warnings', scriptPath];
  } else {
    const py = resolvePython(projectRoot); // throws PythonNotFoundError on miss
    scriptPath = join(tempDir, 'script.py');
    writeFileSync(scriptPath, script, { mode: 0o600 });
    baseCmd = py.interpreter;
    baseArgs = ['-I', '-B', scriptPath]; // -I isolated mode, -B no .pyc
  }

  const env = scrubEnv();
  const allowedPathResult = normalizeAllowedPaths({
    projectRoot,
    cwd: tempDir,
    allowedPaths: opts.allowedPaths || [],
  });
  const allowedPaths = allowedPathResult.allowedPaths;
  const pathWarnings = allowedPathResult.warnings;
  for (const w of pathWarnings) {
    writeLog(`[allowlist-warning] ${w}\n`);
  }

  // Apply OS-level sandbox.
  const detect = await detectSandbox();
  let cmd = baseCmd;
  let args = baseArgs;
  let degraded = !detect.available;
  let profilePath = null;

  if (detect.wrapper) {
    const wrapped = detect.wrapper.wrap({
      cmd: baseCmd,
      args: baseArgs,
      env,
      cwd: tempDir,
      allowNet,
      allowedPaths,
      projectRoot,
      tempDir,
      kind: detect.kind,
    });
    cmd = wrapped.cmd;
    args = wrapped.args;
    if (wrapped.profilePath) profilePath = wrapped.profilePath;
    if (wrapped.degraded) degraded = true;
  }

  if (degraded) {
    writeLog(
      `[ijfw compute] Sandbox is best-effort on this host -- subprocess runs ` +
      `with scrubbed env + path-prefix check only. See sandbox-detect.js.\n`
    );
  }

  // Spawn -- detached:true so we own the process group for SIGKILL on timeout.
  const start = Date.now();
  let timedOut = false;
  let totalBytes = 0;
  let truncated = false;
  const returnedChunks = [];

  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      cwd: tempDir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    const stderrChunks = [];

    const onData = (chunk, isErr) => {
      // Always preserve full output to disk up to MAX_OUTPUT_BYTES.
      writeLog(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ }
        return;
      }
      if (returnedChunks.reduce((n, c) => n + c.length, 0) < MAX_RETURNED_BYTES) {
        if (isErr) stderrChunks.push(chunk);
        else returnedChunks.push(chunk);
      }
    };

    child.stdout.on('data', (c) => onData(c, false));
    child.stderr.on('data', (c) => onData(c, true));

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the entire process group so children/grandchildren go too.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch {
        // Group might already be gone or detach may have failed; fall back.
        try { child.kill('SIGKILL'); } catch { /* nothing more to do */ }
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolveP({
        stdout: '',
        stderr: `spawn error: ${err && err.message}`,
        exitCode: 1,
        signal: null,
        durationMs: Date.now() - start,
        timedOut: false,
        truncated: false,
        logPath,
        sandbox: {
          kind: detect.kind,
          available: detect.available,
          degraded,
        },
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(returnedChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      const stdoutTrunc = truncateUtf8(stdoutBuf, MAX_RETURNED_BYTES);
      const stderrTrunc = truncateUtf8(stderrBuf, MAX_RETURNED_BYTES);
      cleanup();
      resolveP({
        stdout: stdoutTrunc.out.toString('utf8'),
        stderr: stderrTrunc.out.toString('utf8'),
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
        timedOut,
        truncated: truncated || stdoutTrunc.truncated || stderrTrunc.truncated,
        logPath,
        sandbox: {
          kind: detect.kind,
          available: detect.available,
          degraded,
        },
      });
    });

    function cleanup() {
      try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* nothing */ }
      // profilePath lives inside tempDir, rm covers it.
      void profilePath;
    }
  });
}

// Re-export for tests.
export { resolvePython, detectSandbox };
export const __test = { normalizeAllowedPaths };
