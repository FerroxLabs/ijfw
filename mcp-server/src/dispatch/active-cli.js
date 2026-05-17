/**
 * dispatch/active-cli.js — IJFW v1.4.3 W9-B (B18)
 *
 * Frozen CLI module contract:
 *   export const handlers       — { '<subcommand>': async (args, ctx) => { ok, output?, error? } }
 *   export const subcommandHelp — { '<subcommand>': 'one-line description' }
 *
 * Subcommands:
 *   active --check          — report current active extension + last-writer IDE + divergence
 *   activate <name> [--ide <id>] [--strict-ide]
 *                           — activate <name> stamping the host IDE id; refuse
 *                             activation when --strict-ide is set AND a different
 *                             IDE is the current writer of stale state.
 *
 * Phase D wires these into `dispatch/extension.js`'s main switch by iterating
 * Object.entries(handlers). Until then, this module is callable in isolation.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  findInstalledManifest,
  writeActiveExtension,
  detectCrossIdeDivergence,
} from '../active-extension-writer.js';
import { detectIde } from '../ide-detect.js';

function homeFromCtx(ctx) {
  if (ctx && typeof ctx.homedir === 'string') return ctx.homedir;
  if (ctx && typeof ctx.homeDir === 'string') return ctx.homeDir;
  return undefined;
}

function projectRootFromCtx(ctx) {
  if (ctx && typeof ctx.projectRoot === 'string') return ctx.projectRoot;
  return process.cwd();
}

function parseArgs(args) {
  // Accept either a token array (preferred per registry-cli contract) or a
  // raw string (fallback for direct callers).
  let tokens;
  if (Array.isArray(args)) {
    tokens = args.slice();
  } else if (typeof args === 'string') {
    tokens = args.split(/\s+/).filter(Boolean);
  } else {
    tokens = [];
  }
  const flags = { check: false, strictIde: false, ide: null };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--check') { flags.check = true; continue; }
    if (t === '--strict-ide') { flags.strictIde = true; continue; }
    if (t === '--ide' && tokens[i + 1]) {
      flags.ide = tokens[i + 1];
      i++;
      continue;
    }
    positional.push(t);
  }
  return { positional, flags };
}

async function activeHandler(args, ctx) {
  const { flags } = parseArgs(args);
  const home = homeFromCtx(ctx) || process.env.HOME || homedir();
  if (!flags.check) {
    return { ok: false, error: "active: --check required (usage: active --check)" };
  }
  // Read current active.json (best-effort).
  const activePath = join(home, '.ijfw', 'state', 'active-extension.json');
  let active = null;
  try {
    const raw = await readFile(activePath, 'utf8');
    active = JSON.parse(raw);
  } catch {
    // null
  }
  const verdict = await detectCrossIdeDivergence({ homeDir: home });
  const out = {
    active: active ? {
      name: active.name ?? null,
      scope: active.scope ?? null,
      activated_at: active.activated_at ?? null,
      activated_by_ide: active.activated_by_ide ?? null,
      activated_by_pid: active.activated_by_pid ?? null,
    } : null,
    current_ide: verdict.current_ide,
    divergent: !!verdict.divergent,
    last_writer: verdict.last_writer ?? null,
    age_seconds: verdict.age_seconds ?? null,
  };
  return { ok: true, output: JSON.stringify(out, null, 2) };
}

async function activateHandler(args, ctx) {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'activate: extension name required (usage: activate <name> [--ide <id>] [--strict-ide])' };
  }
  const home = homeFromCtx(ctx) || process.env.HOME || homedir();
  const projectRoot = projectRootFromCtx(ctx);

  const ideId = flags.ide && /^[a-z0-9-]+$/.test(flags.ide) ? flags.ide : detectIde();

  // Strict-IDE gate: if active.json was last touched by a different IDE AND
  // divergence semantic flags it, refuse before writing.
  if (flags.strictIde) {
    const verdict = await detectCrossIdeDivergence({ homeDir: home, currentIde: ideId });
    if (verdict && verdict.divergent) {
      return {
        ok: false,
        error: `[ijfw] activate refused: --strict-ide and active extension last activated by '${verdict.last_writer}'`,
      };
    }
  }

  const lookup = await findInstalledManifest(name, projectRoot, { homeDir: home });
  if (!lookup.ok) return { ok: false, error: lookup.error };
  const result = await writeActiveExtension(lookup.manifest, lookup.scope, { homeDir: home, ideId });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    output: JSON.stringify({ name, scope: lookup.scope, activated_by_ide: ideId, path: result.path }, null, 2),
  };
}

export const handlers = Object.freeze({
  'active': activeHandler,
  'activate': activateHandler,
});

export const subcommandHelp = Object.freeze({
  'active': 'active --check — report current active extension + cross-IDE divergence status',
  'activate': 'activate <name> [--ide <id>] [--strict-ide] — activate extension and stamp host IDE',
});
