// Child process used by test-fs-lock.js cross-process race test.
//
// Reads `IJFW_FS_LOCK_DIR` and `IJFW_FS_LOCK_COUNTER` from argv, sends a
// 'ready' IPC message, waits for a 'go' message from the parent, then
// performs a `read → +1 → write` counter increment INSIDE `withFsLock`.
// Exits 0 on success, non-zero on failure (with reason on stderr).

import { readFile, writeFile } from 'node:fs/promises';
import { withFsLock } from '../src/fs-lock.js';

const lockDir = process.argv[2];
const counterPath = process.argv[3];

if (!lockDir || !counterPath) {
  console.error('child: missing argv (lockDir, counterPath)');
  process.exit(2);
}

async function increment() {
  await withFsLock(
    lockDir,
    async () => {
      const raw = await readFile(counterPath, 'utf8');
      const current = parseInt(raw, 10);
      if (!Number.isFinite(current)) {
        throw new Error(`child: bad counter value "${raw}"`);
      }
      // Yield to widen the window where a lock-bug would interleave reads.
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(counterPath, String(current + 1), 'utf8');
    },
    { acquireTimeoutMs: 10_000 },
  );
}

process.on('message', async (msg) => {
  if (msg === 'go') {
    try {
      await increment();
      process.send?.('done');
      process.exit(0);
    } catch (err) {
      console.error(`child error: ${err && err.message ? err.message : err}`);
      process.exit(1);
    }
  }
});

// Signal readiness to parent so both children start the race at the same time.
process.send?.('ready');
