#!/usr/bin/env bash
# cli-smoke.sh -- IJFW CLI command smoke harness.
#
# Audits EVERY routed `ijfw` verb against the repo CLI and records, per verb:
#   exit code, stderr tail, and a WORKS / BROKEN / STUB / NEEDS-NETWORK / MISSING
#   verdict. It is a real gate: exits non-zero if ANY verb hard-crashes
#   (node stack trace, "Cannot find module", undefined-var / require-path drift).
#
# Architecture under test (confirmed 2026-06-08):
#   `ijfw <verb>` shell/npm-bin launcher -> installer/src/ijfw.js
#     - some verbs handled directly (install, uninstall, dashboard, design,
#       help, preflight, pack-hub-extension, doctor, commands, off, version)
#     - "orchestrator" verbs delegated to:
#       node mcp-server/src/cross-orchestrator-cli.js <verb> ...
#   Pointer-stub verbs (workflow, handoff, mode, metrics, ...) resolve ONLY at
#   the launcher level; hitting the orchestrator directly returns "Unknown".
#
# This harness exercises BOTH dispatchers:
#   ORCH  rows -> node mcp-server/src/cross-orchestrator-cli.js <verb>
#   LAUNCH rows -> node installer/src/ijfw.js <verb>
#
# SAFETY (hard rules):
#   - Stateful/destructive verbs run under a scratch HOME ($SCRATCH_HOME) or
#     are tested via a read-only / --help / status / --dry-run / --check path
#     ONLY. The harness NEVER mutates the real ~/.ijfw, never pushes/publishes,
#     never touches a pod, never spawns a long-lived server.
#   - All invocations get stdin </dev/null so an interactive confirm cannot hang.
#   - Every verb runs under `timeout` so nothing wedges CI.
#   - Network-required verbs (install, update apply) are SKIPPED + logged.
#
# Usage:
#   mcp-server/scripts/cli-smoke.sh            # human table + gate
#   mcp-server/scripts/cli-smoke.sh --json     # JSON lines (one per verb)
#   mcp-server/scripts/cli-smoke.sh --verbose  # echo stderr tails inline
#
# Exit: 0 if no BROKEN verbs; 1 if any verb hard-crashed.

set -u

# --- locate repo root (script lives at <root>/mcp-server/scripts/) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd)"
ORCH="$REPO_ROOT/mcp-server/src/cross-orchestrator-cli.js"
LAUNCH="$REPO_ROOT/installer/src/ijfw.js"

JSON=0
VERBOSE=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    --help|-h)
      sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "cli-smoke: node not found on PATH" >&2
  exit 2
fi
for f in "$ORCH" "$LAUNCH"; do
  if [ ! -f "$f" ]; then
    echo "cli-smoke: missing CLI file: $f" >&2
    exit 2
  fi
done

