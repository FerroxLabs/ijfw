/**
 * dispatch/override.js
 *
 * IJFW v1.4.0 / W3/t16 — override colon-namespace dispatch handler.
 *
 * Routes `override:<command>` invocations from colon-syntax dispatch and
 * `ijfw override <command>` invocations from the CLI to the W1
 * override-resolver primitives.
 *
 * Commands:
 *   add <preset> [scope]      — record + redeploy
 *   list                      — read active-overrides.json for project
 *   audit                     — summarise active overrides + extends chains
 *   promote <preset>          — copy project-scope override to user scope
 *   remove <preset>           — remove active override + redeploy base
 *   deploy <skill>            — force redeploy of one skill
 */

import {
  recordActiveOverride,
  removeActiveOverride,
  deployResolvedSkill,
  resolveSkill,
  resolveOverridePaths,
  loadOverrideFile,
} from '../override-resolver.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OVERRIDE_SCOPES, BUILTIN_PRESETS } from '../override-manifest-schema.js';

// Mirror of override-manifest-schema.js PRESET_NAME_PATTERN (not exported there).
// Keep the two in sync if the upstream regex tightens.
const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// All built-in presets target ijfw-critique in v1.4.0. We hardcode the
// affected-skills list for the add/remove paths; if a preset later targets
// additional skills, expand this map.
const PRESET_TARGET_SKILLS = {
  book: ['ijfw-critique'],
  campaign: ['ijfw-critique'],
  academic: ['ijfw-critique'],
  screenplay: ['ijfw-critique'],
};

/**
 * Validate preset NAME shape at the dispatch boundary. Strings like
 * `book; rm -rf $HOME` would otherwise round-trip into receipts and
 * prelude suggestions.
 */
function validatePresetName(preset) {
  if (typeof preset !== 'string' || !PRESET_NAME_PATTERN.test(preset)) {
    return 'invalid preset name';
  }
  return null;
}

/**
 * Confirm a preset name refers to a real preset file. Accepts built-ins,
 * `~/.ijfw/overrides/presets/<preset>.md`, and `~/.ijfw/user-overrides/<preset>`.
 */
async function presetExists(preset) {
  if (BUILTIN_PRESETS.includes(preset)) return true;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.ijfw', 'overrides', 'presets', `${preset}.md`),
    path.join(home, '.ijfw', 'user-overrides', preset),
  ];
  for (const p of candidates) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

async function readActiveOverrides(projectRoot) {
  const file = path.join(os.homedir(), '.ijfw/state/active-overrides.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const json = JSON.parse(raw);
    return json?.projects?.[projectRoot]?.active_overrides ?? [];
  } catch {
    return [];
  }
}

async function cmdAdd({ args, projectRoot }) {
  const [preset, rawScope] = args.split(/\s+/).filter(Boolean);
  if (!preset) return { ok: false, command: 'add', error: 'missing preset name' };
  const shapeErr = validatePresetName(preset);
  if (shapeErr) return { ok: false, command: 'add', error: shapeErr };
  if (!(await presetExists(preset))) {
    return { ok: false, command: 'add', error: `unknown preset: ${preset}` };
  }
  const scope = OVERRIDE_SCOPES.includes(rawScope) ? rawScope : 'project';
  const override = { preset, scope, applied_at: nowIso() };
  try {
    await recordActiveOverride(projectRoot, override);
  } catch (err) {
    return { ok: false, command: 'add', error: `recordActiveOverride failed: ${err.message}` };
  }
  const affected = PRESET_TARGET_SKILLS[preset] ?? ['ijfw-critique'];
  const deploys = [];
  for (const skill of affected) {
    try {
      deploys.push(await deployResolvedSkill(skill, projectRoot, {}));
    } catch (err) {
      deploys.push({ skill, deployed: [], failed: [{ platform: 'all', error: err.message }] });
    }
  }
  return { ok: true, command: 'add', result: { preset, scope, affected_skills: affected, deploys } };
}

