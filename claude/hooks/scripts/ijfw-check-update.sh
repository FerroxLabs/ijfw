#!/usr/bin/env bash
# Detached, fire-and-forget wrapper around ijfw-check-update.js.
# Called from session-start.sh; never blocks the parent hook.
#
# Contract (v3 Âsection 3 SessionStart detach contract):
#   - Parent has 2s ceiling; we spawn detached + unref'd
#   - Child writes one atomic cache file + exits 0
#   - Stale run/<sid>/ dirs >24h get cleaned by the same call
#   - Logs to ~/.ijfw/logs/update-check.log (rotated at 1MB)

# Bail out fast on env disable
case "${IJFW_DISABLE_UPDATE_CHECK:-}" in
  1|true|yes|on|TRUE|YES|ON|True|Yes|On) exit 0 ;;
esac

# Resolve node + script paths
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null)}"
[ -z "$NODE_BIN" ] && exit 0

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_JS="$SCRIPT_DIR/ijfw-check-update.js"
[ -f "$CHECK_JS" ] || exit 0

# Detached spawn -- the parent hook returns immediately. Child runs to
# completion in the background, writes ~/.ijfw/cache/update-check.json.
if [ -t 1 ]; then
  # Interactive: nohup keeps process alive after parent exits
  nohup "$NODE_BIN" "$CHECK_JS" >/dev/null 2>&1 &
else
  # Non-interactive (CI, hooks): same pattern, no controlling terminal
  "$NODE_BIN" "$CHECK_JS" >/dev/null 2>&1 &
fi
disown 2>/dev/null || true
exit 0