# --- scratch HOME so stateful verbs cannot touch the real ~/.ijfw -----------
SCRATCH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/ijfw-cli-smoke.XXXXXX")"
cleanup() { rm -rf "$SCRATCH_HOME" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

TIMEOUT_BIN="timeout"
command -v timeout >/dev/null 2>&1 || TIMEOUT_BIN="gtimeout"
command -v "$TIMEOUT_BIN" >/dev/null 2>&1 || TIMEOUT_BIN=""
PER_CMD_TIMEOUT="${IJFW_SMOKE_TIMEOUT:-25}"

# --- crash signatures: a non-zero exit is only a HARD CRASH if stderr looks
#     like a node runtime fault, NOT a clean usage error -----------------------
CRASH_RE='(node:internal|at .*\.js:[0-9]+:[0-9]+|Cannot find module|ERR_MODULE_NOT_FOUND|is not a function|is not defined|Cannot read propert|UnhandledPromiseRejection|ReferenceError|TypeError:|SyntaxError:|throw new Error)'

BROKEN_COUNT=0
WORKS_COUNT=0
STUB_COUNT=0
SKIP_COUNT=0
MISSING_COUNT=0
ROWS=()

# run_case <label> <dispatcher: ORCH|LAUNCH> <expect: ok|usage|guided|missing|skip> <verb...>
#   ok      -> exit 0 expected (WORKS); non-zero w/o crash sig = BROKEN
#   usage   -> exit 1 with a usage/Unknown message is acceptable (WORKS surface)
#   guided  -> v1.6.0 CLI-honesty: an unrouted/documented verb that MUST NOT
#              return a BARE "Unknown command" — it has to carry a guidance line
#              ("Did you mean", "Note:", "not available", "design milestone").
#              Bare-unknown with no guidance = BROKEN (the user complaint).
#   missing -> documented-but-unrouted; "Unknown command" exit1 expected (MISSING)
#   skip    -> network/destructive; not executed (NEEDS-NETWORK)
GUIDED_RE='Did you mean|Note:|not available|design milestone|ijfw install|ijfw personalize|ijfw swarm|ijfw memory'
run_case() {
  local label="$1" disp="$2" expect="$3"; shift 3
  local cli; [ "$disp" = "ORCH" ] && cli="$ORCH" || cli="$LAUNCH"

  if [ "$expect" = "skip" ]; then
    SKIP_COUNT=$((SKIP_COUNT+1))
    ROWS+=("$label|$disp|NEEDS-NETWORK|-|skipped (network/destructive — not executed)")
    return
  fi

  local out err code
  local of="$SCRATCH_HOME/out.$$" ef="$SCRATCH_HOME/err.$$"
  if [ -n "$TIMEOUT_BIN" ]; then
    HOME="$SCRATCH_HOME" IJFW_HOME="$SCRATCH_HOME/.ijfw" NO_OPEN=1 CI=1 \
      "$TIMEOUT_BIN" "$PER_CMD_TIMEOUT" node "$cli" "$@" </dev/null >"$of" 2>"$ef"
    code=$?
  else
    HOME="$SCRATCH_HOME" IJFW_HOME="$SCRATCH_HOME/.ijfw" NO_OPEN=1 CI=1 \
      node "$cli" "$@" </dev/null >"$of" 2>"$ef"
    code=$?
  fi
  err="$(cat "$ef" 2>/dev/null)"
  out="$(cat "$of" 2>/dev/null)"

  local verdict reason
  if [ "$code" -eq 124 ]; then
    verdict="BROKEN"; reason="TIMED OUT after ${PER_CMD_TIMEOUT}s (possible hang / blocked on input)"
  elif printf '%s\n%s' "$err" "$out" | grep -qE "$CRASH_RE"; then
    verdict="BROKEN"; reason="crash: $(printf '%s\n%s' "$err" "$out" | grep -oE "$CRASH_RE" | head -1) :: $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-110)"
  else
    case "$expect" in
      guided)
        # v1.6.0: an unrouted advertised verb is acceptable ONLY if it carries a
        # guidance line. A bare "Unknown command" with NO did-you-mean/Note is
        # exactly the user complaint -> BROKEN.
        if [ "$code" -eq 0 ]; then
          verdict="WORKS"; reason="routed after all (exit 0)"
        elif printf '%s' "$err$out" | grep -qiE "$GUIDED_RE"; then
          verdict="WORKS"; reason="unrouted but GUIDED (did-you-mean/Note present, exit $code)"
        elif printf '%s' "$err$out" | grep -qiE 'Unknown (command|subcommand)'; then
          verdict="BROKEN"; reason="BARE unknown — no guidance line (the user complaint), exit $code"
        else
          verdict="BROKEN"; reason="exit $code, no guidance, no crash: $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-110)"
        fi ;;
      missing)
        if printf '%s' "$err$out" | grep -qiE 'Unknown (command|subcommand)'; then
          verdict="MISSING"; reason="documented but NOT routed (Unknown command, exit $code)"
        elif [ "$code" -eq 0 ]; then
          verdict="WORKS"; reason="routed after all (exit 0)"
        else
          verdict="BROKEN"; reason="exit $code, no crash sig: $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-110)"
        fi ;;
      usage)
        if [ "$code" -eq 0 ] || printf '%s' "$err$out" | grep -qiE 'Usage|requires a mode|requires a'; then
          verdict="WORKS"; reason="usage/arg-guard surfaced cleanly (exit $code)"
        else
          verdict="BROKEN"; reason="exit $code, no usage text, no crash: $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-110)"
        fi ;;
      ok|*)
        if [ "$code" -eq 0 ]; then
          if printf '%s' "$out" | grep -qiE 'not implemented|queued for a later release|coming soon|no-?op'; then
            verdict="STUB"; reason="runs but advertises unimplemented surface (exit 0)"
          else
            verdict="WORKS"; reason="exit 0"
          fi
        else
          verdict="BROKEN"; reason="exit $code (expected 0), no crash sig: $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-110)"
        fi ;;
    esac
  fi

  case "$verdict" in
    BROKEN)  BROKEN_COUNT=$((BROKEN_COUNT+1)) ;;
    WORKS)   WORKS_COUNT=$((WORKS_COUNT+1)) ;;
    STUB)    STUB_COUNT=$((STUB_COUNT+1)) ;;
    MISSING) MISSING_COUNT=$((MISSING_COUNT+1)) ;;
  esac

  ROWS+=("$label|$disp|$verdict|$code|$reason")
  if [ "$VERBOSE" -eq 1 ] && [ -n "$err" ]; then
    echo "    [$label stderr] $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-200)" >&2
  fi
  rm -f "$of" "$ef" 2>/dev/null || true
}

