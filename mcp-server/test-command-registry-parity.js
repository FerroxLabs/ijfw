// v1.5.1 W3.A.5 — Parity test for installer/src/command-registry.js.
//
// Why this lives in mcp-server/: the test needs to grep the orchestrator
// dispatch source (mcp-server/src/cross-orchestrator-cli.js), and the
// mcp-server already has node --test infrastructure with relative paths.
// Tests run on every `npm test`.
//
// What this enforces:
//   1. Schema integrity (every entry has required fields; aliases unique).
//   2. Tier invariants (primary entries have helpGroup; deprecated have
//      deprecatedReason).
//   3. Dispatch parity (orchestrator-owned active commands have a matching
//      `parsed.cmd === '<name>'` branch, and every dispatch literal maps
//      back to a registry entry — unless it is a synthetic literal like
//      'help' / 'guide' / 'memory-checkpoint' that intentionally diverges
//      from the user-facing command name).
//   4. Delegation parity (the installer no longer contains a literal
//      ORCHESTRATOR_COMMANDS Set; it imports ORCHESTRATOR_COMMAND_NAMES
//      from the registry).
//   5. printHelp() drift (no hardcoded command names in the body — it must
//      derive from the registry).
//   6. Known alias resolution (off → uninstall, cross-audit → cross, etc.)
//   7. Off-bug regression guard (`off` must reach a working uninstall path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  COMMAND_REGISTRY,
  ORCHESTRATOR_COMMAND_NAMES,
  ALL_COMMAND_NAMES,
  findCommand,
} from '../installer/src/command-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_CLI = readFileSync(
  join(__dirname, 'src', 'cross-orchestrator-cli.js'),
  'utf8'
);
const INSTALLER = readFileSync(
  join(__dirname, '..', 'installer', 'src', 'ijfw.js'),
  'utf8'
);

test('schema: every entry has required fields', () => {
  const required = ['name', 'tier', 'owner', 'description', 'aliases', 'since', 'status'];
  for (const e of COMMAND_REGISTRY) {
    for (const f of required) {
      assert.ok(f in e, `entry ${e.name || '<unnamed>'} missing field ${f}`);
    }
    assert.ok(Array.isArray(e.aliases), `entry ${e.name} aliases must be array`);
  }
});

test('schema: primary tier entries have helpGroup', () => {
  for (const e of COMMAND_REGISTRY) {
    if (e.tier === 'primary') {
      assert.ok(
        ['GET STARTED', 'USE IT', 'EXPLORE'].includes(e.helpGroup),
        `primary entry ${e.name} has invalid helpGroup: ${e.helpGroup}`
      );
    }
  }
});

test('schema: deprecated entries have deprecatedReason', () => {
  for (const e of COMMAND_REGISTRY) {
    if (e.status === 'deprecated') {
      assert.ok(
        e.deprecatedReason && e.deprecatedReason.length > 0,
        `deprecated entry ${e.name} missing deprecatedReason`
      );
    }
  }
});

test('schema: no duplicate names or aliases across the registry', () => {
  const seen = new Set();
  for (const e of COMMAND_REGISTRY) {
    const all = [e.name, ...(e.aliases || [])];
    for (const n of all) {
      assert.ok(!seen.has(n), `duplicate name/alias: ${n}`);
      seen.add(n);
    }
  }
});

test('schema: tier values are constrained', () => {
  const allowedTiers = new Set(['primary', 'coordination', 'plumbing', 'pointer-stub']);
  for (const e of COMMAND_REGISTRY) {
    assert.ok(allowedTiers.has(e.tier), `entry ${e.name} has invalid tier: ${e.tier}`);
  }
});

test('schema: owner values are constrained', () => {
  const allowedOwners = new Set(['installer-direct', 'orchestrator']);
  for (const e of COMMAND_REGISTRY) {
    assert.ok(allowedOwners.has(e.owner), `entry ${e.name} has invalid owner: ${e.owner}`);
  }
});

// ---------------------------------------------------------------------------
// Dispatch parity
// ---------------------------------------------------------------------------

