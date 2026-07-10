// issue #27 — argv-pin for the gitleaks preflight gate.
//
// The gate spawns `gitleaks detect ... -v`. Without `--redact`, gitleaks
// prints each finding's literal secret VALUE, and the gate captures that
// stdout into its FAIL `details`, which is serialized into preflight-report.json
// and uploaded as a public-repo CI artifact (14-30d retention) -- turning the
// leak scanner into a leak amplifier. `--redact` masks the value (shown as
// REDACTED) while keeping the finding's location/rule/line. This pins the flag
// so it cannot be silently dropped again (empirically verified against the
// pinned gitleaks 8.30.1: value is plaintext without --redact, REDACTED with).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_SRC = join(__dirname, '..', 'src', 'preflight', 'gates', 'gitleaks.js');

// Extract the real string-literal ELEMENTS of the `detect` argv array, with
// comments stripped first so an inline-commented flag (`/* '--redact' */`)
// cannot falsely satisfy the pin (adversarial-review nit). Returns the list of
// argv tokens actually passed to gitleaks.
function detectArgvTokens(src) {
  const m = src.match(/\[\s*'detect'[\s\S]*?\]/);
  assert.ok(m, 'could not locate the gitleaks detect argv array');
  const argvBlock = m[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments
    .replace(/\/\/[^\n]*/g, '');        // strip line comments
  return [...argvBlock.matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

test('gitleaks gate argv includes --redact (no plaintext secret in artifacts)', () => {
  const tokens = detectArgvTokens(readFileSync(GATE_SRC, 'utf8'));

  assert.ok(tokens.includes('--redact'),
    `gitleaks detect argv MUST include --redact (got: ${tokens.join(' ')})`);
  // Sanity: -v still present (redact masks the value, not the finding output
  // the gate parses); --exit-code 1 still present (still fails on a real leak).
  assert.ok(tokens.includes('-v'), 'gitleaks detect argv should keep -v for finding details');
  const ec = tokens.indexOf('--exit-code');
  assert.ok(ec !== -1 && tokens[ec + 1] === '1', 'gitleaks detect argv should keep --exit-code 1');
});

test('gitleaks argv pin is not defeated by an inline-commented flag (self-check)', () => {
  // Prove the comment-stripping actually works: a commented --redact must NOT
  // count as present.
  const fake = "const res = spawnSync('gitleaks', ['detect', '--no-git', /* '--redact' */ '-v', '--exit-code', '1']);";
  assert.ok(!detectArgvTokens(fake).includes('--redact'),
    'a commented-out --redact must not satisfy the pin');
});