# ===========================================================================
# ORCHESTRATOR verbs (node mcp-server/src/cross-orchestrator-cli.js <verb>)
# Read-only / safe-default invocations. status-style subcommands chosen so no
# state is mutated. (team/swarm/blackboard default to their `status` sub.)
# ===========================================================================
run_case "version"        ORCH ok    --version
run_case "help"           ORCH ok    --help
run_case "status"         ORCH ok    status
# demo spawns live auditor CLIs (codex/gemini) via runCrossOp + makes real LLM
# calls (30s/auditor) — network/LLM-bound, not unit-testable here. Skipped.
run_case "demo"           ORCH skip  demo
run_case "doctor"         ORCH ok    doctor
run_case "config"         ORCH ok    config
run_case "insight"        ORCH ok    insight
run_case "receipt"        ORCH ok    receipt
run_case "recover"        ORCH ok    recover
run_case "team"           ORCH ok    team
run_case "swarm"          ORCH ok    swarm
run_case "blackboard"     ORCH ok    blackboard
run_case "codex"          ORCH ok    codex
run_case "memory"         ORCH ok    memory
run_case "memory-reindex" ORCH ok    memory reindex
run_case "env"            ORCH ok    env
run_case "personalize"    ORCH ok    personalize status
run_case "checkpoint"     ORCH ok    checkpoint smoke-label
run_case "worktree"       ORCH ok    worktree list
run_case "statusline"     ORCH ok    statusline
run_case "design"         ORCH ok    design
run_case "dashboard"      ORCH ok    dashboard
run_case "override"       ORCH ok    override
run_case "extension"      ORCH ok    extension
run_case "update-check"   ORCH ok    update --check
run_case "cross"          ORCH usage  cross
run_case "import"         ORCH usage  import
run_case "ui-review"      ORCH usage  ui-review
# Destructive / network — NOT executed against the real env:
run_case "install"        ORCH skip   install
run_case "uninstall"      ORCH skip   uninstall
run_case "preflight"      ORCH skip   preflight
# v1.6.0 CLI-honesty: documented-but-unrouted verbs must be GUIDED, never bare
# "Unknown command". `checkpoint` + `worktree` are now real top-level aliases
# (tested ok above); the rest are guided redirects / de-documented-but-helpful.
run_case "marketplace"    ORCH guided  marketplace
run_case "wave-status"    ORCH guided  wave-status
run_case "cluster"        ORCH guided  cluster
run_case "state"          ORCH guided  state:list
run_case "on"             ORCH guided  on
run_case "worktree-drain" ORCH guided  worktree-drain
# Control: a TRULY non-advertised garbage string SHOULD bare-unknown (the
# suggester must not hallucinate a "did you mean" for noise). MISSING = correct.
run_case "unknown-probe"  ORCH missing definitely-not-a-verb

# ===========================================================================
# LAUNCHER verbs (node installer/src/ijfw.js <verb>)
# These resolve only at the launcher tier (pointer-stubs + installer-direct).
# ===========================================================================
run_case "L:version"     LAUNCH ok    --version
run_case "L:help"        LAUNCH ok    --help
run_case "L:commands"    LAUNCH ok    commands
run_case "L:doctor"      LAUNCH ok    doctor
run_case "L:status"      LAUNCH ok    status
run_case "L:workflow"    LAUNCH ok    workflow
run_case "L:handoff"     LAUNCH ok    handoff
run_case "L:mode"        LAUNCH ok    mode smart
run_case "L:metrics"     LAUNCH ok    metrics
run_case "L:dashboard"   LAUNCH ok    dashboard status
run_case "L:personalize" LAUNCH ok    personalize status
# v1.6.0: launcher-side unknown verbs are GUIDED too (did-you-mean), not bare.
run_case "L:on"          LAUNCH guided on
run_case "L:marketplace" LAUNCH guided marketplace
# off prompts for confirmation; </dev/null makes empty input a safe non-confirm.
run_case "L:off"         LAUNCH ok    off
# Network/destructive at launcher tier — skipped:
run_case "L:install"     LAUNCH skip  install
run_case "L:uninstall"   LAUNCH skip  uninstall
run_case "L:preflight"   LAUNCH skip  preflight
run_case "L:pack-hub"    LAUNCH skip  pack-hub-extension