async function cmdRemove({ args, projectRoot }) {
  const [preset] = args.split(/\s+/).filter(Boolean);
  if (!preset) return { ok: false, command: 'remove', error: 'missing preset name' };
  const shapeErr = validatePresetName(preset);
  if (shapeErr) return { ok: false, command: 'remove', error: shapeErr };
  try {
    await removeActiveOverride(projectRoot, preset);
  } catch (err) {
    return { ok: false, command: 'remove', error: `removeActiveOverride failed: ${err.message}` };
  }
  const affected = PRESET_TARGET_SKILLS[preset] ?? ['ijfw-critique'];
  const deploys = [];
  for (const skill of affected) {
    try {
      deploys.push(await deployResolvedSkill(skill, projectRoot, {}));
    } catch (err) {
      deploys.push({ skill, deployed: [], failed: [{ platform: 'all', error: err.message }] });
    }
  }
  return { ok: true, command: 'remove', result: { preset, affected_skills: affected, deploys } };
}

async function cmdList({ projectRoot }) {
  const active = await readActiveOverrides(projectRoot);
  return { ok: true, command: 'list', result: { active, count: active.length } };
}

async function cmdAudit({ projectRoot }) {
  const active = await readActiveOverrides(projectRoot);
  const items = [];
  for (const entry of active) {
    const affected = PRESET_TARGET_SKILLS[entry.preset] ?? ['ijfw-critique'];
    for (const skill of affected) {
      const paths = resolveOverridePaths(skill, projectRoot);
      let sections = 0;
      let extendsChain = [];
      for (const p of paths) {
        const file = await loadOverrideFile(p).catch(() => null);
        if (!file) continue;
        if (Array.isArray(file.manifest?.extends)) extendsChain = file.manifest.extends;
        const matches = file.body?.match(/<!--\s*ijfw-override:/g);
        sections += matches ? matches.length : 0;
      }
      items.push({ preset: entry.preset, scope: entry.scope, skill, sections, extends: extendsChain });
    }
  }
  return { ok: true, command: 'audit', result: { items } };
}

async function cmdPromote({ args, projectRoot }) {
  const [preset] = args.split(/\s+/).filter(Boolean);
  if (!preset) return { ok: false, command: 'promote', error: 'missing preset name' };
  const shapeErr = validatePresetName(preset);
  if (shapeErr) return { ok: false, command: 'promote', error: shapeErr };
  if (!(await presetExists(preset))) {
    return { ok: false, command: 'promote', error: `unknown preset: ${preset}` };
  }
  const affected = PRESET_TARGET_SKILLS[preset] ?? ['ijfw-critique'];
  const promoted = [];
  for (const skill of affected) {
    const src = path.join(projectRoot, '.ijfw/skill-overrides', skill, 'override.md');
    const dst = path.join(os.homedir(), '.ijfw/user-overrides', skill, 'override.md');
    try {
      const data = await fs.readFile(src, 'utf8');
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst + '.tmp', data, 'utf8');
      await fs.rename(dst + '.tmp', dst);
      promoted.push({ skill, src, dst });
    } catch (err) {
      promoted.push({ skill, src, dst, error: err.message });
    }
  }
  return { ok: true, command: 'promote', result: { preset, promoted } };
}

async function cmdDeploy({ args, projectRoot }) {
  const [skill] = args.split(/\s+/).filter(Boolean);
  if (!skill) return { ok: false, command: 'deploy', error: 'missing skill name' };
  try {
    const merged = await resolveSkill(skill, projectRoot);
    const r = await deployResolvedSkill(skill, projectRoot, {});
    return { ok: true, command: 'deploy', result: { skill, body_length: merged.length, ...r } };
  } catch (err) {
    return { ok: false, command: 'deploy', error: err.message };
  }
}

export async function overrideDispatch({ command, args = '', projectRoot }) {
  const ctx = { command, args: String(args || ''), projectRoot: String(projectRoot || process.cwd()) };
  switch (command) {
    case 'add': return cmdAdd(ctx);
    case 'remove': return cmdRemove(ctx);
    case 'list': return cmdList(ctx);
    case 'audit': return cmdAudit(ctx);
    case 'promote': return cmdPromote(ctx);
    case 'deploy': return cmdDeploy(ctx);
    default:
      return {
        ok: false,
        command,
        error: `unknown override command: ${command}. Supported: add | list | audit | promote | remove | deploy`,
      };
  }
}
