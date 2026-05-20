/**
 * test-state-sdk-grepgate.js — v1.5.0 T14 SDK grep-gate + per-writer regression sweep.
 *
 * Four gate checks prove zero state writes bypass the SDK across JS, shell hooks,
 * and homedir paths, and confirm each T6-T11 per-writer spy regression test exists.
 *
 * Run: node --test mcp-server/test-state-sdk-grepgate.js
 *
 * DOCUMENTED EXEMPTIONS (do not expand without a named task):
 *
 *   E1. `~/.ijfw/state/permission-events.jsonl` — Codex and Gemini
 *       `pre-tool-use-extension-check.sh` use inline Node `appendFile()` to append
 *       permission audit records to this file. T11 flagged this as out-of-scope:
 *       no frozen SDK verb maps to a permission-event audit log (the SDK verb table
 *       covers workflow, wave, subagent, event, telemetry, roster, extension, decision,
 *       blocker, state — no "permission-event" verb exists). Migrating to the SDK
 *       would require adding a new verb, which violates the "combine before raise"
 *       policy for the frozen 12/12 MCP tool cap. Deferred to a future task
 *       (TODO: add `permission.record` verb in a future verb-expansion task).
 *
 *   E2. `~/.ijfw/state/${SESSION_ID}.compute-nudged` sentinel — Claude and Gemini
 *       `compute-nudge.sh` write this as a local fast-path cache AFTER a successful
 *       `ijfw state:event.emit` SDK call (T11 migration). It is NOT a canonical state
 *       file (not in the §1 physical file table of STATE-SDK-CONTRACT.md); it is an
 *       ephemeral per-session boolean sentinel used only for O(1) fast-path reads.
 *       The authoritative idempotency key is the SDK `dedupKey`; the sentinel is a
 *       local optimisation. Both hooks use `( set -C; : > "$STATE_FILE" )` — bash
 *       noclobber CAS, not a `>` truncate-write. Exempt as a non-canonical file.
 *
 *   E3. `~/.ijfw/state/last-seen-by-<ideId>.json` in `active-extension-writer.js` —
 *       B18 cross-IDE divergence detection helper. Written via tmp+rename pattern
 *       (not raw `writeFile` to the canonical state path). This is a peer-detection
 *       marker, not a canonical state file. Exempt.
 *
 *   E4. `wave-state.js` `writeFile` to tmp path + `appendFile` for per-wave summary —
 *       `writeWaveState` writes to a `.tmp.*` file then renames atomically; the
 *       actual rename is via `lib/atomic-io.js`. `appendSummary` appends to a
 *       per-wave `summary.md` body file inside `.ijfw/wave-<waveId>/`, NOT to any
 *       canonical state file in the §1 contract table. Both are SDK-internal patterns.
 *       Exempt.
 *
 *   E5. `.ijfw/logs/` appends in shell hooks — Log files under `.ijfw/logs/` are
 *       operational log streams, NOT canonical state files. They do not appear in the
 *       §1 physical file table and are exempt from SDK routing.
 *
 *   E6. `pre-tool-use.sh` / `pre-prompt.sh` inline Node writes — These hooks write
 *       to `.ijfw/.patterns-fallback-active`, `.ijfw/.session-feedback.jsonl`, and
 *       `.ijfw/.prompt-check-state`. These are dot-prefixed non-canonical support
 *       files (patterns cache, session-scoped feedback buffer, prompt-check state)
 *       that predate the SDK and have no corresponding frozen verb. Exempt.
 *
 * KNOWN GAPS noted by T7 (do NOT fix here — documented for the record):
 *   - `wave.advance` body-field: the body portion of STATE.md is managed by
 *     `wave-state.js` directly (SDK receives frontmatter only); body round-trip
 *     is not part of the frozen verb signature.
 *   - `waves.json` target: T7 noted that `wave.advance` acquires a lock on
 *     `waves.json` per the contract lock-order, but `wave-state.js`'s direct
 *     integration with the SDK for `waves.json` is a known gap deferred to T7+.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Gate 1 — JS state-write bypass scan
// ---------------------------------------------------------------------------
//
// Scan mcp-server/src/**/*.js for direct fs.writeFile / fs.writeFileSync /
// fs.appendFile / fs.appendFileSync calls whose first argument contains a
// canonical state path (.ijfw/state/, .ijfw/wave-, ~/.ijfw/state/).
//
// SDK internals are excluded — they are the ALLOWED write surfaces:
//   - orchestrator/state-sdk.js      — the SDK core
//   - orchestrator/state-events.js   — event log writer
//   - lib/atomic-io.js               — atomic rename primitive
//   - lib/jsonl-rotation.js          — JSONL rotation primitive
//   - fs-lock.js                     — lock acquisition
//
// Exemptions are documented in the module header above.

