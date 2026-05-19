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

  // r17.1 (item 6): subagent "did anyone go silent?" check. Takes a wave id
  // plus the list of subagent ids you EXPECTED to complete and reports which
  // ones have a checkpoint receipt vs which are MIA. Closes the wayland-
  // session pattern where 5 of 8 dispatched subagents went silent and the
  // orchestrator (Claude) had no way to know without manually scanning.
  //
  // Usage:
  //   ijfw wave-missing <waveId> <expectedId1> [<expectedId2> ...]
  // Exits non-zero (via ctx-aware caller) when any expected id is missing.
  //
  // Why this is in IJFW vs a SKILL: the orchestrator harness doesn't notify
  // Claude when an Agent subagent silently fails. IJFW can't fix that — only
  // the harness can. What IJFW CAN do: give the orchestrator a deterministic,
  // mechanical way to ask "are the receipts here?" without scraping the
  // worktree filesystem by hand.
  'wave-missing': async (args, ctx) => {
    const tokens = tokenize(args);
    const waveId = tokens[0];
    const expected = tokens.slice(1);
    if (!waveId || expected.length === 0) {
      return {
        ok: false,
        error: 'Usage: ijfw wave-missing <waveId> <expectedSubId1> [<expectedSubId2> ...]',
      };
    }
    const projectRoot = (ctx && ctx.projectRoot) || process.cwd();
    const waveDir = join(projectRoot, '.ijfw', `${WAVE_DIR_PREFIX}${waveId}`);
    let dirents = [];
    try {
      dirents = await readdir(waveDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          ok: false,
          output: `Wave ${waveId} has no .ijfw/wave-${waveId}/ directory. All ${expected.length} expected subagent(s) are MISSING.\nMissing: ${expected.join(', ')}`,
        };
      }
      return { ok: false, error: `wave-missing: ${err.message}` };
    }

    // Two canonical receipt filename forms:
    //   1. Wave-id-prefixed (Phase D synthesized + S01 CLI default):
    //        subagent-<waveId>-<subId>.checkpoint.json
    //   2. Bare runtime form (when ijfw checkpoint <waveId> <subId> ... runs
    //      and the subId itself has no embedded dashes that collide):
    //        subagent-<subId>.checkpoint.json
    // We extract subId by stripping a leading "<waveId>-" if present, then
    // taking everything before ".checkpoint.json". This avoids the regex-
    // overlap bug where greedy captures double-counted a subId that happens
    // to start with a word that resembles another subId.
    const present = new Set();
    const wavePrefix = `subagent-${waveId}-`;
    const barePrefix = 'subagent-';
    const suffix = '.checkpoint.json';
    for (const ent of dirents) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      if (!name.startsWith(barePrefix) || !name.endsWith(suffix)) continue;
      let subId;
      if (name.startsWith(wavePrefix)) {
        subId = name.slice(wavePrefix.length, name.length - suffix.length);
      } else {
        subId = name.slice(barePrefix.length, name.length - suffix.length);
      }
      if (subId.length > 0) present.add(subId);
    }
    const found = expected.filter(id => present.has(id));
    const missing = expected.filter(id => !present.has(id));
    const stray = [...present].filter(id => !expected.includes(id));

    const lines = [
      `Wave: ${waveId}`,
      `Expected: ${expected.length} subagent(s)`,
      `Present:  ${found.length} (${found.join(', ') || 'none'})`,
      `Missing:  ${missing.length} (${missing.join(', ') || 'none'})`,
    ];
    if (stray.length > 0) {
      lines.push(`Stray:    ${stray.length} (${stray.join(', ')}) — present but not expected`);
    }
    return {
      ok: missing.length === 0,
      output: lines.join('\n'),
    };
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
  'wave-missing':
    'wave-missing <waveId> <expectedId1> [<expectedId2> ...] — list any dispatched subagents that have no checkpoint receipt (catches silent-failure dispatches)',
  'worktree-drain':
    'worktree-drain <waveId> <worktreePath> — copy subagent checkpoints from a worktree to the parent before `git worktree remove` (v1.5.0 S01)',
};
