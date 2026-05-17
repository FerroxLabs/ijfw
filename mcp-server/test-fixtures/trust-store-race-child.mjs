// Child process for the cross-process race test in test-extension-registry.js
// (R12-H-02 proof for applyMultiRegistry trust-store serialisation).
//
// argv: [home, sourceName, keyId1, keyId2, ...]
// The child constructs an applyMultiRegistry call whose registry revokes
// exactly the keyIds passed via argv. Two children with DIFFERENT keyIds run
// concurrently; the final revoked-publishers.json must contain BOTH sets
// (the union). Before R12-H-02 the read-merge-write race could drop one set.
//
// IPC: parent sends 'go'; child performs the call, replies with the verdict.

import { applyMultiRegistry } from '../src/extension-registry.js';

const home = process.argv[2];
const sourceName = process.argv[3];
const keyIds = process.argv.slice(4);

if (!home || !sourceName || keyIds.length === 0) {
  console.error('trust-store-race-child: missing argv (home, sourceName, keyId...)');
  process.exit(2);
}

process.env.HOME = home;
process.env.USERPROFILE = home;

process.on('message', async (msg) => {
  if (msg !== 'go') return;
  try {
    const registry = {
      registry_version: '1.0',
      updated_at: new Date().toISOString(),
      publishers: {},
      revoked: keyIds.map((k) => ({
        keyId: k,
        revoked_at: new Date().toISOString(),
        reason: 'race-test',
        superseded_by: null,
      })),
    };
    const appliedSources = [
      {
        source: { name: sourceName, url: 'https://test.example/v1.json', priority: 0 },
        registry,
        rejected: null,
      },
    ];
    const result = await applyMultiRegistry(appliedSources);
    process.send?.({
      ok: true,
      global_revocations: result.global_revocations.map((g) => g.keyId),
    });
    process.exit(0);
  } catch (err) {
    console.error(`trust-store-race-child error: ${err && err.message ? err.message : err}`);
    process.send?.({ ok: false, error: String(err && err.message ? err.message : err) });
    process.exit(1);
  }
});

process.send?.('ready');
