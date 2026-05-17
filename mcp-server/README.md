# @ijfw/memory-server

IJFW MCP memory server — the runtime backend that powers memory, metrics,
update checks, and the extension sandbox for all supported AI coding agents.

## Install

This package is installed automatically by `@ijfw/install`. You generally
do not need to install it manually.

```bash
npm install -g @ijfw/memory-server
```

## Extension CLI

IJFW ships a full extension system for installing and sandboxing third-party skills.

```bash
# Publisher key management
ijfw extension keygen <author>              # Generate an Ed25519 publisher keypair
ijfw extension trust <keyId> <publicKey>   # Add a publisher to your trusted store
ijfw extension trust-registry [<url>]      # Pull + apply the hosted publisher registry
ijfw extension untrust <keyId>             # Remove a publisher from your trusted store
ijfw extension trusted                     # List all trusted publishers

# Extension lifecycle
ijfw extension add <source> [flags]        # Install an extension (npm name, local path, or https git URL)
  --allow-unsigned                         #   Accept extensions with no signature
  --accept-untrusted                       #   Accept extensions signed by an untrusted publisher (prompts on TTY)
  --activate                               #   Auto-activate after install
ijfw extension activate <name>             # Activate an installed extension (enforces declared permissions)
ijfw extension deactivate                  # Deactivate the current extension

# Admin / registry maintainer (rare)
ijfw extension rotate-keys <oldKeyId> <newKeyId>   # Produce a signed rotation token
ijfw extension keygen-meta <author>                # Generate the registry meta-keypair
ijfw extension sign-registry <path>                # Sign a registry JSON file in place
ijfw extension verify-registry <path>              # Verify a registry JSON signature
ijfw extension registry-status                     # Show registry cache age + signature status
```

The rotation flow and registry maintainer docs live in `docs/REGISTRY-MAINTAINER.md`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `ijfw_memory_store` | Store a memory entry |
| `ijfw_memory_recall` | Recall memory entries |
| `ijfw_memory_search` | Full-text search over memories |
| `ijfw_memory_prelude` | Load project context at session start |
| `ijfw_cross_project_search` | Search memories across projects |
| `ijfw_metrics` | Read cost + usage metrics |
| `ijfw_update_check` | Check for IJFW updates |
| `ijfw_update_apply` | Apply a pending IJFW update |
| `ijfw_prompt_check` | Validate a prompt against IJFW rules |
| `ijfw_run` | Run a sandboxed IJFW command |

## Build (contributors)

```bash
cd mcp-server
npm install
npm test
node --experimental-sqlite --test test-*.js
```
