# IJFW Compute Sandbox Coverage

This file documents what the IJFW compute lever (`ijfw_run compute:js` /
`compute:python`) does and does not protect against, per platform. It is
the honest counterpart to V3-B1 ("everything is best-effort, OS-level is
the real boundary").

The runner has two layers:

1. **In-process layer** -- `vm.Script` (vmOnly mode) or env scrub.
2. **OS-level wrapper** -- `sandbox-exec` (macOS), `nsjail` / `firejail` /
   `bwrap` (Linux), AppContainer / job objects (Windows, degraded).

The OS layer is the actual security boundary. The in-process layer is a
defence-in-depth layer.

## macOS (sandbox-exec)

`sandbox-exec` is deprecated by Apple but still functional through current
macOS releases. Generated profile lives at `<tempDir>/sandbox.sb`.

### Read-side enforcement (V3-B1 honest broad-allow caveat)

The macOS profile uses **broadly-allowed reads, plus an enumerated deny-list**
for sensitive HOME subpaths and literal files. A strict allow-list is not
viable on macOS: Node and Python require sweeping read access to dyld, the
shared library cache, and frameworks just to start. Implementing strict
allowlist reads breaks `process.execPath` resolution before user code runs.

The deny-list at `mcp-server/src/compute/sandbox-macos.js` covers:

- `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Pictures`, `~/Movies`, `~/Music`
- Browser profiles: Chrome, Firefox, Brave, Edge, Arc, Vivaldi, Safari
- `~/Library/Application Support/Slack`
- `~/Library/Group Containers` (1Password, etc.)
- `~/Library/Cookies`, `~/Library/Keychains`, `~/Library/Mail`,
  `~/Library/Messages`, `~/Library/Safari`
- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`
- `~/.config` (covers gh, op tokens, gcloud), `~/.config/gcloud`
- `~/.cargo`, `~/.op` (1Password CLI)
- Literal: `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.gitconfig`,
  `~/.gitconfig.local`, `~/.bash_history`, `~/.zsh_history`,
  `~/.psql_history`, `~/.profile`, `~/.bashrc`, `~/.zshrc`

### Residual gaps (known)

- Anything under `~` not enumerated above is **readable** by the compute
  child. New apps creating credential stores in non-standard locations are
  not covered until the deny-list is extended.
- Some Apple-internal subsystems (e.g. `mDNSResponder` lookup) may leak
  metadata even when `network*` is denied.

### Write-side enforcement

Writes are a strict allow-list: only `cwd`, the per-invocation `tempDir`,
and caller-supplied `allowedPaths` are writable. All other locations
(including the read-allowed home subtrees) are write-denied.

### Network

Default deny outbound + inbound. Loopback is allowed for Node IPC.
`allowNet=true` switches to `(allow network*)`.

## Linux

Detected from this priority order: `nsjail` > `firejail` > `bwrap` >
passthrough.

### Network namespacing (B2 fix)

For `allowNet=false`:
- `bwrap`: `--unshare-net`
- `firejail`: `--net=none`
- `nsjail`: new netns is created by default (no flag); `--iface_no_lo`
  added to deny loopback.

For `allowNet=true`, host network is shared. `nsjail` explicitly passes
`--disable_clone_newnet`.

### Filesystem

Read-only bindmounts of `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/etc`
plus the project root. Read-write only on `cwd`, `tempDir`, and
caller-supplied `allowedPaths`.

### Passthrough fallback

If no isolation tool is detected, the runner emits a degraded-mode warning
and runs the subprocess with scrubbed env + path-prefix check only. The
sandbox status is reported back to the caller via `sandbox.degraded=true`.

## Windows

AppContainer is reported as `degraded=true` per V3-B1. The IJFW project
does not currently ship a job-object profile that meets the same coverage
as macOS / Linux. The compute lever runs with env scrub + path-prefix
check only on Windows. This is documented in `sandbox-windows.js`.

## In-process (vm.Script, JS only)

Enabled via `vmOnly=true` or `IJFW_COMPUTE_VM_ONLY=1`.

**Blocked at parse / runtime:**
- The `Function` constructor (codeGeneration.strings = false)
- `eval` (same gate)
- Dynamic `import('...')` (no module loader configured)
- `WebAssembly.instantiate*` (codeGeneration.wasm = false; WebAssembly
  global also seeded undefined at context creation)
- Prototype pollution (frozen prelude on `Object.prototype`,
  `Array.prototype`, etc.)

**Best-effort dropped (see V3-F6 honesty downgrade):**
- `Atomics`, `SharedArrayBuffer` -- seeded as `undefined` keys at
  `vm.createContext()`. If a future Node/V8 release re-exposes them via
  host realm intrinsics, the OS sandbox is the actual security boundary.

**Not exposed:**
- `process`, `require`, `import.meta`
- `setTimeout`, `setImmediate`, `setInterval` (vm.Script has no event loop)
- `fetch`, `XMLHttpRequest`

## Test coverage

Adversarial fixtures live at `mcp-server/test-sandbox-allowlist.js` and
`mcp-server/test-sandbox-vm-bans.js`. The allowlist test creates canary
fixtures in writable areas and probes a subset of the deny-list above; if
the host is missing a target (e.g. CI machine with no `~/Documents`) the
test fails-fast with a clear setup error rather than silently skipping.
