#!/usr/bin/env bash
# IJFW AfterModel (Gemini BONUS) -- response auto-memorize trigger.
# Fires after every model response. Scans the response for decision/pattern
# signals and appends them to .ijfw/.session-feedback.jsonl so session-end
# can synthesize into memory. No LLM calls -- pure pattern matching.
#
# Gemini hook JSON in/out:
#   stdin:  { "event": "AfterModel", "session_id": "...", "response": "...",
#             "turn": <n>, "cwd": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }
#
# No set -e -- hooks must never crash Gemini CLI.

[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null || true

HOOK_STDIN=$(head -c 131072 2>/dev/null)
[ -z "$HOOK_STDIN" ] && printf '{"decision":"allow"}\n' && exit 0

command -v node >/dev/null 2>&1 || { printf '{"decision":"allow"}\n'; exit 0; }

# Node emits exactly one envelope (either on parse error or after signal scan).
# The shell never emits -- avoids double-emit on success path.
NODE_OUT=$(node -e '
  const fs = require("fs");
  const os = require("os");
  const raw = process.argv[1] || "{}";
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    try {
      const logPath = os.homedir() + "/.ijfw/logs/gemini-after-model.log";
      fs.mkdirSync(os.homedir() + "/.ijfw/logs", { recursive: true });
      const ts = new Date().toISOString();
      fs.appendFileSync(logPath, ts + " parse-error: " + raw.slice(0, 120) + "\n");
    } catch {}
    process.stdout.write("{\"decision\":\"allow\"}\n");
    process.exit(0);
  }
  const response = payload.response || "";

  // Decision patterns: lines containing decision markers.
  const decisionPat = /\b(decided|decision|will use|going with|chosen|locked|approach:|pattern:)\b/i;
  // Learning patterns: retrospective markers.
  const learnPat = /\b(learned|insight|note:|remember|important:|key finding|root cause)\b/i;

  const lines = response.split("\n").filter(l => l.trim().length > 20);
  const signals = [];
  for (const line of lines.slice(0, 50)) {
    if (decisionPat.test(line)) signals.push({ kind: "decision", text: line.trim().slice(0, 200) });
    else if (learnPat.test(line)) signals.push({ kind: "learning", text: line.trim().slice(0, 200) });
    if (signals.length >= 3) break;
  }

  if (signals.length > 0) {
    try {
      fs.mkdirSync(".ijfw", { recursive: true });
      const ts = new Date().toISOString();
      for (const s of signals) {
        fs.appendFileSync(".ijfw/.session-feedback.jsonl",
          JSON.stringify({ ts, platform: "gemini", ...s }) + "\n");
      }
    } catch {}
  }

  process.stdout.write("{\"decision\":\"allow\"}\n");
' "$HOOK_STDIN" 2>>"$HOME/.ijfw/logs/gemini-after-model.log")

if [ -n "$NODE_OUT" ]; then
  printf '%s\n' "$NODE_OUT"
else
  printf '{"decision":"allow"}\n'
fi
exit 0
