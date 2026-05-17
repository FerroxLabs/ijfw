#!/usr/bin/env bash
# IJFW v1.4.1 B7 -- tier-2 runtime sandbox mediation for Codex CLI.
#
# Codex stdin shape matches Claude verbatim:
#   { "hook_event_name": "PreToolUse", "tool_name": "...", "tool_input": {...} }
# No adapter needed -- same embedded node check as the Claude hook.
#
# With NO ~/.ijfw/state/active-extension.json present, hook is a no-op.
# Fail-closed: malformed active-extension state denies the call.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

STATE="${HOME:-$USERPROFILE}/.ijfw/state/active-extension.json"
[ ! -f "$STATE" ] && exit 0

node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const home = process.env.HOME || process.env.USERPROFILE || homedir();
const stateFile = join(home, ".ijfw", "state", "active-extension.json");
let active;
try {
  active = JSON.parse(await readFile(stateFile, "utf8"));
  if (!active || typeof active !== "object" || !active.name || !active.permissions) {
    process.stderr.write("ijfw extension permission check: malformed active-extension state\n");
    process.exit(1);
  }
} catch (err) {
  if (err.code === "ENOENT") process.exit(0);
  process.stderr.write(`ijfw extension permission check: ${err.message}\n`);
  process.exit(1);
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
  set.has(want) || set.has("*") ||
  [...set].some((p) => p.endsWith(":*") && want.startsWith(p.slice(0, -1)));
if (writeTools.has(tool) && !has(writes, `tool:${tool.toLowerCase()}`) && !has(writes, "tool:*")) {
  process.stderr.write(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.writes)\n`);
  process.exit(1);
}
if (readTools.has(tool) && !has(reads, `tool:${tool.toLowerCase()}`) && !has(reads, "tool:*")) {
  process.stderr.write(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.reads)\n`);
  process.exit(1);
}
process.exit(0);
' <<<"$INPUT"
RC=$?
exit "$RC"
