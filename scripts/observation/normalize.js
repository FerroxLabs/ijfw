/**
 * IJFW hook payload normalizer.
 * Pure function: normalizeHookPayload(payload) -> canonical event.
 * No I/O, no deps.
 *
 * Hosts send different stdin shapes to the same IJFW capture script:
 *
 *   Claude Code / Codex (current) / Gemini:
 *     { hook_event_name, session_id, cwd, prompt,            // UserPromptSubmit / BeforeAgent
 *       tool_name, tool_input, tool_response }               // PostToolUse / AfterTool
 *   Codex (older builds, as documented in IJFW's own hook headers):
 *     { event, session_id, cwd, prompt, tool, tool_input, tool_response }
 *   Pre-fix IJFW callers:
 *     { hook, user_prompt, ... }
 *
 * Verified against openai/codex codex-rs/hooks/schema/generated/*.command.input.schema.json
 * and google-gemini/gemini-cli packages/core/src/hooks/types.ts.
 *
 * Tool names are mapped to the Claude-style vocabulary classify.js and
 * titleize.js understand (Bash / Edit / Write / Read / Grep / Glob).
 */

const EVENT_ALIASES = {
  userpromptsubmit: 'UserPromptSubmit',
  beforeagent: 'UserPromptSubmit',      // Gemini equivalent
  posttooluse: 'PostToolUse',
  aftertool: 'PostToolUse',             // Gemini equivalent
};

const TOOL_ALIASES = {
  bash: 'Bash',
  shell: 'Bash',                        // older Codex shell tool
  local_shell: 'Bash',
  exec_command: 'Bash',
  unified_exec: 'Bash',
  run_shell_command: 'Bash',            // Gemini
  apply_patch: 'Edit',                  // Codex file edits
  edit: 'Edit',
  replace: 'Edit',                      // Gemini edit tool
  write: 'Write',
  write_file: 'Write',                  // Gemini
  read: 'Read',
  read_file: 'Read',                    // Gemini
  grep: 'Grep',
  search_file_content: 'Grep',          // Gemini
  glob: 'Glob',
};

function str(v) {
  return typeof v === 'string' ? v : '';
}

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.length) return v;
  return '';
}

function canonicalEvent(raw) {
  const key = str(raw).replace(/[^A-Za-z]/g, '').toLowerCase();
  return EVENT_ALIASES[key] || str(raw);
}

function canonicalTool(raw) {
  let name = raw;
  if (raw && typeof raw === 'object') name = raw.name || raw.tool_name || '';
  name = str(name).trim();
  if (!name) return { tool: '', original: '' };
  const mapped = TOOL_ALIASES[name.toLowerCase()];
  return { tool: mapped || name, original: name };
}

// Codex shell commands may arrive as an argv array (["bash","-lc","cmd"]).
// Keep only the script part when the array is a shell -c wrapper.
function commandText(cmd) {
  if (Array.isArray(cmd)) {
    const parts = cmd.map((c) => String(c));
    const i = parts.findIndex((p) => /^-l?c$/.test(p));
    if (i >= 0 && i + 1 < parts.length) return parts.slice(i + 1).join(' ');
    return parts.join(' ');
  }
  return str(cmd);
}

// Pull touched file paths out of an apply_patch envelope.
export function patchFiles(patch) {
  const files = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(str(patch))) !== null) {
    const f = m[1].trim();
    if (f && !files.includes(f)) files.push(f);
  }
  const moved = /^\*\*\* Move to: (.+)$/gm;
  while ((m = moved.exec(str(patch))) !== null) {
    const f = m[1].trim();
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

function responseText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r !== 'object') return String(r);
  const parts = [];
  for (const k of ['output', 'stdout', 'stderr', 'text', 'content', 'result', 'llmContent']) {
    if (r[k] == null) continue;
    parts.push(typeof r[k] === 'string' ? r[k] : JSON.stringify(r[k]));
  }
  return parts.join('\n');
}

/**
 * @param {object} payload raw hook JSON
 * @returns {{hookEvent:string, toolName:string, originalToolName:string,
 *   command:string, filePath:string, files:string[], prompt:string,
 *   toolResponseText:string, isNewFile:boolean, sessionId:string, cwd:string}}
 */
export function normalizeHookPayload(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const { tool, original } = canonicalTool(p.tool_name != null ? p.tool_name : p.tool);
  const prompt = firstString(p.prompt, p.user_prompt);

  let hookEvent = canonicalEvent(firstString(p.hook_event_name, p.event, p.hook));
  if (!hookEvent) hookEvent = (prompt && !tool) ? 'UserPromptSubmit' : 'PostToolUse';

  const isPatch = original.toLowerCase() === 'apply_patch';
  const rawCommand = isPatch ? '' : commandText(input.command != null ? input.command : input.cmd);
  let files = [];
  let filePath = firstString(input.file_path, input.path, input.absolute_path);
  if (isPatch) {
    files = patchFiles(firstString(input.command, input.patch, input.input));
    filePath = files[0] || '';
  } else if (filePath) {
    files = [filePath];
  }

  return {
    hookEvent,
    toolName: tool,
    originalToolName: original,
    command: rawCommand,
    filePath,
    files,
    prompt,
    toolResponseText: responseText(p.tool_response),
    // Write creates a file; Codex apply_patch "Add File" also does.
    isNewFile: tool === 'Write' || (isPatch && /^\*\*\* Add File: /m.test(str(input.command))),
    sessionId: firstString(p.session_id, p.sessionId),
    cwd: firstString(p.cwd),
  };
}
