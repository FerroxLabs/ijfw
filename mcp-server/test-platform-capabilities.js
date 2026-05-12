import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

test('platform capability manifest matches shipped surfaces', () => {
  execFileSync(process.execPath, [join(REPO, 'scripts', 'check-platform-drift.js')], {
    cwd: REPO,
    stdio: 'pipe'
  });
});
