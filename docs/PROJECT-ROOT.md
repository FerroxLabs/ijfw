# Project root contract (MCP memory server)

The MCP server stores project memory in `<project root>/.ijfw/`. This page
defines how that root is chosen, and what each host gives the server to choose
it. The code is `mcp-server/src/lib/project-root-guard.js`
(`describeProjectRoot()` / `safeProjectDir()`). The tests are
`mcp-server/test-project-root-contract.js` and `test-safe-project-dir.js`.

## The contract

The server checks these candidates in order. It uses the first one that passes.

| # | Candidate | Accepted when |
|---|-----------|---------------|
| 1 | `IJFW_PROJECT_DIR` | absolute, not an unexpanded template (`${PWD}`, `$HOME`, `{{x}}`, `%CD%`), not inside an app bundle (also checked through symlinks), writable |
| 2 | `CLAUDE_PROJECT_DIR` | same rules as 1 |
| 3 | `process.cwd()` | not inside an app bundle, not the filesystem root `/`, writable, and, for the MCP server only, not inside an OS temp root |
| 4 | `HOME` | always (fallback) |

- **OS temp roots:** `os.tmpdir()`, `/tmp`, `/var/tmp`, `/var/folders`, and
  their `/private/...` forms on macOS.
- **Explicit signals win.** If you set `IJFW_PROJECT_DIR` to a temp directory,
  the server uses it, because you chose it on purpose. Only a temp *cwd* is
  skipped.
- **The temp rule is for the MCP server only.** The host picks the server's
  cwd (`safeProjectDir({ hostSpawned: true })` in `server.js`). The `ijfw`
  CLI runs in the directory where you typed the command, so a temp cwd there
  is your choice and is kept.
- **HOME fallback means user-global memory.** When nothing better is
  available, `<HOME>/.ijfw/memory` is the store. That is the same directory as
  the global memory. Memory is then shared across all projects, but it is
  never lost in a temp directory and never written to `/` or into an app
  bundle.
- **No walking up to a parent directory.** If a session starts in a project
  subdirectory, memory stays in that subdirectory. The hooks also write to the
  session's cwd. Walking up in the server only would split memory between two
  places.
- **No output at startup.** Rejected candidates do not print to stderr,
  because MCP clients treat startup stderr as a failure.
  `describeProjectRoot()` returns `{ dir, source, rejected[] }` for
  diagnostics.

## What each host provides (audit)

"Verified" means checked against the host's source code. The host was not run
in this change.

| Host | How IJFW registers the server | Root signal the server receives | Status |
|------|-------------------------------|----------------------------------|--------|
| Codex CLI / Codex Desktop | `~/.codex/config.toml` `[mcp_servers.ijfw-memory]`, no `cwd` key, own `env.PATH` so desktop apps find `node` | cwd = Codex's runtime working directory (`LocalStdioServerLauncher` `fallback_cwd`, openai/codex `codex-rs/rmcp-client/src/stdio_server_launcher.rs`) | Verified in source |
| Gemini CLI (extension) | `gemini-extension.json` | `IJFW_PROJECT_DIR=${workspacePath}`. Gemini fills this with its workspace dir (`hydrateString` in gemini-cli `packages/cli/src/config/extensions/variables.ts`). The old value, `${PWD}`, depended on the launching shell and stayed as the literal `${PWD}` when `PWD` was unset. | Verified in source |
| Gemini CLI (settings.json) | `~/.gemini/settings.json` from the installer | cwd only. Gemini skips a second server with the same name, so whichever entry registers first wins. | Order not verified |
| Claude Code | plugin `.mcp.json` + `~/.claude/settings.json` | cwd = the directory where the session started; `CLAUDE_PROJECT_DIR` when Claude Code sets it | Not re-verified here |
| Claude Desktop | `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`), merged only when the app is installed | none; the app does not report an open project, so memory is **user-global** (HOME). Use `scope: "all"` search to reach project memory | Root signal not verifiable (closed source) |
| Cursor / Windsurf / Copilot / other project-scoped JSON configs | project or user MCP JSON | cwd only (the host chooses it; IJFW sets no `cwd`) | Not verified |

## Searching all projects (`scope: "all"`)

- **What is searched:** every project listed in `~/.ijfw/registry.md` (the
  session-start hooks add a project the first time an agent starts in it),
  plus the current project.
- **Which folder is read:** each project's memory is read from the folder
  that project's own server uses: `ijfw/memory` (layout v2) or
  `.ijfw/memory` (older layout).
- **Which locations are allowed:**
  - your home folder;
  - on macOS, `/Volumes/...` (projects on a separate drive);
  - any absolute path listed in `IJFW_PROJECT_ROOTS` (separated by `:`).
- **Safety rule outside the home folder:** a project there is read only if
  it has a `.ijfw` folder owned by you. A stray or hostile registry line
  therefore cannot make the server read other folders.

## Known limitations

- A host that starts the server with cwd `/`, a temp directory, or its own app
  bundle, and gives no explicit signal, gets **user-global** memory (HOME).
  The server cannot see the project such a host has open. Fix it in the host
  config by setting `IJFW_PROJECT_DIR` to an absolute project path.
- The Codex hooks (`~/.codex/hooks/*.sh`) write `.ijfw/` files into Codex's
  hook cwd (the session cwd). They do not apply this contract. So if Codex runs
  in a temp directory, the hooks still write there.
- The installer writes `~/.codex/...` and does not read `CODEX_HOME`. Codex
  loads `AGENTS.md` from `$CODEX_HOME`, which defaults to `~/.codex`. If you
  set `CODEX_HOME` to another path, copy the IJFW block from
  `~/.codex/AGENTS.md` there.
- Codex reads `~/.codex/AGENTS.override.md` *instead of* `AGENTS.md` when the
  override file has content. The installer leaves your override untouched and
  prints a note.
