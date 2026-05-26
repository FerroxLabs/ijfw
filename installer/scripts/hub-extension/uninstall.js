// IJFW Hub Extension — onUninstall lifecycle hook.
// Runs in a sandboxed forked process via require() (NOT ESM).
// Wayland forks this script with a 120s timeout; we set our own inner
// timeout of 100_000ms so we surface a clean error before Wayland's hard kill.

'use strict';

const { spawnSync } = require('child_process');

const result = spawnSync('npx', ['-y', '@ijfw/install', '--uninstall'], {
  stdio: 'inherit',
  timeout: 100_000,
  env: { ...process.env, IJFW_NONINTERACTIVE: '1' },
});

if (result.status !== 0) {
  console.error(`[ijfw] uninstall failed (exit ${result.status})`);
  process.exit(result.status || 1);
}

console.log('[ijfw] IJFW uninstalled');
