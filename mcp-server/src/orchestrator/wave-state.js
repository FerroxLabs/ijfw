/**
 * wave-state.js — Atomic STATE.md read/write for orchestrator wave tracking.
 *
 * STATE.md lives at <projectRoot>/.ijfw/wave-<waveId>/STATE.md.
 * Format: YAML frontmatter (---delimited) + markdown body.
 * Writes are atomic: withFsLock + write-to-tmp + rename.
 *
 * Landed in W10-A0 (v1.4.4 prelude). checkpointWave is a stub;
 * N4 (W10-A2) will flesh out the blackboard→STATE rollup logic.
 */

import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFsLock } from '../fs-lock.js';

// ---------------------------------------------------------------------------
// Internal YAML helpers — flat subset only (string/number/boolean/string[])
// ---------------------------------------------------------------------------

/**
 * Parse a YAML frontmatter block (lines between the two `---` delimiters).
 * Supports: scalar string/number/boolean values, arrays of strings (block style).
 * Rejects nested maps with a clear error.
 *
 * @param {string} block  Lines between the two `---` markers (no delimiters)
 * @returns {object}
 */
function parseYaml(block) {
  const result = {};
  const lines = block.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (!key) { i++; continue; }

    // Detect nested map: next non-empty lines are indented key: value pairs
    if (rest === '') {
      // Could be array or nested map — peek ahead
      const nextLines = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '' && !lines[j].match(/^\S.*:/)) {
        nextLines.push(lines[j]);
        j++;
      }
      if (nextLines.length > 0 && nextLines[0].trimStart().startsWith('- ')) {
        // Block sequence
        result[key] = nextLines.map((l) => l.replace(/^\s*-\s?/, ''));
        i = j;
        continue;
      } else if (nextLines.length > 0) {
        throw new Error(`wave-state: nested YAML maps are not supported (key: "${key}")`);
      }
      result[key] = null;
      i++;
      continue;
    }

    // Inline array: [a, b, c]
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]$/, '');
      result[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) : [];
      i++;
      continue;
    }

    // Scalar
    if (rest === 'true') { result[key] = true; }
    else if (rest === 'false') { result[key] = false; }
    else if (rest === 'null' || rest === '~') { result[key] = null; }
    else if (!Number.isNaN(Number(rest)) && rest !== '') { result[key] = Number(rest); }
    else { result[key] = rest.replace(/^['"]|['"]$/g, ''); }
    i++;
  }
  return result;
}

/**
 * Emit a YAML frontmatter block for flat string/number/boolean/string[] values.
 * @param {object} obj
 * @returns {string}  (no leading/trailing `---`)
 */
function emitYaml(obj) {
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - ${item}`);
      }
    } else if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'object') {
      throw new Error(`wave-state: nested YAML objects are not supported (key: "${key}")`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function wavePaths(waveId, projectRoot) {
  const dir = join(projectRoot, '.ijfw', `wave-${waveId}`);
  return {
    dir,
    state: join(dir, 'STATE.md'),
    summary: join(dir, 'SUMMARY.md'),
    lock: join(dir, '.STATE.md.lock'),
    summaryLock: join(dir, '.SUMMARY.md.lock'),
    tmp: join(dir, '.STATE.md.tmp'),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a wave's STATE.md and return parsed { frontmatter, body, raw }.
 * Returns null if the wave directory or file doesn't exist.
 * Throws on malformed frontmatter.
 *
 * @param {string} waveId       e.g. "W10-A0"
 * @param {string} projectRoot  absolute path to project root
 * @returns {Promise<{frontmatter: object, body: string, raw: string} | null>}
 */
export async function readWaveState(waveId, projectRoot) {
  const { state } = wavePaths(waveId, projectRoot);
  let raw;
  try {
    raw = await readFile(state, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  // Parse frontmatter
  if (!raw.startsWith('---')) {
    throw new Error(`wave-state: STATE.md for "${waveId}" is missing YAML frontmatter`);
  }
  const secondDelim = raw.indexOf('\n---', 3);
  if (secondDelim === -1) {
    throw new Error(`wave-state: STATE.md for "${waveId}" has unclosed YAML frontmatter`);
  }
  const fmBlock = raw.slice(4, secondDelim); // skip "---\n"
  const body = raw.slice(secondDelim + 4).replace(/^\n+/, ''); // skip "\n---\n\n"

  const frontmatter = parseYaml(fmBlock);
  return { frontmatter, body, raw };
}

/**
 * Atomically write a wave's STATE.md using withFsLock + tmp+rename.
 * Auto-creates .ijfw/wave-<waveId>/ if missing.
 *
 * @param {string} waveId
 * @param {{frontmatter: object, body: string}} state
 * @param {string} projectRoot
 * @returns {Promise<void>}
 */
export async function writeWaveState(waveId, state, projectRoot) {
  const { dir, state: statePath, lock, tmp } = wavePaths(waveId, projectRoot);
  const payload = `---\n${emitYaml(state.frontmatter)}\n---\n\n${state.body}`;

  await withFsLock(lock, async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, statePath);
  });
}

/**
 * Append a delta entry to a wave's SUMMARY.md — markdown append-only log.
 * r13-M-03 (post-Trident r13 fix): minimum-viable implementation closing the
 * handoff §N4 promise. Full blackboard→STATE rollup remains future work for
 * v1.5.0 (would mean reading blackboard.js claims/findings and summarising).
 *
 * Delta shape (caller chooses what to record):
 *   { agent_id?, task_id?, commits?: string[], tests_delta?: string,
 *     contracts_touched?: string[], surprises?: string }
 *
 * Atomic via withFsLock + appendFile. Each delta is rendered as a markdown
 * H3 section dated by ISO timestamp; subsequent entries append below.
 *
 * @param {string} waveId
 * @param {object} delta
 * @param {string} projectRoot
 * @returns {Promise<void>}
 */
export async function appendSummary(waveId, delta, projectRoot) {
  const { dir, summary, summaryLock } = wavePaths(waveId, projectRoot);
  const ts = new Date().toISOString();
  const lines = [`### ${ts}`];
  if (delta.agent_id) lines.push(`- **agent:** ${delta.agent_id}`);
  if (delta.task_id) lines.push(`- **task:** ${delta.task_id}`);
  if (Array.isArray(delta.commits) && delta.commits.length) {
    lines.push(`- **commits:** ${delta.commits.join(', ')}`);
  }
  if (delta.tests_delta) lines.push(`- **tests:** ${delta.tests_delta}`);
  if (Array.isArray(delta.contracts_touched) && delta.contracts_touched.length) {
    lines.push(`- **contracts:** ${delta.contracts_touched.join(', ')}`);
  }
  if (delta.surprises) lines.push(`- **surprises:** ${delta.surprises}`);
  const payload = lines.join('\n') + '\n\n';

  await withFsLock(summaryLock, async () => {
    await mkdir(dir, { recursive: true });
    await appendFile(summary, payload, 'utf8');
  });
}

/**
 * Stub checkpoint — full blackboard→STATE rollup remains v1.5.0 work.
 * Seeds an empty state if missing; updates only frontmatter.checkpoint_at.
 *
 * @param {string} waveId
 * @param {string} projectRoot
 * @returns {Promise<{frontmatter: object, body: string}>}
 */
export async function checkpointWave(waveId, projectRoot) {
  const now = new Date().toISOString();
  const existing = await readWaveState(waveId, projectRoot);

  const next = existing
    ? { frontmatter: { ...existing.frontmatter, checkpoint_at: now }, body: existing.body }
    : {
        frontmatter: {
          wave_id: waveId,
          status: 'in_progress',
          created_at: now,
          checkpoint_at: now,
        },
        body: '',
      };

  await writeWaveState(waveId, next, projectRoot);
  return next;
}
