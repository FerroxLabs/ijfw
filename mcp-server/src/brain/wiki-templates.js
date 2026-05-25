// IJFW v1.5.2 -- brain wiki page templates.
//
// applyTemplate(type, existingMd, { subject, facts, history, backlinks, sources })
// returns markdown with 4 AUTO sections (current-state, history, backlinks,
// sources) wrapped in ijfw:auto sentinels. Operator-owned NOTES regions OUTSIDE
// the sentinels are preserved verbatim by the underlying replaceSection().
//
// Per Trident F-B2, the history section is windowed (consumer passes
// {rows, older} from getHistoryWindow); when older is present we append a
// rollup line ("Older: 55 events between A and B") instead of pasting more rows.

import { replaceSection } from './wiki-sentinels.js';

function isoDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toISOString().slice(0, 10);
  } catch { return s; }
}

function renderCurrentState({ subject, facts }) {
  if (!facts || facts.length === 0) {
    return `_No facts about **${subject}** yet._`;
  }
  const lines = [];
  for (const f of facts) {
    const cite = f.id != null ? ` [fact:${f.id}]` : '';
    const memCite = f.memory_id != null ? ` [mem:${f.memory_id}]` : '';
    lines.push(`- ${f.predicate || '(no predicate)'}: **${f.object ?? ''}**${cite}${memCite}`);
  }
  return lines.join('\n');
}

function renderHistory({ history }) {
  if (!history) return '_No history available._';
  const { rows = [], older = null } = history;
  if (rows.length === 0) return '_No history available._';
  const lines = [];
  for (const r of rows) {
    const date = isoDate(r.valid_from);
    const closed = r.valid_to ? ` (closed ${isoDate(r.valid_to)})` : '';
    const memCite = r.memory_id != null ? ` [mem:${r.memory_id}]` : '';
    const factCite = r.id != null ? ` [fact:${r.id}]` : '';
    lines.push(`- ${date}: ${r.predicate || '(no predicate)'} = **${r.object ?? ''}**${closed}${factCite}${memCite}`);
  }
  if (older) {
    lines.push('');
    lines.push(`_Older: ${older.count} event${older.count === 1 ? '' : 's'} between ${isoDate(older.fromIso)} and ${isoDate(older.toIso)}._`);
  }
  return lines.join('\n');
}

function renderBacklinks({ backlinks }) {
  if (!backlinks || backlinks.length === 0) return '_No backlinks._';
  const lines = [];
  for (const b of backlinks) {
    const target = b.target || b.to_target || '';
    const n = b.count ?? b.incomingLinks ?? 1;
    if (!target) continue;
    lines.push(`- [[${target}]] (${n} link${n === 1 ? '' : 's'})`);
  }
  return lines.length ? lines.join('\n') : '_No backlinks._';
}

function renderSources({ sources }) {
  if (!sources || sources.length === 0) return '_No sources._';
  const top = sources.slice(0, 5);
  const lines = [];
  for (const s of top) {
    const path = s.path || '(no path)';
    const kind = s.kind ? ` (${s.kind})` : '';
    const mentions = s.mentions != null ? ` — ${s.mentions} mention${s.mentions === 1 ? '' : 's'}` : '';
    lines.push(`- \`${path}\`${kind}${mentions}`);
  }
  return lines.join('\n');
}

export function applyTemplate(type, existingMd, data) {
  let md = existingMd || '';
  md = replaceSection(md, 'current-state', renderCurrentState(data));
  md = replaceSection(md, 'history', renderHistory(data));
  md = replaceSection(md, 'backlinks', renderBacklinks(data));
  md = replaceSection(md, 'sources', renderSources(data));
  return md;
}

export {
  renderCurrentState as _renderCurrentState,
  renderHistory as _renderHistory,
  renderBacklinks as _renderBacklinks,
  renderSources as _renderSources,
};
