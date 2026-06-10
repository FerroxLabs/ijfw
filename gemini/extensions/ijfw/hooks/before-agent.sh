#!/usr/bin/env bash
# IJFW BeforeAgent (Gemini) -- maps Claude's UserPromptSubmit / pre-prompt.sh.
# Deterministic vague-prompt detector. Injects sharpening context when prompt
# signals are weak.
#
# Gemini hook JSON in/out:
#   stdin:  { "event": "BeforeAgent", "session_id": "...", "prompt": "...", "cwd": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }  OR  { "decision": "allow", "additionalContext": "..." }
#
# No set -e -- hooks must never crash Gemini CLI.

[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

# Read config.
PROMPT_CHECK_MODE="signals"
if [ -f ".ijfw/config.json" ]; then
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
[ "$PROMPT_CHECK_MODE" = "off" ] && printf '{"decision":"allow"}\n' && exit 0

HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(head -c 1048576 2>/dev/null || true)
fi
[ -z "$HOOK_STDIN" ] && printf '{"decision":"allow"}\n' && exit 0

command -v node >/dev/null 2>&1 || { printf '{"decision":"allow"}\n'; exit 0; }

# Resolve prompt-check module.
DETECTOR=""
for base in \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  [ -f "$base/prompt-check.js" ] && DETECTOR="$base/prompt-check.js" && break
done
[ -z "$DETECTOR" ] && printf '{"decision":"allow"}\n' && exit 0

RESULT=$(node --input-type=module -e "
const { checkPrompt } = await import(process.argv[2]);
import { writeFileSync, mkdirSync } from 'fs';
let payload = {};
try { payload = JSON.parse(process.argv[1] || '{}'); } catch {}
const prompt = payload.prompt || '';
// Skip bypass prefixes.
if (/^[*\/#]/.test(prompt) || /ijfw off/i.test(prompt)) { process.exit(0); }
const r = checkPrompt(prompt);
try {
  mkdirSync('.ijfw', { recursive: true });
  writeFileSync('.ijfw/.prompt-check-state', JSON.stringify({ fired: r.vague === true, signals: r.signals || [] }));
} catch {}
if (r.vague) {
  let block = '<ijfw-prompt-check>\n' + r.suggestion;
  if (Array.isArray(r.rewrite) && r.rewrite.length) {
    block += '\n\nAsk back:';
    for (const q of r.rewrite) block += '\n  - ' + q;
  }
  block += '\nOverride: start prompt with * to skip.\nSignals: ' + r.signals.join(', ') + '.\n</ijfw-prompt-check>';
  process.stdout.write(JSON.stringify({ decision: 'allow', additionalContext: block }) + '\n');
}
" "$HOOK_STDIN" "$DETECTOR" 2>/dev/null)

# Dispatch session-request observation ASYNC before emitting terminal envelope.
# Invariant: decision:"allow" must be the TERMINAL stdout line.
_OBS_CAPTURE="$(dirname "$0")/user-prompt-submit-capture.sh"
if [ -f "$_OBS_CAPTURE" ] && [ -n "$HOOK_STDIN" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  printf '%s' "$HOOK_STDIN" | bash "$_OBS_CAPTURE" \
    >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# --- Profile bus P1: per-message style capture (METADATA ONLY) ---
# Gemini's BeforeAgent maps to Claude's UserPromptSubmit and receives the
# {session_id, prompt} payload, so it is a true per-message capture site --
# parity with claude/codex pre-prompt.sh. Folds THIS message's metadata
# (length/emoji/code/formality counts -- never the text) into the per-session
# accumulator the SessionEnd flush (gemini session-end.sh) turns into one
# .ijfw/.session-style.jsonl record. Best-effort + isolated: a capture failure
# never affects the decision envelope below and never crashes Gemini.
#
# NOTE: this MUST run BEFORE the terminal decision:"allow" line (the hook's
# stdout-envelope invariant), but it writes nothing to stdout itself.
CAPTURE=""
for base in \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/capture.js" ]; then CAPTURE="$base/profile/capture.js"; break; fi
done
if [ -n "$CAPTURE" ]; then
  # Export the canonical host so capture.js resolveHost() stamps 'gemini' -- the
  # SAME provenance string the gemini session-end flush + dream-trigger use.
  # 'gemini' is a known key in capture.js HOST_TRUST (weight 0.9).
  export IJFW_HOST="${IJFW_HOST:-gemini}"
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
  " "$HOOK_STDIN" "$CAPTURE" "$PROFILE_INJECTED" 2>>"$HOME/.ijfw/logs/gemini-before-agent.log" || true
fi

# --- Profile-bus INJECT GATE (v1.6.0) ---------------------------------------
# Consent-gated injection of the learned low-sensitivity style brief, mirroring
# claude/codex pre-prompt.sh. Only runs when prompt-check produced no envelope
# ($RESULT empty), so the terminal decision:"allow" line stays the single
# stdout envelope. IJFW_PROFILE_KILL forces off; inject "on" injects; "ask" +
# no consent emits a one-line nudge once then stamps. CAPTURE above is never
# gated by this.
if [ -z "$RESULT" ]; then
  PROFILE_SERVE=""
  for base in "$HOME/.ijfw/mcp-server/src" "$(pwd)/mcp-server/src"; do
    [ -f "$base/profile/serve.js" ] && PROFILE_SERVE="$base/profile/serve.js" && break
  done
  if [ -n "$PROFILE_SERVE" ]; then
    RESULT=$(node --input-type=module -e "
      import { readFileSync, mkdirSync, writeFileSync } from 'fs';
      import { join } from 'path';
      const home = process.env.IJFW_HOME || join(process.env.HOME || '', '.ijfw');
      const sf = join(home, 'settings.json');
      let ps = { inject: 'ask', inject_consent_version: null };
      try { const s = JSON.parse(readFileSync(sf,'utf8')); if (s && typeof s.profile==='object') ps = { inject: s.profile.inject||'ask', inject_consent_version: s.profile.inject_consent_version||null }; } catch {}
      const kill = String(process.env.IJFW_PROFILE_KILL||'').trim().toLowerCase();
      const killed = kill!=='' && kill!=='0' && kill!=='false' && kill!=='no' && kill!=='off';
      const inject = killed ? 'off' : ps.inject;
      let block = null;
      if (inject === 'on') {
        try {
          const { profileBrief } = await import('file://' + process.argv[1]);
          const r = profileBrief({ context: { host: process.env.IJFW_HOST || 'gemini' }, env: process.env, forceLowOnly: true });
          if (r && r.brief && r.brief.trim()) block = '<ijfw-profile>\n' + r.brief.trim() + '\n(Informative; disable: ijfw personalize off)\n</ijfw-profile>';
        } catch {}
      } else if (inject === 'ask' && !ps.inject_consent_version) {
        block = '<ijfw-profile-consent>\nIJFW can include your learned writing style in prompts (low-sensitivity only; never raw text). Enable: ijfw personalize on  ·  decline: ijfw personalize off\n</ijfw-profile-consent>';
        try { let s2={}; try { s2 = JSON.parse(readFileSync(sf,'utf8')); } catch {} s2.profile = Object.assign({ capture:'on', inject:'ask', share_sensitive:false }, s2.profile, { inject_consent_version: '1.6.0' }); mkdirSync(home, { recursive: true }); writeFileSync(sf, JSON.stringify(s2,null,2)+'\n'); } catch {}
      }
      if (block) process.stdout.write(JSON.stringify({ decision: 'allow', additionalContext: block }) + '\n');
    " "$PROFILE_SERVE" 2>>"$HOME/.ijfw/logs/gemini-before-agent.log")
  fi
fi

if [ -n "$RESULT" ]; then
  printf '%s' "$RESULT"
else
  printf '{"decision":"allow"}\n'
fi

exit 0
