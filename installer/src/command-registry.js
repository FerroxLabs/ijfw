// SINGLE SOURCE OF TRUTH for the ijfw CLI command surface.
//
// Every help block, delegation gate, and parity test reads from here.
// To add a command: append one entry. Run
//   cd mcp-server && node --test test-command-registry-parity.js
// to confirm it's wired in every consumer.
//
// Physical home: installer/src/ (per W3.A design decision §10).
// The orchestrator (mcp-server/src/cross-orchestrator-cli.js) imports
// from this file via a relative path `../../installer/src/command-registry.js`,
// matching the pattern already established by extension-installer.js.

export const COMMAND_REGISTRY = Object.freeze([
  // ---------- TIER 1: PRIMARY (shown in `ijfw --help`) ----------
  {
    name: 'install',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Install IJFW into your AI coding agents',
    aliases: [],
    since: '1.0.0',
    status: 'active',
    helpGroup: 'GET STARTED',
  },
  {
    name: 'uninstall',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Remove IJFW (alias: off)',
    aliases: ['off'],
    since: '1.0.0',
    status: 'active',
    helpGroup: 'GET STARTED',
  },
  {
    name: 'doctor',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Diagnose installation health',
    aliases: [],
    since: '1.0.0',
    status: 'active',
    helpGroup: 'GET STARTED',
  },
  {
    name: 'init',
    tier: 'primary',
    owner: 'orchestrator',
    description: 'Approve the current folder for codebase indexing',
    aliases: [],
    since: '1.6.1',
    status: 'active',
    helpGroup: 'GET STARTED',
  },
  {
    name: 'update',
    tier: 'primary',
    owner: 'orchestrator',
    description: 'Upgrade to the latest IJFW',
    aliases: [],
    since: '1.1.0',
    status: 'active',
    helpGroup: 'GET STARTED',
  },
  {
    name: 'demo',
    tier: 'primary',
    owner: 'orchestrator',
    description: '30-second Trident tour against a sample file',
    aliases: [],
    since: '1.2.0',
    status: 'active',
    helpGroup: 'USE IT',
  },
  {
    name: 'cross',
    tier: 'primary',
    owner: 'orchestrator',
    description: 'Run Trident audit/research/critique on any file',
    aliases: ['cross-audit', 'cross-critique', 'cross-research'],
    since: '1.2.0',
    status: 'active',
    helpGroup: 'USE IT',
  },
  {
    name: 'dashboard',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Start the local observability dashboard',
    aliases: [],
    since: '1.1.0',
    status: 'active',
    helpGroup: 'USE IT',
  },
  {
    name: 'preflight',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Run 11-gate quality pipeline before publishing',
    aliases: [],
    since: '1.0.0',
    status: 'active',
    helpGroup: 'USE IT',
  },
  {
    name: 'help',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Open the full IJFW guide',
    aliases: [],
    since: '1.0.0',
    status: 'active',
    helpGroup: 'EXPLORE',
  },
  {
    name: 'commands',
    tier: 'primary',
    owner: 'installer-direct',
    description: 'Show every command (advanced + coordination)',
    aliases: [],
    since: '1.5.1',
    status: 'active',
    helpGroup: 'EXPLORE',
  },
  {
    name: 'version',
    tier: 'primary',
    owner: 'orchestrator',
    description: 'Show version',
    aliases: ['--version', '-v'],
    since: '1.0.0',
    status: 'active',
    helpGroup: 'EXPLORE',
  },

  // ---------- TIER 2: COORDINATION (shown in `ijfw commands`) ----------
  {
    name: 'pack-hub-extension',
    tier: 'coordination',
    owner: 'installer-direct',
    description: 'Pack the Wayland Hub Extension (zip + SHA-512 + manifest snippet). Used by Wayland\'s prebuild sync.',
    aliases: [],
    since: '1.5.4',
    status: 'active',
    helpGroup: 'BUILD',
  },
  {
    name: 'status',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Show recent cross-audit activity',
    aliases: [],
    since: '1.2.0',
    status: 'active',
  },
  {
    name: 'receipt',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Print a redacted, shareable block from the last Trident run',
    aliases: [],
    since: '1.2.0',
    status: 'active',
  },
  {
    name: 'recover',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Show the latest checkpoint and next recovery step',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'team',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Assemble project agents, charter, and workflow manifest',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'swarm',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Plan artifact-aware parallel work from the team manifest',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'blackboard',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Coordinate project-local swarm state and artifact claims',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'memory',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Memory checkpoint operations (currently: `memory checkpoint <label>`)',
    aliases: [],
    since: '1.3.0',
    status: 'active',
    notes: 'Only `memory checkpoint <label>` subcommand is implemented today. Top-level `ijfw memory` prints help, not "Unknown command".',
  },
  {
    name: 'import',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Pull memory in from another tool (claude-mem, rtk)',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'personalize',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Control the profile-bus learning feature (on|off|status|forget)',
    aliases: [],
    since: '1.6.0',
    status: 'active',
    notes: 'Opt-in injection control. `on`/`off` toggle whether your learned style is added to prompts; `status` shows flags + what was inferred; `forget` deletes inferences. Capture is always local; injection defaults to "ask".',
  },
  {
    name: 'checkpoint',
    tier: 'coordination',
    owner: 'orchestrator',
    description: 'Snapshot swarm/memory state (alias for `memory checkpoint`)',
    aliases: [],
    since: '1.6.0',
    status: 'active',
    notes: 'Thin top-level alias forwarding to `ijfw memory checkpoint <label>`. Added so the documented bare verb routes instead of returning Unknown.',
  },
  {
    name: 'design',
    tier: 'coordination',
    owner: 'installer-direct',
    description: 'Live visual design companion + durable design intelligence',
    aliases: [],
    since: '1.3.0',
    status: 'active',
  },

  // ---------- TIER 3: PLUMBING (hidden by default; surfaced in `ijfw commands`) ----------
  {
    name: 'statusline',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Manage the statusline integration',
    aliases: [],
    since: '1.2.0',
    status: 'active',
  },
  {
    name: 'config',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Inspect or audit IJFW configuration',
    aliases: [],
    since: '1.2.0',
    status: 'active',
  },
  {
    name: 'codex',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Codex-specific helpers (doctor, sync-agents)',
    aliases: [],
    since: '1.3.0',
    status: 'active',
  },
  {
    name: 'extension',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Manage installed IJFW extensions',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'override',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Manage extension overrides',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'insight',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Inspect IJFW insights',
    aliases: [],
    since: '1.4.0',
    status: 'active',
  },
  {
    name: 'ui-review',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Run the visual UI review pipeline against a spec',
    aliases: [],
    since: '1.5.0',
    status: 'active',
  },
  {
    name: 'worktree',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Manage swarm task worktrees (alias for `swarm worktree`)',
    aliases: [],
    since: '1.6.0',
    status: 'active',
    notes: 'Thin top-level alias forwarding to `ijfw swarm worktree …`. Added so the documented bare verb routes instead of returning Unknown.',
  },
  {
    name: '--purge-receipts',
    tier: 'plumbing',
    owner: 'orchestrator',
    description: 'Clear the cross-runs receipt log',
    aliases: [],
    since: '1.2.0',
    status: 'active',
    notes: 'Flag-style command (leading "--"). Registered as a name so parity check picks it up; documented under plumbing.',
  },

  // ---------- DEPRECATED: pointer-stub aliases ----------
  // These commands print "use the <X> skill" guidance and exit.
  // They live behind cross-orchestrator-cli.js COMMAND_ALIAS_HELP (derived from these entries).
  // Decision: keep them as silent redirects -- they have shipped documentation
  // pointing at them, removal is a breaking change.
  // status='deprecated' so help blocks suppress them, but dispatch still handles them.
  {
    name: 'workflow',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to the ijfw-workflow skill',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use the ijfw-workflow skill in agents. Terminal helpers: ijfw team init, ijfw swarm plan, ijfw swarm prepare.',
  },
  {
    name: 'handoff',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to the ijfw-handoff skill',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use the ijfw-handoff skill in agents, or record swarm handoff text with: ijfw blackboard handoff --message "<summary>".',
  },
  {
    name: 'compress',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to the ijfw-compress skill',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use the ijfw-compress skill in agents. Terminal context compression is host-specific and should preserve exact paths, commands, versions, and decisions.',
  },
  {
    name: 'consolidate',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to the ijfw-handoff or ijfw-memory-audit skill',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use the ijfw-handoff or ijfw-memory-audit skill to consolidate decisions into memory. For swarm state, run: ijfw memory checkpoint <label>.',
  },
  {
    name: 'ijfw-audit',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to `ijfw preflight`',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Run verification with: ijfw preflight. For multi-model review, run: ijfw cross audit <target>.',
  },
  {
    name: 'ijfw-execute',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to ijfw-workflow skill + swarm helpers',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use ijfw-workflow in agents, then terminal helpers: ijfw team init, ijfw swarm plan, ijfw swarm prepare, ijfw swarm start <task-id>.',
  },
  {
    name: 'ijfw-help',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to `ijfw help`',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Run: ijfw help. Add --browser for the rendered local guide.',
  },
  {
    name: 'ijfw-plan',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to ijfw-workflow planning skills',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use ijfw-workflow for planning. Terminal helpers: ijfw team init, ijfw swarm plan, ijfw swarm prepare --reviews.',
  },
  {
    name: 'ijfw-ship',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to `ijfw preflight`',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Run: ijfw preflight. Do not publish or tag until your release gate is explicitly cleared.',
  },
  {
    name: 'ijfw-verify',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to `ijfw preflight`',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Run: ijfw preflight. For focused review, run: ijfw cross audit <target>.',
  },
  {
    name: 'memory-audit',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to the ijfw-memory-audit skill',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use the ijfw-memory-audit skill in agents. Terminal safety net: ijfw recover status and ijfw memory checkpoint <label>.',
  },
  {
    name: 'memory-consent',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to memory checkpoint',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use IJFW memory tools only for explicit project memory. Terminal checkpoint: ijfw memory checkpoint <label>.',
  },
  {
    name: 'memory-why',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to ijfw-recall / ijfw-memory-audit skills',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Use ijfw-recall or ijfw-memory-audit in agents to inspect why memory exists. Terminal recovery state: ijfw recover latest.',
  },
  {
    name: 'metrics',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to the dashboard (real subcommand: metrics --benchmark)',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Open the dashboard with: ijfw dashboard start. Agent-side metrics are available through ijfw_metrics. Run the memory benchmark harness with: ijfw metrics --benchmark.',
  },
  {
    name: 'mode',
    tier: 'pointer-stub',
    owner: 'orchestrator',
    description: 'Redirect to `ijfw config --audit`',
    aliases: [],
    since: '1.4.0',
    status: 'deprecated',
    deprecatedReason: 'Inspect configuration with: ijfw config --audit. Statusline mode helpers: ijfw statusline --status, --compose, or --disable.',
  },
]);

