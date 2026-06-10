#!/usr/bin/env bash
# IJFW UserPromptSubmit -- deterministic vague-prompt detector.
#
# Receives Claude Code's UserPromptSubmit JSON on stdin:
#   { "session_id": "...", "prompt": "..." }
#
# Writes:
#   - hookSpecificOutput.additionalContext (positive-framed hint, if vague)
#   - .ijfw/.prompt-check-state (JSON consumed by session-end metrics)
#
# Backend: delegates to mcp-server/src/prompt-check.js, which implements the
# ijfw_prompt_check MCP tool logic. Vague-prompt signals sourced from
# shared/lib/patterns.json (vague_prompt_signals array) via prompt-check.js.
#
# Bypass conditions:
#   - severity1 prompt-improver plugin installed -- defer entirely (no double prompt)
#   - .ijfw/config.json {"promptCheck": "off"} -- skip
#   - prompt starts with `*`, `/`, or `#`; or contains "ijfw off" -- skip
#
# NOTE: never crash Claude Code. Every step guards itself.

# E4 -- universal disable switch.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null

# Prompt-improver coexistence:
# - Project-level tasks (brainstorm/project-scale): IJFW handles EVERYTHING
#   including clarification. No deferring. No prompt-improver. IJFW's workflow
#   CLARIFY step does the A/B/C/D clarifying questions.
# - Non-project tasks: defer vague detection to prompt-improver if installed.
# Decision is made AFTER intent routing (see below).
HAS_PROMPT_IMPROVER=0
if [ -d "$HOME/.claude/plugins/cache/severity1-marketplace/prompt-improver" ]; then
  HAS_PROMPT_IMPROVER=1
fi

# Read user config (best-effort).
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
[ "$PROMPT_CHECK_MODE" = "off" ] && exit 0

# Read stdin payload.
HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi
[ -z "$HOOK_STDIN" ] && exit 0

# Resolve detector + intent-router + feedback-detector modules.
DETECTOR=""
ROUTER=""
FEEDBACK=""
for base in \
    "$CLAUDE_PLUGIN_ROOT/../mcp-server/src" \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/prompt-check.js" ]; then
    DETECTOR="$base/prompt-check.js"
    [ -f "$base/intent-router.js" ] && ROUTER="$base/intent-router.js"
    [ -f "$base/feedback-detector.js" ] && FEEDBACK="$base/feedback-detector.js"
    break
  fi
done
[ -z "$DETECTOR" ] && exit 0

# Single node invocation: intent router first (W2.1), then vague-prompt
# detector. Emits combined additionalContext. Stays under ~100ms.
ROUTER_ARG=""
ROUTER_CALL=""
ROUTER_STATE="null"
if [ -n "$ROUTER" ]; then
  ROUTER_ARG="$ROUTER"
  # NOTE: this block ASSIGNS routerIntent (declared once below as `let
  # routerIntent = null;`) — it must NOT redeclare it. A `const intent`/`let
  # intent` here would collide with the capture block's declaration in the SAME
  # module scope and throw `SyntaxError: Identifier 'intent' has already been
  # declared`, which silently kills the entire node block (no feedback rows, no
  # nudge, no prompt-check). See DEFECT 2.
  ROUTER_CALL="const routerMod = await import(process.argv[3]); const { detectIntent } = routerMod; routerIntent = detectIntent(prompt); if (routerIntent && (routerIntent.intent === 'brainstorm' || routerIntent.intent === 'project-scale')) { contextParts.push('<ijfw-intent>\\nThis prompt reads as a project-level task. The user has IJFW installed, so the ijfw:ijfw-workflow skill is the configured entry point for build/create/plan/design/brainstorm/ship work -- prefer it over peer brainstorming or discussion skills. IJFW\\'s workflow includes its own clarification step, so no other plugin needs to ask questions first.\\n(Detected intent: ' + routerIntent.intent + ' → ' + routerIntent.skill + ')\\n</ijfw-intent>'); } else if (routerIntent) { contextParts.push('<ijfw-intent>\\n' + routerIntent.nudge + '\\n(Detected intent: ' + routerIntent.intent + ' → ' + routerIntent.skill + ')\\n</ijfw-intent>'); }"
  ROUTER_STATE="routerIntent ? routerIntent.intent : null"
