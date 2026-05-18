/**
 * dispatch/checkpoint-cli.js — IJFW v1.5.0 / S1 subagent checkpoint CLI.
 *
 * Frozen export contract (v1.4.3 dispatch module convention):
 *   export const handlers = { '<subcommand>': async (args, ctx) => ({ ok, output?, error? }) };
 *   export const subcommandHelp = { '<subcommand>': 'one-line description' };
 *
 * Subcommands owned by this module:
 *   - checkpoint <waveId> <subId> <jsonPayload>
 *
 * Writes via mcp-server/src/orchestrator/subagent-telemetry.js (W11-A0).
 * Used by implementer subagents to persist progress before the Claude Code
 * harness ~20-tool / 60s wall-clock cap fires (v1.5.0 S1 — closes 8/13
 * truncation pattern from v1.4.4 Wave 10 + v1.5.0 research).
 *
 * Wire-up into extension.js is handled by orchestrator post-Wave-11-A.
 */

import { recordCheckpoint } from '../orchestrator/subagent-telemetry.js';

function tokenize(args) {
  if (Array.isArray(args)) return args.filter((x) => x !== undefined && x !== null);
  if (typeof args !== 'string') return [];
  // Checkpoint args are: <waveId> <subId> <jsonPayload>.
  // The JSON payload may contain spaces — split into at most 3 tokens so the
  // payload survives intact regardless of internal whitespace.
  const trimmed = args.trim();
  if (!trimmed) return [];
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return [trimmed];
  const secondSpace = trimmed.indexOf(' ', firstSpace + 1);
  if (secondSpace === -1) return [trimmed.slice(0, firstSpace), trimmed.slice(firstSpace + 1)];
  return [
    trimmed.slice(0, firstSpace),
    trimmed.slice(firstSpace + 1, secondSpace),
    trimmed.slice(secondSpace + 1),
  ];
}

async function handleCheckpoint(args, ctx) {
  const tokens = tokenize(args);
  const [waveId, subId, payloadJson] = tokens;
  if (!waveId || !subId || !payloadJson) {
    return {
      ok: false,
      error: 'Usage: ijfw checkpoint <waveId> <subId> <jsonPayload>',
    };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    return {
      ok: false,
      error: `ijfw checkpoint: invalid JSON payload — ${err.message}`,
    };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      error: 'ijfw checkpoint: JSON payload must be a JSON object (not array/null/scalar)',
    };
  }

  const projectRoot = (ctx && ctx.projectRoot) || process.cwd();

  try {
    await recordCheckpoint(waveId, subId, payload, projectRoot);
    return { ok: true, output: `ok: wrote checkpoint for ${waveId}/${subId}` };
  } catch (err) {
    return {
      ok: false,
      error: `ijfw checkpoint: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

export const handlers = Object.freeze({
  checkpoint: handleCheckpoint,
});

export const subcommandHelp = Object.freeze({
  checkpoint:
    'checkpoint <waveId> <subId> <jsonPayload> — record a subagent checkpoint (v1.5.0 S1)',
});