// ---------------------------------------------------------------------------
// Derived views -- every consumer reads from these, NOT from literal sets.
// ---------------------------------------------------------------------------

/** Names of every command the orchestrator owns (canonical + aliases).
 *  Replaces the ORCHESTRATOR_COMMANDS literal Set in installer/src/ijfw.js. */
export const ORCHESTRATOR_COMMAND_NAMES = Object.freeze(new Set(
  COMMAND_REGISTRY
    .filter(e => e.owner === 'orchestrator')
    .flatMap(e => [e.name, ...(e.aliases || [])])
));

/** Names of every command the installer process handles directly
 *  (does not delegate to the orchestrator). */
export const INSTALLER_DIRECT_COMMAND_NAMES = Object.freeze(new Set(
  COMMAND_REGISTRY
    .filter(e => e.owner === 'installer-direct')
    .flatMap(e => [e.name, ...(e.aliases || [])])
));

/** All known names, including aliases -- used by parity tests. */
export const ALL_COMMAND_NAMES = Object.freeze(new Set(
  COMMAND_REGISTRY.flatMap(e => [e.name, ...(e.aliases || [])])
));

/** Convenience filter for printHelp() -- primary tier entries only,
 *  excluding deprecated, in the order they appear in the registry. */
export function primaryCommands() {
  return COMMAND_REGISTRY.filter(
    e => e.tier === 'primary' && e.status === 'active'
  );
}

/** All non-deprecated commands grouped by tier -- used by `ijfw commands`. */
export function commandsByTier() {
  const tiers = { primary: [], coordination: [], plumbing: [] };
  for (const e of COMMAND_REGISTRY) {
    if (e.status !== 'active') continue;
    if (tiers[e.tier]) tiers[e.tier].push(e);
  }
  return tiers;
}

/** Lookup by name OR alias. Returns the canonical entry or null. */
export function findCommand(name) {
  for (const e of COMMAND_REGISTRY) {
    if (e.name === name) return e;
    if (e.aliases && e.aliases.includes(name)) return e;
  }
  return null;
}
