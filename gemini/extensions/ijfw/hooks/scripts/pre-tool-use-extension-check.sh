#!/usr/bin/env bash
# IJFW v1.4.1 B7 -- tier-2 runtime sandbox mediation for Gemini CLI.
#
# Gemini stdin shape:
#   { "event": "pre_tool_use", "tool": { "name": "...", "input": {...} } }
# Reshaped to Claude-compat { hook_event_name, tool_name, tool_input } then
# run through the same embedded node permission check as the Claude hook.
#
# With NO ~/.ijfw/state/active-extension.json present, hook is a no-op.
# Fail-closed: malformed active-extension state denies the call.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

STATE="${HOME:-$USERPROFILE}/.ijfw/state/active-extension.json"
[ ! -f "$STATE" ] && exit 0

# Reshape Gemini payload to Claude-compat shape.
# Fail-closed: parse error or missing required fields → exit 1 (deny).
RESHAPED=$(node -e "
let p;
try { p = JSON.parse(process.argv[1]); } catch (e) {
  process.stderr.write('[ijfw] gemini hook: malformed payload -- denying\n');
  process.exit(1);
}
if (!p || typeof p !== 'object' || !p.tool || typeof p.tool.name !== 'string') {
  process.stderr.write('[ijfw] gemini hook: malformed payload -- denying\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  hook_event_name: p.event === 'pre_tool_use' ? 'PreToolUse' : (p.event || ''),
  tool_name: p.tool.name,
  tool_input: p.tool.input || {}
}));
" "$INPUT")
RC=$?
[ "$RC" -ne 0 ] && exit "$RC"

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
try {
  req = JSON.parse(payload);
} catch {
  // v1.5.0 audit-LOW-update-#15: same advisory as the codex variant. Silent
  // fail-open hides config drift across the Gemini stdin reshape pipeline.
  process.stderr.write("[ijfw] gemini hook: malformed reshaped payload -- skipping permission check (fail-open)\n");
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
  process.exit(1);
}
if (readTools.has(tool) && !has(reads, `tool:${tool.toLowerCase()}`) && !has(reads, "tool:*")) {
  process.stderr.write(`extension "${active.name}" not permitted to use ${tool} (declare tool:${tool.toLowerCase()} in permissions.reads)\n`);
  await emitEvent(active.name, tool, false, "not in permissions.reads");
  process.exit(1);
}
await emitEvent(active.name, tool, true);
process.exit(0);
' <<<"$RESHAPED"
RC=$?
exit "$RC"