# ===========================================================================
# PARITY GATE (v1.6.0) — docs ⊆ routed.
# Enumerate EVERY active verb the command-registry advertises (the same set
# `ijfw commands` prints) and assert each one, run bare through the launcher,
# either WORKS, surfaces a clean usage/guidance, or is GUIDED — but NEVER
# returns a bare "Unknown command" with no help. This is the machine-checkable
# promise behind Part A: no advertised verb dead-ends.
# ===========================================================================
PARITY_FAIL=0
PARITY_CHECKED=0
ADVERTISED=$(node --input-type=module -e "
  import { COMMAND_REGISTRY } from '$REPO_ROOT/installer/src/command-registry.js';
  const skip = new Set(['install','uninstall','off','preflight','demo','pack-hub-extension','--purge-receipts','update']);
  const names = COMMAND_REGISTRY
    .filter(e => e.status === 'active' && !e.name.startsWith('--'))
    .map(e => e.name)
    .filter(n => !skip.has(n));
  process.stdout.write([...new Set(names)].join('\n'));
" 2>/dev/null)

while IFS= read -r verb; do
  [ -z "$verb" ] && continue
  PARITY_CHECKED=$((PARITY_CHECKED+1))
  pf="$SCRATCH_HOME/parity-out.$$"; pe="$SCRATCH_HOME/parity-err.$$"
  if [ -n "$TIMEOUT_BIN" ]; then
    HOME="$SCRATCH_HOME" IJFW_HOME="$SCRATCH_HOME/.ijfw" NO_OPEN=1 CI=1 \
      "$TIMEOUT_BIN" "$PER_CMD_TIMEOUT" node "$LAUNCH" "$verb" </dev/null >"$pf" 2>"$pe"
    pcode=$?
  else
    HOME="$SCRATCH_HOME" IJFW_HOME="$SCRATCH_HOME/.ijfw" NO_OPEN=1 CI=1 \
      node "$LAUNCH" "$verb" </dev/null >"$pf" 2>"$pe"
    pcode=$?
  fi
  pboth="$(cat "$pe" "$pf" 2>/dev/null)"
  rm -f "$pf" "$pe" 2>/dev/null || true
  # Acceptable: exit 0, OR any non-zero that carries usage/guidance text.
  if [ "$pcode" -eq 0 ]; then
    :
  elif printf '%s' "$pboth" | grep -qiE "$GUIDED_RE|Usage|requires"; then
    :
  elif printf '%s' "$pboth" | grep -qiE 'Unknown (command|subcommand)'; then
    PARITY_FAIL=$((PARITY_FAIL+1))
    ROWS+=("parity:$verb|LAUNCH|BROKEN|$pcode|advertised verb returns BARE unknown (docs⊄routed)")
    BROKEN_COUNT=$((BROKEN_COUNT+1))
  fi
done <<EOF
$ADVERTISED
EOF
ROWS+=("parity-gate|LAUNCH|$([ "$PARITY_FAIL" -eq 0 ] && echo WORKS || echo BROKEN)|-|$PARITY_CHECKED advertised verbs checked; $PARITY_FAIL bare-unknown")

# ===========================================================================
# Output
# ===========================================================================
if [ "$JSON" -eq 1 ]; then
  for row in "${ROWS[@]}"; do
    IFS='|' read -r verb disp verdict code reason <<<"$row"
    printf '{"verb":"%s","dispatcher":"%s","verdict":"%s","exit":"%s","reason":"%s"}\n' \
      "$verb" "$disp" "$verdict" "$code" "$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  done
else
  printf '\n  IJFW CLI smoke -- %s verbs probed\n\n' "${#ROWS[@]}"
  printf '  %-16s %-7s %-13s %-5s %s\n' "VERB" "DISP" "VERDICT" "EXIT" "REASON"
  printf '  %-16s %-7s %-13s %-5s %s\n' "----" "----" "-------" "----" "------"
  for row in "${ROWS[@]}"; do
    IFS='|' read -r verb disp verdict code reason <<<"$row"
    printf '  %-16s %-7s %-13s %-5s %s\n' "$verb" "$disp" "$verdict" "$code" "$reason"
  done
  printf '\n  WORKS=%s  BROKEN=%s  STUB=%s  MISSING=%s  NEEDS-NETWORK=%s\n\n' \
    "$WORKS_COUNT" "$BROKEN_COUNT" "$STUB_COUNT" "$MISSING_COUNT" "$SKIP_COUNT"
fi

if [ "$BROKEN_COUNT" -gt 0 ]; then
  echo "cli-smoke: GATE FAILED -- $BROKEN_COUNT verb(s) hard-crashed or misbehaved." >&2
  exit 1
fi
exit 0
