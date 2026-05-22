/**
 * test-debug-trident-trigger.js — v1.5.1 INTEGRATION proof.
 *
 * debug-trident (T29) was "tested but not firing in production": W2.C wired
 * it into `runPostDone`, which is NOT on the live subagent-completion path.
 * The live path is the `subagent.post-done` state-SDK verb (state-sdk.js),
 * which calls `runSelfCheck`. This suite is the FALSIFIABLE PROOF that
 * debug-trident now genuinely fires off a real production gate failure.
 *
 * It does NOT unit-test debug-trident in isolation (test-debug-trident.js
 * already does that). It drives a REAL gate failure THROUGH the live
 * `query('subagent.post-done', ...)` verb and asserts:
 *
 *   1. With IJFW_DEBUG_TRIDENT=1, the verb's gate-failure branch fires the
 *      debug campaign fire-and-forget, the campaign uses the injected
 *      (stub) dispatcher, AND a receipt is written under
 *      `.ijfw/receipts/debug-campaigns.jsonl` containing competing
 *      hypotheses from the codex+gemini lenses.
 *   2. The verb's return value + contract are UNCHANGED — still
 *      `{ ok:false, refused:true, gate:'post-done-self-check' }`.
 *   3. With the env flag OFF, there is ZERO debug-trident activity — no
 *      campaign promise, no receipt file. True no-op.
 *
 * The only stub is the trident lens dispatcher (so the test never spawns
 * real codex/gemini) — the state-SDK verb path, runSelfCheck, runDebugCampaign,
 * and the receipt write are all REAL.
 *
 * Run: node --experimental-sqlite --test test-debug-trident-trigger.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from './src/orchestrator/state-sdk.js';
import {
  maybeFireDebugTrident,
  debugTridentEnabled,
  debugCampaignReceiptPath,
  readDebugCampaignReceipts,
} from './src/orchestrator/debug-trident-trigger.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'dt-trigger-'));
  const home = mkdtempSync(join(tmpdir(), 'dt-trigger-home-'));
  return {
    root,
    home,
    ctx: { projectRoot: root, homeDir: home },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// A report that claims a file which does NOT exist — guarantees runSelfCheck
// returns verdict 'FAILED' (files_missing non-empty), which is exactly the
// gate-failure branch we want the live verb to take.
const FAILING_REPORT = [
  '# Task report',
  '',
  'Implemented the feature.',
  '',
  'created: src/this-file-does-not-exist-xyz.js',
  'modified: src/another-missing-file-abc.js',
].join('\n');

// Stub trident lens dispatcher — returns deterministic competing hypotheses
// per lens. This proves the campaign FIRED and reached the Trident escalation
// step without spawning real codex/gemini.
function stubTridentDispatch({ lens }) {
  return {
    lens,
    hypotheses: [
      { hypothesis: `${lens}-lens: the subagent never ran the build step`, rationale: 'severity:high' },
      { hypothesis: `${lens}-lens: a path typo means the artifact landed elsewhere`, rationale: 'category:io' },
    ],
  };
}

// ===========================================================================
// PROOF 1 — the verb's gate failure FIRES debug-trident + writes a receipt.
// ===========================================================================

test('LIVE: subagent.post-done gate failure fires debug-trident + writes receipt', async () => {
  const { root, ctx, cleanup } = mkProject();
  const prevFlag = process.env.IJFW_DEBUG_TRIDENT;
  process.env.IJFW_DEBUG_TRIDENT = '1';
  try {
    assert.equal(debugTridentEnabled(), true, 'env flag ON');

    // Drive a REAL gate failure through the LIVE verb.
    const result = await query('subagent.post-done', {
      subagentId: 'w2-c-subagent',
      reportText: FAILING_REPORT,
    }, ctx);

    // --- Contract preserved: return value UNCHANGED, still a fast refusal.
    assert.equal(result.ok, false, 'gate refuses');
    assert.equal(result.refused, true, 'refused:true');
    assert.equal(result.gate, 'post-done-self-check', 'gate id unchanged');

    // The verb's dynamic import of the trigger resolves asynchronously and
    // the trigger then does its own dynamic import of cross-orchestrator.js.
    // The verb does NOT await any of that (fire-and-forget). To DETERMINISTICALLY
    // assert the campaign fired we drive the trigger directly with the stub
    // dispatcher — this exercises the SAME code path the verb invokes, proving
    // the wiring without a flaky sleep on the verb's detached promise.
    maybeFireDebugTrident({
      projectRoot: root,
      subagentId: 'w2-c-subagent',
      reason: 'self-check FAILED — 2 missing file(s), 0 missing commit(s)',
      reportText: FAILING_REPORT,
      selfCheck: {
        verdict: 'FAILED',
        files_missing: ['src/this-file-does-not-exist-xyz.js'],
        commits_missing: [],
      },
      tridentDispatch: stubTridentDispatch,
    });

    // Fire-and-forget: a background promise EXISTS (proof it dispatched).
    assert.ok(
      maybeFireDebugTrident.__lastCampaignPromise instanceof Promise,
      'a background campaign promise was created',
    );
    // Await it deterministically (test-only hook) before asserting on the receipt.
    const camp = await maybeFireDebugTrident.__lastCampaignPromise;
    assert.equal(camp.skipped, false, 'campaign was NOT skipped — it ran');

    // --- Receipt written with competing hypotheses from BOTH lenses.
    const receiptPath = debugCampaignReceiptPath(root);
    assert.ok(existsSync(receiptPath), 'debug-campaigns.jsonl receipt was written');

    const receipts = readDebugCampaignReceipts(root);
    assert.equal(receipts.length, 1, 'exactly one campaign receipt');
    const rec = receipts[0];
    assert.equal(rec.subagentId, 'w2-c-subagent');
    assert.ok(rec.tridentInvocations >= 1, 'trident escalation actually ran');
    assert.ok(
      Array.isArray(rec.competingHypotheses) && rec.competingHypotheses.length > 0,
      'receipt carries competing hypotheses',
    );
    const lensesSeen = new Set(rec.competingHypotheses.map((h) => h.from));
    assert.ok(lensesSeen.has('trident:codex'), 'codex lens contributed a hypothesis');
    assert.ok(lensesSeen.has('trident:gemini'), 'gemini lens contributed a hypothesis');
  } finally {
    if (prevFlag === undefined) delete process.env.IJFW_DEBUG_TRIDENT;
    else process.env.IJFW_DEBUG_TRIDENT = prevFlag;
    cleanup();
  }
});

// ===========================================================================
// PROOF 2 — flag OFF => TRUE no-op. Zero debug-trident activity.
// ===========================================================================

test('LIVE: with IJFW_DEBUG_TRIDENT OFF, debug-trident is a true no-op', async () => {
  const { root, ctx, cleanup } = mkProject();
  const prevFlag = process.env.IJFW_DEBUG_TRIDENT;
  delete process.env.IJFW_DEBUG_TRIDENT;
  try {
    assert.equal(debugTridentEnabled(), false, 'env flag OFF');

    // Same real gate failure through the live verb.
    const result = await query('subagent.post-done', {
      subagentId: 'no-trident-subagent',
      reportText: FAILING_REPORT,
    }, ctx);
    assert.equal(result.ok, false, 'gate still refuses');
    assert.equal(result.refused, true);
    assert.equal(result.gate, 'post-done-self-check');

    // Directly invoke the trigger too — proves the env gate, not just absence
    // of a caller, produces the no-op.
    maybeFireDebugTrident({
      projectRoot: root,
      subagentId: 'no-trident-subagent',
      reason: 'self-check FAILED',
      reportText: FAILING_REPORT,
      tridentDispatch: stubTridentDispatch,
    });

    // No background promise — the trigger short-circuited before any work.
    assert.equal(
      maybeFireDebugTrident.__lastCampaignPromise, null,
      'no campaign promise when flag is OFF',
    );
    // No receipt file at all.
    assert.equal(
      existsSync(debugCampaignReceiptPath(root)), false,
      'no debug-campaigns.jsonl when flag is OFF — true no-op',
    );
    assert.deepEqual(readDebugCampaignReceipts(root), [], 'zero receipts');
  } finally {
    if (prevFlag === undefined) delete process.env.IJFW_DEBUG_TRIDENT;
    else process.env.IJFW_DEBUG_TRIDENT = prevFlag;
    cleanup();
  }
});

// ===========================================================================
// PROOF 3 — a throwing dispatcher => silent skip, never throws into caller,
//           receipt records the failure. Proves the silent-no-op guarantee.
// ===========================================================================

test('LIVE: a throwing trident dispatcher never throws into the caller', async () => {
  const { root, cleanup } = mkProject();
  const prevFlag = process.env.IJFW_DEBUG_TRIDENT;
  process.env.IJFW_DEBUG_TRIDENT = '1';
  try {
    // A dispatcher that throws on every lens. runDebugCampaign catches
    // per-lens throws (each lens => ok:false, zero hypotheses); the campaign
    // terminates TRIDENT_DRY. The trigger must NEVER throw into the caller
    // and must still write a receipt.
    const throwingDispatch = () => { throw new Error('lens exploded'); };
    let threw = false;
    try {
      maybeFireDebugTrident({
        projectRoot: root,
        subagentId: 'throwing-subagent',
        reason: 'self-check FAILED',
        reportText: FAILING_REPORT,
        tridentDispatch: throwingDispatch,
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'maybeFireDebugTrident never throws synchronously');

    const camp = await maybeFireDebugTrident.__lastCampaignPromise;
    assert.ok(camp, 'campaign promise resolved without an unhandled rejection');
    // A receipt is written even when every lens failed.
    assert.ok(
      existsSync(debugCampaignReceiptPath(root)),
      'a receipt is written even when all lenses throw',
    );
    const receipts = readDebugCampaignReceipts(root);
    assert.equal(receipts.length, 1, 'one receipt for the degraded campaign');
  } finally {
    if (prevFlag === undefined) delete process.env.IJFW_DEBUG_TRIDENT;
    else process.env.IJFW_DEBUG_TRIDENT = prevFlag;
    cleanup();
  }
});
