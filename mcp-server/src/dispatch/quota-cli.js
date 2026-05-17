/**
 * dispatch/quota-cli.js — IJFW v1.4.3 W9-A3 (B16)
 *
 * Frozen CLI module contract:
 *   export const handlers       — { '<subcommand>': async (args, ctx) => { ok, output?, error? } }
 *   export const subcommandHelp — { '<subcommand>': 'one-line description' }
 *
 * Phase D wires these into `dispatch/extension.js`'s main switch by iterating
 * Object.entries(handlers). Until then, this module is callable in isolation.
 */

import { getQuotaUsage, resetExtensionQuotas } from '../extension-quota-tracker.js';

function homeFromCtx(ctx) {
  if (ctx && typeof ctx.homedir === 'string') return ctx.homedir;
  if (ctx && typeof ctx.homeDir === 'string') return ctx.homeDir;
  return undefined; // tracker will fall back to env HOME / homedir()
}

export const handlers = Object.freeze({
  'quota-status': async (args, ctx) => {
    const name = Array.isArray(args) ? args[0] : undefined;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'quota-status: extension name required' };
    }
    const usage = await getQuotaUsage(name, { homeDir: homeFromCtx(ctx) });
    return { ok: true, output: JSON.stringify(usage, null, 2) };
  },
  'quota-reset': async (args, ctx) => {
    const name = Array.isArray(args) ? args[0] : undefined;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'quota-reset: extension name required' };
    }
    await resetExtensionQuotas(name, { homeDir: homeFromCtx(ctx) });
    return { ok: true, output: 'reset' };
  },
});

export const subcommandHelp = Object.freeze({
  'quota-status': 'quota-status [<ext-name>] — print current usage vs limits',
  'quota-reset': 'quota-reset <ext-name> — admin: manually reset counters',
});
