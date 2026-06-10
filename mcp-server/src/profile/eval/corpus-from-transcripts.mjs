/**
 * profile/eval/corpus-from-transcripts.mjs — REAL-CORPUS builder for the
 * profile-bus eval (v1.6.0). Turns the user's OWN Claude Code transcripts into
 * the `{ sessions, feedback }` shape the REAL capture/derive pipeline consumes,
 * so Gate B/C can be run against genuine "learns YOU" data instead of a synthetic
 * fixture.
 *
 * ── PRIVACY (the load-bearing invariant) ───────────────────────────────────
 * Raw transcript TEXT never leaves this process and is never persisted as a
 * style record. Each user message is reduced to COUNTS via the REAL
 * `extractMessageMetadata` (capture.js) and the string is discarded. The ONLY
 * place raw-ish text survives is a `.session-feedback.jsonl` row's `context`
 * snippet (the feedback detector's 120-char window) — and that file is written
 * ONLY to the local, gitignored scratch dir and is NEVER sent to any cloud API
 * (the cloud only ever sees the DERIVED brief = slugs, plus authored prompts).
 *
 * ── METHOD ─────────────────────────────────────────────────────────────────
 *  1. Walk ~/.claude/projects/<projectDir>/<uuid>.jsonl.
 *  2. Keep lines: type==='user' AND message.content is a STRING AND NOT isMeta
 *     AND not a slash-command/hook/system artifact (those are not the user's
 *     own authored prose — counting them would poison the style fingerprint).
 *  3. Group by sessionId. For each session: fold per-message metadata into a
 *     counts-only accumulator (mirrors capture.js flushSession math EXACTLY) and
 *     run the REAL `detectFeedback` over each human message → feedback rows.
 *  4. Emit one session record per session with: a `metadata` block in the exact
 *     `toDeriveMeta`/deriveStyle input shape, a `feedback[]` array in the
 *     .session-feedback.jsonl shape, a session `ts` (first human-message time),
 *     and `host: 'claude-code'`.
 *
 * Zero deps. Node built-ins only. No network. No LLM.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractMessageMetadata } from '../capture.js';
import { detectFeedback } from '../../feedback-detector.js';

/** Default corpus root: the user's real Claude Code transcript store. */
export function defaultProjectsRoot() {
  return join(homedir(), '.claude', 'projects');
}

/**
 * A user message line is "authored human prose" iff it is a plain string turn
 * that is NOT a slash-command expansion, hook-injected context, system reminder,
 * tool-result echo, or interrupt marker. These artifacts are machine-authored
 * (or template-expanded) and counting them would corrupt the style signal.
 */
const ARTIFACT_PREFIXES = [
  '<command-name>', '<command-message>', '<command-args>', '<local-command-',
  '<system-reminder', '<user-memory-input>', 'Caveat:', '[Request interrupted',
  '<bash-', '<task-', '<post-tool-use', '<pre-tool-use',
];
function isAuthoredHumanText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  for (const p of ARTIFACT_PREFIXES) if (t.startsWith(p)) return false;
  // A pasted system-reminder block mid-text is still machine context.
  if (t.startsWith('<') && t.includes('</')) return false;
  return true;
}

/** Per-session counts accumulator — identical math to capture.js flushSession. */
function freshAcc(sessionId) {
  return {
    session_id: sessionId,
    first_ts: null, last_ts: null,
    msg_count: 0, total_chars: 0, total_emojis: 0,
    code_msgs: 0, formality_msgs: 0,
    feedback: [],
  };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Fold one accumulator into the eval session record. Mirrors capture.js
 * flushSession's field derivation (avg_msg_chars / emoji_rate / code_block_ratio
 * / formality_markers / turn_cadence_s) then maps to the deriveStyle input shape
 * (emoji_per_msg, turn_cadence_per_min) — exactly toDeriveMeta's transform — so
 * the heuristic derive sees production-identical metadata.
 */
function accToSession(acc, host) {
  const n = acc.msg_count;
  if (n <= 0) return null;
  const avgChars = acc.total_chars / n;
  const emojiRate = acc.total_emojis / n;
  const codeRatio = clamp01(acc.code_msgs / n);
  const formality = clamp01(acc.formality_msgs / n);
  let cadenceS = 0;
  if (n > 1 && Number.isFinite(acc.first_ts) && Number.isFinite(acc.last_ts) && acc.last_ts > acc.first_ts) {
    cadenceS = ((acc.last_ts - acc.first_ts) / 1000) / (n - 1);
  }
  const metadata = {
    avg_msg_chars: Math.round(avgChars * 100) / 100,
    emoji_per_msg: Math.round(emojiRate * 1000) / 1000,
    code_block_ratio: Math.round(codeRatio * 1000) / 1000,
    formality_markers: Math.round(formality * 1000) / 1000,
    turn_cadence_per_min: cadenceS > 0 ? Math.round((60 / cadenceS) * 1000) / 1000 : 0,
  };
  const tsIso = Number.isFinite(acc.first_ts) ? new Date(acc.first_ts).toISOString() : null;
  // Stamp session_id/ts onto every feedback row (capture's contract).
  const feedback = acc.feedback.map((f) => ({
    session_id: acc.session_id,
    ts: tsIso,
    kind: f.kind,
    phrase: f.phrase,
    context: f.context,
  }));
  return {
    session_id: acc.session_id,
    sessionId: acc.session_id,
    host,
    ts: tsIso,
    metadata,
    feedback,
    msg_count: n,
  };
}

