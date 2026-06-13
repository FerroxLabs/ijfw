#!/usr/bin/env bash
# seed-gate.sh -- shared "should IJFW materialize on-disk content here?" gate.
#
# Single rule across the whole product: IJFW only writes project artifacts
# (the visible `ijfw/` brain layer, AGENTS.md, CLAUDE.md/GEMINI.md, the codebase
# index, the `.ijfw/project.type` cold scan) into a directory that is actually a
# project. "A project" = carries a recognized marker (a VCS dir or a language
# manifest) OR the operator explicitly blessed it with `ijfw init` (which drops
# `.ijfw/project`).
#
# Why: session-start hooks fire on EVERY new chat, including throwaway scratch
# dirs and ephemeral "temporary spaces" (e.g. Wayland). Seeding those
# unconditionally littered `ijfw/`, AGENTS.md, and CLAUDE.md into dirs the user
# never meant to keep. Memory recall still works in-session; only the on-disk
# content is withheld until the dir proves it's a real project.
#
# This is the bash twin of mcp-server/src/brain/seed-gate.js and mirrors the
# indexer guard in scripts/build-codebase-index.sh. The three marker lists are
# kept identical by a drift test (mcp-server/test/brain/test-seed-gate-drift.js).
# Edit all three together or the test fails.
#
# Two usage shapes:
#   1. Source it:   . seed-gate.sh; ijfw_should_seed "$DIR" && ...    (hooks)
#   2. Run it:      bash seed-gate.sh "$DIR"; [ $? -eq 0 ] && ...      (Python)
#      -> exit 0 = seed, exit 1 = skip. No stdout.
#
# Discipline: LC_ALL=C, ASCII only, no `set -e`, bash 3.2 compatible (POSIX
# `case`, no `[[ ]]`). The gate must NEVER crash a session-start hook.

# Canonical project-marker list. MUST stay identical (same set) to PROJECT_MARKERS
# in seed-gate.js and ijfw_has_project_marker in build-codebase-index.sh.
# `.ijfw/project` is the `ijfw init` override.
# shellcheck disable=SC2034
IJFW_SEED_MARKERS=".git package.json go.mod Cargo.toml pyproject.toml setup.py tsconfig.json pom.xml build.gradle build.gradle.kts Gemfile composer.json deno.json deno.jsonc mix.exs Package.swift requirements.txt .hg .svn .ijfw/project"

# ijfw_should_seed <dir> -> returns 0 (seed) / 1 (skip).
# Refuses the filesystem root, the home directory, and any ancestor of home
# (the issue #16 privacy hole), then requires a project marker.
ijfw_should_seed() {
  _isg_dir="${1:-}"
  [ -n "$_isg_dir" ] || return 1

  # Resolve the physical path. An unresolvable dir cannot be proven safe -> skip.
  _isg_phys="$(cd "$_isg_dir" 2>/dev/null && pwd -P 2>/dev/null)"
  [ -n "$_isg_phys" ] || return 1

  case "$_isg_phys" in
    ""|"/") return 1 ;;
  esac
  # Any filesystem/drive root is its own dirname (covers Windows /c, C:/ shapes).
  if [ "$(dirname "$_isg_phys")" = "$_isg_phys" ]; then
    return 1
  fi

  # Resolve physical $HOME only if HOME is set; treat unresolvable HOME as
  # "could be home" and fail closed (skip) -- we must not risk a home-root write.
  _isg_home=""
  if [ -n "${HOME:-}" ]; then
    _isg_home="$(cd "$HOME" 2>/dev/null && pwd -P 2>/dev/null)"
  fi
  [ -n "$_isg_home" ] || return 1
  # Refuse the home root itself.
  [ "$_isg_phys" = "$_isg_home" ] && return 1
  # Refuse ancestors of home (/Users, /home, ...): home lives under phys/.
  case "$_isg_home/" in
    "$_isg_phys"/*) return 1 ;;
  esac

  # Require a project marker.
  for _isg_m in $IJFW_SEED_MARKERS; do
    [ -e "$_isg_phys/$_isg_m" ] && return 0
  done
  return 1
}

# Standalone invocation: `bash seed-gate.sh <dir>` exits 0/1 for non-bash callers.
# Guard so sourcing does not trigger the exit. ${BASH_SOURCE[0]} vs $0 detects
# direct execution.
if [ "${BASH_SOURCE:-$0}" = "$0" ]; then
  export LC_ALL=C
  if ijfw_should_seed "${1:-}"; then
    exit 0
  else
    exit 1
  fi
fi
