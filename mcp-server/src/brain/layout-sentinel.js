import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function readLayoutVersion(repoRoot) {
  const p = join(repoRoot, '.ijfw', '.layout-version');
  if (!existsSync(p)) return 1;
  const v = parseInt(readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

export function writeLayoutVersion(repoRoot, version) {
  writeFileSync(join(repoRoot, '.ijfw', '.layout-version'), `${version}\n`);
}

export async function withLayoutLock(repoRoot, fn, { timeoutMs = 5000 } = {}) {
  const lockPath = join(repoRoot, '.ijfw', '.migrate.lock');
  const start = Date.now();
  let fd = null;
  while (true) {
    try { fd = openSync(lockPath, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) throw new Error(`layout-sentinel: locked > ${timeoutMs}ms`);
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); }
  finally { try { closeSync(fd); } catch {} try { unlinkSync(lockPath); } catch {} }
}
