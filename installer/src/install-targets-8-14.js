// installer/src/install-targets-8-14.js
//
// Per-platform install functions for IJFW v1.3.0 -- targets 8-14.
//
// Ported from scripts/install.sh:1526-1660 (and the corresponding case-block
// bodies for copilot/opencode/qwen/cline/kimi/openclaw above that range).
// Pure-Node ESM, sync filesystem APIs, zero external dependencies.
//
// Each function takes the shared `ctx` object (see PORT-SPEC.md) and returns
//   { status: 'ok' }     -- config written
//   { status: 'noop' }   -- skipped (custom-dir guard or source-tree guard)
// Throws on hard write failure (file-system ENOENT/EACCES bubbles up).
//
// Imports below pull from Agent A's install-helpers.js. The set is the
// minimum surface this file needs; if Agent A renames an export, update
// the import list -- nothing else in this file shells out.

/* eslint-disable security/detect-non-literal-fs-filename -- Per-target
 * installer functions operate on validated IJFW home, repo, and platform
 * config paths supplied by install-flow. Dynamic filesystem calls here are
 * the intentional installer write surface. */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  mergeJson,
  opencodeMerge,
  openclawMerge,
  clineMerge,
  printOk,
  printInfo,
} from './install-helpers.js';

// ---------------------------------------------------------------------------
// Internal helpers (kept local to keep this module self-contained for the
// few cases install-helpers.js doesn't already cover).
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort -- mirrors `mkdir -p ... 2>/dev/null || true` in bash.
  }
}