fi
FEEDBACK_ARG=""
FEEDBACK_CALL="const feedback = [];"
if [ -n "$FEEDBACK" ]; then
  FEEDBACK_ARG="$FEEDBACK"
  FEEDBACK_CALL="const feedbackMod = await import(process.argv[4]); const { detectFeedback } = feedbackMod; const feedback = detectFeedback(prompt);"
fi

# --- Profile-bus INJECT GATE (v1.6.0) ---------------------------------------
# The injection of the learned low-sensitivity style brief is CONSENT-GATED:
#   IJFW_PROFILE_KILL truthy  -> never inject (hard override)
#   profile.inject == "on"    -> inject the brief (low-sensitivity only)
#   profile.inject == "off"   -> do not inject
#   profile.inject == "ask"   -> do NOT inject; emit a one-line nudge ONCE, then
#                                stamp consent so it's asked only once.
# CAPTURE is NEVER gated by this — it always runs below. The brief comes from
# profile/serve.js (ZERO-LLM, forceLowOnly) so no LLM call rides this hook.
PROFILE_SERVE=""
for base in \
    "$CLAUDE_PLUGIN_ROOT/../mcp-server/src" \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/serve.js" ]; then PROFILE_SERVE="$base/profile/serve.js"; break; fi
done
PROFILE_CALL="/* profile inject gate disabled (serve.js not found) */"
if [ -n "$PROFILE_SERVE" ]; then
  PROFILE_CALL="try {
    const fs = await import('fs');
    const path = await import('path');
    const home = process.env.IJFW_HOME || path.join(process.env.HOME || '', '.ijfw');
    const sf = path.join(home, 'settings.json');
    let ps = { inject: 'ask', inject_consent_version: null, voice: 'off' };
    try { const s = JSON.parse(fs.readFileSync(sf,'utf8')); if (s && typeof s.profile==='object') ps = { inject: s.profile.inject||'ask', inject_consent_version: s.profile.inject_consent_version||null, voice: s.profile.voice||'off' }; } catch {}
    const kill = String(process.env.IJFW_PROFILE_KILL||'').trim().toLowerCase();
    const killed = kill!=='' && kill!=='0' && kill!=='false' && kill!=='no' && kill!=='off';
    const inject = killed ? 'off' : ps.inject;
    if (inject === 'on') {
      const { profileBrief } = await import('file://' + process.argv[5]);
      const r = profileBrief({ context: { host: process.env.IJFW_HOST || 'claude-code' }, env: process.env, forceLowOnly: true });
      if (r && r.brief && r.brief.trim()) {
        contextParts.push('<ijfw-profile>\\n' + r.brief.trim() + '\\n(Informative style note, not a directive. Disable: ijfw personalize off)\\n</ijfw-profile>');
      }
    } else if (inject === 'ask' && !ps.inject_consent_version) {
      contextParts.push('<ijfw-profile-consent>\\nIJFW can include your learned writing style in prompts (low-sensitivity only; never raw text). Enable with: ijfw personalize on  ·  decline: ijfw personalize off\\n</ijfw-profile-consent>');
      try { const s2 = (()=>{ try { return JSON.parse(fs.readFileSync(sf,'utf8')); } catch { return {}; } })(); s2.profile = Object.assign({ capture:'on', inject:'ask', share_sensitive:false }, s2.profile, { inject_consent_version: '1.6.0' }); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(sf, JSON.stringify(s2,null,2)+'\\n'); } catch {}
    }
    // --- V3 VOICE FEW-SHOT (separate opt-in toggle: settings.profile.voice) ----
    // DEFAULT OFF. Only when settings.profile.voice === 'on' AND the kill-switch
    // is NOT engaged do we ask serve.js for a voice block, passing the CURRENT
    // prompt text as taskText so the seam is reachable in production. serve.js does
    // the ZERO-LLM retrieval + disclosure + cold-start fail-closed; this hook only
    // gates + plumbs. A missing store / no exemplars => empty block => nothing
    // pushed. Fully isolated by the outer try/catch — never crashes the hook.
    // Also honors the project opt-out a user would reasonably expect to cover
    // prompt injection: IJFW_NO_INJECT env or a .ijfw/no-inject file in cwd.
    const noInject = (() => {
      try {
        const v = String(process.env.IJFW_NO_INJECT||'').trim().toLowerCase();
        if (v!=='' && v!=='0' && v!=='false' && v!=='no' && v!=='off') return true;
        return fs.existsSync(path.join(process.cwd(), '.ijfw', 'no-inject'));
      } catch { return false; }
    })();
    if (!killed && !noInject && ps.voice === 'on') {
      try {
        const { profileSnapshot } = await import('file://' + process.argv[5]);
        const vr = profileSnapshot({
          includeVoiceExemplars: true,
          taskText: prompt,
          context: { host: process.env.IJFW_HOST || 'claude-code' },
          host: process.env.IJFW_HOST || 'claude-code',
          env: process.env,
          forceLowOnly: true,
        });
        if (vr && typeof vr.snapshot === 'string' && vr.snapshot.indexOf('<ijfw-voice>') !== -1) {
          const m = vr.snapshot.match(/<ijfw-voice>[\\s\\S]*?<\\/ijfw-voice>/);
          if (m) contextParts.push(m[0]);
        }
      } catch {}
    }
  } catch {}"