test('dispatch: every orchestrator-owned active command has a dispatch branch', () => {
  // The dispatch chain in cross-orchestrator-cli.js routes via
  // `parsed.cmd === '<name>'`. We allow a small set of synthetic
  // command names that intentionally diverge from the user-facing name
  // (e.g. `help` parses to `parsed.cmd === 'guide'`).
  const syntheticAliasMap = new Map([
    // user-facing → synthetic literal used in dispatch
    ['help', 'guide'],
    ['memory', 'memory-checkpoint'],
    ['--purge-receipts', 'purge-receipts'],
  ]);

  for (const e of COMMAND_REGISTRY) {
    if (e.owner !== 'orchestrator' || e.status !== 'active') continue;
    if (e.tier === 'pointer-stub') continue; // dispatched via command-alias

    const candidateLiterals = [
      syntheticAliasMap.get(e.name) || e.name,
      e.name,
    ];
    const patterns = candidateLiterals.flatMap(lit => [
      `parsed.cmd === '${lit}'`,
      `args[0] === '${lit}'`,
    ]);
    const found = patterns.some(v => ORCH_CLI.includes(v));
    assert.ok(
      found,
      `orchestrator dispatch chain missing branch for "${e.name}" (looked for any of: ${patterns.join(' OR ')})`
    );
  }
});

test('dispatch: every parsed.cmd literal in orchestrator maps to a registry entry', () => {
  const dispatchLiterals = [...ORCH_CLI.matchAll(/parsed\.cmd === '([a-z][a-z0-9-]*)'/g)]
    .map(m => m[1]);
  // Synthetic dispatch labels that are NOT user-facing commands.
  const allowedSynthetic = new Set([
    'help',                // orchestrator's own --help (registry has 'help' = installer-direct + 'guide' synthetic)
    'guide',               // synthetic for `ijfw help` (browser/terminal guide rendering)
    'command-alias',       // shared dispatch for all pointer-stub aliases
    'cross-project-audit', // sub-mode of `cross`, not a top-level command
    'memory-checkpoint',   // sub-command of `memory`
    'memory-reindex',      // sub-command of `memory` (R5-1.2 M1/M2 backfill)
    'memory-help',         // optional namespace-level help for `ijfw memory`
    'memory-unknown',      // optional unknown-subcmd handler for `ijfw memory <x>`
    'env',                 // v1.5.2 F6: env-var discoverability verb
    'purge-receipts',      // synthetic literal for the `--purge-receipts` flag-command
    'metrics-benchmark',   // synthetic literal for the `metrics --benchmark` flag-command (W2.H)
    'unknown',             // unknown-command sink
  ]);
  for (const lit of dispatchLiterals) {
    if (allowedSynthetic.has(lit)) continue;
    assert.ok(
      findCommand(lit),
      `dispatch literal '${lit}' has no registry entry (add it to the registry, or to allowedSynthetic if intentional)`
    );
  }
});

// ---------------------------------------------------------------------------
// Delegation parity
// ---------------------------------------------------------------------------

