#!/usr/bin/env bash
# IJFW PermissionRequest (Codex) -- deny high-risk permission requests.
#
# Codex hook JSON in/out:
#   stdin:  { "event": "PermissionRequest", "tool_name": "...",
#             "tool_input": {...}, "session_id": "..." }
#   stdout: { "continue": true,
#             "hookSpecificOutput": {
#               "hookEventName": "PermissionRequest",
#               "permissionDecision": "deny",
#               "permissionDecisionReason": "..."
#             } }
#            OR nothing (exit 0 with no output = pass through)
#
# No set -e -- hooks must never crash Codex.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
mkdir -p "$HOME/.ijfw/logs" 2>/dev/null || true

node -e '
	  let payload = {};
	  try {
	    payload = JSON.parse(process.argv[1] || "{}");
	  } catch {
	    process.exit(0);
	  }
  const haystack = collect(payload).join("\n");
  const lower = haystack.toLowerCase();
  const checks = [
    [/\bnpm\s+publish\b/i, "npm publish is release-gated. Confirm version, changelog, CI, and explicit user approval before publishing."],
    [/\bgit\s+push\b[^\n]*(?:--force|-f\b)/i, "Force push requested. Confirm branch, remote, and recovery plan before proceeding."],
    [/\bgit\s+reset\s+--hard\b/i, "git reset --hard discards uncommitted work. Inspect status and confirm target first."],
    [/\bgit\s+clean\b[^\n]*-[a-zA-Z]*[fdx]/i, "git clean can permanently remove untracked files. Run a dry-run with -n first."],
    [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b\s+(?:\/|~|\$HOME|\*|\.{1,2}(?:\s|$))/i, "High-risk recursive delete requested. Narrow the target and confirm scope."],
    [/\bchmod\s+-R\s+777\b/i, "chmod -R 777 grants world write. Use a narrower permission model."],
    [/\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, "Destructive database operation requested. Confirm target, environment, and backup."],
    [/\bdelete\s+from\s+[\w.]+\s*(?:;|$)/i, "DELETE without WHERE requested. Confirm this is intentional and backed up."],
  ];
  let reason = "";
  for (const [re, msg] of checks) {
    if (re.test(haystack) || re.test(lower)) { reason = msg; break; }
  }
  if (!reason) process.exit(0);
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      permissionDecision: "deny",
      permissionDecisionReason: `[ijfw] ${reason}`
    }
  }) + "\n");

  function collect(value, out = []) {
    if (value == null) return out;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push(String(value));
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, out);
      return out;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) collect(item, out);
    }
    return out;
  }
' -- "$INPUT" 2>>"$HOME/.ijfw/logs/codex-permission-request.log"

exit 0
