#!/usr/bin/env bash
# IJFW UserPromptSubmit (Codex) -- deterministic vague-prompt detector.
#
# Codex hook JSON in/out:
#   stdin:  { "event": "UserPromptSubmit", "prompt": "...", "session_id": "..." }
#   stdout: { "continue": true, "systemMessage": "..." }
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
  process.stdout.write(JSON.stringify({ continue: true, systemMessage: hint }) + '\n');
}
" "$HOOK_STDIN" "$DETECTOR" 2>>"$HOME/.ijfw/logs/codex-pre-prompt.log")

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

exit 0