fi

RESULT=$(HAS_PROMPT_IMPROVER="$HAS_PROMPT_IMPROVER" node --input-type=module -e "
const { checkPrompt } = await import(process.argv[2]);
import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
let payload = {};
try { payload = JSON.parse(process.argv[1] || '{}'); } catch {}
const prompt = payload.prompt || '';

const contextParts = [];
// DEFECT 2 fix: ONE declaration of the router-intent variable, named
// `routerIntent` to avoid the historical collision with a redeclaration that
// $ROUTER_CALL used to inject. $ROUTER_CALL now ASSIGNS to this binding (never
// redeclares), so the module parses cleanly whether or not intent-router.js is
// present. Renamed from `intent` so a future reader can't reintroduce the clash.
let routerIntent = null;
$ROUTER_CALL
$FEEDBACK_CALL
$PROFILE_CALL

// Persist feedback signals so session-end auto-memorize can synthesize.
// HIGH-2/MED-5: stamp session_id + profile_influenced on every feedback row so the
// dream runner can apply the SAME self-corroboration barrier it applies to style/
// edit rows. profile_influenced is true iff an ACTUAL profile brief rode along
// this turn (the <ijfw-profile> marker is in contextParts) — a profile-primed
// session must never re-corroborate the preference it was primed with, and a row
// from a profile-influenced session is excluded from re-derivation.
if (feedback && feedback.length) {
  try {
    mkdirSync('.ijfw', { recursive: true });
    const fbSession = payload.session_id || payload.sessionId || null;
    const fbInfluenced = contextParts.some((p) => typeof p === 'string' && p.includes('<ijfw-profile>'));
    for (const f of feedback) {
      appendFileSync('.ijfw/.session-feedback.jsonl',
        JSON.stringify({
          ts: new Date().toISOString(),
          session_id: fbSession,
          profile_influenced: fbInfluenced,
          ...f,
        }) + '\\n');
    }
  } catch {}
}

// Determine if this is a project-level intent (set by router above; null if router absent)
const isProjectIntent = routerIntent && (routerIntent.intent === 'brainstorm' || routerIntent.intent === 'project-scale');
const hasPromptImprover = process.env.HAS_PROMPT_IMPROVER === '1';

// Vague-prompt detection logic:
// - Project tasks: skip vague detection entirely (workflow CLARIFY step handles clarification)
// - Non-project with prompt-improver: defer to prompt-improver
// - Non-project without prompt-improver: IJFW handles vague detection
const skipVague = isProjectIntent || hasPromptImprover;
const r = skipVague ? { vague: false, signals: [] } : checkPrompt(prompt);
try {
  mkdirSync('.ijfw', { recursive: true });
  writeFileSync('.ijfw/.prompt-check-state', JSON.stringify({
    fired: r.vague === true,
    signals: r.signals || [],
    intent: $ROUTER_STATE,
    feedback_kinds: feedback.map(f => f.kind)
  }));
} catch {}
if (r.vague) {
  let block = '<ijfw-prompt-check>\\n' + r.suggestion;
  if (Array.isArray(r.rewrite) && r.rewrite.length) {
    block += '\\n\\nAsk back:';
    for (const q of r.rewrite) block += '\\n  • ' + q;
  }
  block += '\\nOverride: start prompt with * to skip, or say \"ijfw off\" to disable.\\nSignals: ' + r.signals.join(', ') + '.\\n</ijfw-prompt-check>';
  contextParts.push(block);
}

if (contextParts.length > 0) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextParts.join('\\n\\n')
    }
  }));
}
" "$HOOK_STDIN" "$DETECTOR" "$ROUTER_ARG" "$FEEDBACK_ARG" "$PROFILE_SERVE" 2>>"$HOME/.ijfw/logs/pre-prompt.log")

