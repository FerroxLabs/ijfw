// IJFW v1.5.2 -- brain project discovery (Trident F-F3).
//
// Two sources, registry wins on duplicate:
//   1. Registry: <homeDir>/.ijfw/registry.md -- markdown list of "- [name](path)".
//      This is the operator-curated source of truth.
//   2. Filesystem scan: opt-in walk of caller-supplied dev roots. Skips
//      node_modules + dotdirs. Stops descending once a marker hits (either
//      <dir>/ijfw/ for v2 or <dir>/.ijfw/ for legacy v1).
//
// Each discovered project is reported with { name, path, kind, fromRegistry }
// where kind = 'v2' (ijfw/ present) or 'legacy' (only .ijfw/). v2 wins
// when both markers are present.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const REGISTRY_RE = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;

export function readRegistry(homeDir) {
  const p = join(homeDir, '.ijfw', 'registry.md');
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(REGISTRY_RE);
    if (m) out.push({ name: m[1].trim(), path: m[2].trim(), fromRegistry: true });
  }
  return out;
}

export function isIjfwProject(dir) {
  const visible = existsSync(join(dir, 'ijfw'));
  const hidden = existsSync(join(dir, '.ijfw'));
  if (visible) return { kind: 'v2', migrate: false };
  if (hidden) return { kind: 'legacy', migrate: true };
  return null;
}

export function scanFilesystem(roots, { maxDepth = 3 } = {}) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    const marker = isIjfwProject(dir);
    if (marker) {
      found.push({ name: basename(dir), path: dir, kind: marker.kind, fromRegistry: false });
      return; // do NOT descend into a project
    }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules') continue;
      walk(join(dir, e.name), depth + 1);
    }
  }
  for (const root of roots || []) {
    let s;
    try { s = statSync(root); } catch { continue; }
    if (s.isDirectory()) walk(root, 0);
  }
  return found;
}

export function discoverProjects({ homeDir, scanRoots = [], maxDepth = 3 } = {}) {
  const fromRegistry = readRegistry(homeDir);
  const fromScan = scanFilesystem(scanRoots, { maxDepth });
  // Dedup: registry wins on duplicate path
  const seenPaths = new Set(fromRegistry.map((p) => p.path));
  const merged = [...fromRegistry];
  for (const p of fromScan) {
    if (seenPaths.has(p.path)) continue;
    merged.push(p);
    seenPaths.add(p.path);
  }
  // Annotate kind for registry entries (registry doesn't carry it).
  for (const p of merged) {
    if (p.fromRegistry && !p.kind) {
      const m = isIjfwProject(p.path);
      p.kind = m ? m.kind : 'unknown';
    }
  }
  return merged;
}
