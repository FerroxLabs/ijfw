# IJFW Settings + State

State ownership model (1.1.6):

| File | Purpose | Ownership | Lifetime |
|---|---|---|---|
| `~/.ijfw/settings.json` | User preferences only | User-editable | Persistent |
| `~/.ijfw/state.json` | Durable runtime facts | Installer + update flow | Persistent |
| `~/.ijfw/cache/*.json` | Disposable network results | Background writers | Auto-expires |
| `~/.ijfw/run/<session>/` | Ephemeral per-session | SessionStart + tools | Cleaned at 24h |
| `~/.ijfw/logs/*.log` | Observability | All writers | Rotated at 1MB, keep 2 |

## settings.json

User-editable. JSON Schema at `installer/src/settings-schema.json`. Validated on every write. If validation fails: file is backed up to `settings.json.corrupt.<ts>`, reseeded, and a flag is written to `state.json.settings_reseeded_at` so `ijfw doctor` and the next-session memory prelude surface it.

```json
{
  "schema_version": 1,
  "auto_update": "ask",
  "auto_update_consent_version": null,
  "statusline": {
    "enabled": "auto",
    "mode": "compose",
    "style": "left",
    "compose_path_hash": null,
    "composed_command": null
  },
  "update_check": {
    "interval_hours": 24,
    "failure_backoff_hours": 1
  },
  "context_bar": {
    "enabled": true,
    "used_warn": 0.50,
    "used_critical": 0.80,
    "style": "left"
  }
}
```

### Decision fields (enum strings)

- `auto_update` -- `"ask"` (default), `"on"` (1.1.7+), `"off"`
- `statusline.enabled` -- `"auto"` (compose if GSD detected, else off), `"on"`, `"off"`
- `statusline.mode` -- `"compose"`, `"own"`
- `statusline.style` -- `"left"`, `"right"`
- `context_bar.style` -- `"left"`, `"runway"`, `"classic"`

### Runtime-state fields (nullable)

- `auto_update_consent_version` -- semver of last consent prompt, or `null`
- `statusline.compose_path_hash` -- SHA256 of composed-with binary, or `null`
- `statusline.composed_command` -- absolute path to composed-with command, or `null`

## state.json

Installer-owned. Not user-editable. Written atomically.

```json
{
  "schema_version": 1,
  "install_method": "npm-global",
  "installed_version": "1.1.6",
  "last_applied_version": "1.1.6",
  "last_good_shasum": null,
  "settings_reseeded_at": null,
  "installed_at": 1745270400
}
```

`install_method` enum: `npm-global`, `npm-local`, `git-clone`, `tarball`, `manual`.

## cache/update-check.json

Background writer. Disposable.

```json
{
  "schema_version": 1,
  "last_check": 1745270400,
  "last_latest_seen": "1.1.6",
  "last_failure": null
}
```

## Environment overrides

- `IJFW_DISABLE_UPDATE_CHECK={1|true|yes|on}` -- skip the SessionStart bg check
- `IJFW_HOME=<path>` -- override `~/.ijfw` (used by E2E + isolated installs)
- `IJFW_FROM_MCP=1` -- set internally; refuses terminal-only commands when present
