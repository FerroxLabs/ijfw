import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, 'src');
const ROSTER = readFileSync(join(SRC, 'audit-roster.js'), 'utf8');
const ORCH = readFileSync(join(SRC, 'cross-orchestrator.js'), 'utf8');

// ---------------------------------------------------------------------------
// S7 codex roster surface
// ---------------------------------------------------------------------------

test('audit-roster: codex entry declares timeoutMs (8min)', () => {
  // Find the codex entry and verify it has timeoutMs.
  // Match patterns like "id: 'codex'" or "id:\"codex\"" then look forward for timeoutMs.
  assert.match(ROSTER, /id:\s*['"]codex['"]/, 'codex entry not found in audit-roster');
  assert.match(ROSTER, /timeoutMs:\s*8\s*\*\s*60\s*\*\s*1000/, 'codex timeoutMs (8min) missing');
});

test('audit-roster: codex entry declares reviewInvoke with MCP-disable override', () => {
  assert.match(ROSTER, /reviewInvoke:\s*['"]codex review --base/, 'codex reviewInvoke missing');
  assert.match(ROSTER, /mcp_servers\.ijfw-memory\.enabled=false/,
    'codex invoke must disable IJFW MCP server (load-bearing — closes circular MCP wait)');
});

// ---------------------------------------------------------------------------
// S7 cross-orchestrator surface
// ---------------------------------------------------------------------------

test('cross-orchestrator: timeoutForPick honours pick.timeoutMs override', () => {
  assert.match(ORCH, /if\s*\(\s*pick\.timeoutMs\s*\)\s*return\s+pick\.timeoutMs/,
    'timeoutForPick must check pick.timeoutMs before PROVIDER_TIMEOUT_MS fallback');
});

test('cross-orchestrator: auditorResults track counted flag', () => {
  // The refactor adds counted: true/false on each result. Verify it's wired.
  assert.match(ORCH, /counted:\s*false/, 'non-productive results must mark counted:false');
  assert.match(ORCH, /counted:\s*true/, 'productive results must mark counted:true');
});

test('cross-orchestrator: zero productive auditors → INCONCLUSIVE verdict', () => {
  // Verify the verdict guard exists.
  assert.match(ORCH, /productive\.length\s*===\s*0\s*\?\s*['"]INCONCLUSIVE['"]/,
    'verdict guard: zero productive must produce INCONCLUSIVE, not PASS');
});

test('cross-orchestrator: productive filter excludes timeout/failed/aborted', () => {
  // Productive list is built by .filter(r => r.counted).
  assert.match(ORCH, /productive\s*=\s*auditorResults\.filter\(r\s*=>\s*r\.counted\)/,
    'productive should be derived via counted flag filter');
});
