// --- Cross-audit roster (P5 followup) ---
//
// Who can we ask for a second opinion? This module knows the roster of
// audit-capable CLI tools, fingerprints the currently-running caller via
// env vars, AND probes whether each CLI is actually installed on PATH.
//
// Donahoe principle: never trust a single AI; run through (at least) three.
// Caller is one. We aim to suggest two reviewers -- the Trident.
//
// Detection is conservative: we'd rather show all options than silently
// exclude a valid one. If we genuinely can't tell who's calling, nothing
// gets filtered as "self."

import { spawnSync } from 'node:child_process';

export const ROSTER = [
  {
    id: 'codex',
    family: 'openai',
    model: '',
    name: 'Codex CLI',
    invoke: 'codex exec --skip-git-repo-check --sandbox read-only -c approval_policy="never" -c mcp_servers.ijfw-memory.enabled=false -',
    note: 'Different training lineage; fast on review tasks. The - flag reads prompt from stdin. --skip-git-repo-check bypasses the trusted-directory gate added in codex-cli 0.118.0. --sandbox read-only blocks file WRITES on the host (verified Codex 0.122.0: `echo > /tmp/x` returns `operation not permitted`); it does NOT block shell exec or subprocess launching -- a `read-only` sandbox can still run `ls`, `curl`, or `gemini`. The defense against codex going meta and shelling out to other auditors is the prompt-layer "Operating constraints" block in cross-dispatcher.js buildRequest, not the sandbox flag. The model layer additionally refuses to read explicitly-secret files like ~/.ssh/id_rsa or ~/.codex/auth.json even when prompt-injected to do so. The visibility surface in cross-orchestrator-cli.js cmdCross catches any residual silent failure. approval_policy="never" auto-approves without an interactive prompt. mcp_servers.ijfw-memory.enabled=false disables IJFW MCP for this session because Codex in `codex exec` mode under a non-bypass sandbox auto-cancels MCP tool calls -- the cancellation noise wastes tokens and the audit does not need IJFW memory recall (the brief contains the full target inline).',
    detect: (env) => Boolean(env.CODEX_SESSION_ID || env.CODEX_HOME) || /codex/i.test(env._ || ''),
    apiFallback: { provider: 'openai', model: 'gpt-4o-mini', authEnv: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1/chat/completions' },
  },
  {
    id: 'gemini',
    family: 'google',
    model: '',
    name: 'Gemini CLI',
    invoke: 'gemini',
    note: 'Strong on security + architectural patterns. Auto-detects piped stdin for headless mode.',
    detect: (env) => Boolean(env.GEMINI_CLI || env.GOOGLE_CLOUD_PROJECT_GEMINI) || /gemini-cli/i.test(env._ || ''),
    apiFallback: { provider: 'google', model: 'gemini-2.0-flash', authEnv: 'GEMINI_API_KEY', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent' },
  },
  {
    id: 'qwen',
    family: 'oss',
    model: '',
    name: 'Qwen Code',
    invoke: 'qwen -p',
    note: 'Apache-2.0 weights (Qwen3-Coder-480B-A35B), agentic-tuned (~67% SWE-Bench Verified). Fork of gemini-cli; supports qwen-oauth (free Coding Plan tier), plus openai/anthropic/gemini auth-types via `qwen auth`. Diversity value for Trident: third independent training lineage outside openai/google.',
    detect: (env) => Boolean(env.QWEN_SESSION) || /(?:^|\W)qwen(?:\W|$)/i.test(env._ || ''),
    apiFallback: { provider: 'openai-compat', model: 'qwen3-coder-plus', authEnv: 'DASHSCOPE_API_KEY', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions' },
  },
  {
    id: 'opencode',
    family: 'oss',
    model: '',
    name: 'opencode',
    invoke: 'opencode',
    note: 'OSS / local-friendly; good when privacy matters.',
    detect: (env) => Boolean(env.OPENCODE_SESSION || env.OPENCODE_HOME),
    apiFallback: null,
  },
  {
    id: 'aider',
    family: 'oss',
    model: '',
    name: 'Aider',
    invoke: 'aider --message',
    note: 'Code-focused peer; terse + diff-aware.',
    detect: (env) => Boolean(env.AIDER_SESSION) || /aider/i.test(env._ || ''),
    apiFallback: null,
  },
  {
    id: 'copilot',
    family: 'openai',
    model: '',
    name: 'Copilot CLI',
    invoke: 'gh copilot suggest',
    note: 'Convenient if gh CLI is already authenticated.',
    detect: (env) => Boolean(env.GH_COPILOT_TOKEN || env.COPILOT_CLI_SESSION),
    apiFallback: null,
  },
  {
    id: 'claude',
    family: 'anthropic',
    model: '',
    name: 'Claude Code',
    invoke: 'claude -p',
    note: 'Anthropic; useful when you want a second Claude pass in a fresh session.',
    detect: (env) => Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PLUGIN_ROOT),
    apiFallback: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', authEnv: 'ANTHROPIC_API_KEY', endpoint: 'https://api.anthropic.com/v1/messages' },
  },
];

// Returns the id of the current caller, or null if unknown.
export function detectSelf(env = process.env) {
  for (const entry of ROSTER) {
    try { if (entry.detect(env)) return entry.id; } catch { /* ignore */ }
  }
  return null;
}

// Probe whether the auditor's CLI is on PATH. Cached per process.
// Exported so tests can prime the cache for deterministic behavior.
export const _installedCache = new Map();
export function isInstalled(id) {
  if (_installedCache.has(id)) return _installedCache.get(id);
  const entry = ROSTER.find(e => e.id === id);
  if (!entry) return false;
  // First word of invoke is the binary; the rest are args.
  const bin = entry.invoke.split(/\s+/)[0];
  // POSIX `command -v` is the portable existence check; bash builtin form
  // works reliably across macOS + Linux. spawnSync exit code = 0 → present.
  const r = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(bin)} >/dev/null 2>&1`], { timeout: 2000 });
  const installed = r.status === 0;
  _installedCache.set(id, installed);
  return installed;
}

// Check reachability: CLI (PATH probe) and/or API (env key present).
// Returns { cli: bool, api: bool, any: bool }. Does not touch isInstalled signature.
export function isReachable(id, env = process.env) {
  const entry = ROSTER.find(e => e.id === id);
  if (!entry) return { cli: false, api: false, any: false };
  const cli = isInstalled(id);
  const api = Boolean(entry.apiFallback && env[entry.apiFallback.authEnv]);
  return { cli, api, any: cli || api };
}

// Returns roster entries with isSelf + installed flags resolved.
export function rosterWithStatus(env = process.env) {
  const self = detectSelf(env);
  return ROSTER.map(e => ({ ...e, isSelf: e.id === self, installed: isInstalled(e.id) }));
}

// The Trident: pick up to N (default 2) installed, non-self auditors in
// roster priority order. Returns { picks: [], missing: [], note: string }.
//   - picks: chosen auditor entries, ready to invoke
//   - missing: roster entries we'd have liked but aren't installed
//   - note: human-readable advisory (Donahoe trident reminder when only 1)
export function pickAuditors({ count = 2, env = process.env, only = null, strategy = 'priority' } = {}) {
  const all = rosterWithStatus(env);
  // Annotate a pick with preferredSource:'api' when reachable only via API key.
  function annotatePick(e) {
    const reach = isReachable(e.id, env);
    if (!reach.cli && reach.api) return { ...e, preferredSource: 'api' };
    return e;
  }

  if (only) {
    const ids = String(only).split(/[ ,]+/).map(s => s.toLowerCase()).filter(Boolean);
    const picks = ids.map(id => all.find(e => e.id === id)).filter(Boolean);
    const reachablePicks = picks.filter(e => isReachable(e.id, env).any);
    const missing = picks.filter(e => !isReachable(e.id, env).any);
    return {
      picks: reachablePicks.map(annotatePick),
      missing,
      note: missing.length ? `Requested but not reachable: ${missing.map(e => e.id).join(', ')}.` : '',
    };
  }

  if (strategy === 'diversity') {
    const selfId = detectSelf(env);
    const selfEntry = ROSTER.find(e => e.id === selfId);
    const callerFamily = selfEntry ? selfEntry.family : null;

    // Reachable (CLI or API) non-self entries, grouped by family
    const eligible = all.filter(e => !e.isSelf && isReachable(e.id, env).any);
    const byFamily = (fam) => eligible.filter(e => e.family === fam);

    const TARGET_FAMILIES = ['openai', 'google'];
    const picks = [];
    const picked = new Set();
    const missing = [];
    const nudges = [];

    for (const fam of TARGET_FAMILIES) {
      if (fam === callerFamily) {
        // Caller is in this family -- pick next-best family (oss, or other non-self)
        const backfill = eligible.find(e => !picked.has(e.id) && e.family !== callerFamily);
        if (backfill) {
          picks.push(annotatePick(backfill));
          picked.add(backfill.id);
          nudges.push(`No ${fam}-family auditor outside caller -- using ${backfill.id} (${backfill.family}) as stand-in. Install a ${fam === 'openai' ? 'google' : 'openai'}-family auditor for full Trident diversity.`);
        } else {
          missing.push({ family: fam, reason: `no reachable auditor in family ${fam}` });
        }
        continue;
      }
      const candidates = byFamily(fam);
      if (candidates.length > 0) {
        const pick = candidates.find(e => !picked.has(e.id));
        if (pick) {
          picks.push(annotatePick(pick));
          picked.add(pick.id);
        } else {
          // All family members already picked -- leave slot missing
          missing.push({ family: fam, reason: `all reachable auditors in family ${fam} already selected` });
        }
      } else {
        // No reachable member of this family -- backfill from oss or any remaining non-self
        const backfill = eligible.find(e => !picked.has(e.id) && e.family !== callerFamily && !TARGET_FAMILIES.includes(e.family));
        missing.push({ family: fam, reason: `no reachable auditor in family ${fam}` });
        if (backfill) {
          picks.push(annotatePick(backfill));
          picked.add(backfill.id);
          nudges.push(`No ${fam}-family auditor reachable -- using ${backfill.id} (${backfill.family}) as stand-in. Install gemini (google) or codex/copilot (openai) for full Trident lineage diversity.`);
        }
      }
    }

    // If we still have fewer than 2 picks, backfill from any remaining eligible
    if (picks.length < 2) {
      for (const e of eligible) {
        if (picks.length >= 2) break;
        if (!picked.has(e.id)) {
          picks.push(annotatePick(e));
          picked.add(e.id);
        }
      }
    }

    const baseNote = picks.length === 0
      ? 'No external auditors reachable. Install codex, gemini, opencode, aider, or copilot (or set OPENAI_API_KEY / GEMINI_API_KEY) to use cross-audit.'
      : picks.length < 2
        ? `Donahoe Trident principle: cross-audit works best with two top-tier AIs reviewing alongside the caller. Only ${picks.length} reachable (${picks.map(e => e.id).join(', ')}); install another to triangulate findings.`
        : '';
    const note = [baseNote, ...nudges].filter(Boolean).join(' ');
    return { picks, missing, note };
  }

  // Default: priority strategy
  const eligible = all.filter(e => !e.isSelf && isReachable(e.id, env).any);
  const picks = eligible.slice(0, count).map(annotatePick);
  const wantMore = count - picks.length;
  let note = '';
  if (picks.length === 0) {
    note = 'No external auditors reachable. Install codex, gemini, opencode, aider, or copilot (or set OPENAI_API_KEY / GEMINI_API_KEY) to use cross-audit.';
  } else if (picks.length < count) {
    note = `Donahoe Trident principle: cross-audit works best with two top-tier AIs reviewing alongside the caller. Only ${picks.length} reachable (${picks.map(e => e.id).join(', ')}); ${wantMore} short. Install another to triangulate findings -- single-reviewer audits miss what overlap would catch.`;
  }
  return { picks, missing: all.filter(e => !e.isSelf && !isReachable(e.id, env).any), note };
}

// Returns roster entries, marking self and filtering when requested.
//   { excludeSelf: bool, only: string | null }
export function rosterFor({ excludeSelf = true, only = null, env = process.env } = {}) {
  const self = detectSelf(env);
  let list = ROSTER.map(e => ({ ...e, isSelf: e.id === self }));
  if (only) {
    const match = list.find(e => e.id === only.toLowerCase());
    return match ? [match] : [];
  }
  if (excludeSelf && self) list = list.filter(e => !e.isSelf);
  return list;
}

// Pick the top default auditor (first non-self).
export function defaultAuditor(env = process.env) {
  const list = rosterFor({ excludeSelf: true, env });
  return list[0] || null;
}

// Pretty-print the roster for user consumption. Now shows install status
// and self marker so the user sees instantly what's actionable.
export function formatRoster(env = process.env) {
  const self = detectSelf(env);
  const all = rosterWithStatus(env);
  const lines = [];
  for (const e of all) {
    const role = e.isSelf ? 'self    ' : (e.installed ? 'ready   ' : 'install ');
    lines.push(`  ${e.id.padEnd(9)} ${role}-- ${e.name} (${e.invoke}) -- ${e.note}`);
  }
  const header = self
    ? `Detected caller: ${self}. Roster (ready = installed + non-self):`
    : `Caller unknown -- full roster:`;
  return header + '\n' + lines.join('\n');
}
