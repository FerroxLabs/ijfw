// Gate: design-pass -- warn if UI files changed without a recent design pass.
//
// STATUS (v1.5.1 R4-LOW): DRAFT / NOT WIRED. This gate file is complete and
// passes its own unit test, but it is NOT registered in the preflight runner.
// `preflight.js` imports a fixed 11-gate list (shellcheck..upgrade-smoke) and
// there is no config-driven gate loading -- so "enable in preflight-versions.json"
// is NOT yet a real path. To activate this as a 12th gate, import it in
// preflight.js, push it onto the `gates` array, and update the gate-count refs
// in the help text + docs. Until then it is a future gate, kept here as a draft.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const UI_PATTERNS = /\.(html|css|jsx|tsx|vue|svelte)$|\/components\//;

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();

  // Detect changed files in working tree vs HEAD
  const git = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    encoding: 'utf8',
    cwd: ctx.repoRoot,
    timeout: 10_000,
  });

  const changedFiles = (git.stdout || '').split('\n').filter(Boolean);
  const uiChanged = changedFiles.filter(f => UI_PATTERNS.test(f));

  if (uiChanged.length === 0) {
    return {
      name: 'design-pass',
      status: 'PASS',
      message: 'design-pass: no UI files changed -- gate skipped',
      details: [],
      durationMs: Date.now() - t0,
    };
  }

  // Check for sentinel
  const sentinelPath = join(ctx.repoRoot, '.ijfw', 'design-pass.json');
  if (!existsSync(sentinelPath)) {
    return {
      name: 'design-pass',
      status: 'WARN',
      message: `design-pass: ${uiChanged.length} UI file(s) changed without a design pass in this session`,
      details: [
        ...uiChanged.slice(0, 5).map(f => `  Changed: ${f}`),
        '  Run: node shared/skills/ijfw-design/scripts/search.js "<goal>" --design-system',
        '  Or:  bash shared/skills/ijfw-design/scripts/design-pass.sh "<goal>" to log the pass',
      ],
      durationMs: Date.now() - t0,
    };
  }

  // Sentinel exists -- check age (warn if > 24h old)
  let sentinel;
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
  } catch {
    sentinel = null;
  }

  if (sentinel && sentinel.ts) {
    const age = Date.now() - new Date(sentinel.ts).getTime();
    const ageHours = age / 3_600_000;
    if (ageHours > 24) {
      return {
        name: 'design-pass',
        status: 'WARN',
        message: `design-pass: design pass is ${Math.round(ageHours)}h old -- consider refreshing`,
        details: [`  Last pass: ${sentinel.ts}  Style: ${sentinel.style || 'unknown'}`],
        durationMs: Date.now() - t0,
      };
    }
  }

  return {
    name: 'design-pass',
    status: 'PASS',
    message: `design-pass: design pass found for ${uiChanged.length} UI file change(s)`,
    details: sentinel ? [`  Style: ${sentinel.style}  Palette: ${sentinel.palette}  Source: ${sentinel.source}`] : [],
    durationMs: Date.now() - t0,
  };
}
