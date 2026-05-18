/**
 * dispatch/worktree-cli.js — v1.5.0 S2 worktree provisioning CLI.
 *
 * Frozen export contract (briefing-locked):
 *   export const worktreeHandlers      = Object.freeze({ worktree: handler });
 *   export const worktreeSubcommandHelp = Object.freeze({ '<subcommand>': '<help>' });
 *
 * Handler returns a numeric exit code (0=ok, 1=failure, 2=usage), distinct
 * from wave-cli's {ok,output} shape because this command writes JSON to stdout
 * directly for downstream orchestrator consumption.
 *
 * Subcommand owned by this module:
 *   - worktree provision <path>
 */

import { provisionWorktree } from '../orchestrator/worktree-provision.js';
import { resolve } from 'node:path';

const SUBCOMMAND_HELP = {
  'worktree provision': 'ijfw worktree provision <path> — detect+install deps in a worktree (v1.5.0 S2)',
};

async function handleWorktree(args, _ctx) {
  if (args[0] !== 'provision' || !args[1]) {
    process.stderr.write('Usage: ijfw worktree provision <path>\n');
    return 2;
  }
  const path = resolve(args[1]);
  try {
    const result = await provisionWorktree(path);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`ijfw worktree: ${err.message}\n`);
    return 1;
  }
}

export const worktreeHandlers = Object.freeze({ worktree: handleWorktree });
export const worktreeSubcommandHelp = Object.freeze(SUBCOMMAND_HELP);
