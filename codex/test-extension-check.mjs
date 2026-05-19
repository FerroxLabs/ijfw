// IJFW v1.5.0 audit-H5.1-codex -- codex-local regression coverage for the
// tier-2 sandbox enforcement hook at .codex/hooks/scripts/pre-tool-use-extension-check.sh.
//
// The mcp-server test harness already exercises the no-op, allow, and deny
// paths cross-platform. This file adds codex-resident coverage for two gaps:
//   - fail-closed behaviour on malformed state JSON
//   - `tool:*` wildcard permission grant
// plus the three baseline cases so codex ships with a self-contained smoke
// suite that doesn't depend on the mcp-server harness wiring.
//
// Run: node --test codex/test-extension-check.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '.codex', 'hooks', 'scripts', 'pre-tool-use-extension-check.sh');

/**
 * Spawn the hook script with an isolated HOME and a JSON stdin payload.
 * Returns { code, stderr } once the process closes.
 */
async function runHook({ home, stdin }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, IJFW_DISABLE: '' };
    const child = spawn('bash', [SCRIPT], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

async function makeHome() {
  return mkdtemp(join(tmpdir(), 'ijfw-codex-ext-'));
}

async function writeState(home, state) {
  const dir = join(home, '.ijfw', 'state');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'active-extension.json'), state, 'utf8');
}

test('a: no active-extension state file -> exit 0 (no-op)', async () => {
  const home = await makeHome();
  try {
    const { code } = await runHook({
      home,
      stdin: JSON.stringify({ tool_name: 'Bash' }),
    });
    assert.equal(code, 0, 'hook should be a no-op when no state file is present');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('b: state with tool:read read-only -> Bash denied with informative stderr', async () => {
  const home = await makeHome();
  try {
    await writeState(
      home,
      JSON.stringify({
        name: 'unit-test-ext',
        permissions: { reads: ['tool:read'], writes: [] },
      }),
    );
    const { code, stderr } = await runHook({
      home,
      stdin: JSON.stringify({ tool_name: 'Bash' }),
    });
    assert.notEqual(code, 0, 'Bash should be denied when not in writes');
    assert.match(
      stderr,
      /not permitted/,
      `stderr should explain the denial, got: ${stderr}`,
    );
    assert.match(stderr, /unit-test-ext/, 'stderr should name the extension');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('c: state with tool:read read-only -> Read allowed', async () => {
  const home = await makeHome();
  try {
    await writeState(
      home,
      JSON.stringify({
        name: 'unit-test-ext',
        permissions: { reads: ['tool:read'], writes: [] },
      }),
    );
    const { code, stderr } = await runHook({
      home,
      stdin: JSON.stringify({ tool_name: 'Read' }),
    });
    assert.equal(code, 0, `Read should be allowed, stderr was: ${stderr}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('d: malformed state JSON -> exit 1 (fail-closed)', async () => {
  const home = await makeHome();
  try {
    await writeState(home, '{ not valid json');
    const { code, stderr } = await runHook({
      home,
      stdin: JSON.stringify({ tool_name: 'Read' }),
    });
    assert.notEqual(code, 0, 'malformed state must fail closed');
    assert.match(
      stderr,
      /ijfw extension permission check/,
      `stderr should surface the parse failure, got: ${stderr}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('e: writes wildcard tool:* -> Bash allowed', async () => {
  const home = await makeHome();
  try {
    await writeState(
      home,
      JSON.stringify({
        name: 'wildcard-ext',
        permissions: { reads: [], writes: ['tool:*'] },
      }),
    );
    const { code, stderr } = await runHook({
      home,
      stdin: JSON.stringify({ tool_name: 'Bash' }),
    });
    assert.equal(
      code,
      0,
      `tool:* wildcard must grant Bash, got exit ${code}, stderr: ${stderr}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
