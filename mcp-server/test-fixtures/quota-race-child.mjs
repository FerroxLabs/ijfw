// Child process for the cross-process race test in
// test-server-quota-integration.js (SEC-H-01 proof for the quota tracker).
//
// argv: [extName, home]
// IPC: parent sends 'go' message; child calls checkAndIncrement(extName,
// 'files_written', 1, 1, opts) — exactly ONE of two siblings should return
// allowed=true; the other allowed=false (limit=1).

import { checkAndIncrement } from '../src/extension-quota-tracker.js';

const extName = process.argv[2];
const home = process.argv[3];

if (!extName || !home) {
  console.error('quota-race-child: missing argv (extName, home)');
  process.exit(2);
}

process.env.HOME = home;
process.env.USERPROFILE = home;

process.on('message', async (msg) => {
  if (msg === 'go') {
    try {
      const r = await checkAndIncrement(extName, 'files_written', 1, 1, {
        homeDir: home,
        // Unique path per child so we exercise the increment branch (not the
        // dedupe branch — the race we care about is the counter R/M/W).
        path: `/abs/${process.pid}`,
      });
      // Send the per-child verdict back as IPC.
      process.send?.({ allowed: r.allowed, current: r.current, limit: r.limit });
      process.exit(0);
    } catch (err) {
      console.error(`quota-race-child error: ${err && err.message ? err.message : err}`);
      process.exit(1);
    }
  }
});

process.send?.('ready');
