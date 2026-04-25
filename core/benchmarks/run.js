#!/usr/bin/env node
// IJFW benchmark runner - scaffold.
// Spawns `claude -p --output-format json` per (task, arm, epoch), parses usage+cost, writes JSONL.
// Default cost cap $10; abort if running total exceeds cap.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, 'runs');
const TASKS_DIR = join(HERE, 'tasks');

const ARMS = {
  A: { env: { CLAUDE_DISABLE_PLUGINS: '1' } },
  B: { env: { IJFW_TERSE_ONLY: '1' } },
  C: { env: {} },
};

function parseArgs(argv) {
  const out = { task: null, arm: 'C', epochs: 1, dryRun: false, really: false, maxCostUsd: 10, model: null, skillVariant: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--arm') out.arm = argv[++i];
    else if (a === '--epochs') out.epochs = parseInt(argv[++i], 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--really') out.really = true;
    else if (a === '--max-cost-usd') out.maxCostUsd = parseFloat(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    // A5 - skill-variant: path to a SKILL.md that replaces ijfw-core during this run.
    // Useful for A/B testing skill rewrites without permanently changing the plugin.
    else if (a === '--skill-variant') out.skillVariant = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`ijfw benchmark runner
Usage: node run.js --task <id> [--arm A|B|C] [--epochs N] [--dry-run | --really] [--max-cost-usd N] [--model M]
  --dry-run          validate fixture, do not spawn claude
  --really           actually invoke claude (otherwise refuses)
  --max-cost-usd N   abort if cumulative cost exceeds N (default 10)
  --model M          pass --model to claude (e.g. claude-sonnet-4-6, claude-haiku-4-5)
  --skill-variant P  swap ijfw-core SKILL.md with file at P for this run (A/B)
`);
}

function loadManifest(taskId) {
  const p = join(TASKS_DIR, taskId, 'manifest.json');
  if (!existsSync(p)) throw new Error(`manifest missing: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadPrompt(taskId) {
  const p = join(TASKS_DIR, taskId, 'README.md');
  return readFileSync(p, 'utf8');
}

function runClaude(arm, prompt, manifest, model) {
  const armDef = ARMS[arm];
  if (!armDef) throw new Error(`unknown arm: ${arm}`);
  const env = { ...process.env, ...armDef.env };
  const args = ['-p', '--output-format', 'json', '--max-turns', String(manifest.max_turns ?? 20)];
  if (model) args.push('--model', model);
  const res = spawnSync('claude', args, {
    input: prompt,
    env,
    encoding: 'utf8',
    timeout: (manifest.timeout_s ?? 300) * 1000,
  });
  if (res.error) throw res.error;
  let parsed;
  try { parsed = JSON.parse(res.stdout); }
  catch (e) { throw new Error(`non-JSON output: ${res.stdout.slice(0, 200)}`); }
  return parsed;
}

function writeJsonl(record) {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `runs-${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(file, JSON.stringify(record) + '\n');
  return file;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.task) { printHelp(); process.exit(1); }
  const manifest = loadManifest(opts.task);
  const prompt = loadPrompt(opts.task);

  if (opts.dryRun) {
    console.log(`[dry-run] task=${opts.task} arm=${opts.arm} epochs=${opts.epochs}`);
    console.log(`  manifest: ${JSON.stringify(manifest)}`);
    console.log(`  prompt chars: ${prompt.length}`);
    console.log(`  fixture repo: ${existsSync(join(TASKS_DIR, opts.task, 'repo'))}`);
    console.log(`  verify.sh:    ${existsSync(join(TASKS_DIR, opts.task, 'verify.sh'))}`);
    return;
  }

  if (!opts.really) {
    console.error('refusing to spawn claude without --really (this costs real money)');
    process.exit(2);
  }

  // A5 - skill-variant swap. Backup the live ijfw-core SKILL.md, copy the
  // variant into its place for the duration of the run, restore in finally.
  let skillSwap = null;
  if (opts.skillVariant) {
    const fsMod = await import('node:fs');
    const liveSkill = new URL('../../claude/skills/ijfw-core/SKILL.md', import.meta.url).pathname;
    if (!fsMod.existsSync(opts.skillVariant)) {
      console.error(`--skill-variant expects a readable SKILL.md at ${opts.skillVariant}; run cancelled.`);
      process.exit(2);
    }
    const backup = liveSkill + '.bench-backup';
    fsMod.copyFileSync(liveSkill, backup);
    fsMod.copyFileSync(opts.skillVariant, liveSkill);
    skillSwap = { live: liveSkill, backup };
    console.log(`  skill-variant swapped: ${opts.skillVariant} → live`);
  }
  const restore = () => {
    if (skillSwap) {
      try {
        const fsMod = require('node:fs');
        fsMod.copyFileSync(skillSwap.backup, skillSwap.live);
        fsMod.unlinkSync(skillSwap.backup);
      } catch { /* best-effort */ }
    }
  };
  process.once('SIGINT', () => { restore(); process.exit(130); });

  let totalCost = 0;
  try {
  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    if (totalCost >= opts.maxCostUsd) {
      console.error(`ABORT: cumulative cost $${totalCost.toFixed(4)} >= cap $${opts.maxCostUsd}`);
      process.exit(3);
    }
    const started = Date.now();
    const result = runClaude(opts.arm, prompt, manifest, opts.model);
    const durationMs = Date.now() - started;
    const cost = result.total_cost_usd ?? 0;
    totalCost += cost;
    const record = {
      ts: new Date().toISOString(),
      task: opts.task,
      arm: opts.arm,
      epoch,
      duration_ms: durationMs,
      cost_usd: cost,
      model: opts.model || null,
      usage: result.usage ?? null,
      session_id: result.session_id ?? null,
    };
    const file = writeJsonl(record);
    console.log(`  epoch=${epoch} arm=${opts.arm} cost=$${cost.toFixed(4)} total=$${totalCost.toFixed(4)} → ${file}`);
  }
  } finally {
    if (skillSwap) {
      const fsMod = await import('node:fs');
      try {
        fsMod.copyFileSync(skillSwap.backup, skillSwap.live);
        fsMod.unlinkSync(skillSwap.backup);
      } catch { /* best-effort */ }
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
