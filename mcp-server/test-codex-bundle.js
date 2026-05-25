/**
 * Codex bundle smoke tests.
 * Verifies: manifest validity, skill file presence, hooks.json structure,
 * hook script presence and syntax, slash-command parity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BASH } from './test/win-bash-helper.js';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const CODEX = join(REPO, 'codex');

function rmTmpDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return;
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err;
  }

  const tombstone = `${dir}.delete-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, tombstone);
  } catch (err) {
    if (!['ENOENT', 'EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err;
    console.info(`[info] Codex hook temp cleanup deferred to OS: ${err?.code || 'unknown'}`);
    return;
  }

  try {
    rmSync(tombstone, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err;
    console.info(`[info] Codex hook temp cleanup deferred to OS: ${err?.code || 'unknown'}`);
  }
}

// ---- Manifest ---------------------------------------------------------------

test('codex: plugin.json is valid JSON', () => {
  const p = join(CODEX, '.codex-plugin', 'plugin.json');
  assert.ok(existsSync(p), 'plugin.json missing');
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(typeof obj.name === 'string', 'manifest missing name');
  assert.ok(typeof obj.version === 'string', 'manifest missing version');
  assert.ok(typeof obj.description === 'string', 'manifest missing description');
  assert.ok(typeof obj.skills_dir === 'string', 'manifest missing skills_dir');
  assert.ok(typeof obj.hooks_config === 'string', 'manifest missing hooks_config');
});

test('codex: plugin.json skills_dir resolves to existing directory', () => {
  const manifest = JSON.parse(readFileSync(join(CODEX, '.codex-plugin', 'plugin.json'), 'utf8'));
  const skillsDir = join(CODEX, manifest.skills_dir);
  assert.ok(existsSync(skillsDir), `skills_dir "${manifest.skills_dir}" does not exist`);
});

test('codex: plugin.json commands_dir resolves to existing directory', () => {
  const manifest = JSON.parse(readFileSync(join(CODEX, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(typeof manifest.commands_dir, 'string', 'manifest missing commands_dir');
  const commandsDir = join(CODEX, manifest.commands_dir);
  assert.ok(existsSync(commandsDir), `commands_dir "${manifest.commands_dir}" does not exist`);
});

test('codex: command aliases mirror Claude command names', () => {
  const claudeCommands = readdirSync(join(REPO, 'claude', 'commands'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const codexCommands = readdirSync(join(CODEX, 'commands'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(codexCommands, claudeCommands);
});

test('codex: command alias files are non-empty and have descriptions', () => {
  for (const name of readdirSync(join(CODEX, 'commands')).filter((item) => item.endsWith('.md'))) {
    const content = readFileSync(join(CODEX, 'commands', name), 'utf8');
    assert.ok(content.length > 50, `command alias suspiciously short: ${name}`);
    assert.match(content, /^---\ndescription: /, `command alias missing frontmatter description: ${name}`);
  }
});

// ---- hooks.json -------------------------------------------------------------

// Codex CLI 0.120+ schema (per codex-rs/hooks/src/engine/config.rs):
//   { "hooks": { EventName: [ { matcher?, hooks: [{type:"command", command, ...}] } ] } }
// Valid events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PermissionRequest.
test('codex: hooks.json is valid JSON with expected events', () => {
  const p = join(CODEX, '.codex', 'hooks.json');
  assert.ok(existsSync(p), 'hooks.json missing');
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj),
    'hooks.json: top-level must be an object');
  assert.ok(obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks),
    'hooks.json: "hooks" must be a map keyed by event name');
  for (const expected of ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse']) {
    assert.ok(Array.isArray(obj.hooks[expected]),
      `hooks.json event missing or not an array: ${expected}`);
    assert.ok(obj.hooks[expected].length > 0,
      `hooks.json event ${expected} has no MatcherGroups`);
  }
});

test('codex: all hook scripts listed in hooks.json exist on disk', () => {
  const hooksBase = join(CODEX, '.codex');
  const obj = JSON.parse(readFileSync(join(hooksBase, 'hooks.json'), 'utf8'));
  for (const event of Object.keys(obj.hooks || {})) {
    for (const group of obj.hooks[event]) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (h && h.type === 'command' && typeof h.command === 'string') {
          const abs = join(hooksBase, h.command);
          assert.ok(existsSync(abs), `hook command missing: ${h.command} (event ${event})`);
        }
      }
    }
  }
});

test('codex: hook scripts pass bash syntax check', () => {
  const hooksDir = join(CODEX, '.codex', 'hooks');
  const scripts = ['session-start.sh', 'session-end.sh', 'pre-prompt.sh', 'pre-tool-use.sh', 'permission-request.sh', 'post-tool-use.sh', 'after-agent.sh'];
  for (const s of scripts) {
    const abs = join(hooksDir, s);
    if (existsSync(abs)) {
      assert.doesNotThrow(
        () => execFileSync(BASH, ['-n', abs], { stdio: 'pipe' }),
        `bash -n failed: ${s}`
      );
    }
  }
});

// ---- Session-start hook fires memory injection ------------------------------

test('codex: session-start hook references ijfw memory path', () => {
  const src = readFileSync(join(CODEX, '.codex', 'hooks', 'session-start.sh'), 'utf8');
  assert.ok(
    src.includes('.ijfw') || src.includes('ijfw_memory'),
    'session-start.sh does not reference ijfw memory'
  );
});

test('codex: session-start emits Codex 0.130 hookSpecificOutput shape', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'session-start.sh');
  const cwd = mkdtempSync(join(tmpdir(), 'ijfw-codex-start-'));
  try {
    const payload = JSON.stringify({
      cwd,
      hook_event_name: 'SessionStart',
      model: 'gpt-test',
      permission_mode: 'default',
      session_id: 'test-session',
      source: 'startup',
      transcript_path: null
    });
    const out = execFileSync(BASH, [hook], {
      cwd,
      input: payload,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    assert.ok(out, 'session-start should emit a startup envelope');
    const obj = JSON.parse(out);
    assert.equal(obj.continue, true);
    assert.equal(typeof obj.systemMessage, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(obj, 'additionalContext'), false);
    if (obj.hookSpecificOutput) {
      assert.equal(obj.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.equal(typeof obj.hookSpecificOutput.additionalContext, 'string');
    }
  } finally {
    rmTmpDir(cwd);
  }
});

test('codex: post-tool-use stays quiet for routine output', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'post-tool-use.sh');
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
    tool_response: { output: 'hello world' },
    session_id: 'test-session'
  });
  const out = execFileSync(BASH, [hook], {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.equal(out, '');
});

test('codex: post-tool-use stays quiet for failure signals too', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'post-tool-use.sh');
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { output: '---\nError: test failed\n---\nbody' },
    session_id: 'test-session'
  });
  const out = execFileSync(BASH, [hook], {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.equal(out, '');
});

test('codex: permission-request denies high-risk release/destructive commands', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'permission-request.sh');
  const payload = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm publish && git push --force' },
    session_id: 'test-session'
  });
  const out = execFileSync(BASH, [hook], {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
  assert.ok(out, 'permission-request should emit a deny decision');
  const obj = JSON.parse(out);
  assert.equal(obj.continue, true);
  assert.equal(obj.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(obj.hookSpecificOutput.permissionDecisionReason, /npm publish/);
});

test('codex: permission-request still denies when IJFW log directory is absent', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'permission-request.sh');
  const home = mkdtempSync(join(tmpdir(), 'ijfw-codex-hook-home-'));
  try {
    const payload = JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git reset --hard HEAD~1' },
      session_id: 'test-session'
    });
    const out = execFileSync(BASH, [hook], {
      input: payload,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    assert.ok(out, 'permission-request should not depend on a pre-existing log directory');
    const obj = JSON.parse(out);
    assert.equal(obj.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(obj.hookSpecificOutput.permissionDecisionReason, /reset --hard/);
  } finally {
    rmTmpDir(home);
  }
});

test('codex: permission-request stays quiet for benign read-only commands', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'permission-request.sh');
  const payload = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
    session_id: 'test-session'
  });
  const out = execFileSync(BASH, [hook], {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.equal(out, '');
});

test('codex: doctor works from a non-IJFW project directory using bundled assets', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ijfw-codex-doctor-'));
  try {
    const out = execFileSync(process.execPath, [join(REPO, 'mcp-server', 'src', 'cross-orchestrator-cli.js'), 'codex', 'doctor'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.match(out, /IJFW Codex doctor/);
    // v1.5.2.1: assert doctor surfaces ANY semver version string under the
    // plugin-metadata check, not a hardcoded literal. The earlier regex
    // matched `1\.3\.2` exactly, which silently broke on every release
    // bump (1.4.0, 1.4.1, 1.4.3, 1.5.0, 1.5.1, 1.5.2.1…) — the test was
    // pre-existing-failing per memory note 8787 at the v1.5.1 W0 baseline.
    // Doctor itself now reads the canonical version from
    // installer/package.json (see codexDoctor in cross-orchestrator-cli.js)
    // so the comparison can no longer drift; this assertion just confirms
    // doctor surfaces SOMETHING that looks like a semver.
    assert.match(out, /plugin metadata -- version \d+\.\d+\.\d+/);
    assert.match(out, /skills -- /);
  } finally {
    rmTmpDir(cwd);
  }
});

test('codex: stop hook stays quiet for routine session saves', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'session-end.sh');
  const cwd = mkdtempSync(join(tmpdir(), 'ijfw-codex-stop-'));
  try {
    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'test-session',
      cwd
    });
    const out = execFileSync(BASH, [hook], {
      cwd,
      input: payload,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.equal(out, '');
  } finally {
    rmTmpDir(cwd);
  }
});

test('codex: stop hook ignores non-regular transcript paths', () => {
  if (!existsSync('/dev/zero')) return;
  const hook = join(CODEX, '.codex', 'hooks', 'session-end.sh');
  const cwd = mkdtempSync(join(tmpdir(), 'ijfw-codex-stop-device-'));
  try {
    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'test-session',
      cwd,
      transcript_path: '/dev/zero'
    });
    const out = execFileSync(BASH, [hook], {
      cwd,
      input: payload,
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.equal(out, '');
  } finally {
    rmTmpDir(cwd);
  }
});

test('codex: stop hook emits only actionable compress notice', () => {
  const hook = join(CODEX, '.codex', 'hooks', 'session-end.sh');
  const cwd = mkdtempSync(join(tmpdir(), 'ijfw-codex-stop-compress-'));
  try {
    const transcript = join(cwd, 'rollout.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        message: {
          model: 'gpt-test',
          usage: { input_tokens: 1, output_tokens: 2 }
        }
      }) + '\n'
    );
    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'test-session',
      cwd,
      transcript_path: transcript
    });
    const out = execFileSync(BASH, [hook], {
      cwd,
      input: payload,
      env: { ...process.env, IJFW_COMPRESS_THRESHOLD: '1' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    assert.ok(out, 'compress threshold should emit a notice');
    const obj = JSON.parse(out);
    assert.equal(obj.continue, true);
    assert.match(obj.systemMessage, /Context large -- run: ijfw compress/);
    assert.doesNotMatch(obj.systemMessage, /Session #/);
  } finally {
    rmTmpDir(cwd);
  }
});

// ---- Skills -----------------------------------------------------------------

const EXPECTED_SKILLS = [
  'ijfw-workflow', 'ijfw-handoff', 'ijfw-cross-audit', 'ijfw-commit',
  'ijfw-status', 'ijfw-doctor', 'ijfw-recall', 'ijfw-team',
  'ijfw-compress', 'ijfw-review', 'ijfw-debug', 'ijfw-summarize',
  'ijfw-critique', 'ijfw-memory-audit', 'ijfw-plan-check', 'ijfw-update',
  'ijfw-dashboard', 'ijfw-design', 'ijfw-preflight'
];

test('codex: all expected skill directories exist', () => {
  for (const skill of EXPECTED_SKILLS) {
    const p = join(CODEX, 'skills', skill);
    assert.ok(existsSync(p), `skill dir missing: ${skill}`);
  }
});

test('codex: every skill directory contains SKILL.md', () => {
  for (const skill of EXPECTED_SKILLS) {
    const p = join(CODEX, 'skills', skill, 'SKILL.md');
    assert.ok(existsSync(p), `SKILL.md missing in: ${skill}`);
  }
});

test('codex: SKILL.md files are non-empty', () => {
  for (const skill of EXPECTED_SKILLS) {
    const p = join(CODEX, 'skills', skill, 'SKILL.md');
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      assert.ok(content.length > 50, `SKILL.md suspiciously short: ${skill}`);
    }
  }
});

// ---- ASCII and positive framing ---------------------------------------------

test('codex: IJFW.md is ASCII-only', () => {
  const content = readFileSync(join(CODEX, '.codex', 'IJFW.md'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(content), 'IJFW.md contains non-ASCII characters');
});

test('codex: plugin.json is ASCII-only', () => {
  const content = readFileSync(join(CODEX, '.codex-plugin', 'plugin.json'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(content), 'plugin.json contains non-ASCII characters');
});

// ---- No LLM calls in hooks --------------------------------------------------

test('codex: hooks do not contain calls to AI endpoints', () => {
  const hooksDir = join(CODEX, '.codex', 'hooks');
  const scripts = ['session-start.sh', 'session-end.sh', 'pre-prompt.sh', 'pre-tool-use.sh', 'permission-request.sh', 'post-tool-use.sh'];
  const aiPattern = /curl|wget.*(openai|anthropic|googleapis|gemini)/i;
  for (const s of scripts) {
    const abs = join(hooksDir, s);
    if (existsSync(abs)) {
      const content = readFileSync(abs, 'utf8');
      assert.ok(!aiPattern.test(content), `hook makes LLM call: ${s}`);
    }
  }
});

// ---- Marketplace metadata ---------------------------------------------------

test('codex: marketplace.json exists and is valid JSON', () => {
  const p = join(CODEX, '.agents', 'plugins', 'marketplace.json');
  assert.ok(existsSync(p), 'marketplace.json missing');
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(typeof obj.name === 'string', 'marketplace.json missing name');
  assert.ok(typeof obj.version === 'string', 'marketplace.json missing version');
  assert.ok(typeof obj.install_path === 'string', 'marketplace.json missing install_path');
});
