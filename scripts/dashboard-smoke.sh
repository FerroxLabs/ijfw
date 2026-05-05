#!/usr/bin/env bash
# dashboard-smoke.sh -- end-to-end smoke for `ijfw dashboard` surface.
#
# Exercises start (daemon detach), status (live probe), HTTP serve,
# stop (clean shutdown + port file removal), and render (terminal).
# Catches the npm-installed-CLI path-resolution class of bugs that
# the structural e2e harness misses.
#
# Run from repo root:
#   bash scripts/dashboard-smoke.sh
#
# Honors $IJFW_HOME if set (isolated test environments). Otherwise
# uses the real ~/.ijfw/ -- so this can be run on a developer box to
# validate after edits.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IJFW_DIR="${IJFW_HOME:-$HOME/.ijfw}"
PORT_FILE="$IJFW_DIR/dashboard.port"
CLI="$REPO_ROOT/installer/dist/ijfw.js"

PASS=0
FAIL=0
note() { printf "  [..]  %s\n" "$*"; }
pass() { printf "  [PASS] %s\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "  [FAIL] %s\n" "$*"; FAIL=$((FAIL+1)); }

# Pre-check: built dist exists.
if [ ! -f "$CLI" ]; then
  echo "  [skip] CLI not built. Run: cd installer && npm run build" >&2
  exit 64
fi

# Sentinel cleanup -- always tear down at exit, never leave a dashboard
# running on the developer's machine.
cleanup() {
  node "$CLI" dashboard stop --json >/dev/null 2>&1 || true
  # Belt-and-braces: kill anything still listening on the canonical range.
  for p in 37891 37892 37893 37894 37895 37896 37897 37898 37899 37900; do
    pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PORT_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# Reset state.
cleanup
sleep 1

echo "== ijfw dashboard end-to-end smoke =="

# Gate 1: start succeeds (daemon detaches, returns quickly).
note "start dashboard (daemon)"
START_OUT=$(node "$CLI" dashboard start --no-open 2>&1)
START_RC=$?
echo "$START_OUT" | sed 's/^/    /'
if [ $START_RC -eq 0 ]; then
  pass "dashboard start exits 0"
else
  fail "dashboard start exited $START_RC"
fi

# Gate 2: port file written within 5s.
note "wait for port file"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$PORT_FILE" ]; then break; fi
  sleep 0.5
done
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
  pass "port file written: $PORT_FILE -> $PORT"
else
  fail "port file never appeared at $PORT_FILE"
  exit 1
fi

# Gate 3: process actually listening on that port.
note "probe TCP listener on port $PORT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  pass "TCP LISTEN on 127.0.0.1:$PORT"
else
  fail "no TCP LISTEN on port $PORT despite port file"
fi

# Gate 4: HTTP serves index.html (200 + non-empty body).
note "HTTP GET http://127.0.0.1:$PORT/"
HTTP_CODE=$(curl -s -o /tmp/dashboard-smoke-body -w "%{http_code}" "http://127.0.0.1:$PORT/" || echo "000")
BODY_BYTES=$(wc -c < /tmp/dashboard-smoke-body 2>/dev/null || echo 0)
if [ "$HTTP_CODE" = "200" ] && [ "$BODY_BYTES" -gt 100 ]; then
  pass "GET / -> 200 (${BODY_BYTES} bytes)"
else
  fail "GET / -> code=$HTTP_CODE bytes=$BODY_BYTES"
fi

# Gate 5: status command reports running.
note "ijfw dashboard status"
STATUS_OUT=$(node "$CLI" dashboard status 2>&1)
echo "$STATUS_OUT" | sed 's/^/    /'
if echo "$STATUS_OUT" | grep -qiE "running|listening|active|on port|http://"; then
  pass "status reports dashboard running"
else
  fail "status output did not indicate running state"
fi

# Gate 6: status does NOT falsely report running when not asked.
# (skipped -- redundant; covered by gate 9 below)

# Gate 7: stop succeeds.
note "ijfw dashboard stop"
STOP_OUT=$(node "$CLI" dashboard stop 2>&1)
STOP_RC=$?
echo "$STOP_OUT" | sed 's/^/    /'
if [ $STOP_RC -eq 0 ]; then
  pass "dashboard stop exits 0"
else
  fail "dashboard stop exited $STOP_RC"
fi

# Gate 8: process actually gone within 3s.
note "verify TCP LISTEN gone"
for i in 1 2 3 4 5 6; do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "process still listening on $PORT after stop"
else
  pass "no TCP LISTEN on port $PORT after stop"
fi

# Gate 9: status after stop reports not running.
note "ijfw dashboard status (after stop)"
POST_STATUS=$(node "$CLI" dashboard status 2>&1)
echo "$POST_STATUS" | sed 's/^/    /'
if echo "$POST_STATUS" | grep -qiE "not running|stopped|inactive|no dashboard"; then
  pass "post-stop status reports not running"
else
  fail "post-stop status did not indicate stopped state"
fi

# Gate 10: render command (terminal dashboard) returns quickly with output.
note "ijfw dashboard render (terminal)"
RENDER_OUT=$(timeout 10 node "$CLI" dashboard render 2>&1 || echo "TIMEOUT_OR_ERR")
RENDER_BYTES=$(printf '%s' "$RENDER_OUT" | wc -c)
if [ "$RENDER_BYTES" -gt 50 ] && ! echo "$RENDER_OUT" | grep -q "TIMEOUT_OR_ERR\|Dashboard bin not found"; then
  pass "render produced terminal output (${RENDER_BYTES} bytes)"
else
  fail "render failed or empty (bytes=$RENDER_BYTES)"
fi

echo
echo "== Summary =="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