function copyIfMissing(src, dst) {
  // Mirrors the bash idiom:
  //   if [ ! -f "$dst" ] && [ -f "$src" ]; then cp "$src" "$dst" 2>/dev/null || true; fi
  try {
    if (fs.existsSync(dst)) return false;
    if (!fs.existsSync(src)) return false;
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

function commandExists(name) {
  // Cross-platform `command -v` replacement. Uses spawnSync (no shell) to
  // avoid command-injection surface; `name` is a hardcoded literal in our
  // call sites, but staying shell-free keeps the audit clean either way.
  const probeCmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probeCmd, [name], { stdio: 'ignore' });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// 8. Copilot (VS Code) -- install.sh:1364-1385
// ---------------------------------------------------------------------------
//
// Project-scoped install:
//   - ./.vscode/mcp.json  (mergeJson)
//   - ./.github/copilot-instructions.md  (only if missing)
//
// Custom-dir does NOT skip Copilot in install.sh -- only the IJFW source-tree
// guard skips it (would litter our own repo). We mirror that behaviour: we
// honour `ctx.isIjfwSource` if the caller sets it, but the canonical guard
// in this codebase is the source-tree marker. To stay safe in either world
// we also honour `ctx.ijfwCustomDir` for symmetry with the rest of this file.

export function installCopilot(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping Copilot project writes.');
    printOk('Copilot: real platform config left untouched.');
    return { status: 'noop' };
  }
  if (ctx.isIjfwSource) {
    printInfo('IJFW source tree detected -- skipping Copilot project writes (would litter source).');
    printOk('Copilot: source tree left untouched.');
    return { status: 'noop' };
  }

  const dst = path.join(process.cwd(), '.vscode', 'mcp.json');
  ensureDir(path.dirname(dst));
  mergeJson(dst, ctx.serverJsNative || ctx.serverJs);

  const rulesDst = path.join(process.cwd(), '.github', 'copilot-instructions.md');
  const rulesSrc = path.join(ctx.repoRoot, 'copilot', 'copilot-instructions.md');
  const wroteRules = copyIfMissing(rulesSrc, rulesDst);

  if (wroteRules) {
    printOk('Merged MCP + installed .github/copilot-instructions.md');
  } else {
    printOk('Merged MCP into project ./.vscode/mcp.json');
  }
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 9. OpenCode -- install.sh:1453-1465
// ---------------------------------------------------------------------------
//
// ~/.config/opencode/opencode.json -- top-level `mcp.{name}` with
// `type: 'local'` and `command: ['node', serverJs]`. opencodeMerge owns the
// shape; we just locate the destination.

export function installOpencode(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping ~/.config/opencode/ merge.');
    printOk('OpenCode: real platform config left untouched.');
    return { status: 'noop' };
  }

  const dst = path.join(ctx.home, '.config', 'opencode', 'opencode.json');
  ensureDir(path.dirname(dst));
  opencodeMerge(dst, ctx.serverJsNative || ctx.serverJs);
  printOk(`Merged MCP into ${dst} (opencode mcp.local schema)`);
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 10. Qwen Code -- install.sh:1466-1478
// ---------------------------------------------------------------------------
//
// ~/.qwen/settings.json -- standard mcpServers shape, mergeJson handles it.

export function installQwen(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping ~/.qwen/ merge.');
    printOk('Qwen Code: real platform config left untouched.');
    return { status: 'noop' };
  }

  const dst = path.join(ctx.home, '.qwen', 'settings.json');
  ensureDir(path.dirname(dst));
  mergeJson(dst, ctx.serverJsNative || ctx.serverJs);
  printOk(`Merged MCP into ${dst}`);
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 11. Cline -- install.sh:1479-1492
// ---------------------------------------------------------------------------
//
// VS Code globalStorage for extension `saoudrizwan.claude-dev`. The OS-specific
// path resolution lives inside `clineMerge`; we just receive the dst it picked
// so we can echo it.

export function installCline(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping Cline merges.');
    printOk('Cline: real platform config left untouched.');
    return { status: 'noop' };
  }

  const dst = clineMerge(ctx.serverJsNative || ctx.serverJs, ctx.home);
  printOk(`Merged MCP into ${dst} (cline globalStorage schema)`);
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 12. Kimi Code -- install.sh:1493-1505
// ---------------------------------------------------------------------------
//
// ~/.kimi/mcp.json -- standard mcpServers shape, mergeJson handles it.

export function installKimi(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping ~/.kimi/ merge.');
    printOk('Kimi Code: real platform config left untouched.');
    return { status: 'noop' };
  }

  const dst = path.join(ctx.home, '.kimi', 'mcp.json');
  ensureDir(path.dirname(dst));
  mergeJson(dst, ctx.serverJsNative || ctx.serverJs);
  printOk(`Merged MCP into ${dst}`);
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 13. OpenClaw -- install.sh:1506-1529
// ---------------------------------------------------------------------------
//
// ~/.openclaw/openclaw.json -- nested `mcp.servers.{name}` shape (NOT flat
// mcpServers). Prefer the official `openclaw mcp set` subcommand when the
// CLI is on PATH (runs the daemon validator); fall back to direct file write
// for the standing-by case.

export function installOpenclaw(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping OpenClaw merges.');
    printOk('OpenClaw: real platform config left untouched.');
    return { status: 'noop' };
  }

  const dst = path.join(ctx.home, '.openclaw', 'openclaw.json');
  const serverJs = ctx.serverJsNative || ctx.serverJs;

  if (commandExists('openclaw')) {
    try {
      const payload = JSON.stringify({ command: 'node', args: [serverJs] });
      // execFileSync (no shell) keeps Windows + POSIX safe -- args go to argv,
      // not through cmd.exe / sh.
      execFileSync('openclaw', ['mcp', 'set', 'ijfw-memory', payload], { stdio: 'ignore' });
      printOk(`Registered ijfw-memory via 'openclaw mcp set' (${dst})`);
      return { status: 'ok' };
    } catch {
      // Fall through to direct file write.
    }
  }

  ensureDir(path.dirname(dst));
  openclawMerge(dst, serverJs);
  printOk(`Merged MCP into ${dst} (openclaw mcp.servers schema)`);
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 14. Aider -- install.sh:1530-1549
// ---------------------------------------------------------------------------
//
// Tier-3 rules-only install. Aider has no native MCP client, so we ship its
// two documented convention files (~/.aider.conf.yml and ~/CONVENTIONS.md)
// from $repoRoot/aider/. No MCP entry written anywhere.
//
// Both files are copy-if-missing -- never overwrite user edits.

export function installAider(ctx) {
  if (ctx.ijfwCustomDir) {
    printInfo('Custom-dir install -- skipping Aider merges.');
    printOk('Aider: real platform config left untouched.');
    return { status: 'noop' };
  }

  const confSrc = path.join(ctx.repoRoot, 'aider', 'aider.conf.yml');
  const confDst = path.join(ctx.home, '.aider.conf.yml');
  copyIfMissing(confSrc, confDst);

  const convSrc = path.join(ctx.repoRoot, 'aider', 'CONVENTIONS.md');
  const convDst = path.join(ctx.home, 'CONVENTIONS.md');
  copyIfMissing(convSrc, convDst);

  printOk('Aider: rules-only install (~/.aider.conf.yml + ~/CONVENTIONS.md). No MCP -- Aider lacks a native MCP client.');
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// 15. Antigravity -- Google's VS Code-fork agentic IDE (ex-Windsurf team).
// ---------------------------------------------------------------------------
//
// Tier `mcp-plus-rules`. Mirrors installWindsurf: home-scoped MCP merge, no
// skills/hooks/commands/agents surface. Antigravity's MCP schema is identical
// to Windsurf's (same team, same flat `mcpServers` block in mcp_config.json).
//
// Antigravity ships TWO surfaces, both Gemini-family, both using the same
// `{"mcpServers":{...}}` schema but reading from DIFFERENT paths:
//   - IDE:  ~/.gemini/antigravity/mcp_config.json
//   - CLI:  ~/.gemini/config/mcp_config.json  (the `agy` binary, confirmed
//           via the CLI's own discovery.go log)
//
// Writes:
//   - ~/.gemini/antigravity/mcp_config.json (mergeJson -- IDE)
//   - ~/.gemini/config/mcp_config.json      (mergeJson -- CLI `agy`)
//
// Agent context: Antigravity uses the AGENTS.md convention, which IJFW
// already deploys/manages -- so Antigravity inherits IJFW context through the
// shared AGENTS.md mechanism, no Antigravity-specific rules file needed.
//
// Skipped on custom-dir or in-source installs (parity with Windsurf).

export function installAntigravity(ctx) {
  if (ctx.ijfwCustomDir || ctx.isIjfwSource) {
    printInfo('Skipping Antigravity platform writes (custom-dir or IJFW source tree).');
    printOk('Antigravity: real platform config left untouched.');
    return { status: 'noop' };
  }

  const serverJs = ctx.serverJsNative || ctx.serverJs;

  // Surface 1 -- Antigravity IDE.
  const ideDst = path.join(ctx.home, '.gemini', 'antigravity', 'mcp_config.json');
  ensureDir(path.dirname(ideDst));
  mergeJson(ideDst, serverJs);

  // Surface 2 -- Antigravity CLI (`agy`). Reads from a different path; ships
  // mcp_config.json as a 0-byte file -- mergeJson treats empty files as {}.
  const cliDst = path.join(ctx.home, '.gemini', 'config', 'mcp_config.json');
  ensureDir(path.dirname(cliDst));
  mergeJson(cliDst, serverJs);

  printOk(`Merged MCP into ${ideDst} + ${cliDst} (Antigravity IDE + CLI)`);
  return { status: 'ok' };
}
