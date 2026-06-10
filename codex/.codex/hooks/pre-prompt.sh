#!/usr/bin/env bash
# IJFW UserPromptSubmit (Codex) -- deterministic vague-prompt detector.
#
# Codex hook JSON in/out:
#   stdin:  { "event": "UserPromptSubmit", "prompt": "...", "session_id": "..." }
#   stdout: { "continue": true,
#             "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
#                                     "additionalContext": "..." } }
#            OR nothing (exit 0 with no output = pass through)
#
# Bypass conditions:
#   - IJFW_DISABLE=1
#   - .ijfw/config.json {"promptCheck": "off"}
#   - prompt starts with *, /, or #; or contains "ijfw off"
#
# No set -e -- hooks must never crash Codex.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null

# Read user config (best-effort).
PROMPT_CHECK_MODE="signals"
if [ -f ".ijfw/config.json" ] && command -v node >/dev/null 2>&1; then
  cfg_mode=$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(".ijfw/config.json","utf8"));
      process.stdout.write(String(c.promptCheck || ""));
    } catch {}
  ' 2>/dev/null)
  case "$cfg_mode" in
    off|signals|interrupt) PROMPT_CHECK_MODE="$cfg_mode" ;;
  esac
fi
[ "$PROMPT_CHECK_MODE" = "off" ] && exit 0

# Read stdin payload.
HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi
[ -z "$HOOK_STDIN" ] && exit 0

# Resolve prompt-check detector module.
DETECTOR=""
for base in \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/prompt-check.js" ]; then
    DETECTOR="$base/prompt-check.js"
    break
  fi
done
[ -z "$DETECTOR" ] && exit 0

# Single node invocation: vague-prompt detector.
RESULT=$(node --input-type=module -e "
const { checkPrompt } = await import(process.argv[2]);
import { writeFileSync, mkdirSync } from 'fs';
process.stdout.on('error', () => process.exit(0));
let payload = {};
try { payload = JSON.parse(process.argv[1] || '{}'); } catch {}
const prompt = payload.prompt || '';

// Bypass conditions.
if (!prompt || /^[*\/#]/.test(prompt) || /ijfw off/i.test(prompt)) process.exit(0);

const r = checkPrompt(prompt);
try {
  mkdirSync('.ijfw', { recursive: true });
  writeFileSync('.ijfw/.prompt-check-state', JSON.stringify({
    fired: r.vague === true,
    signals: r.signals || [],
    platform: 'codex'
  }));
} catch {}

if (r.vague) {
  let hint = '[ijfw] Prompt looks vague -- ' + r.suggestion;
  if (Array.isArray(r.rewrite) && r.rewrite.length) {
    hint += ' | Try: ' + r.rewrite.slice(0,2).join(' OR ');
  }
  hint += ' | Start with * to skip.';
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: hint
    }
  }) + '\n');
}
" -- "$HOOK_STDIN" "$DETECTOR" 2>>"$HOME/.ijfw/logs/codex-pre-prompt.log")

# Dispatch session-request observation ASYNC (does not affect stdout envelope).
_OBS_CAPTURE="$(dirname "$0")/user-prompt-submit-capture.sh"
if [ -f "$_OBS_CAPTURE" ] && [ -n "$HOOK_STDIN" ]; then
  printf '%s' "$HOOK_STDIN" | bash "$_OBS_CAPTURE" \
    >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

if [ -n "$RESULT" ]; then
  printf '%s' "$RESULT"
fi

