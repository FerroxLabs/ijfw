import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withFsLock, lockPathFor } from '../fs-lock.js';

export function readLayoutVersion(repoRoot) {
  const p = join(repoRoot, '.ijfw', '.layout-version');
  if (!existsSync(p)) return 1;
  const v = parseInt(readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

export function writeLayoutVersion(repoRoot, version) {
  writeFileSync(join(repoRoot, '.ijfw', '.layout-version'), `${version}\n`);
}

// V155-016 (HIGH): replace the bespoke `openSync('wx')` mutex with the
// canonical `withFsLock` primitive. The prior implementation had no stale
// recovery — on SIGKILL between `openSync` and the `finally` unlink, the
// lockfile orphaned forever; next server startup would throw after 5s and
// the operator had to manually `rm .ijfw/.migrate.lock`. `withFsLock`
// inherits canonical heartbeat-refreshed stale recovery (live processes
// always renew before staleMs fires; crashed holders age out cleanly).
// The .migrate.lock path sorts to LOCK_TIERS' tier-99 fallback (unknown
// path → tail of canonical order) so it cannot deadlock against numbered
// §3 locks. `timeoutMs` is preserved as `acquireTimeoutMs` so the documented
// startup-timeout behaviour is unchanged.
export async function withLayoutLock(repoRoot, fn, { timeoutMs = 5000 } = {}) {
  const lockTarget = join(repoRoot, '.ijfw', '.migrate.lock');
  return withFsLock(lockPathFor(lockTarget), fn, {
    staleMs: 60_000,
    heartbeatMs: 2_000,
    acquireTimeoutMs: timeoutMs,
  });
}