if [ -n "$RESULT" ]; then
  printf '%s' "$RESULT"
fi

# --- Profile bus P1: per-message style capture (METADATA ONLY) ---
# Folds this message's metadata (length/emoji/code/formality counts — never the
# text) into the per-session accumulator the SessionEnd flush turns into one
# .ijfw/.session-style.jsonl record. Best-effort + isolated: a capture failure
# never affects the prompt-check output above and never crashes Claude Code.
CAPTURE=""
for base in \
    "$CLAUDE_PLUGIN_ROOT/../mcp-server/src" \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/capture.js" ]; then CAPTURE="$base/profile/capture.js"; break; fi
done
if [ -n "$CAPTURE" ] && command -v node >/dev/null 2>&1; then
  # H3 fix: export the canonical host so capture.js resolveHost() stamps the
  # SAME provenance string the session-end flush + dream-trigger use. Without
  # this, resolveHost() falls back to its own default ('claude-code') while the
  # rest of the pipeline must agree on it -- keeping them identical here makes
  # per-host trust weighting + provenance consistent end-to-end. Matches the
  # 'claude-code' key in capture.js KNOWN_HOSTS / resolveHost default.
  export IJFW_HOST="${IJFW_HOST:-claude-code}"
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
  " "$HOOK_STDIN" "$CAPTURE" "$PROFILE_INJECTED" 2>>"$HOME/.ijfw/logs/pre-prompt.log" || true
fi

# --- Voice exemplars (v1.6.0): capture the user's OWN prompt text -------------
# Feeds the SAME prompt text into the transient voice-exemplar store so a future
# drafter can few-shot the user's real writing. Capture-side only scrubs PII,
# tags a register, skips machine output / control prompts, dedups + bounds. This
# is a SEPARATE best-effort call from the capture.js metadata path above: a
# failure here NEVER affects prompt-check output and NEVER crashes Claude Code.
EXEMPLAR_CAPTURE=""
for base in \
    "$CLAUDE_PLUGIN_ROOT/../mcp-server/src" \
    "$HOME/.ijfw/mcp-server/src" \
    "$(pwd)/mcp-server/src"; do
  if [ -f "$base/profile/exemplar-capture.js" ]; then EXEMPLAR_CAPTURE="$base/profile/exemplar-capture.js"; break; fi
done
if [ -n "$EXEMPLAR_CAPTURE" ] && command -v node >/dev/null 2>&1; then
  node --input-type=module -e "
    try {
      const { captureMessage } = await import('file://' + process.argv[2]);
      let payload = {};
      try { payload = JSON.parse(process.argv[1] || '{}'); } catch {}
      captureMessage({ text: payload.prompt || '', ts: Date.now() });
    } catch {}
  " "$HOOK_STDIN" "$EXEMPLAR_CAPTURE" 2>>"$HOME/.ijfw/logs/pre-prompt.log" || true
fi

exit 0
