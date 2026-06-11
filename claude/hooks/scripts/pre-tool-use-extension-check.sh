#!/usr/bin/env bash
# IJFW 1.4.0 W7/B2 -- tier-2 runtime sandbox mediation.
#
# Claude Code only. Other platforms get tier-1 (MCP server wrap) only.
#
# Enforces the active extension's permissions allowlist against Claude Code's
# built-in tools (Edit, Write, Bash, Read, etc.) before they run. Blocks by
# exiting 2 AND emitting the structured permissionDecision:"deny" JSON on
# stdout (both block per the PreToolUse contract); the reason is also written
# to stderr for the user.
#
# With NO ~/.ijfw/state/active-extension.json present (bundled IJFW context),
# this hook is a no-op -- preserving the backwards-compat invariant.
#
# Fail-closed: malformed active-extension state denies the call.

# E4 -- universal disable switch.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

STATE="$HOME/.ijfw/state/active-extension.json"
# No active extension -> bundled IJFW context -> allow.
[ ! -f "$STATE" ] && exit 0

# Embedded node check -- ~50ms cap. Keeps the hook self-contained and avoids
# spawning a second process. Reads payload from stdin via the heredoc.
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const home = process.env.HOME || homedir();
const stateFile = join(home, ".ijfw", "state", "active-extension.json");
// Claude Code PreToolUse contract: only exit code 2 OR a stdout JSON
// permissionDecision:"deny" blocks the call. Exit 1 is non-blocking
// (stderr shown, tool runs anyway). Emit BOTH so the deny holds even
// if one channel is dropped.
const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\n");
  process.stderr.write(reason + "\n");
  process.exit(2);
};
let active;
try {
  active = JSON.parse(await readFile(stateFile, "utf8"));
  if (!active || typeof active !== "object" || !active.name || !active.permissions) {
    deny("ijfw extension permission check: malformed active-extension state");
  }
} catch (err) {
  deny(`ijfw extension permission check: ${err.message}`);
}
const payload = await new Promise((r) => {
  let buf = "";
  process.stdin.on("data", (c) => buf += c);
  process.stdin.on("end", () => r(buf));
});
let req;
try { req = JSON.parse(payload); } catch { process.exit(0); }
const tool = req.tool_name || "";
const writes = new Set(active.permissions.writes || []);
const reads = new Set(active.permissions.reads || []);
const writeTools = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);
const readTools = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch"]);
const has = (set, want) =>
  set.has(want) ||
  set.has("*") ||
  [...set].some((p) => p.endsWith(":*") && want.startsWith(p.slice(0, -1)));
if (writeTools.has(tool) && !has(writes, `tool:${tool.toLowerCase()}`) && !has(writes, "tool:*")) {
  deny(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.writes)`);
}
if (readTools.has(tool) && !has(reads, `tool:${tool.toLowerCase()}`) && !has(reads, "tool:*")) {
  deny(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.reads)`);
}
process.exit(0);
' <<<"$INPUT"
RC=$?
exit "$RC"
