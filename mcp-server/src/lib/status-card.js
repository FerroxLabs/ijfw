// Shared status-card composer -- one source of truth for the per-turn
// "[ijfw] context: X% | 1.1.6 available" line that Codex Stop + Gemini
// AfterAgent + (eventually) other-platform hooks all surface.
//
// Inputs:
//   contextPct  number 0..100 (optional) -- estimated context-used percentage
//                If null, the bar is omitted; only the update nudge surfaces.
//   ijfwHome    string (optional) -- override for ~/.ijfw (testing)
//
// Output:
//   string -- single-line card, or '' when nothing useful to surface.
//   Caller is responsible for embedding into the platform-specific envelope
//   (systemMessage / additionalContext / etc.).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function readJsonSafe(p) {
  try { if (!existsSync(p)) return null; return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return null; }
}

function cmpSemver(a, b) {
  const parse = v => {
    const [main, pre] = String(v).split('-', 2);
    const nums = main.split('.').map(n => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || null };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return A.pre < B.pre ? -1 : 1;
}

export function composeStatusCard(opts = {}) {
  const root = opts.ijfwHome || process.env.IJFW_HOME || join(homedir(), '.ijfw');
  const state = readJsonSafe(join(root, 'state.json')) || {};
  const cache = readJsonSafe(join(root, 'cache', 'update-check.json')) || {};
  const settings = readJsonSafe(join(root, 'settings.json')) || {};

  // Update segment with re-entrancy guard (matches statusline + prelude logic)
  let updateSeg = '';
  if (cache.last_latest_seen) {
    const installed = state.installed_version || '0.0.0';
    const lastApplied = state.last_applied_version;
    const stillBehind = cmpSemver(installed, cache.last_latest_seen) < 0;
    const reentrancyOk = !lastApplied || cmpSemver(lastApplied, cache.last_latest_seen) < 0;
    if (stillBehind && reentrancyOk) {
      updateSeg = `${cache.last_latest_seen} available`;
    }
  }

  // Context segment (only when we have a number)
  let ctxSeg = '';
  const pct = opts.contextPct;
  if (typeof pct === 'number' && isFinite(pct) && pct >= 0 && pct <= 100) {
    const cb = settings.context_bar || {};
    const style = cb.style || 'left';
    const used = Math.round(pct);
    const remaining = Math.max(0, 100 - used);
    ctxSeg =
      style === 'runway' ? `${remaining}% runway` :
      style === 'classic' ? `${used}% used` :
      `${remaining}% left`;
  }

  if (!updateSeg && !ctxSeg) return '';
  const parts = [];
  if (ctxSeg) parts.push(`context: ${ctxSeg}`);
  if (updateSeg) parts.push(`update: ${updateSeg}`);
  return `[ijfw] ${parts.join(' | ')}`;
}

// Estimate context % from a transcript file's byte size.
// Heuristic shared with Codex's PreCompact workaround in session-end.sh.
//   - Default model context window: 200_000 tokens (Claude Sonnet 4.6 ballpark).
//   - Token estimate: bytes / 3.5 (rough English heuristic).
//   - Returns null when transcript missing or empty.
export function estimateContextPctFromTranscript(transcriptPath, opts = {}) {
  const { modelContextTokens = 200_000, bytesPerToken = 3.5 } = opts;
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    const sz = statSync(transcriptPath).size;
    if (sz <= 0) return null;
    const tokens = sz / bytesPerToken;
    const pct = Math.min(99, Math.max(0, (tokens / modelContextTokens) * 100));
    return pct;
  } catch { return null; }
}
