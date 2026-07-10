#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- A3 cold-scan runner.
//
// Tiny CLI adapter so the installer + hooks can spawn the detector as a
// detached child. Reads --project-root, runs detect() + writeProjectType(),
// exits 0 on completion. Any throw is swallowed so a broken scan never
// surfaces a non-zero exit to the parent installer / hook.
//
// Usage:
//   node cold-scan-runner.mjs --project-root <path> [--no-c9] [--max-files N]

import { detect, writeProjectType } from './project-type-detector.js';
import { shouldSeedProject } from './brain/seed-gate.js';
import { isBundleInternalDeep } from './lib/project-root-guard.js';

const argv = process.argv.slice(2);
const opts = { projectRoot: null, c9Available: true, maxFiles: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project-root') opts.projectRoot = argv[++i];
  else if (a === '--no-c9') opts.c9Available = false;
  else if (a === '--max-files') opts.maxFiles = Number(argv[++i]);
}

if (!opts.projectRoot) process.exit(0);

// issue #26 — seed-gate + bundle guard at the JS chokepoint. The bash trigger
// (cold-scan-trigger.sh) already sources seed-gate.sh, but the installer and
// programmatic callers spawn THIS runner directly, bypassing that wrapper. So
// materializing .ijfw/project.type here into a marker-less dir, $HOME, a
// signed app bundle, or an attacker-chosen IJFW_PROJECT_DIR regressed the
// issue-#16 privacy fix and the wayland#755 bundle protection. isBundleInternalDeep
// catches a bundle that happens to carry a marker (e.g. an Electron app's
// package.json); shouldSeedProject enforces the real-project / homedir rule.
if (isBundleInternalDeep(opts.projectRoot) || !shouldSeedProject(opts.projectRoot)) {
  process.exit(0);
}

try {
  const result = detect(opts.projectRoot, {
    c9Available: opts.c9Available,
    maxFiles: opts.maxFiles || undefined,
    sessionId: process.env.IJFW_SESSION_ID || null,
  });
  writeProjectType(opts.projectRoot, result);
  process.exit(0);
} catch {
  // Cold scan is best-effort. The hoist treats a missing project.type as
  // "silent skip", so failing here only delays detection to the next session.
  process.exit(0);
}
