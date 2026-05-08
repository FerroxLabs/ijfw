/**
 * runner-vm.js -- vm.Script JS-only path for the compute runner.
 *
 * Enabled via vmOnly=true (or IJFW_COMPUTE_VM_ONLY=1 at runner level).
 * Per V3-F6 enumerated bans:
 *   - codeGeneration.strings = false   -> disables string-to-code (the dynamic
 *                                         code-generation primitive) plus the
 *                                         Function constructor
 *   - codeGeneration.wasm    = false   -> disables WebAssembly.instantiate*
 *   - context prototype frozen          -> defends against prototype pollution
 *   - dynamic import() not exposed      -> not configured -> throws at parse
 *   - Atomics / SharedArrayBuffer / WebAssembly -> seeded as undefined at
 *     vm.createContext() so the keys exist on globalThis but evaluate to
 *     undefined. This is a best-effort drop; V8 may re-expose intrinsics in
 *     some builds, in which case the OS-level sandbox is the actual security
 *     boundary. See "Honest framing" below.
 *   - setTimeout / setImmediate / setInterval -> not exposed; vm.Script has
 *     no separate event loop, so async-timer-escape is impossible
 *   - vm.Script's native `timeout` option enforces hard wall-clock kill
 *
 * The script gets `console.log` / `console.error` only. stdout is captured
 * and returned. Errors are surfaced as throw -- never swallowed.
 *
 * Honest framing: vm.Script is a Node-internal isolation primitive, NOT a
 * security boundary by Node's own docs. We pair it with the OS-level sandbox
 * applied to the parent process for defense in depth. This file is the
 * deterministic, JS-only fast-path; if you need true isolation, prefer the
 * subprocess sandbox in runner.js.
 *
 * V3-F6 honesty downgrade (1.3.0-alpha.1):
 *   Function/eval/import/prototype: blocked.
 *   Atomics/SAB/WebAssembly: best-effort dropped at context-creation. If a
 *   future Node/V8 release re-exposes them via host realm intrinsics, the
 *   subprocess+OS sandbox path remains the enforced security boundary.
 *
 * Zero external deps.
 */

import vm from 'vm';

export class VmOnlyJsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VmOnlyJsError';
    this.code = 'VM_ONLY_JS_ONLY';
  }
}

export class VmTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VmTimeoutError';
    this.code = 'VM_TIMEOUT';
  }
}

const HARD_CAP_MS = 300_000;
const DEFAULT_MS = 30_000;

/**
 * runVm({ script, timeoutMs, projectRoot })
 *  -> { stdout, durationMs, timedOut: false }
 *
 * Throws on script error (with original error attached) or VmTimeoutError on
 * wall-clock timeout.
 */
export function runVm({ script, timeoutMs, projectRoot } = {}) {
  if (typeof script !== 'string' || script.length === 0) {
    throw new TypeError('runVm: `script` must be a non-empty string');
  }
  // Deliberately ignore projectRoot here -- vm.Script has no FS access by
  // design. The parameter exists for parity with the subprocess runner so
  // the caller doesn't need a separate code path.
  void projectRoot;

  const timeout = clampTimeout(timeoutMs);
  const start = Date.now();

  // Capture buffers -- console.log writes here; we never expose process.stdout.
  const stdoutChunks = [];
  const stderrChunks = [];

  const safeConsole = Object.freeze({
    log:   (...a) => stdoutChunks.push(stringify(a)),
    error: (...a) => stderrChunks.push(stringify(a)),
    warn:  (...a) => stderrChunks.push(stringify(a)),
    info:  (...a) => stdoutChunks.push(stringify(a)),
    debug: () => {},
  });

  // Build a context with NO ambient capabilities. Note: `vm.createContext`
  // assigns the passed object to be the context's globalThis -- we only put
  // `console` on it. No setTimeout, no fetch, no process, no require, no
  // import.meta. We seed Atomics / SharedArrayBuffer / WebAssembly as
  // explicit `undefined` keys at context creation so they're not exposed
  // from the host realm intrinsics. (Per V3-F6 honesty note: this is
  // best-effort. V8 may re-expose them in some builds.)
  const sandbox = {
    console: safeConsole,
    Atomics: undefined,
    SharedArrayBuffer: undefined,
    WebAssembly: undefined,
  };
  const context = vm.createContext(sandbox, {
    name: 'ijfw-compute-vm',
    codeGeneration: { strings: false, wasm: false },
  });

  // V3-F6: freeze the prototype chain visible inside the context. Atomics /
  // SAB / WebAssembly are dropped at context-creation above (not via post-hoc
  // delete), so the freeze prelude only handles prototype pollution defence.
  const freezePrelude = `
    Object.freeze(Object.prototype);
    Object.freeze(Array.prototype);
    Object.freeze(Function.prototype);
    Object.freeze(String.prototype);
    Object.freeze(Number.prototype);
    Object.freeze(Boolean.prototype);
    Object.freeze(Object);
    Object.freeze(Array);
  `;
  try {
    vm.runInContext(freezePrelude, context, { timeout: preludeTimeout() });
  } catch (e) {
    // Freezing fails if the host is exotic; surface honestly rather than
    // continuing under a false-pretence frozen context.
    throw new Error(
      `[ijfw compute] vm prelude (prototype freeze) failed: ${e && e.message}. ` +
      'Refusing to run untrusted code in an unfrozen context.'
    );
  }

  let result;
  try {
    const compiled = new vm.Script(script, { filename: 'ijfw-compute.js' });
    result = compiled.runInContext(context, { timeout, displayErrors: true });
  } catch (e) {
    // vm's timeout surfaces as an Error with code 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    // on modern Node. Match by code when available, fall back to message.
    if (e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /Script execution timed out/.test(String(e.message)))) {
      throw new VmTimeoutError(
        `[ijfw compute] vm.Script timed out after ${timeout}ms.`
      );
    }
    throw e;
  } finally {
    void result;
  }

  const stdout = stdoutChunks.join('\n');
  const stderr = stderrChunks.join('\n');
  return {
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut: false,
  };
}

function clampTimeout(t) {
  const fromEnv = Number(process.env.IJFW_COMPUTE_TIMEOUT_MS || 0);
  let ms = Number(t || 0) || fromEnv || DEFAULT_MS;
  if (!Number.isFinite(ms) || ms <= 0) ms = DEFAULT_MS;
  if (ms > HARD_CAP_MS) ms = HARD_CAP_MS;
  return Math.floor(ms);
}

// L4: configurable freeze-prelude timeout. Default 5000ms (was 1000ms);
// override via IJFW_COMPUTE_VM_PRELUDE_TIMEOUT_MS for high-load hosts.
const PRELUDE_DEFAULT_MS = 5_000;
function preludeTimeout() {
  const v = Number(process.env.IJFW_COMPUTE_VM_PRELUDE_TIMEOUT_MS || 0);
  if (!Number.isFinite(v) || v <= 0) return PRELUDE_DEFAULT_MS;
  return Math.min(Math.floor(v), HARD_CAP_MS);
}

// Stringify args in a console.log-like way without inheriting host globals.
function stringify(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
}