test('delegation: installer no longer contains a literal ORCHESTRATOR_COMMANDS Set', () => {
  // Catch anyone re-introducing a literal Set as a regression. The registry
  // is the single source of truth; the installer must import from it.
  assert.ok(
    !/ORCHESTRATOR_COMMANDS\s*=\s*new\s+Set\s*\(\[/.test(INSTALLER),
    'installer/src/ijfw.js still contains a literal ORCHESTRATOR_COMMANDS Set — must import from command-registry.js'
  );
  assert.ok(
    INSTALLER.includes('ORCHESTRATOR_COMMAND_NAMES'),
    'installer/src/ijfw.js does not import ORCHESTRATOR_COMMAND_NAMES from command-registry.js'
  );
});

test('delegation: every orchestrator-owned command name is in ORCHESTRATOR_COMMAND_NAMES', () => {
  for (const e of COMMAND_REGISTRY) {
    if (e.owner !== 'orchestrator') continue;
    assert.ok(
      ORCHESTRATOR_COMMAND_NAMES.has(e.name),
      `orchestrator-owned command "${e.name}" missing from ORCHESTRATOR_COMMAND_NAMES`
    );
    for (const a of e.aliases || []) {
      assert.ok(
        ORCHESTRATOR_COMMAND_NAMES.has(a),
        `orchestrator-owned alias "${a}" (of ${e.name}) missing from ORCHESTRATOR_COMMAND_NAMES`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// printHelp drift detection
// ---------------------------------------------------------------------------

test('help: printHelp() does not inline literal primary-command names', () => {
  // A registry-driven printHelp must derive its body via primaryCommands().
  // If a regression re-hardcodes commands, the literal "  install     " padding
  // pattern will reappear. This heuristic flags backslash-newline literal
  // command name + description pairs.
  const match = INSTALLER.match(/function printHelp\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, 'printHelp() function not found in installer/src/ijfw.js');
  const body = match[0];
  const primaryNames = ['install', 'uninstall', 'doctor', 'update', 'demo', 'cross', 'dashboard', 'preflight'];
  const inlined = primaryNames.filter(n => new RegExp(`['"\`]\\s*${n}\\s+[A-Z]`).test(body));
  assert.equal(
    inlined.length,
    0,
    `printHelp() contains hardcoded command names: ${inlined.join(', ')} — must read from command-registry`
  );
});

test('help: printCommands() does not inline literal command surface', () => {
  // Same guard for the full-surface helper.
  const match = INSTALLER.match(/function printCommands\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, 'printCommands() function not found');
  const body = match[0];
  // A literal "  install · uninstall · " pattern is the regression signature.
  assert.ok(
    !/install\s*·\s*uninstall\s*·/.test(body),
    'printCommands() contains a hardcoded · separated command list — must derive from commandsByTier()'
  );
});

// ---------------------------------------------------------------------------
// Aliases + off-bug regression guard
// ---------------------------------------------------------------------------

test('aliases: known aliases resolve to canonical entries', () => {
  assert.equal(findCommand('off')?.name, 'uninstall');
  assert.equal(findCommand('cross-audit')?.name, 'cross');
  assert.equal(findCommand('cross-critique')?.name, 'cross');
  assert.equal(findCommand('cross-research')?.name, 'cross');
  assert.equal(findCommand('--version')?.name, 'version');
});

test('off-bug regression: `off` is reachable through installer delegation', () => {
  // The exact v1.5.0 bug: `off` was in the orchestrator dispatch chain but
  // not in the installer's ORCHESTRATOR_COMMANDS Set → delegation never fired.
  // Either it's an alias of an installer-direct command (uninstall) handled
  // inline by the installer, OR it's in ORCHESTRATOR_COMMAND_NAMES. Both
  // are acceptable; both are explicitly verified.
  const offEntry = findCommand('off');
  assert.ok(offEntry, '`off` is not registered as an alias of any command');

  if (offEntry.owner === 'installer-direct') {
    // Installer must special-case it inline before the delegation gate.
    assert.ok(
      /sub === 'off'/.test(INSTALLER),
      'installer/src/ijfw.js does not handle `off` alias inline (regression risk for v1.5.0 off-bug)'
    );
  } else {
    assert.ok(
      ORCHESTRATOR_COMMAND_NAMES.has('off'),
      '`off` is owner=orchestrator but missing from ORCHESTRATOR_COMMAND_NAMES'
    );
  }
});

test('alias-help: every pointer-stub entry has a deprecatedReason used by COMMAND_ALIAS_HELP', () => {
  // The orchestrator now derives COMMAND_ALIAS_HELP from registry entries
  // where tier === 'pointer-stub'. Each one must have a usable
  // deprecatedReason string (the body that gets printed to the user).
  const stubs = COMMAND_REGISTRY.filter(e => e.tier === 'pointer-stub');
  assert.ok(stubs.length > 0, 'expected at least one pointer-stub entry in the registry');
  for (const e of stubs) {
    assert.ok(
      typeof e.deprecatedReason === 'string' && e.deprecatedReason.length > 10,
      `pointer-stub "${e.name}" must have a usable deprecatedReason (got: ${e.deprecatedReason})`
    );
  }
});

test('coverage: ALL_COMMAND_NAMES exposes every name + alias in the registry', () => {
  for (const e of COMMAND_REGISTRY) {
    assert.ok(ALL_COMMAND_NAMES.has(e.name), `ALL_COMMAND_NAMES missing canonical: ${e.name}`);
    for (const a of e.aliases || []) {
      assert.ok(ALL_COMMAND_NAMES.has(a), `ALL_COMMAND_NAMES missing alias: ${a} (of ${e.name})`);
    }
  }
});
