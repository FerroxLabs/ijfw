/**
 * test-observation-codex.js -- observation capture: schema normalization,
 * secret redaction, and restrictive file modes.
 *
 * Every case runs scripts/observation/capture.js in a CHILD process with a
 * throwaway HOME shaped like a macOS home ("/.../Users/test user"), so the
 * real home directory of the machine running the suite is never touched.
 *
 * Fake secrets are assembled at runtime from obviously-fake parts; no
 * fixture file contains a credential-shaped string.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, writeFileSync, chmodSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { normalizeHookPayload, patchFiles } from '../scripts/observation/normalize.js';
import { redactObservationText } from '../scripts/observation/redact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CAPTURE = join(REPO, 'scripts', 'observation', 'capture.js');
const FIX = join(REPO, 'scripts', 'observation', 'fixtures');
const BASE = mkdtempSync(join(tmpdir(), 'ijfw-obs-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

let n = 0;
function macHome() {
  const home = join(BASE, `case-${++n}`, 'Users', 'test user');
  const project = join(home, 'dev', 'my project');
  mkdirSync(project, { recursive: true });
  return { home, project };
}

function fixture(name) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

function runCapture(payload, { home, project, platform = 'codex', env = {} }) {
  const r = spawnSync(process.execPath, [CAPTURE], {
    cwd: project,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      IJFW_PLATFORM: platform,
      ...env,
    },
    encoding: 'utf8',
  });
  const ledger = join(home, '.ijfw', 'observations.jsonl');
  const rows = existsSync(ledger)
    ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { r, rows, ledger };
}

// Fake credentials, built at runtime.
const FAKE = {
  openai: 'sk-' + 'proj-' + 'FAKEfake'.repeat(5),
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'FAKEFAKE'.repeat(4),
  github: 'gh' + 'p_' + 'FAKE0'.repeat(8),
  bearer: 'FAKEbearer' + '0123456789abcdef',
  password: 'not-a-real-pw-' + '42',
  short: 'fake' + 'tok' + '9',
};
const ALL_FAKE = Object.values(FAKE);
// The HTTP client name is assembled too, so the secret scanner's
// curl-auth rules never see a credential-shaped command line in this file.
const HTTP_CLIENT = 'cu' + 'rl';

function assertNoFake(text, label) {
  for (const s of ALL_FAKE) {
    assert.ok(!String(text).includes(s), `${label}: leaked fake secret ${s.slice(0, 6)}...`);
  }
}

// --- 1. Normalization adapter (pure) -----------------------------------------

test('normalize: Codex UserPromptSubmit (hook_event_name + prompt)', () => {
  const ev = normalizeHookPayload(fixture('codex-user-prompt-submit.json'));
  assert.equal(ev.hookEvent, 'UserPromptSubmit');
  assert.equal(ev.prompt, 'Add a retry to the upload client');
  assert.equal(ev.sessionId, '019a0000-0000-7000-8000-000000000001');
  assert.equal(ev.cwd, '/Users/test user/dev/my project');
});

test('normalize: Codex PostToolUse Bash', () => {
  const ev = normalizeHookPayload(fixture('codex-post-tool-use-bash.json'));
  assert.equal(ev.hookEvent, 'PostToolUse');
  assert.equal(ev.toolName, 'Bash');
  assert.equal(ev.command, 'npm run build');
  assert.equal(ev.toolResponseText, 'build ok\n');
});

test('normalize: Codex apply_patch maps to Edit and extracts files (spaces kept)', () => {
  const ev = normalizeHookPayload(fixture('codex-post-tool-use-apply-patch.json'));
  assert.equal(ev.toolName, 'Edit');
  assert.equal(ev.originalToolName, 'apply_patch');
  assert.deepEqual(ev.files, ['src/upload client.js']);
  assert.equal(ev.command, '', 'patch body must never be treated as a command line');
});

test('normalize: legacy Codex schema (event / tool / argv command)', () => {
  const up = normalizeHookPayload(fixture('codex-legacy-user-prompt-submit.json'));
  assert.equal(up.hookEvent, 'UserPromptSubmit');
  assert.equal(up.prompt, 'Explain the cache layer');
  const pt = normalizeHookPayload(fixture('codex-legacy-post-tool-use.json'));
  assert.equal(pt.hookEvent, 'PostToolUse');
  assert.equal(pt.toolName, 'Bash');
  assert.equal(pt.command, 'git commit -m "fix: retry uploads"');
});

test('normalize: Claude Edit + Gemini AfterTool still map correctly', () => {
  const c = normalizeHookPayload(fixture('claude-post-tool-use-edit.json'));
  assert.equal(c.toolName, 'Edit');
  assert.equal(c.filePath, '/Users/test user/dev/my project/src/app.js');
  const g = normalizeHookPayload(fixture('gemini-after-tool.json'));
  assert.equal(g.hookEvent, 'PostToolUse');
  assert.equal(g.toolName, 'Bash');
  assert.equal(g.command, 'ls -la');
});

test('normalize: garbage input never throws', () => {
  for (const v of [null, undefined, 42, 'x', [], { tool_input: 'str' }, { tool: { name: 7 } }]) {
    assert.doesNotThrow(() => normalizeHookPayload(v));
  }
  assert.deepEqual(patchFiles(null), []);
});

// --- 2. capture.js end-to-end with Codex payloads ---------------------------

test('capture: Codex UserPromptSubmit records the prompt as a session-request', () => {
  const ctx = macHome();
  const { r, rows } = runCapture(fixture('codex-user-prompt-submit.json'), ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rows.length, 1, 'exactly one observation');
  assert.equal(rows[0].type, 'session-request');
  assert.equal(rows[0].title, 'Add a retry to the upload client');
  assert.equal(rows[0].platform, 'codex');
  assert.equal(rows[0].session_id, '019a0000-0000-7000-8000-000000000001',
    'Codex session_id from the payload is used when no env/session file exists');
  assert.equal(rows[0].project, 'my project');
});

test('capture: Codex PostToolUse Bash records the command', () => {
  const ctx = macHome();
  const { r, rows } = runCapture(fixture('codex-post-tool-use-bash.json'), ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, 'Bash');
  assert.equal(rows[0].title, 'npm run build');
});

test('capture: Codex apply_patch records touched file', () => {
  const ctx = macHome();
  const { rows } = runCapture(fixture('codex-post-tool-use-apply-patch.json'), ctx);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].files, ['src/upload client.js']);
  assert.equal(rows[0].title, 'Updated upload client.js');
  assert.equal(rows[0].tool_name, 'apply_patch');
});

test('capture: legacy Codex event/tool schema is captured, not mislabeled', () => {
  const ctx = macHome();
  runCapture(fixture('codex-legacy-user-prompt-submit.json'), ctx);
  const { rows } = runCapture(fixture('codex-legacy-post-tool-use.json'), ctx);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'session-request');
  assert.equal(rows[0].title, 'Explain the cache layer');
  assert.equal(rows[1].type, 'bugfix');
  assert.equal(rows[1].title, 'fix: retry uploads');
});

// --- 3. Redaction ------------------------------------------------------------

test('redact: fake API keys, bearer tokens, password assignments', () => {
  const samples = [
    `export OPENAI_API_KEY=${FAKE.openai}`,
    `use ${FAKE.anthropic} please`,
    `git push https://x:${FAKE.github}@github.com/o/r.git`,
    `${HTTP_CLIENT} -H "Authorization: Bearer ${FAKE.bearer}" https://api.example.test`,
    `${HTTP_CLIENT} -H 'authorization: bearer ${FAKE.bearer}' https://api.example.test`,
    `mysql -u root --password ${FAKE.password} db`,
    `${HTTP_CLIENT} -u admin:${FAKE.password} https://x.test`,
    `mysql --password=${FAKE.password}`,
    `DB_PASSWORD="${FAKE.password}" npm start`,
    `password: ${FAKE.password}`,
    `GITHUB_TOKEN=${FAKE.short} gh pr list`,
    `MY_SERVICE_SECRET=${FAKE.short} ./run`,
    `postgres://admin:${FAKE.password}@db.example.test/app`,
  ];
  for (const s of samples) {
    const out = redactObservationText(s);
    assertNoFake(out, s.slice(0, 30));
    assert.match(out, /\[REDACTED/, `marker present for: ${s.slice(0, 30)}`);
  }
  // Ordinary text survives.
  assert.equal(redactObservationText('npm run build'), 'npm run build');
  assert.equal(redactObservationText('Add a retry to the upload client'), 'Add a retry to the upload client');
});

test('capture: secrets in prompt, command, tool input and tool output never reach the ledger', () => {
  const ctx = macHome();
  const prompt = {
    hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: ctx.project,
    prompt: `my key is ${FAKE.openai} and password=${FAKE.password}`,
  };
  const bash = {
    hook_event_name: 'PostToolUse', session_id: 's1', cwd: ctx.project, tool_name: 'Bash',
    tool_input: { command: `${HTTP_CLIENT} -H "Authorization: Bearer ${FAKE.bearer}" -u u:${FAKE.password} https://x.test` },
    tool_response: `token=${FAKE.github}`,
  };
  const legacy = {
    event: 'PostToolUse', tool: 'shell',
    tool_input: { command: ['bash', '-lc', `GITHUB_TOKEN=${FAKE.short} gh api /user`] },
    tool_response: { stdout: `Bearer ${FAKE.bearer}` },
  };
  const write = {
    hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: { file_path: `/tmp/${FAKE.anthropic}.txt`, content: FAKE.openai },
  };
  for (const p of [prompt, bash, legacy, write]) runCapture(p, ctx);
  const { rows, ledger } = runCapture({ ...prompt, prompt: `${FAKE.anthropic}` }, ctx);
  assert.equal(rows.length, 5, 'all five events captured');
  const raw = readFileSync(ledger, 'utf8');
  assertNoFake(raw, 'observations.jsonl');
});

// --- 4. File modes -------------------------------------------------------------

test('capture: ledger file is created 0600 and an existing 0644 ledger is tightened', { skip: process.platform === 'win32' }, () => {
  const ctx = macHome();
  const { ledger } = runCapture(fixture('codex-post-tool-use-bash.json'), ctx);
  assert.equal(statSync(ledger).mode & 0o777, 0o600);

  const ctx2 = macHome();
  const ledger2 = join(ctx2.home, '.ijfw', 'observations.jsonl');
  mkdirSync(dirname(ledger2), { recursive: true });
  writeFileSync(ledger2, '');
  chmodSync(ledger2, 0o644);
  runCapture(fixture('codex-post-tool-use-bash.json'), ctx2);
  assert.equal(statSync(ledger2).mode & 0o777, 0o600);
});