/**
 * parseTranscript(file) -> Map<sessionId, acc>. One .jsonl may contain a single
 * session (the common case) but we group by the line's own sessionId to be safe.
 */
function parseTranscript(file, accumulators, _host) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return; }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'user' || !o.message) continue;
    if (o.isMeta === true) continue;
    const content = o.message.content;
    if (!isAuthoredHumanText(content)) continue; // string-only + non-artifact

    const sid = String(o.sessionId || o.session_id || '').trim();
    if (!sid) continue;
    let acc = accumulators.get(sid);
    if (!acc) { acc = freshAcc(sid); accumulators.set(sid, acc); }

    // METADATA ONLY — extract counts, discard the string.
    const meta = extractMessageMetadata(content);
    acc.msg_count += 1;
    acc.total_chars += meta.chars;
    acc.total_emojis += meta.emojis;
    if (meta.hasCode) acc.code_msgs += 1;
    if (meta.formalityHits > 0) acc.formality_msgs += 1;

    const t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) {
      if (acc.first_ts === null || t < acc.first_ts) acc.first_ts = t;
      if (acc.last_ts === null || t > acc.last_ts) acc.last_ts = t;
    }

    // REAL feedback detection over the human message (high-precision, low-recall).
    for (const fb of detectFeedback(content)) {
      acc.feedback.push(fb);
    }
  }
}

/**
 * buildCorpus(opts) -> { sessions, stats }.
 *
 * @param {object} [opts]
 *   @param {string} [opts.root]        projects root (default ~/.claude/projects)
 *   @param {number} [opts.minMessages] keep sessions with >= this many human msgs (default 8)
 *   @param {number} [opts.cap]         cap total kept sessions (stratified by project) (default 400)
 *   @param {number} [opts.maxFiles]    safety cap on files scanned (default Infinity)
 *
 * Stratified sampling: we keep up to `perDir` sessions from each project dir so a
 * few huge projects don't dominate the profile. Deterministic (sorted) ordering.
 */
export function buildCorpus(opts = {}) {
  const root = opts.root || defaultProjectsRoot();
  const minMessages = Number.isFinite(opts.minMessages) ? opts.minMessages : 8;
  const cap = Number.isFinite(opts.cap) ? opts.cap : 400;
  const host = 'claude-code';

  let dirs = [];
  try { dirs = readdirSync(root).filter((d) => !d.startsWith('.')); } catch {
    return { sessions: [], stats: { error: `cannot read ${root}` } };
  }
  dirs.sort();

  let filesScanned = 0;
  let sessionsSeen = 0;
  // Collect per-dir kept sessions for stratified capping.
  const perDirSessions = new Map();
  for (const d of dirs) {
    const dirPath = join(root, d);
    let files = [];
    try { files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    files.sort();
    const accumulators = new Map();
    for (const f of files) {
      if (filesScanned >= (opts.maxFiles ?? Infinity)) break;
      const full = join(dirPath, f);
      try { if (!statSync(full).isFile()) continue; } catch { continue; }
      parseTranscript(full, accumulators, host);
      filesScanned += 1;
    }
    const kept = [];
    for (const acc of accumulators.values()) {
      sessionsSeen += 1;
      if (acc.msg_count < minMessages) continue;
      const sess = accToSession(acc, host);
      if (sess && sess.ts) kept.push(sess);
    }
    // sort kept by ts so the per-dir slice is chronological + deterministic
    kept.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (kept.length) perDirSessions.set(d, kept);
  }

  // Stratified cap: round-robin across dirs until we hit `cap`.
  const dirKeys = [...perDirSessions.keys()].sort();
  const sessions = [];
  let added = true;
  const cursors = new Map(dirKeys.map((k) => [k, 0]));
  while (added && sessions.length < cap) {
    added = false;
    for (const k of dirKeys) {
      if (sessions.length >= cap) break;
      const list = perDirSessions.get(k);
      const i = cursors.get(k);
      if (i < list.length) {
        sessions.push(list[i]);
        cursors.set(k, i + 1);
        added = true;
      }
    }
  }

  // Final chronological sort (the eval split is time-based).
  sessions.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const withFeedback = sessions.filter((s) => s.feedback.length > 0).length;
  const totalFeedback = sessions.reduce((n, s) => n + s.feedback.length, 0);
  return {
    sessions,
    stats: {
      projectDirs: dirs.length,
      filesScanned,
      sessionsSeen,
      sessionsKept: sessions.length,
      minMessages,
      cap,
      sessionsWithFeedback: withFeedback,
      totalFeedbackRows: totalFeedback,
      tsMin: sessions.length ? sessions[0].ts : null,
      tsMax: sessions.length ? sessions[sessions.length - 1].ts : null,
    },
  };
}

export default { buildCorpus, defaultProjectsRoot };
