#!/usr/bin/env node
/**
 * test-agents-md.js -- Phase 2 (A1) AGENTS.md merger regression suite.
 *
 * Covers V3-F1 (block-aware merge), V3-F9 (4-block taxonomy), V3-F12
 * (PID lock + atomic rename), V3-B4 (typed frontmatter schema), and the
 * Phase 2 fix-wave items P2-H2 (real JSON Schema validator), P2-M2
 * (multi-block single-transaction merge), P2-M6 (compute_trust consumer
 * missing -- documents the gap until C6 lands).
 *
 *   1. Seed AGENTS.md from template; assert all 4 marker blocks present.
 *   2. Replace MEMORY block; assert ROUTING/AGENTS/BLACKBOARD bytes
 *      identical before/after the merge.
 *   3. User content outside markers is preserved across a merge.
 *   4. Frontmatter validates against the JSON schema using ajv 2020-12.
 *      P2-H2: real validator + happy-path + 6 distinct negative cases.
 *   5. Concurrent write -- 5 children, no clobber, all succeed, lock cleaned.
 *   6. Stale lock recovery -- write a lock with a non-existent PID; merger
 *      reclaims it.
 *   7. Multi-block merge (P2-M2) -- single invocation updates MEMORY +
 *      AGENTS in one transaction; one backup; atomic rename.
 *   8. compute_trust consumer-missing (P2-M6) -- documents the gap until
 *      Phase 4 wires the Wayland consumer for these fields.
 *
 * Zero external deps for runtime; ajv is a devDependency. ESM.
 * Run: node mcp-server/test-agents-md.js
 */

import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SKILL_DIR = join(REPO_ROOT, 'claude', 'skills', 'ijfw-agents-md');
const TEMPLATE = join(SKILL_DIR, 'templates', 'AGENTS.md.tmpl');
const SCHEMA = join(SKILL_DIR, 'schema', 'agents-md-frontmatter.json');
const MERGER = join(SKILL_DIR, 'scripts', 'merge-block-aware.sh');
const LOCK_SH = join(SKILL_DIR, 'scripts', 'lock.sh');

let pass = 0;
let fail = 0;

function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, msg) { fail++; console.log(`  FAIL ${name}: ${msg}`); }

function run(script, args, opts = {}) {
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return res;
}

function makeWorkdir(label) {
  return mkdtempSync(join(tmpdir(), `ijfw-agents-md-${label}-`));
}

const ALL_BLOCKS = ['MEMORY', 'ROUTING', 'AGENTS', 'BLACKBOARD'];

function blockBounds(text, name) {
  const startM = `<!-- IJFW-${name}-START -->`;
  const endM = `<!-- IJFW-${name}-END -->`;
  const s = text.indexOf(startM);
  const e = text.indexOf(endM);
  if (s === -1 || e === -1 || e < s) return null;
  return { s, e: e + endM.length, startM, endM };
}

function outsideBlock(text, name) {
  const b = blockBounds(text, name);
  if (!b) return text;
  return text.slice(0, b.s) + text.slice(b.e);
}

// ---- Test 1: seed from template ------------------------------------------
function test1_seed() {
  const dir = makeWorkdir('seed');
  const target = join(dir, 'AGENTS.md');
  const r = run(MERGER, [target, 'MEMORY', 'first pointer']);
  if (r.status !== 0) {
    bad('test 1 seed exits 0', `status=${r.status} stderr=${r.stderr}`);
    return;
  }
  const text = readFileSync(target, 'utf8');
  const missing = ALL_BLOCKS.filter(b => !blockBounds(text, b));
  if (missing.length === 0) ok('test 1: all 4 marker blocks present after seed');
  else bad('test 1: all 4 marker blocks present', `missing=${missing.join(',')}`);
  rmSync(dir, { recursive: true, force: true });
}