# --- Profile-bus INJECT GATE (v1.6.0) ---------------------------------------
# Consent-gated injection of the learned low-sensitivity style brief, mirroring
# claude/hooks/scripts/pre-prompt.sh. Codex emits at most ONE stdout envelope,
# so this only emits when the prompt-check above produced none ($RESULT empty).
#   IJFW_PROFILE_KILL truthy -> never inject; profile.inject "on" -> inject;
#   "off" -> nothing; "ask" + no consent -> one-line nudge once, then stamp.
# CAPTURE below is never gated by this.
if [ -z "$RESULT" ]; then
  PROFILE_SERVE=""
  for base in "$HOME/.ijfw/mcp-server/src" "$(pwd)/mcp-server/src"; do
    if [ -f "$base/profile/serve.js" ]; then PROFILE_SERVE="$base/profile/serve.js"; break; fi
  done
  if [ -n "$PROFILE_SERVE" ] && command -v node >/dev/null 2>&1; then
    PROFILE_OUT=$(node --input-type=module -e "
      import { readFileSync, mkdirSync, writeFileSync } from 'fs';
      import { join } from 'path';
      process.stdout.on('error', () => process.exit(0));
      const home = process.env.IJFW_HOME || join(process.env.HOME || '', '.ijfw');
      const sf = join(home, 'settings.json');
      let ps = { inject: 'ask', inject_consent_version: null };
      try { const s = JSON.parse(readFileSync(sf,'utf8')); if (s && typeof s.profile==='object') ps = { inject: s.profile.inject||'ask', inject_consent_version: s.profile.inject_consent_version||null }; } catch {}
      const kill = String(process.env.IJFW_PROFILE_KILL||'').trim().toLowerCase();
      const killed = kill!=='' && kill!=='0' && kill!=='false' && kill!=='no' && kill!=='off';
      const inject = killed ? 'off' : ps.inject;
      let ctx = null;
      if (inject === 'on') {
        try {
          const { profileBrief } = await import('file://' + process.argv[1]);
          const r = profileBrief({ context: { host: process.env.IJFW_HOST || 'codex' }, env: process.env, forceLowOnly: true });
          if (r && r.brief && r.brief.trim()) ctx = '[ijfw profile] ' + r.brief.trim() + ' (informative; disable: ijfw personalize off)';
        } catch {}
      } else if (inject === 'ask' && !ps.inject_consent_version) {
        ctx = '[ijfw] IJFW can include your learned writing style in prompts (low-sensitivity only; never raw text). Enable: ijfw personalize on  ·  decline: ijfw personalize off';
        try { let s2={}; try { s2 = JSON.parse(readFileSync(sf,'utf8')); } catch {} s2.profile = Object.assign({ capture:'on', inject:'ask', share_sensitive:false }, s2.profile, { inject_consent_version: '1.6.0' }); mkdirSync(home, { recursive: true }); writeFileSync(sf, JSON.stringify(s2,null,2)+'\\n'); } catch {}
      }
      if (ctx) process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }) + '\\n');
    " -- "$PROFILE_SERVE" 2>>"$HOME/.ijfw/logs/codex-pre-prompt.log")
    [ -n "$PROFILE_OUT" ] && printf '%s' "$PROFILE_OUT" && RESULT="$PROFILE_OUT"
  fi
fi

# --- Profile bus P1: per-message style capture (METADATA ONLY) ---
# Mirrors claude/hooks/scripts/pre-prompt.sh: folds THIS message's metadata
# (length/emoji/code/formality counts -- never the text) into the per-session
# accumulator the SessionEnd flush (codex session-end.sh) turns into one
# .ijfw/.session-style.jsonl record. Best-effort + isolated: a capture failure
# never affects the prompt-check stdout above and never crashes Codex.
CAPTURE=""
for base in \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/capture.js" ]; then CAPTURE="$base/profile/capture.js"; break; fi
done
if [ -n "$CAPTURE" ] && command -v node >/dev/null 2>&1; then
  # Export the canonical host so capture.js resolveHost() stamps the SAME
  # provenance string the codex session-end flush + dream-trigger use ('codex').
  # 'codex' is a known key in capture.js HOST_TRUST (weight 0.9), so per-host
  # trust weighting + provenance stay consistent end-to-end.
  export IJFW_HOST="${IJFW_HOST:-codex}"
  # profile_influenced (P1.2): true when a profile brief was injected into the
  # turn. The prompt-check additionalContext above is our injection surface, so
  # a non-empty RESULT means a brief rode along this turn.
  PROFILE_INJECTED="false"
  [ -n "$RESULT" ] && PROFILE_INJECTED="true"
  node --input-type=module -e "
    const { captureMessage } = await import('file://' + process.argv[2]);
    let payload = {};
    try { payload = JSON.parse(process.argv[1] || '{}'); } catch {}
    try {
      captureMessage({
        sessionId: payload.session_id || null,
        text: payload.prompt || '',
        ts: Date.now(),
        profileInjected: process.argv[3] === 'true',
        cwd: process.cwd(),
        env: process.env,
      });
    } catch {}
  " "$HOOK_STDIN" "$CAPTURE" "$PROFILE_INJECTED" 2>>"$HOME/.ijfw/logs/codex-pre-prompt.log" || true
fi

exit 0
