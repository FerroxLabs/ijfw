#!/usr/bin/env bash
# scripts/check-version-lockstep.sh
#
# F4.4 + Wave 2 Lens 3 (F-C-5, F-C-7): assert every RELEASE-versioned surface
# carries the same version. Codex doctor's "plugin metadata" check trusts this
# invariant -- a half-bumped release silently breaks the doctor for users, and
# a marketplace/plugin manifest stuck a version behind mislabels the listing
# users install from (Hermes copies its plugin.yaml to ~/.hermes verbatim).
#
# Coverage: gemini + both marketplaces were drifted at 1.5.6, and the hermes +
# wayland plugin.yaml manifests at 1.5.1, while the code shipped 1.6.4 -- because
# the old gate checked only 3 JSON surfaces AND ran only in the manual
# scripts/e2e-smoke.sh. This now covers ALL NINE release surfaces:
#   1. installer/package.json                        (npm @ijfw/install version)
#   2. mcp-server/package.json                       (npm @ijfw/memory-server version)
#   3. claude/.claude-plugin/plugin.json             (Claude Code plugin manifest)
#   4. claude/.claude-plugin/marketplace.json        (Claude marketplace -> .plugins[0])
#   5. codex/.codex-plugin/plugin.json               (Codex plugin manifest)
#   6. codex/.agents/plugins/marketplace.json        (Codex marketplace listing)
#   7. gemini/extensions/ijfw/gemini-extension.json  (Gemini extension manifest)
#   8. hermes/plugins/ijfw/plugin.yaml               (Hermes plugin manifest; SHIPS verbatim)
#   9. wayland/plugins/ijfw/plugin.yaml              (Wayland plugin source manifest)
#
# NOT covered (deliberate): the repo root package.json is the private
# "ijfw-workspace" stub (private:true, version 1.0.0) -- not a release surface.
#
# IJFW-styled error surface (no raw Node stack traces) + a "likely target" hint.

set -euo pipefail
REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# read_json_ver <label> <manifest-path> [<node-accessor>]
# accessor defaults to `m.version`; pass a JS expression on `m` for nested
# surfaces (the Claude marketplace nests it under plugins[0]). The manifest path
# is passed via argv (NOT string-interpolated) so a checkout path containing a
# quote can't break the require().
read_json_ver () {
  local label="$1" pkg="$2" accessor="${3:-m.version}"
  local v
  v=$(node -e "const m=require(process.argv[1]); const v=($accessor); if(v==null){process.exit(3)} process.stdout.write(String(v))" "$REPO_ROOT/$pkg" 2>/dev/null) || {
    echo "[version-lockstep] $label manifest UNPARSEABLE or missing version: $pkg" >&2
    exit 1
  }
  printf '%s' "$v"
}

# read_yaml_ver <label> <manifest-path>
# Reads the first top-level `version:` key. Zero-dep (no YAML lib): strips
# optional surrounding quotes/whitespace. Sufficient for these flat manifests.
read_yaml_ver () {
  local label="$1" pkg="$2" v
  v=$(awk -F: '/^version:[[:space:]]*/ {sub(/^version:[[:space:]]*/,""); gsub(/["'\''[:space:]]/,""); print; exit}' "$pkg")
  if [ -z "$v" ]; then
    echo "[version-lockstep] $label manifest missing a top-level version: $pkg" >&2
    exit 1
  fi
  printf '%s' "$v"
}

# read_ver <label> <path> <kind> [<accessor>]  -- kind = json | yaml
read_ver () {
  local label="$1" pkg="$2" kind="$3" accessor="${4:-}"
  if [ ! -f "$pkg" ]; then
    echo "[version-lockstep] $label manifest MISSING: $pkg" >&2
    exit 1
  fi
  case "$kind" in
    json) read_json_ver "$label" "$pkg" "$accessor" ;;
    yaml) read_yaml_ver "$label" "$pkg" ;;
    *)    echo "[version-lockstep] internal: unknown kind '$kind' for $pkg" >&2; exit 1 ;;
  esac
}

# label|path|kind|accessor  (accessor only used for json; omit for m.version)
SURFACES=(
  "installer|installer/package.json|json"
  "mcp-server|mcp-server/package.json|json"
  "claude plugin|claude/.claude-plugin/plugin.json|json"
  "claude marketplace|claude/.claude-plugin/marketplace.json|json|m.plugins[0].version"
  "codex plugin|codex/.codex-plugin/plugin.json|json"
  "codex marketplace|codex/.agents/plugins/marketplace.json|json"
  "gemini extension|gemini/extensions/ijfw/gemini-extension.json|json"
  "hermes plugin|hermes/plugins/ijfw/plugin.yaml|yaml"
  "wayland plugin|wayland/plugins/ijfw/plugin.yaml|yaml"
)

ref_ver=""
drift=0
report=""
for entry in "${SURFACES[@]}"; do
  IFS='|' read -r label path kind accessor <<< "$entry"
  v=$(read_ver "$label" "$path" "$kind" "$accessor")
  report+="$(printf '  %-44s %s' "$path:" "$v")"$'\n'
  if [ -z "$ref_ver" ]; then
    ref_ver="$v"
  elif [ "$v" != "$ref_ver" ]; then
    drift=1
  fi
done

if [ "$drift" -ne 0 ]; then
  echo "[version-lockstep] DRIFT detected across release surfaces:" >&2
  printf '%s' "$report" >&2
  echo "" >&2
  target=$(printf '%s' "$report" | awk '{print $NF}' | sort -V | tail -1)
  echo "  likely target (highest semver): $target" >&2
  echo "" >&2
  echo "Fix: bump every surface above to the same version before publishing." >&2
  exit 1
fi

echo "[version-lockstep] OK: all 9 release surfaces at $ref_ver"
