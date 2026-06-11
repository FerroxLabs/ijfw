#!/usr/bin/env bash
# IJFW v1.4.1 B7 -- tier-2 runtime sandbox mediation for Codex CLI.
#
# Codex stdin shape matches Claude verbatim:
#   { "hook_event_name": "PreToolUse", "tool_name": "...", "tool_input": {...} }
# No adapter needed -- same embedded node check as the Claude hook.
#
# With NO ~/.ijfw/state/active-extension.json present, hook is a no-op.
# Fail-closed: malformed active-extension state denies the call.
# Deny paths exit 2, not 1: the Codex hook contract matches Claude verbatim,
# where only exit 2 aborts the tool call; exit 1 is a non-blocking error.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

STATE="${HOME:-$USERPROFILE}/.ijfw/state/active-extension.json"
[ ! -f "$STATE" ] && exit 0

node --input-type=module -e '
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const home = process.env.HOME || process.env.USERPROFILE || homedir();
const stateFile = join(home, ".ijfw", "state", "active-extension.json");
async function emitEvent(name, tool, allowed, reason) {
  try {
    const dir = join(home, ".ijfw", "state");
    await mkdir(dir, { recursive: true });
    const ev = { ts: new Date().toISOString(), extension: name, tool, allowed };
    if (reason) ev.reason = reason;
    await appendFile(join(dir, "permission-events.jsonl"), JSON.stringify(ev) + "\n", "utf8");
  } catch {}
}
let active;
try {
  active = JSON.parse(await readFile(stateFile, "utf8"));
  if (!active || typeof active !== "object" || !active.name || !active.permissions) {
    process.stderr.write("ijfw extension permission check: malformed active-extension state\n");
    process.exit(2);
  }
} catch (err) {
  if (err.code === "ENOENT") process.exit(0);
  process.stderr.write(`ijfw extension permission check: ${err.message}\n`);
  process.exit(2);
}
const payload = await new Promise((r) => {
  let buf = "";
  process.stdin.on("data", (c) => buf += c);
  process.stdin.on("end", () => r(buf));
});
let req;
try {
  req = JSON.parse(payload);
} catch {
  // v1.5.0 audit-LOW-update-#15: fail-open is right (codex has its own
  // sandbox tier, no need to double-deny here; codex stdin contracts also
  // vary by version + adapter), but SILENT fail-open hides config drift.
  // The stderr advisory surfaces malformed payloads so a user with a broken
  // codex-to-hook pipe sees why the permission check never blocks. Exit 0
  // retained.
  process.stderr.write("[ijfw] codex hook: malformed PreToolUse payload -- skipping permission check (fail-open)\n");
  process.exit(0);
}
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
  await emitEvent(active.name, tool, false, "not in permissions.writes");
  process.exit(2);
}
if (readTools.has(tool) && !has(reads, `tool:${tool.toLowerCase()}`) && !has(reads, "tool:*")) {
  process.stderr.write(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.reads)\n`);
  await emitEvent(active.name, tool, false, "not in permissions.reads");
  process.exit(2);
}
await emitEvent(active.name, tool, true);
process.exit(0);
' <<<"$INPUT"
RC=$?
exit "$RC"
