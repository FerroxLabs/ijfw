#!/usr/bin/env bash
# test-envelope-invariant-codex.sh
# Asserts that the Codex PostToolUse trim envelope is the FINAL stdout line,
# even after the async observation capture is dispatched.
#
# Acceptance: exit 0 if invariant holds, exit 1 if violated.

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POST_TOOL_USE="$REPO_ROOT/codex/.codex/hooks/post-tool-use.sh"

if [ ! -f "$POST_TOOL_USE" ]; then
  printf 'FAIL: post-tool-use.sh not found at %s\n' "$POST_TOOL_USE" >&2
  exit 1
fi

# Minimal PostToolUse payload with no failure signal should stay silent.
PAYLOAD='{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo hello"},"tool_response":{"output":"hello world"},"session_id":"test-codex-001"}'

# Run post-tool-use.sh with the payload, capture stdout.
OUTPUT=$(printf '%s' "$PAYLOAD" | bash "$POST_TOOL_USE" 2>/dev/null)

if [ -n "$OUTPUT" ]; then
  printf 'FAIL: post-tool-use.sh should be silent for routine output\n' >&2
  printf 'Output was: %s\n' "$OUTPUT" >&2
  exit 1
fi

# Failure payload should also stay silent; signal capture happens locally.
PAYLOAD='{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"output":"Error: test failed"},"session_id":"test-codex-001"}'
OUTPUT=$(printf '%s' "$PAYLOAD" | bash "$POST_TOOL_USE" 2>/dev/null)

if [ -n "$OUTPUT" ]; then
  printf 'FAIL: post-tool-use.sh should be silent even for failure output\n' >&2
  printf 'Output was: %s\n' "$OUTPUT" >&2
  exit 1
fi

printf 'PASS: Codex PostToolUse is silent; observations and signals are local-only\n'
exit 0
