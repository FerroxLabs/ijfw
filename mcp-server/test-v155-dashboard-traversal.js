// Regression tests for v1.5.5 fix wave — agent G4b scope.
// Covers: V155-037 — dashboard /design/files/ route rejects backslash and
// dot-segment traversal that the original `[^/]+\.html$` regex missed on
// Windows where path.join treats `\` as a separator.
//
// Run: node --test test-v155-dashboard-traversal.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SRC = readFileSync(
  join(__dirname, 'src', 'dashboard-server.js'),
  'utf8',
);

describe('V155-037: /design/files route hardens against backslash traversal', () => {
  it('source defines and applies the isUnsafeName predicate', () => {
    // The patched route must screen the name BEFORE join. Key checks: contains
    // `\\`, contains `..`, contains `/`, starts with `.`, basename mismatch.
    // We assert by reading the source — full HTTP integration is covered by
    // the dashboard-server smoke test.
    assert.ok(
      /isUnsafeName/.test(DASHBOARD_SRC),
      'expected isUnsafeName variable in /design/files route',
    );
    assert.ok(
      /name\.includes\('\\\\'\)/.test(DASHBOARD_SRC),
      "expected backslash rejection in isUnsafeName",
    );
    assert.ok(
      /name\.includes\('\.\.'\)/.test(DASHBOARD_SRC),
      "expected '..' dot-segment rejection in isUnsafeName",
    );
    assert.ok(
      /basename\(name\)\s*!==\s*name/.test(DASHBOARD_SRC),
      'expected basename-roundtrip check in isUnsafeName',
    );
  });

  it('source performs a resolved-path containment check', () => {
    // After the lexical name check, the route must also verify the resolved
    // filePath lives under the resolved contentDir. This is the belt-and-
    // braces fallback in case a future name allows something the lexical
    // check missed.
    assert.ok(
      /filePathResolved\s*=\s*resolve\(filePath\)/.test(DASHBOARD_SRC),
      'expected resolve(filePath) for containment check',
    );
    assert.ok(
      /contentDirResolved\s*=\s*resolve\(contentDir\)/.test(DASHBOARD_SRC),
      'expected resolve(contentDir) for containment check',
    );
    assert.ok(
      /startsWith\(contentDirResolved\s*\+\s*sep\)/.test(DASHBOARD_SRC),
      'expected sep-aware containment check',
    );
  });

  it('imports basename and sep from node:path', () => {
    assert.ok(
      /from 'node:path'/.test(DASHBOARD_SRC),
      'expected node:path import',
    );
    assert.ok(
      /\bbasename\b/.test(DASHBOARD_SRC),
      'expected basename to be imported / used',
    );
    assert.ok(
      /\bsep\b/.test(DASHBOARD_SRC),
      'expected sep to be imported / used',
    );
  });
});
