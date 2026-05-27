/**
 * dispatch/signer-cli.js — IJFW v1.4.3 W9-A2 / B15
 *
 * CLI handlers for signing-key management. Exported as the frozen
 * `{ handlers, subcommandHelp }` shape so the Phase D orchestrator can wire
 * them into the top-level dispatch table without per-area editing.
 *
 * Subcommands:
 *
 *   keygen <author> [--backend software|ssh-agent] [--ssh-key-comment <c>]
 *     - Default backend: software (existing v1.4.0 behavior — generates a
 *       fresh Ed25519 keypair on disk).
 *     - --backend ssh-agent: NO private-key generation in IJFW. Connects
 *       to the running SSH agent, enumerates Ed25519 identities, selects
 *       one to enroll. Writes only the public material:
 *         ~/.ijfw/keys/<keyId>/public.pem
 *         ~/.ijfw/keys/<keyId>/backend.json
 *           { backend, pubkey_blob_hex, keyId, ssh_key_comment }
 *       The comment is recorded for display only; sign-time identity
 *       selection matches on pubkey_blob_hex (SEC-H-03).
 *
 *   keygen-fido2 <author>
 *     - Deferred stub. Prints a message routing users to ssh-agent or the
 *       default software backend. Exits 0 (deferred, not failed).
 *
 * Spec: .planning/1.4.3/HANDOFF-1.4.3.md §B15
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  generatePublisherKeypair,
} from '../extension-signer.js';
import {
  listAgentIdentities,
  pubkeyBlobFromPem,
  ed25519PemFromRaw,
  publicKeyFingerprint,
  _testInternals,
} from '../hardware-signer.js';

/**
 * Parse argv-style array (or whitespace-split string) into `{ positional, flags }`.
 * Supports `--flag` (boolean) and `--flag value` (string value).
 *
 * @param {string|string[]} input
 * @returns {{ positional: string[], flags: Record<string, string|boolean> }}
 */
function parseArgs(input) {
  const tokens = Array.isArray(input)
    ? input.slice()
    : String(input || '').trim().split(/\s+/).filter(Boolean);
  const positional = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

/**
 * Extract the SSH wire ssh-ed25519 alg prefix used for filtering Ed25519
 * identities returned by the agent.
 */
const ED25519_ALG_PREFIX = _testInternals.sshWireString(_testInternals.SSH_ED25519_ALG);

/**
 * Build the per-key directory path under the (possibly overridden) home.
 */
function keysDir(home, keyId) {
  return join(home, '.ijfw', 'keys', keyId);
}

/**
 * Convert an SSH-wire Ed25519 pubkey blob back into PEM. Useful when
 * enrolling — the agent gives us the wire blob, but downstream verify
 * paths want PEM.
 *
 * @param {Buffer} blob
 * @returns {string} PEM
 */
function ed25519PemFromBlob(blob) {
  // Blob shape: ssh-string("ssh-ed25519") || ssh-string(raw32).
  // Skip the alg prefix; the trailing string is the raw key.
  const algLen = ED25519_ALG_PREFIX.length;
  // The raw key follows; the leading 4 bytes are the length (always 32).
  const raw = blob.slice(algLen + 4);
  if (raw.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 raw key, got ${raw.length}`);
  }
  return ed25519PemFromRaw(raw);
}

/**
 * Filter agent identities to Ed25519 only.
 *
 * @param {Array<{blob: Buffer, comment: string}>} identities
 * @returns {Array<{blob: Buffer, comment: string}>}
 */
function ed25519Only(identities) {
  return identities.filter(
    i => i.blob.length >= ED25519_ALG_PREFIX.length
      && i.blob.slice(0, ED25519_ALG_PREFIX.length).equals(ED25519_ALG_PREFIX),
  );
}

/**
 * Enrol an existing SSH-agent identity as an IJFW publisher key.
 *
 * Workflow:
 *   1. Connect to SSH_AUTH_SOCK (errors clearly if unavailable).
 *   2. List identities; filter to Ed25519.
 *   3. Resolve a single candidate. Selection precedence:
 *      a. If --ssh-key-comment is provided, prefer that comment.
 *      b. Otherwise: exactly 1 Ed25519 identity → auto-pick. Multiple
 *         identities → fail with usage hint (interactive picker not yet
 *         wired into MCP transport).
 *   4. Compute keyId = sha256(SPKI-DER of the agent-key's PEM).
 *   5. Write public.pem + backend.json to ~/.ijfw/keys/<keyId>/.
 *
 * @param {object} args
 * @param {string} args.author informational author label
 * @param {string} [args.sshKeyComment] disambiguator
 * @param {string} [args.home] override ~/.ijfw root (test isolation)
 * @param {string} [args.socketPath] override SSH_AUTH_SOCK (test isolation)
 * @returns {Promise<{ ok: true, keyId: string, dir: string, ssh_key_comment: string, backend: 'ssh-agent' } | { ok: false, error: string }>}
 */
async function enrolSshAgentKey(args) {
  const home = args.home || homedir();
  let identities;
  try {
    identities = await listAgentIdentities(args.socketPath);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const candidates = ed25519Only(identities);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: 'SSH agent has no Ed25519 identities; add one with `ssh-keygen -t ed25519` and `ssh-add`',
    };
  }
  let chosen;
  if (args.sshKeyComment) {
    const matches = candidates.filter(c => c.comment === args.sshKeyComment);
    if (matches.length === 0) {
      return {
        ok: false,
        error: `SSH agent has no Ed25519 identity with comment ${JSON.stringify(args.sshKeyComment)}`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple SSH agent identities share comment ${JSON.stringify(args.sshKeyComment)}; comments are not unique — disambiguate by re-running ssh-add or removing duplicates`,
      };
    }
    chosen = matches[0];
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    return {
      ok: false,
      error: `Multiple Ed25519 identities in SSH agent (${candidates.length}); pass --ssh-key-comment <c> to disambiguate. Comments seen: ${candidates.map(c => JSON.stringify(c.comment)).join(', ')}`,
    };
  }

  let pem;
  try {
    pem = ed25519PemFromBlob(chosen.blob);
  } catch (err) {
    return { ok: false, error: `failed to convert agent blob to PEM: ${err.message}` };
  }
  const keyId = publicKeyFingerprint(pem);
  // Belt-and-braces self-consistency check: the blob we just stored should
  // round-trip back through PEM and yield the same blob.
  const roundTripBlob = pubkeyBlobFromPem(pem);
  if (!roundTripBlob.equals(chosen.blob)) {
    return {
      ok: false,
      error: 'internal: pubkey blob round-trip via PEM differed; refusing to enrol',
    };
  }

  const dir = keysDir(home, keyId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await chmod(dir, 0o700); } catch { /* best-effort */ }
  await writeFile(join(dir, 'public.pem'), pem, 'utf8');
  try { await chmod(join(dir, 'public.pem'), 0o644); } catch { /* best-effort */ }
  const backendJson = {
    backend: 'ssh-agent',
    pubkey_blob_hex: chosen.blob.toString('hex'),
    keyId,
    ssh_key_comment: chosen.comment, // display only — never used for matching
  };
  await writeFile(
    join(dir, 'backend.json'),
    JSON.stringify(backendJson, null, 2) + '\n',
    'utf8',
  );
  if (typeof args.author === 'string' && args.author.length > 0) {
    try {
      await writeFile(
        join(dir, 'author.txt'),
        `${args.author}\n${new Date().toISOString()}\n`,
        'utf8',
      );
    } catch { /* non-fatal */ }
  }

  return {
    ok: true,
    keyId,
    dir,
    ssh_key_comment: chosen.comment,
    backend: 'ssh-agent',
  };
}