// ---- Test 2: byte-stable replace -----------------------------------------
function test2_byteStable() {
  const dir = makeWorkdir('byte');
  const target = join(dir, 'AGENTS.md');
  // Seed all four blocks with distinct fingerprints.
  for (const b of ALL_BLOCKS) {
    const r = run(MERGER, [target, b, `body-${b}-init`]);
    if (r.status !== 0) {
      bad(`test 2 seed ${b}`, `status=${r.status} stderr=${r.stderr}`);
      rmSync(dir, { recursive: true, force: true });
      return;
    }
  }
  const before = readFileSync(target, 'utf8');
  // Replace MEMORY only.
  const r2 = run(MERGER, [target, 'MEMORY', 'body-MEMORY-replaced']);
  if (r2.status !== 0) {
    bad('test 2 replace MEMORY', `status=${r2.status} stderr=${r2.stderr}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const after = readFileSync(target, 'utf8');
  // Bytes outside MEMORY block must be identical.
  const beforeOutside = outsideBlock(before, 'MEMORY');
  const afterOutside = outsideBlock(after, 'MEMORY');
  if (beforeOutside === afterOutside) ok('test 2: ROUTING/AGENTS/BLACKBOARD + frontmatter byte-identical');
  else bad('test 2: outside-MEMORY byte-identical', `len-before=${beforeOutside.length} len-after=${afterOutside.length}`);

  // The MEMORY block must contain the new fingerprint and not the old one.
  const memBounds = blockBounds(after, 'MEMORY');
  const memInner = after.slice(memBounds.s, memBounds.e);
  if (memInner.includes('body-MEMORY-replaced') && !memInner.includes('body-MEMORY-init')) {
    ok('test 2: MEMORY inner content swapped');
  } else {
    bad('test 2: MEMORY inner swapped', `inner=${memInner.slice(0, 120)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---- Test 3: preserve user content between blocks -------------------------
function test3_userContent() {
  const dir = makeWorkdir('user');
  const target = join(dir, 'AGENTS.md');
  // Seed.
  for (const b of ALL_BLOCKS) {
    run(MERGER, [target, b, `body-${b}`]);
  }
  // Inject a user paragraph between MEMORY-END and ROUTING-START.
  let text = readFileSync(target, 'utf8');
  const memEnd = '<!-- IJFW-MEMORY-END -->';
  const routStart = '<!-- IJFW-ROUTING-START -->';
  const idxEnd = text.indexOf(memEnd) + memEnd.length;
  const idxStart = text.indexOf(routStart);
  if (idxEnd === -1 || idxStart === -1 || idxStart < idxEnd) {
    bad('test 3 setup', 'marker layout unexpected');
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const userPara = '\n\n## User notes\n\nThis paragraph is hand-authored and must survive.\n\n';
  text = text.slice(0, idxEnd) + userPara + text.slice(idxStart);
  writeFileSync(target, text);

  // Replace the MEMORY block.
  const r = run(MERGER, [target, 'MEMORY', 'body-MEMORY-replaced-test3']);
  if (r.status !== 0) {
    bad('test 3 replace', `status=${r.status} stderr=${r.stderr}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const after = readFileSync(target, 'utf8');
  if (after.includes(userPara.trim())) ok('test 3: user paragraph between MEMORY-END and ROUTING-START preserved');
  else bad('test 3: user paragraph preserved', 'paragraph lost');
  rmSync(dir, { recursive: true, force: true });
}

// ---- Test 4: frontmatter validates via ajv 2020-12 (P2-H2) ---------------
// Replaces the legacy manual shape check. Compiles the schema once and
// asserts every required schema feature: required[], additionalProperties,
// enums, format date-time, and uniqueItems.
function test4_frontmatterSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default ? addFormats.default(ajv) : addFormats(ajv);
  const validate = ajv.compile(schema);

  const happy = {
    ijfw_version: '1.3.0-alpha.1',
    ijfw_schema: 1,
    type: 'software',
    primary_type: 'software',
    secondary_types: ['content'],
    confidence: 0.85,
    detected_at: '2026-05-08T11:00:00Z',
    signals: ['package_json_present', 'file_extension_ratio_code_0.78'],
    compute_trust: 'vm_only',
    compute_net: 'deny',
  };

  // 4a: happy-path validates.
  if (validate(happy)) ok('test 4a: happy-path frontmatter validates via ajv 2020-12');
  else bad('test 4a: happy-path validates', JSON.stringify(validate.errors));

  // 4b: missing ijfw_version is rejected (required[]).
  const noVer = { ...happy };
  delete noVer.ijfw_version;
  if (!validate(noVer)) ok('test 4b: missing ijfw_version rejected');
  else bad('test 4b: missing ijfw_version rejected', 'validator passed');

  // 4c: missing ijfw_schema is rejected (required[]).
  const noSchema = { ...happy };
  delete noSchema.ijfw_schema;
  if (!validate(noSchema)) ok('test 4c: missing ijfw_schema rejected');
  else bad('test 4c: missing ijfw_schema rejected', 'validator passed');

  // 4d: unknown property rejected (additionalProperties: false).
  const extra = { ...happy, mystery_field: 'x' };
  if (!validate(extra)) ok('test 4d: unknown additional property rejected');
  else bad('test 4d: unknown property rejected', 'validator passed');

  // 4e: bad enum value rejected (type='unsupported').
  const badEnum = { ...happy, type: 'unsupported' };
  if (!validate(badEnum)) ok('test 4e: bad enum value rejected');
  else bad('test 4e: bad enum rejected', 'validator passed');

  // 4f: malformed date-time rejected (format date-time).
  const badDate = { ...happy, detected_at: 'not-a-date' };
  if (!validate(badDate)) ok('test 4f: malformed date-time rejected');
  else bad('test 4f: malformed date-time rejected', 'validator passed');

  // 4g: duplicate signals[] entries rejected (uniqueItems).
  // Note: schema currently has uniqueItems on secondary_types[], not signals[].
  // Use secondary_types to exercise the same constraint.
  const dupe = { ...happy, secondary_types: ['content', 'content'] };
  if (!validate(dupe)) ok('test 4g: duplicate items in uniqueItems array rejected');
  else bad('test 4g: duplicate items rejected', 'validator passed');
}

// ---- Test 5: concurrent writers do not clobber ---------------------------
async function test5_concurrent() {
  const dir = makeWorkdir('concurrent');
  const target = join(dir, 'AGENTS.md');
  // Seed once so the file exists for all writers.
  const seed = run(MERGER, [target, 'MEMORY', 'seed']);
  if (seed.status !== 0) {
    bad('test 5 seed', `status=${seed.status} stderr=${seed.stderr}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const N = 5;
  const writers = [];
  for (let i = 0; i < N; i++) {
    const block = ALL_BLOCKS[i % ALL_BLOCKS.length];
    const content = `concurrent-writer-${i}-${block}`;
    writers.push(new Promise((resolve) => {
      const child = spawn('bash', [LOCK_SH, target, block, content], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
      child.on('exit', (code) => resolve({ code, stderr, content, block }));
    }));
  }
  const results = await Promise.all(writers);
  const allOk = results.every(r => r.code === 0);
  if (allOk) ok('test 5: 5 concurrent writers all exited 0');
  else bad('test 5: concurrent exits', JSON.stringify(results.map(r => ({ code: r.code, err: r.stderr.slice(0, 80) }))));

  // Lock file must be cleaned up after all writers finish.
  const lockFile = join(dir, '.AGENTS.md.lock');
  if (!existsSync(lockFile)) ok('test 5: lock file cleaned up after run');
  else bad('test 5: lock cleanup', `lock still exists at ${lockFile}`);

  // File must be valid (4 blocks intact, last writer per block won).
  const text = readFileSync(target, 'utf8');
  const missing = ALL_BLOCKS.filter(b => !blockBounds(text, b));
  if (missing.length === 0) ok('test 5: all 4 marker blocks intact after concurrent merges');
  else bad('test 5: blocks intact', `missing=${missing.join(',')}`);

  // No stray .tmp.* files (atomic rename guarantee).
  const stray = readdirSync(dir).filter(f => f.startsWith('AGENTS.md.tmp.'));
  if (stray.length === 0) ok('test 5: no stray .tmp.* files left over');
  else bad('test 5: tmp cleanup', `stray=${stray.join(',')}`);

  rmSync(dir, { recursive: true, force: true });
}

// ---- Test 6: stale lock reclamation --------------------------------------
function test6_staleLock() {
  const dir = makeWorkdir('stale');
  const target = join(dir, 'AGENTS.md');
  // Seed file so it exists.
  run(MERGER, [target, 'MEMORY', 'pre-stale']);
  // Plant a lock with a PID that is virtually guaranteed not to exist.
  const lockFile = join(dir, '.AGENTS.md.lock');
  // PID 999999 is well outside default kernel pid_max on Linux/macOS.
  writeFileSync(lockFile, '999999\n0\n');

  const r = run(LOCK_SH, [target, 'MEMORY', 'post-stale']);
  if (r.status === 0) ok('test 6: lock.sh reclaims stale lock and merges');
  else bad('test 6: stale reclaim', `status=${r.status} stderr=${r.stderr}`);

  const text = readFileSync(target, 'utf8');
  if (text.includes('post-stale')) ok('test 6: merge after stale reclaim took effect');
  else bad('test 6: merge took effect', 'post-stale content not found');

  rmSync(dir, { recursive: true, force: true });
}

// ---- Test 7: multi-block single-transaction merge (P2-M2) ----------------
// Single lock.sh invocation with two <BLOCK>:<file> pairs must:
//   - update both blocks
//   - take exactly one new backup under ~/.ijfw/state/agents-md/backups/
//   - leave no half-written tmp/lock state
function test7_multiBlock() {
  const dir = makeWorkdir('multi');
  const target = join(dir, 'AGENTS.md');
  // Seed.
  const seed = run(MERGER, [target, 'MEMORY', 'seed-mem']);
  if (seed.status !== 0) {
    bad('test 7 seed', `status=${seed.status} stderr=${seed.stderr}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }

  // Compute the backup dir the merger will use (project-hash on TARGET dir).
  // canonicalize the dir to match merger's `cd -P`.
  const canonicalDir = (() => {
    const r = spawnSync('bash', ['-c', `cd -P "${dir}" && pwd`], { encoding: 'utf8' });
    return (r.stdout || dir).trim();
  })();
  const projectHash = createHash('sha256').update(canonicalDir).digest('hex').slice(0, 12);
  const backupDir = join(homedir(), '.ijfw', 'state', 'agents-md', 'backups', projectHash);

  // Snapshot existing backups so we can count net-new.
  const before = existsSync(backupDir) ? readdirSync(backupDir).filter(f => f.startsWith('AGENTS.md.bak.')) : [];

  // Write two block files.
  const memFile = join(dir, '_mem.txt');
  const agFile = join(dir, '_ag.txt');
  writeFileSync(memFile, 'multi-pair-MEMORY-content\n');
  writeFileSync(agFile, '- **role-a** -- desc a\n- **role-b**\n');

  // Multi-pair invocation through lock.sh.
  const r = run(LOCK_SH, [target, `MEMORY:${memFile}`, `AGENTS:${agFile}`]);
  if (r.status === 0) ok('test 7: multi-pair lock invocation exits 0');
  else bad('test 7: multi-pair exit', `status=${r.status} stderr=${r.stderr}`);

  const text = readFileSync(target, 'utf8');
  const memBounds = blockBounds(text, 'MEMORY');
  const agBounds = blockBounds(text, 'AGENTS');
  const memInner = memBounds ? text.slice(memBounds.s, memBounds.e) : '';
  const agInner = agBounds ? text.slice(agBounds.s, agBounds.e) : '';
  if (memInner.includes('multi-pair-MEMORY-content') && agInner.includes('role-a') && agInner.includes('role-b')) {
    ok('test 7: both MEMORY and AGENTS blocks updated in single transaction');
  } else {
    bad('test 7: blocks updated', `mem=${memInner.slice(0, 80)} ag=${agInner.slice(0, 80)}`);
  }

  // Exactly one net-new backup file should exist (not two -- single backup).
  const after = existsSync(backupDir) ? readdirSync(backupDir).filter(f => f.startsWith('AGENTS.md.bak.')) : [];
  const netNew = after.filter(f => !before.includes(f));
  if (netNew.length === 1) ok('test 7: single backup taken for multi-pair (not one per block)');
  else bad('test 7: single backup', `net-new=${netNew.length} (expected 1)`);

  // No stray tmp / lock files left.
  const stray = readdirSync(dir).filter(f => f.startsWith('AGENTS.md.tmp.') || f === '.AGENTS.md.lock');
  if (stray.length === 0) ok('test 7: no half-written tmp or lock state remains');
  else bad('test 7: clean state', `stray=${stray.join(',')}`);

  rmSync(dir, { recursive: true, force: true });
}

// ---- Test 8: compute_trust consumer missing (P2-M6) ----------------------
// Documents the schema-reservation gap honestly.
//
// Phase 4 (C6) will wire the Wayland consumer for compute_trust + compute_net.
// Until C6 lands, the read pathway in wayland/plugins/ijfw/_handlers.py does
// not reference these fields. This test asserts that pathway is unwired and
// that frontmatter carrying the fields parses + degrades gracefully (no
// crash; consumer simply does nothing).
//
// When Phase 4 lands, this test should be flipped to assert successful read.
function test8_computeTrustConsumerMissing() {
  // Inspect the Wayland handler source for any consumer reference.
  const handlerPath = join(REPO_ROOT, 'wayland', 'plugins', 'ijfw', '_handlers.py');
  if (!existsSync(handlerPath)) {
    bad('test 8 setup', `wayland handler not found at ${handlerPath}`);
    return;
  }
  const src = readFileSync(handlerPath, 'utf8');
  // Look for any read-side reference: function call, attribute access, or
  // os.environ override that bridges these schema fields into the sandbox.
  const consumerSignals = [
    /compute_trust/,
    /compute_net/,
    /IJFW_COMPUTE_TRUST/,
    /IJFW_COMPUTE_NET/,
  ];
  const hits = consumerSignals.filter(re => re.test(src));
  // Phase 2 contract: NO consumer wired yet. Test passes when zero signals
  // present (gap is honest). Phase 4 will flip this assertion to require the
  // four signals.
  if (hits.length === 0) {
    ok('test 8: compute_trust/compute_net consumer absent (Phase 4 / C6 will wire it)');
  } else {
    bad('test 8: consumer absent', `unexpected signals found: ${hits.map(r => r.source).join(', ')} -- if Phase 4 has shipped, flip this assertion`);
  }

  // Independently verify schema reserves both fields with correct enums.
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  const props = schema.properties || {};
  const trustEnum = (props.compute_trust && props.compute_trust.enum) || [];
  const netEnum = (props.compute_net && props.compute_net.enum) || [];
  const trustOk = trustEnum.includes('vm_only') && trustEnum.includes('subprocess');
  const netOk = netEnum.includes('deny') && netEnum.includes('allow');
  if (trustOk && netOk) ok('test 8: schema reserves compute_trust + compute_net fields with expected enums');
  else bad('test 8: schema reservation', `trust=${JSON.stringify(trustEnum)} net=${JSON.stringify(netEnum)}`);

  // Verify a frontmatter carrying these fields validates -- the read
  // pathway is missing but the write/validate pathway must already accept
  // them so projects can declare them today.
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default ? addFormats.default(ajv) : addFormats(ajv);
  const validate = ajv.compile(schema);
  const sample = {
    ijfw_version: '1.3.0-alpha.1',
    ijfw_schema: 1,
    compute_trust: 'vm_only',
    compute_net: 'deny',
  };
  if (validate(sample)) ok('test 8: frontmatter declaring compute_trust=vm_only + compute_net=deny validates');
  else bad('test 8: validate compute fields', JSON.stringify(validate.errors));
}

(async function main() {
  console.log('=== AGENTS.md merger regression (Phase 2 / A1) ===');
  // Sanity: required artifacts exist.
  for (const f of [TEMPLATE, SCHEMA, MERGER, LOCK_SH]) {
    if (!existsSync(f)) {
      bad('precondition: artifact present', f);
      console.log(`\nagents-md tests: pass=${pass} fail=${fail}`);
      process.exit(2);
    }
  }
  ok('precondition: template / schema / merger / lock all present');

  test1_seed();
  test2_byteStable();
  test3_userContent();
  test4_frontmatterSchema();
  await test5_concurrent();
  test6_staleLock();
  test7_multiBlock();
  test8_computeTrustConsumerMissing();

  console.log(`\nagents-md tests: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('test-agents-md crashed:', e && e.stack || e);
  process.exit(2);
});
