/**
 * dispatch/wave-cli.js — IJFW v1.4.4 / N9 wave-status CLI handlers.
 *
 * Frozen export contract (v1.4.3 dispatch module convention):
 *   export const handlers = { '<subcommand>': async (args, ctx) => ({ ok, output?, error? }) };
 *   export const subcommandHelp = { '<subcommand>': 'one-line description' };
 *
 * Subcommands owned by this module:
 *   - wave-status [<id>|latest]
 *   - wave-list
 *
 * Reads via mcp-server/src/orchestrator/wave-state.js (W10-A0). Read-only,
 * snapshot-based per lock-in #31 — no daemon, no subscriptions.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readWaveState } from '../orchestrator/wave-state.js';
import { drainCheckpoints } from '../orchestrator/subagent-telemetry.js';

const WAVE_DIR_PREFIX = 'wave-';

function tokenize(args) {
  if (Array.isArray(args)) return args.filter((x) => x !== undefined && x !== null);
  if (typeof args !== 'string') return [];
  return args.split(/\s+/).filter(Boolean);
}

async function listWaveEntries(projectRoot) {
  const ijfwDir = join(projectRoot, '.ijfw');
  let entries = [];
  try {
    entries = await readdir(ijfwDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const waves = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith(WAVE_DIR_PREFIX)) continue;
    const id = ent.name.slice(WAVE_DIR_PREFIX.length);
    if (!id) continue;
    const dir = join(ijfwDir, ent.name);
    let mtimeMs = 0;
    try {
      const s = await stat(dir);
      mtimeMs = s.mtimeMs;
    } catch {
      // tolerate vanished dirs
    }
    waves.push({ id, dir, mtimeMs });
  }
  return waves;
}

async function resolveLatestWaveId(projectRoot) {
  const waves = await listWaveEntries(projectRoot);
  if (waves.length === 0) return null;
  waves.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return waves[0].id;
}

function renderStateForTerminal({ waveId, frontmatter, body }) {
  const lines = [];
  lines.push(`Wave: ${waveId}`);
  for (const [key, val] of Object.entries(frontmatter || {})) {
    if (key === 'wave_id') continue;
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(', ')}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  if (body && body.trim()) {
    lines.push('');
    lines.push('--- notes ---');
    lines.push(body.trim());
  }
  return lines.join('\n');
}

export const handlers = {
  'wave-status': async (args, ctx) => {
    const tokens = tokenize(args);
    const projectRoot = (ctx && ctx.projectRoot) || process.cwd();
    let waveId = tokens[0];
    if (!waveId || waveId === 'latest') {
      waveId = await resolveLatestWaveId(projectRoot);
      if (!waveId) {
        return { ok: false, output: 'No waves found in .ijfw/wave-*/' };
      }
    }
    const state = await readWaveState(waveId, projectRoot);
    if (!state) {
      return { ok: false, output: `Wave ${waveId} not found` };
    }
    return {
      ok: true,
      output: renderStateForTerminal({
        waveId,
        frontmatter: state.frontmatter,
        body: state.body,
      }),
    };
  },

  'wave-list': async (_args, ctx) => {
    const projectRoot = (ctx && ctx.projectRoot) || process.cwd();
    const waves = await listWaveEntries(projectRoot);
    if (waves.length === 0) {
      return { ok: true, output: '(no waves)' };
    }
    waves.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // v1.5.0 F3 (R3 fold-in): parallel reads via Promise.all.
    // Sequential await over N waves was O(N*disk-latency); parallelised on N>3.
    const states = await Promise.all(waves.map(({ id }) => readWaveState(id, projectRoot)));
    const rows = waves.map(({ id }, i) => {
      const state = states[i];
      const status = state?.frontmatter?.status ?? '?';
      const createdAt = state?.frontmatter?.created_at ?? '';
      return `${id}\t${status}\t${createdAt}`;
    });
    return { ok: true, output: rows.join('\n') };
  },

  // v1.5.0-major S01: belt-and-suspenders drain of subagent checkpoints from
  // a worktree's .ijfw/wave-<id>/ into the parent project's .ijfw/wave-<id>/.
  // Run BEFORE `git worktree remove` so checkpoints survive cleanup even if
  // the subagent didn't honor IJFW_PARENT_PROJECT_ROOT (older callers, manual
  // claude invocation in a worktree, etc.).
  'worktree-drain': async (args, ctx) => {
    const tokens = tokenize(args);
    const [waveId, worktreePath] = tokens;
    if (!waveId || !worktreePath) {
      return {
        ok: false,
        error: 'Usage: ijfw worktree-drain <waveId> <worktreePath>',
      };
    }
    const projectRoot = (ctx && ctx.projectRoot) || process.cwd();
    try {
      const result = await drainCheckpoints(waveId, worktreePath, projectRoot);
      if (!result.ok) {
        return { ok: false, error: `ijfw worktree-drain: ${result.reason}` };
      }
      return {
        ok: true,
        output: `ok: drained ${result.drained} checkpoint(s) from ${worktreePath}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `ijfw worktree-drain: ${err && err.message ? err.message : String(err)}`,
      };
    }
  },
};

export const subcommandHelp = {
  'wave-status': 'wave-status [<id>|latest] — print live state of a wave',
  'wave-list':   'wave-list — list all known waves (newest first)',
  'worktree-drain':
    'worktree-drain <waveId> <worktreePath> — copy subagent checkpoints from a worktree to the parent before `git worktree remove` (v1.5.0 S01)',
};