/**
 * keygen handler. Dispatches to software (default) or ssh-agent backend
 * per --backend.
 *
 * @param {string|string[]} args
 * @param {object} [ctx]
 * @returns {Promise<object>}
 */
async function keygenHandler(args, ctx = {}) {
  const { positional, flags } = parseArgs(args);
  const author = positional[0] || '';
  const backend = flags.backend === true ? undefined : flags.backend;

  if (backend === undefined || backend === 'software') {
    const kp = await generatePublisherKeypair(author);
    return {
      ok: true,
      backend: 'software',
      keyId: kp.keyId,
      dir: kp.dir,
      publicKey: kp.publicKey,
    };
  }

  if (backend === 'ssh-agent') {
    const sshKeyComment = flags['ssh-key-comment'] === true
      ? undefined
      : flags['ssh-key-comment'];
    return enrolSshAgentKey({
      author,
      sshKeyComment,
      home: ctx.home,
      socketPath: ctx.socketPath,
    });
  }

  // Fail-closed per SEC-L-02. Unknown backend names must not silently fall
  // through to software.
  return {
    ok: false,
    error: `Unsupported --backend value ${JSON.stringify(backend)}; valid: software, ssh-agent`,
  };
}

/**
 * keygen-fido2 handler — unimplemented.
 *
 * V155-057: previously returned `ok:true, deferred:true` — JSON consumers
 * (CI scripts, automated install flows) reading `r.ok` saw success and
 * proceeded as if a key had been minted. That's truthfulness-of-state
 * violation: nothing was minted, no key exists, but state recorded ok.
 *
 * Now returns `ok:false, error:'unimplemented'` so callers fail closed.
 * The transitive ssh-agent path (modern YubiKey/Solokey speak SSH agent
 * natively) remains the recommended route; the hint stays the same but
 * the verdict is honest.
 *
 * @returns {Promise<{ ok: false, error: 'unimplemented', message: string }>}
 */
async function keygenFido2Handler(_args, ctx = {}) {
  const msg = 'FIDO2/libfido2 native backend is unimplemented — use `keygen <author> --backend ssh-agent` (modern YubiKey/Solokey work transitively via ssh-agent)';
  // Write to stderr for CLI visibility without disturbing JSON-stdout
  // consumers. Optionally inject a writer via ctx for tests.
  const stderr = ctx.stderr || process.stderr;
  try { stderr.write(`${msg}\n`); } catch { /* ignore */ }
  return { ok: false, error: 'unimplemented', message: msg };
}

export const handlers = Object.freeze({
  keygen: keygenHandler,
  'keygen-fido2': keygenFido2Handler,
});

export const subcommandHelp = Object.freeze({
  keygen: 'keygen <author> [--backend software|ssh-agent] [--ssh-key-comment <c>] — generate or enrol a publisher signing key',
  'keygen-fido2': 'keygen-fido2 <author> — UNIMPLEMENTED (no native libfido2 backend); use `keygen <author> --backend ssh-agent` instead',
});

// Test-only exports.
export const _testOnly = Object.freeze({
  parseArgs,
  enrolSshAgentKey,
});
