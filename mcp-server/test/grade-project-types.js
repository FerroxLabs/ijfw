#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- A3 fixture grader.
//
// Walks every fixture under test/fixtures/project-types/<domain>/<n>/, runs
// detect() against it, compares to the fixture's expected.json. Emits a
// per-domain pass rate. Exits 1 if any domain falls below 90%.
//
// Run: node mcp-server/test/grade-project-types.js
//
// Per the rubric (test/fixtures/project-types/grading-rubric.md):
//   - primary_type must match exactly
//   - secondary_types must set-equal expected
//   - confidence >= expected.confidence_floor
//   - scan_incomplete + fallback_reason match expected
//
// Per-domain 90% gate (NOT aggregate). One weak domain trips the gate.

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { detect } from '../src/project-type-detector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, '..', '..', 'test', 'fixtures', 'project-types');

const DOMAINS = ['software', 'book', 'content', 'business', 'design'];
const PASS_GATE = 0.9; // 90% per-domain

function setEqual(a, b) {
  const sa = new Set((a || []).map(String).sort());
  const sb = new Set((b || []).map(String).sort());
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

function gradeFixture(domain, fixtureDir) {
  const expectedPath = join(fixtureDir, 'expected.json');
  if (!existsSync(expectedPath)) {
    return { ok: false, reason: 'missing expected.json' };
  }
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));

  let result;
  try {
    result = detect(fixtureDir, { resume: false });
  } catch (err) {
    return { ok: false, reason: 'detector threw: ' + (err && err.message ? err.message : String(err)) };
  }

  const reasons = [];
  if (result.primary_type !== expected.primary_type) {
    reasons.push(`primary_type: got ${result.primary_type}, want ${expected.primary_type}`);
  }
  if (!setEqual(result.secondary_types, expected.secondary_types)) {
    reasons.push(`secondary_types: got ${JSON.stringify(result.secondary_types)}, want ${JSON.stringify(expected.secondary_types)}`);
  }
  if (typeof expected.confidence_floor === 'number' && result.confidence < expected.confidence_floor) {
    reasons.push(`confidence: got ${result.confidence}, floor ${expected.confidence_floor}`);
  }
  if (Boolean(result.scan_incomplete) !== Boolean(expected.scan_incomplete)) {
    reasons.push(`scan_incomplete: got ${result.scan_incomplete}, want ${expected.scan_incomplete}`);
  }
  if ((result.fallback_reason || null) !== (expected.fallback_reason || null)) {
    reasons.push(`fallback_reason: got ${result.fallback_reason}, want ${expected.fallback_reason}`);
  }

  return reasons.length === 0
    ? { ok: true, primary: result.primary_type, confidence: result.confidence }
    : { ok: false, reason: reasons.join('; '), got: { primary_type: result.primary_type, secondary_types: result.secondary_types, confidence: result.confidence } };
}

function main() {
  if (!existsSync(FIXTURES_ROOT)) {
    console.error(`fixtures root not present: ${FIXTURES_ROOT}`);
    process.exit(1);
  }

  let totalPass = 0;
  let totalFail = 0;
  let gateFail = false;
  const perDomain = {};

  for (const domain of DOMAINS) {
    const domainDir = join(FIXTURES_ROOT, domain);
    if (!existsSync(domainDir)) {
      console.error(`domain dir missing: ${domain}`);
      gateFail = true;
      continue;
    }
    const fixtureNames = readdirSync(domainDir)
      .filter((n) => statSync(join(domainDir, n)).isDirectory())
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));

    let pass = 0;
    let fail = 0;
    const failures = [];
    for (const name of fixtureNames) {
      const dir = join(domainDir, name);
      const r = gradeFixture(domain, dir);
      if (r.ok) {
        pass += 1;
      } else {
        fail += 1;
        failures.push({ name, reason: r.reason, got: r.got });
      }
    }
    const rate = fixtureNames.length > 0 ? pass / fixtureNames.length : 0;
    perDomain[domain] = { pass, fail, rate, failures, total: fixtureNames.length };
    totalPass += pass;
    totalFail += fail;
    if (rate < PASS_GATE) gateFail = true;
  }

  console.log('A3 grading rates (per-domain 90% gate):');
  for (const domain of DOMAINS) {
    const d = perDomain[domain];
    if (!d) continue;
    const pct = (d.rate * 100).toFixed(1);
    const flag = d.rate >= PASS_GATE ? 'ok' : 'BELOW GATE';
    console.log(`  ${domain.padEnd(9)} ${d.pass}/${d.total}  (${pct}%)  ${flag}`);
    if (d.failures.length) {
      for (const f of d.failures) {
        console.log(`    - fixture ${f.name}: ${f.reason}`);
      }
    }
  }
  console.log(`Total: ${totalPass} pass / ${totalFail} fail (${totalPass + totalFail} fixtures)`);
  if (gateFail) {
    console.error('FAIL: at least one domain below the 90% gate');
    process.exit(1);
  }
  console.log('PASS: every domain at or above the 90% gate');
}

main();
