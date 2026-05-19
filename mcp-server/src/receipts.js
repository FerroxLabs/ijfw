// receipts.js -- atomic append/read for cross-run JSONL receipts.
// ESM, zero deps, synchronous fs.
//
// renderReceipt(record, stepNum?) -- human-readable text for one receipt.
//   Header:  Phase N / Wave NA -- <operation> -- <timestamp>
//   Body:    Step N.M -- <finding>
//   cache_stats fields (cache_creation_input_tokens, cache_read_input_tokens)
//   are rendered when present; absence is a no-op.

import fs from 'node:fs';
import path from 'node:path';
// v1.5.0 N4.obs M1: tag every receipt with the orchestrator's trace_id so the
// dashboard can roll up sessions->traces->observations like Langfuse / Helicone.
import { getTraceId } from './observability/trace-id.js';

export function RECEIPTS_FILE(projectDir) {
  return path.join(projectDir, '.ijfw', 'receipts', 'cross-runs.jsonl');
}

const MAX_RECEIPTS = 100;

// Atomic append: O_APPEND is atomic for writes ≤ PIPE_BUF (>=4KB on POSIX).
// One JSON line is well under that limit, so appendFileSync is safe for
// concurrent writers without a lock or rename dance.
// After each write, prune to the last MAX_RECEIPTS entries.
export function writeReceipt(projectDir, record) {
  const dest = RECEIPTS_FILE(projectDir);
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  // v1.5.0 N4.obs M1: tag with trace_id if one is set + caller hasn't supplied
  // one. Never overwrite an explicit caller-supplied trace_id.
  const traceId = getTraceId();
  const enriched = (traceId && record && typeof record === 'object' && !record.trace_id)
    ? { ...record, trace_id: traceId }
    : record;
  fs.appendFileSync(dest, JSON.stringify(enriched) + '\n');
  _pruneReceipts(dest);
}

// Keep only the last MAX_RECEIPTS lines. No-op when at or under the limit.
function _pruneReceipts(dest) {
  const raw = fs.readFileSync(dest, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= MAX_RECEIPTS) return;
  fs.writeFileSync(dest, lines.slice(-MAX_RECEIPTS).join('\n') + '\n');
}

// Purge all receipts. Returns the count of entries removed.
export function purgeReceipts(projectDir) {
  const dest = RECEIPTS_FILE(projectDir);
  if (!fs.existsSync(dest)) return 0;
  const raw = fs.readFileSync(dest, 'utf8');
  const count = raw.split('\n').filter(l => l.trim()).length;
  fs.writeFileSync(dest, '');
  return count;
}

// Anthropic cache-read savings rate (mirrors hero-line.js constant).
const CACHE_SAVINGS_PER_TOKEN = 2.70 / 1_000_000;

// renderReceipt(record, phaseWave?, stepNum?)
//   phaseWave -- caller-supplied label for the narration header. Default is
//                a generic "Trident" heading so receipts do not carry stale
//                phase numbers after IJFW itself moves on.
//   stepNum   -- N.M index for body lines (default 1)
// Returns a multi-line string. JSONL schema is never modified.
export function renderReceipt(record, phaseWave = 'Trident', stepNum = 1) {
  const op = record.mode || 'cross';
  const ts = record.timestamp ? record.timestamp.slice(0, 19).replace('T', ' ') : '';
  const lines = [];

  // Header: Phase N / Wave NA -- <operation> -- <timestamp>
  lines.push(`${phaseWave} -- ${op} -- ${ts}`);

  // Auditors
  if (Array.isArray(record.auditors) && record.auditors.length > 0) {
    const ids = record.auditors.map(a => a.id).filter(Boolean).join(', ');
    lines.push(`Step ${stepNum}.1 -- auditors: ${ids}`);
  }

  // Findings
  const findings = record.findings;
  if (findings) {
    if (Array.isArray(findings.items)) {
      lines.push(`Step ${stepNum}.2 -- findings: ${findings.items.length} items`);
    } else {
      const c = typeof findings.consensus === 'number' ? findings.consensus : 0;
      const ct = typeof findings.contested === 'number' ? findings.contested : 0;
      const u = typeof findings.unique === 'number' ? findings.unique : 0;
      lines.push(`Step ${stepNum}.2 -- findings: ${c} consensus, ${ct} contested, ${u} unique`);
    }
  }

  // Duration
  if (typeof record.duration_ms === 'number') {
    const dur = record.duration_ms < 1000
      ? `${Math.round(record.duration_ms)}ms`
      : `${Math.round(record.duration_ms / 1000)}s`;
    lines.push(`Step ${stepNum}.3 -- duration: ${dur}`);
  }

  // Cache stats (Step 10D.3: rendered when present, no-op when absent)
  const cs = record.cache_stats;
  if (cs) {
    if (cs.cache_eligible === false) {
      const reason = cs.cache_eligible_reason ?? 'prompt < 1024 tokens';
      lines.push(`Step ${stepNum}.4 -- cache-eligible: false (${reason})`);
    } else {
      if (typeof cs.cache_creation_input_tokens === 'number') {
        lines.push(`Step ${stepNum}.4 -- cache created: ${cs.cache_creation_input_tokens} tokens`);
      }
      if (typeof cs.cache_read_input_tokens === 'number') {
        const saved = cs.cache_read_input_tokens * CACHE_SAVINGS_PER_TOKEN;
        const savedStr = saved >= 0.01 ? ` (~$${saved.toFixed(2)} saved)` : '';
        lines.push(`Step ${stepNum}.5 -- cache read: ${cs.cache_read_input_tokens} tokens${savedStr}`);
      }
    }
  }

  return lines.join('\n');
}

// Read and parse all lines; skip corrupt lines; return array.
export function readReceipts(projectDir) {
  const file = RECEIPTS_FILE(projectDir);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const results = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return results;
}
