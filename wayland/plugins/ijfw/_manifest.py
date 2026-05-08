# _manifest.py -- plugin checksum manifest verification (V3-F7 baseline).
#
# Each plugin file ships with a SHA-256 entry in manifest.sha256. On
# register() the plugin recomputes the checksums and refuses to register
# its context engine if any file's hash drifts from the manifest. This
# is the deterministic baseline of the V3-F7 signing chain -- the
# ed25519 signature + GitHub OIDC attestation layer rides ON TOP of
# this manifest at install time (installer/src/verify-plugin-signature.js
# and installer/src/trust-store.js).
#
# Format (manifest.sha256, LC_ALL=C compatible):
#   <sha256-hex>  <relative-path>
#   ...
#
# Lines starting with '#' are comments; blank lines ignored. The format
# is identical to GNU coreutils `sha256sum` so users can verify by hand:
#   cd wayland/plugins/ijfw && LC_ALL=C sha256sum -c manifest.sha256
#
# Mismatch policy:
#   - Manifest missing       -> WARN (dev environments, repo-local runs)
#   - Manifest present + OK  -> verified=True
#   - Manifest present + bad -> verified=False, list of mismatched files
#
# The plugin entry point treats verified=False as "do not claim the
# context engine slot". Hooks + commands still register so the user
# gets a clear path to repair via /ijfw doctor; only the high-trust
# context-engine slot is gated on signature integrity.

import hashlib
import os
import pathlib


# Files included in the integrity envelope. Tests, __pycache__, and the
# manifest itself are intentionally excluded -- the manifest can't sign
# itself, and tests aren't loaded by the live agent.
MANIFESTED_FILES = [
    "__init__.py",
    "_handlers.py",
    "_strings.py",
    "_mcp.py",
    "_context_engine.py",
    "_manifest.py",
]


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_manifest(manifest_path):
    """Parse a sha256sum-format manifest. Returns dict[relpath] = hex."""
    entries = {}
    with open(manifest_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # Format: "<hex>  <path>" (two spaces) -- standard sha256sum.
            # Split on first run of whitespace + optional leading '*'.
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            digest, name = parts[0], parts[1]
            # GNU sha256sum prepends '*' for binary mode. Strip it.
            if name.startswith("*"):
                name = name[1:]
            entries[name] = digest.lower()
    return entries


def verify_manifest(plugin_dir=None):
    """Compute checksums for MANIFESTED_FILES and compare to manifest.

    Returns a dict with the verification result:
        {
          "verified": bool,
          "manifest_present": bool,
          "mismatched": [<relpath>, ...],
          "missing":    [<relpath>, ...],
          "manifest_path": <str>,
        }

    Never raises. Failure to read any file is treated as a mismatch so
    the caller errs on the side of caution.
    """
    if plugin_dir is None:
        plugin_dir = pathlib.Path(__file__).parent
    plugin_dir = pathlib.Path(plugin_dir)
    manifest_path = plugin_dir / "manifest.sha256"

    result = {
        "verified": False,
        "manifest_present": False,
        "mismatched": [],
        "missing": [],
        "manifest_path": str(manifest_path),
    }

    if not manifest_path.is_file():
        return result
    result["manifest_present"] = True

    try:
        expected = _parse_manifest(manifest_path)
    except OSError:
        return result

    mismatched = []
    missing = []
    for relpath in MANIFESTED_FILES:
        target = plugin_dir / relpath
        if not target.is_file():
            missing.append(relpath)
            continue
        if relpath not in expected:
            # Manifest doesn't cover this file. Treat as missing-from-manifest
            # so callers see a precise gap rather than a silent pass.
            missing.append(relpath)
            continue
        try:
            got = _sha256_file(target)
        except OSError:
            mismatched.append(relpath)
            continue
        if got.lower() != expected[relpath]:
            mismatched.append(relpath)

    result["mismatched"] = mismatched
    result["missing"] = missing
    result["verified"] = (not mismatched) and (not missing)
    return result


def render_verification_summary(result):
    """One-line summary string for logs / strings table.

    Always positive-framed when verified; explicit when not, so the
    user knows which file drifted (Sutherland reframe doesn't apply
    to integrity warnings -- we want them visible).
    """
    if not result.get("manifest_present"):
        return "IJFW plugin manifest not present (dev mode); integrity check skipped."
    if result.get("verified"):
        return "IJFW plugin integrity verified."
    parts = []
    if result.get("mismatched"):
        parts.append("checksum drift: " + ", ".join(result["mismatched"]))
    if result.get("missing"):
        parts.append("missing from manifest: " + ", ".join(result["missing"]))
    return "IJFW plugin integrity check needs attention -- " + "; ".join(parts)


__all__ = [
    "MANIFESTED_FILES",
    "verify_manifest",
    "render_verification_summary",
]
