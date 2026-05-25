// IJFW v1.5.2 -- brain first-run scan.
//
// Powers the dashboard / Wayland portal "wow" cold-start by surfacing the
// operator's existing CLI memory from known per-CLI homes. Each "source"
// reports { id, label, path, found, count, projects }. onProgress fires
// as { stage: "scanning" | "found", id, ... }.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = [
  { id: 'claude',    label: 'Claude Code',       rel: '.claude/projects',   kind: 'dir-of-projects' },
  { id: 'codex',     label: 'Codex CLI',         rel: '.codex',             kind: 'dir' },
  { id: 'gemini',    label: 'Gemini CLI',        rel: '.gemini',            kind: 'dir' },
  { id: 'cursor',    label: 'Cursor',            rel: '.cursor',            kind: 'dir' },
  { id: 'windsurf',  label: 'Windsurf',          rel: '.windsurf',          kind: 'dir' },
  { id: 'claude-md', label: 'Global CLAUDE.md',  rel: 'CLAUDE.md',          kind: 'file' },
  { id: 'agents-md', label: 'Global AGENTS.md',  rel: 'AGENTS.md',          kind: 'file' },
  { id: 'gemini-md', label: 'Global GEMINI.md',  rel: 'GEMINI.md',          kind: 'file' },
];

function safeReaddir(p) { try { return readdirSync(p); } catch { return []; } }

function sessionsForClaude(claudeProjectsDir) {
  const projects = safeReaddir(claudeProjectsDir).filter((name) => {
    try { return statSync(join(claudeProjectsDir, name)).isDirectory(); } catch { return false; }
  });
  let totalSessions = 0;
  for (const p of projects) {
    const files = safeReaddir(join(claudeProjectsDir, p)).filter((f) => f.endsWith('.jsonl'));
    totalSessions += files.length;
  }
  return { projects: projects.length, totalSessions };
}

export function firstRunScan({ homeDir, onProgress } = {}) {
  const sources = [];
  let totalSessions = 0;
  for (const src of SOURCES) {
    if (onProgress) onProgress({ stage: 'scanning', id: src.id });
    const p = join(homeDir, src.rel);
    const present = existsSync(p);
    if (!present) {
      sources.push({ id: src.id, label: src.label, path: p, found: false, count: 0, projects: 0 });
      continue;
    }
    let count = 0, projects = 0;
    if (src.kind === 'dir-of-projects') {
      const r = sessionsForClaude(p);
      projects = r.projects; count = r.totalSessions; totalSessions += r.totalSessions;
    } else if (src.kind === 'dir') {
      count = safeReaddir(p).length;
    } else if (src.kind === 'file') {
      try { count = statSync(p).size > 0 ? 1 : 0; } catch { count = 0; }
    }
    const entry = { id: src.id, label: src.label, path: p, found: true, count, projects };
    sources.push(entry);
    if (onProgress) onProgress({ stage: 'found', id: src.id, count, projects });
  }
  return { sources, totalSessions };
}
