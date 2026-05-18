/**
 * agents-md-blackboard.js — v1.5.0 S4: populate AGENTS.md BLACKBOARD block.
 *
 * Closes lock-in #28: the BLACKBOARD marker block in AGENTS.md is spec'd in
 * ijfw-agents-md/SKILL.md but currently empty. checkpointWave (S5) calls this
 * after writing wave state to keep AGENTS.md in sync with the live wave.
 *
 * Concurrency: serialised via withFsLock on AGENTS.md path.
 * Failure handling: silent fail (returns {ok:false, reason}) so a missing
 * merger script does NOT block checkpoint. Caller decides whether to surface.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWaveState } from './wave-state.js';
import { withFsLock } from '../fs-lock.js';

const execFileP = promisify(execFile);

export async function populateBlackboardBlock(waveId, projectRoot) {
  const state = await readWaveState(waveId, projectRoot);
  if (!state) return { ok: false, reason: 'no-state' };

  const payload = JSON.stringify({
    wave_id: waveId,
    state_path: `.ijfw/wave-${waveId}/STATE.md`,
    status: state.frontmatter.status,
    claims_active: state.frontmatter.claims_active ?? 0,
    blockers_open: state.frontmatter.blockers_open ?? [],
    findings_recent: state.frontmatter.findings_recent ?? [],
    updated_at: new Date().toISOString(),
  }, null, 2);

  const mergerPath = join(projectRoot, 'claude', 'skills', 'ijfw-agents-md', 'scripts', 'merge-block-aware.sh');
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const lockDir = join(projectRoot, '.ijfw', 'state');
  const lock = join(lockDir, 'AGENTS.md.lock');

  if (!existsSync(mergerPath)) return { ok: false, reason: 'merger-missing' };

  return await withFsLock(lock, async () => {
    try {
      await execFileP('bash', [mergerPath, agentsMdPath, 'BLACKBOARD', payload], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'merger-failed', stderr: err.stderr ? String(err.stderr) : '' };
    }
  });
}