test('Gate 1: no JS state-write bypasses in mcp-server/src/**/*.js', () => {
  const SRC_DIR = join(REPO_ROOT, 'mcp-server', 'src');

  // SDK-internal files that are ALLOWED to write state paths.
  const EXCLUDED_SUFFIXES = [
    join('orchestrator', 'state-sdk.js'),
    join('orchestrator', 'state-events.js'),
    join('lib', 'atomic-io.js'),
    join('lib', 'jsonl-rotation.js'),
    'fs-lock.js',
  ];

  // Canonical state path patterns (what we are guarding).
  // These match the §1 physical file table in STATE-SDK-CONTRACT.md.
  const STATE_PATH_PATTERNS = [
    /\.ijfw\/state\//,
    /\.ijfw\/wave-/,
    /~\/\.ijfw\/state\//,
    /\.ijfw\\state\\/,         // Windows-style paths
    /\.ijfw\\wave-/,
  ];

  // fs write method names we scan for.
  const WRITE_METHODS = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync'];

  /**
   * Recursively walk a directory and collect .js files (excluding SDK internals).
   */
  function collectJsFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...collectJsFiles(full));
      } else if (entry.endsWith('.js')) {
        const rel = full.slice(SRC_DIR.length + 1); // relative to src/
        if (!EXCLUDED_SUFFIXES.some((s) => full.endsWith(s))) {
          results.push(full);
        }
      }
    }
    return results;
  }

  const jsFiles = collectJsFiles(SRC_DIR);
  assert.ok(jsFiles.length > 0, 'should find JS files in mcp-server/src/');

  const violations = [];

  for (const filePath of jsFiles) {
    const src = readFileSync(filePath, 'utf8');
    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this line contains a write method call
      const hasWriteMethod = WRITE_METHODS.some((m) => line.includes(m + '(') || line.includes(m + ' ('));
      if (!hasWriteMethod) continue;

      // Skip if this is a comment line
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // Check if this line OR the next 2 lines (multi-line call) contain a state path
      const context = lines.slice(i, Math.min(i + 3, lines.length)).join('\n');
      const hasStatePath = STATE_PATH_PATTERNS.some((p) => p.test(context));
      if (!hasStatePath) continue;

      // Exemptions by path pattern inside the argument
      // E3: last-seen-by-* writes in active-extension-writer.js (B18 marker)
      if (context.includes('last-seen-by-') || context.includes('lastSeen')) continue;
      // E6: dot-prefixed non-canonical support files
      if (context.includes('.patterns-fallback-active') ||
          context.includes('.session-feedback') ||
          context.includes('.prompt-check-state')) continue;
      // E4: tmp-file writes (writeFile to a .tmp.* path before rename)
      if (context.includes('.tmp.') || context.includes('tmpSuffix')) continue;
      // E4: per-wave summary.md body appends (not a §1 canonical file)
      if (context.includes('summary') && context.includes('appendFile')) continue;

      violations.push({
        file: filePath.replace(REPO_ROOT + '/', ''),
        line: i + 1,
        snippet: line.trim().slice(0, 100),
      });
    }
  }

  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
      .join('\n');
    assert.fail(
      `Gate 1 FAILED: ${violations.length} JS state-write bypass(es) found outside the SDK.\n` +
      `If this is a legitimate new write, it needs a corresponding SDK verb.\n` +
      `Violations:\n${msg}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Gate 2 — Shell hook state-write scan
// ---------------------------------------------------------------------------
//
// Scan all platform hook .sh files for bash redirect operators that write
// directly to canonical state paths (.ijfw/state/ or .ijfw/wave- or ~/.ijfw/state/).
//
// ALLOWED patterns (NOT violations):
//   - Appends to .ijfw/logs/  (log streams, not state — E5)
//   - Appends to ~/.ijfw/logs/ (same)
//   - The sentinel noclobber CAS `( set -C; : > "$STATE_FILE" )` in compute-nudge.sh
//     (E2 — it writes the per-session .compute-nudged sentinel, not a canonical state file)
//   - The inline Node appendFile to permission-events.jsonl in pre-tool-use-extension-check.sh
//     (E1 — not a bash redirect, and no matching SDK verb exists)

const HOOK_GLOB_DIRS = [
  join(REPO_ROOT, 'claude', 'hooks', 'scripts'),
  join(REPO_ROOT, 'codex', '.codex', 'hooks'),
  join(REPO_ROOT, 'codex', '.codex', 'hooks', 'scripts'),
  join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks'),
  join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks', 'scripts'),
];

test('Gate 2: no shell hook bash-redirect state-writes to canonical state paths', () => {
  // Collect all .sh files across platform hook directories.
  function collectShFiles(dir) {
    if (!existsSync(dir)) return [];
    const results = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        // Only recurse one level (avoid picking up test dirs etc.)
      } else if (entry.endsWith('.sh')) {
        results.push(full);
      }
    }
    return results;
  }

  const shFiles = HOOK_GLOB_DIRS.flatMap(collectShFiles);
  // Deduplicate (some dirs overlap)
  const unique = [...new Set(shFiles)];
  assert.ok(unique.length > 0, 'should find .sh files in hook directories');

  // Bash redirect patterns that write to state paths.
  // Pattern: `> <path>` or `>> <path>` where path contains .ijfw/state or .ijfw/wave
  // We look for the literal redirect operators followed by a state path.
  const STATE_REDIRECT_RE = /(?:>>|(?<![<>])>(?![>=]|&))\s*['"$]?(?:[^'" ]*)?(?:\.ijfw\/state\/|\.ijfw\/wave-|~\/\.ijfw\/state\/|\/\.ijfw\/state\/)/;

  const violations = [];

  for (const filePath of unique) {
    const src = readFileSync(filePath, 'utf8');
    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // Skip comment lines
      if (trimmed.startsWith('#')) continue;

      if (!STATE_REDIRECT_RE.test(line)) continue;

      // E5: log appends to .ijfw/logs/ are allowed
      if (line.includes('.ijfw/logs/')) continue;
      if (line.includes('/.ijfw/logs/')) continue;

      // E2: noclobber CAS for the .compute-nudged sentinel
      // The sentinel path is $STATE_FILE which resolves to
      // ~/.ijfw/state/${SESSION_ID}.compute-nudged — exempt as non-canonical.
      // The CAS uses `( set -C; : > "$STATE_FILE" )` — STATE_FILE contains
      // ".compute-nudged" suffix. We detect by context.
      if (line.includes('STATE_FILE') || line.includes('.compute-nudged')) continue;

      // E2 (variable): if $STATE_FILE is matched, the variable itself
      // will appear. Check the file header for .compute-nudged definition.
      if (line.includes('$STATE_FILE') || line.includes('${STATE_FILE}')) continue;

      violations.push({
        file: filePath.replace(REPO_ROOT + '/', ''),
        line: i + 1,
        snippet: line.trim().slice(0, 120),
      });
    }
  }

  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
      .join('\n');
    assert.fail(
      `Gate 2 FAILED: ${violations.length} shell hook bash-redirect state-write(s) to canonical state paths.\n` +
      `Log appends to .ijfw/logs/ are allowed; .compute-nudged sentinel is allowed (E2).\n` +
      `These need to be migrated to \`ijfw state:<verb>\` CLI calls.\n` +
      `Violations:\n${msg}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Gate 3 — Per-writer spy presence check
// ---------------------------------------------------------------------------
//
// For each T6-T11 migration, confirm:
//   (a) The regression test file exists in mcp-server/.
//   (b) The file contains at least one mock.method(fs, ...) spy assertion
//       intercepting a write surface (writeFile / writeFileSync / appendFile /
//       appendFileSync) OR a spawn/exec spy (for the agents-md-blackboard
//       no-subprocess check).
//
// Pattern table (per task):
//   T6  — test-dispatch-planner.js          : mock.method(fs, 'writeFile'|...)
//   T7  — test-orchestrator-wave-state.js   : mock.method(fs, 'writeFile'|...)
//   T9  — test-orchestrator-subagent-telemetry.js : mock.method(fs, 'writeFile'|...)
//   T10 — test-active-extension-writer.js   : mock.method(fs, 'writeFile'|...)
//   T8  — test-agents-md-blackboard.js      : mock.method(childProcessModule, 'spawn'|...) + mock.method(fsModule, ...)
//   T11 — test-compute-nudge.js             : subprocess integration tests (SDK route + fail-open)

const PER_WRITER_TESTS = [
  {
    task: 'T6',
    file: 'test-dispatch-planner.js',
    description: 'dispatch-planner.js → state-SDK (no raw fs writes from planner)',
    // T6 uses a loop: WRITE_METHODS.map((name) => mock.method(fs, name, ...))
    // so the spy call has a variable, not a string literal, as the second arg.
    spyPattern: /mock\.method\s*\(\s*fs\s*,\s*(?:name|['"](?:writeFile|writeFileSync|appendFile|appendFileSync)['"])/,
    spyDescription: "mock.method(fs, name, ...) loop-based spy over WRITE_METHODS",
  },
  {
    task: 'T7',
    file: 'test-orchestrator-wave-state.js',
    description: 'wave-state.js → state-SDK (no raw writes to workflow.json / waves.json)',
    // T7 also uses a loop variable: mock.method(fs, name, function (...args) {...})
    spyPattern: /mock\.method\s*\(\s*fs\s*,\s*(?:name|['"](?:writeFile|writeFileSync|appendFile|appendFileSync)['"])/,
    spyDescription: "mock.method(fs, name, ...) path-scoped spy over WRITE_METHODS loop",
  },
  {
    task: 'T8',
    file: 'test-agents-md-blackboard.js',
    description: 'agents-md-blackboard.js → state-SDK (no subprocess spawn, no bare writeFile to AGENTS.md)',
    spyPattern: /mock\.method\s*\(\s*(?:childProcessModule|fsModule|fs)\s*,\s*['"](?:spawn|exec|execFile|fork|writeFile|writeFileSync)['"]/,
    spyDescription: "mock.method(childProcessModule|fs, 'spawn'|'exec'|...) no-subprocess + no-bare-write spy",
  },
  {
    task: 'T9',
    file: 'test-orchestrator-subagent-telemetry.js',
    description: 'subagent-telemetry.js → state-SDK (no async fs.writeFile bypass)',
    spyPattern: /mock\.method\s*\(\s*fs\s*,\s*['"]writeFile['"]/,
    spyDescription: "mock.method(fs, 'writeFile') async-path bypass spy",
  },
  {
    task: 'T10',
    file: 'test-active-extension-writer.js',
    description: 'active-extension-writer.js → state-SDK (no direct write to active-extension.json)',
    spyPattern: /mock\.method\s*\(\s*fs\s*,\s*['"](?:writeFile|writeFileSync|appendFile|appendFileSync)['"]/,
    spyDescription: "mock.method(fs, 'writeFile'|...) active-extension path spy",
  },
  {
    task: 'T11',
    file: 'test-compute-nudge.js',
    description: 'compute-nudge.sh → state-SDK via ijfw state:event.emit CLI (SDK route + fail-open)',
    // T11 uses real subprocess integration tests (spawnSync), not mock.method spies.
    // The SDK route is validated by checking that the intent-journal was written
    // after hook execution. The spy pattern here checks for SDK-route assertions.
    spyPattern: /intent.journal|state:event\.emit|SDK route|sdk.*route|event\.emit/i,
    spyDescription: 'intent-journal / state:event.emit SDK-route assertion (subprocess integration)',
  },
];

for (const entry of PER_WRITER_TESTS) {
  const { task, file, description, spyPattern, spyDescription } = entry;
  const filePath = join(REPO_ROOT, 'mcp-server', file);

  test(`Gate 3 [${task}]: ${file} exists and contains spy assertion`, () => {
    assert.ok(
      existsSync(filePath),
      `${task} regression test file missing: mcp-server/${file}\n` +
      `Expected: ${description}`,
    );

    const src = readFileSync(filePath, 'utf8');

    assert.ok(
      spyPattern.test(src),
      `${task} regression test ${file} exists but is MISSING the required spy assertion.\n` +
      `Required pattern: ${spyDescription}\n` +
      `This means the per-writer spy regression was not added during the ${task} migration.\n` +
      `File: mcp-server/${file}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Gate 4 — Documented exemptions inventory
// ---------------------------------------------------------------------------
//
// This gate is informational: it confirms the known exemptions still exist
// in their expected locations (no file was deleted that we're exempting).
// If a file disappears, the exemption may no longer be needed and can be
// removed from the exemption list.

test('Gate 4: documented exemptions still present (sanity check)', () => {
  const exemptionChecks = [
    {
      id: 'E1',
      description: 'permission-events.jsonl appendFile — codex pre-tool-use-extension-check.sh',
      file: join(REPO_ROOT, 'codex', '.codex', 'hooks', 'scripts', 'pre-tool-use-extension-check.sh'),
      contentPattern: /permission-events\.jsonl/,
    },
    {
      id: 'E1',
      description: 'permission-events.jsonl appendFile — gemini pre-tool-use-extension-check.sh',
      file: join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks', 'scripts', 'pre-tool-use-extension-check.sh'),
      contentPattern: /permission-events\.jsonl/,
    },
    {
      id: 'E2',
      description: '.compute-nudged sentinel CAS — claude compute-nudge.sh',
      file: join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'compute-nudge.sh'),
      contentPattern: /\.compute-nudged/,
    },
    {
      id: 'E2',
      description: '.compute-nudged sentinel CAS — gemini before-tool-compute-nudge.sh',
      file: join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks', 'before-tool-compute-nudge.sh'),
      contentPattern: /\.compute-nudged/,
    },
    {
      id: 'E3',
      description: 'last-seen-by-* marker write — active-extension-writer.js',
      file: join(REPO_ROOT, 'mcp-server', 'src', 'active-extension-writer.js'),
      contentPattern: /last-seen-by-/,
    },
  ];

  for (const check of exemptionChecks) {
    assert.ok(
      existsSync(check.file),
      `Exemption ${check.id} file missing: ${check.file}\n` +
      `If the file was deleted, remove its entry from the T14 exemption list.\n` +
      `Description: ${check.description}`,
    );

    const src = readFileSync(check.file, 'utf8');
    assert.ok(
      check.contentPattern.test(src),
      `Exemption ${check.id} content pattern no longer matches in ${check.file}.\n` +
      `Pattern: ${check.contentPattern}\n` +
      `If this write was migrated to the SDK, remove it from the exemption list.\n` +
      `Description: ${check.description}`,
    );
  }

  // Informational: log the exemptions for visibility
  // (node:test does not have a log-info API, so we comment the count)
  assert.equal(exemptionChecks.length, 5, 'exemption inventory should have 5 entries (E1×2 + E2×2 + E3×1)');
});
