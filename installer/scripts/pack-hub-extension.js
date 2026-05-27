#!/usr/bin/env node
// installer/scripts/pack-hub-extension.js
//
// Packs the IJFW Wayland Hub Extension into a distributable zip artifact.
//
// Outputs (all under installer/dist/ by default, or --output <dir>):
//   ijfw-<version>.zip         — archive containing manifest + scripts dir + assets
//   ijfw-<version>.sha512      — SRI integrity string: "sha512-<base64>"
//   hub-index-snippet.json     — IHubExtension-shaped JSON for Wayland's Hub Index
//
// Usage:
//   node scripts/pack-hub-extension.js [--output <dir>]
//   npm run pack:hub-extension
//   node scripts/pack-hub-extension.js --help
//
// Requirements: Node.js >=18. Uses only Node builtins — no external deps.
// Deterministic: all zip entries use fixed epoch timestamp (1980-01-01 00:00:00)
// so SHA-512 is stable across runs on identical content.

import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// --help / -h short-circuit (L3-06)
// Must happen before any side-effectful code runs.
// ---------------------------------------------------------------------------

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: node scripts/pack-hub-extension.js [--output <dir>]

Options:
  --output <dir>   Write zip, sha512, and snippet into <dir> instead of the
                   default installer/dist/ (or process.cwd() when invoked from
                   inside node_modules).
  --help, -h       Print this help and exit.

Outputs written:
  ijfw-<version>.zip          Distributable extension archive
  ijfw-<version>.sha512       SRI integrity string (sha512-<base64>)
  hub-index-snippet.json      IHubExtension entry for Wayland's Hub Index
`.trim());
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const INSTALLER_DIR = resolve(__dirname, '..');
const PKG_PATH = join(INSTALLER_DIR, 'package.json');
const TMPL_PATH = join(__dirname, 'hub-extension', 'aion-extension.json.tmpl');
const HUB_EXT_DIR = join(__dirname, 'hub-extension');

// Output directory: defaults to installer/dist/. Override via `--output <dir>`
// so consumers like Wayland's prebuild sync script can stage artifacts directly
// into their own resources/hub/ dir without an intermediate copy step.
//
// The CLI flag is parsed at the script-arg level so all three invocations work:
//   node scripts/pack-hub-extension.js                       (default dist/)
//   node scripts/pack-hub-extension.js --output /tmp/stage    (custom dir)
//   npx -y @ijfw/install --pack-hub-extension --output /tmp   (via ijfw CLI)

// ---------------------------------------------------------------------------
// System-path blocklist for --output validation (L1-02, L1-06)
// ---------------------------------------------------------------------------

const POSIX_SYSTEM_DIRS = [
  '/etc', '/usr', '/bin', '/sbin', '/var',
  '/System', '/Library', '/private',
];

const WINDOWS_SYSTEM_DIRS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  'C:\\System Volume Information',
];

/**
 * Returns true if the resolved path is the filesystem root or a known system
 * directory (or a child of one).
 *
 * Whitelist exception: paths inside the OS temp dir (os.tmpdir()) are always
 * allowed even when they fall under a blocked system prefix. This matters on
 * macOS where os.tmpdir() returns `/var/folders/.../T/` — a legitimate
 * user-writable temp space whose parent `/var` is in the blocklist. Without
 * this exception, every Wayland prebuild that stages into a temp dir on
 * macOS would be rejected, breaking the documented sync pipeline.
 *
 * @param {string} absPath  Already-resolved absolute path.
 * @returns {boolean}
 */
/**
 * canonicalizeAtomic — resolve a path through realpath even when the leaf
 * does not yet exist. Walks up to the deepest existing ancestor, realpaths
 * that, then reattaches the remaining suffix. Handles the macOS
 * /var ↔ /private/var symlink AND the "not-yet-created subdir" case in one
 * pass. Mirrors the same helper in path-guard.js. (V155-036 / L1-02 recur)
 */
function canonicalizeAtomic(p) {
  try { return realpathSync(p); } catch { /* fall through */ }
  const parts = p.split(/[/\\]/);
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  let suffix = [];
  while (parts.length > 0) {
    suffix.unshift(parts.pop());
    const head = parts.join(sep) || sep;
    try {
      const real = realpathSync(head);
      return suffix.length > 0 ? `${real}${sep}${suffix.join(sep)}` : real;
    } catch { /* keep walking up */ }
  }
  return p; // give up; return the input
}

function isSystemPath(absPath) {
  // Reject bare filesystem roots: '/', 'C:\', 'D:\', etc.
  if (/^[A-Za-z]:\\?$/.test(absPath) || absPath === '/') return true;

  // V155-036: pre-canonicalize BOTH sides via the deepest-existing-ancestor
  // walk so the macOS /var → /private/var symlink doesn't slip through when
  // the requested output dir doesn't exist yet (the prior realpathSync on
  // absPath silently kept the unresolved form, which then matched the
  // /private prefix in the blocklist).
  const tmp = osTmpdir();
  const tmpReal = canonicalizeAtomic(tmp);
  const absReal = canonicalizeAtomic(absPath);

  // OS temp-dir whitelist — overrides the system-prefix blocklist.
  if (
    absReal === tmpReal ||
    absReal.startsWith(tmpReal + '/') ||
    absReal.startsWith(tmpReal + '\\') ||
    absPath === tmp ||
    absPath.startsWith(tmp + '/') ||
    absPath.startsWith(tmp + '\\')
  ) {
    return false;
  }

  // V155-059: gate the system-prefix lists by platform so cross-platform
  // false positives go away. macOS users packing under /Library/MyProjects
  // shouldn't trip the Windows blocklist, and Windows users shouldn't trip
  // the POSIX blocklist. Prefer runtime-derived Windows prefixes when set.
  const isWin = process.platform === 'win32';
  const dynamicWinDirs = isWin
    ? [
        process.env.windir,
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
      ].filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  const blockedForPlatform = isWin
    ? [...WINDOWS_SYSTEM_DIRS, ...dynamicWinDirs]
    : [...POSIX_SYSTEM_DIRS];

  const lc = absReal.toLowerCase();
  for (const blocked of blockedForPlatform) {
    const bl = blocked.toLowerCase();
    if (lc === bl || lc.startsWith(bl + '/') || lc.startsWith(bl + '\\')) {
      return true;
    }
  }
  return false;
}

/**
 * Parse --output from argv. Last occurrence wins (L2-02 last-wins convention).
 * Validates non-empty, non-flag-shaped, non-system-path (L2-01, L1-02, L1-06).
 * Returns the resolved absolute path, or null if --output was not present.
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {string|null}
 */
function parseOutputArg(argv) {
  let dir = null;

  // Iterate all positions so last --output wins (L2-02).
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') {
      if (i + 1 >= argv.length) {
        console.error('[pack-hub-extension] ERROR: --output requires a directory argument');
        process.exit(2);
      }
      dir = argv[i + 1];
      i++; // skip value on next iteration
    }
  }

  if (dir === null) return null; // flag not present — caller uses default

  // L2-01: reject whitespace-only or flag-shaped values.
  if (!dir || dir.trim() === '' || dir.startsWith('-')) {
    console.error('[pack-hub-extension] ERROR: --output requires a non-empty directory argument');
    process.exit(2);
  }

  const abs = resolve(process.cwd(), dir.trim());

  // L1-02, L1-06: reject filesystem root and system directories.
  if (isSystemPath(abs)) {
    console.error(
      `[pack-hub-extension] ERROR: --output "${abs}" is a system path. ` +
      'Choose a user-writable directory.'
    );
    process.exit(2);
  }

  return abs;
}

/**
 * Return the default output directory.
 * When invoked from inside node_modules (npm-global install), default to
 * process.cwd() so we don't pollute the package installation directory (L3-07).
 * @returns {string}
 */
function defaultOutputDir() {
  return __dirname.includes('node_modules')
    ? process.cwd()
    : join(INSTALLER_DIR, 'dist');
}

const _explicitOutput = parseOutputArg(process.argv.slice(2));
const DIST_DIR = _explicitOutput !== null ? _explicitOutput : defaultOutputDir();

// L3-07: always announce where output will land so the caller knows.
console.log(
  `[pack-hub-extension] NOTE: writing artifacts to ${resolve(DIST_DIR)}` +
  (_explicitOutput === null ? '. Use --output <dir> to redirect.' : '.')
);

// ---------------------------------------------------------------------------
// Safe write helper — wraps writeFileSync with a clean error UX (L2-09)
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath`, exiting with a clean error message on failure.
 * @param {string} filePath
 * @param {Buffer|string} content
 * @param {string} [encoding]
 */
function safeWrite(filePath, content, encoding) {
  try {
    if (encoding !== undefined) {
      writeFileSync(filePath, content, encoding);
    } else {
      writeFileSync(filePath, content);
    }
  } catch (err) {
    console.error(`[pack-hub-extension] ERROR: cannot write to ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// L2-06: verify hub-extension/ source tree exists before any read/zip work.
// Without this guard, a malformed install (e.g., scripts/hub-extension/ pruned
// from a custom build) produces a raw Node ENOENT stack trace mid-banner with
// no [pack-hub-extension] prefix — confusing for Wayland's sync script
// consumers. Fail-fast with a clean, actionable error instead.
// ---------------------------------------------------------------------------

if (!existsSync(HUB_EXT_DIR)) {
  console.error(
    `[pack-hub-extension] ERROR: hub-extension source dir missing: ${HUB_EXT_DIR}\n` +
    '[pack-hub-extension] Ensure scripts/hub-extension/ ships alongside this script.\n' +
    '[pack-hub-extension] If invoked via npx, your @ijfw/install tarball may be incomplete.'
  );
  process.exit(1);
}
if (!existsSync(TMPL_PATH)) {
  console.error(
    `[pack-hub-extension] ERROR: hub-extension manifest template missing: ${TMPL_PATH}`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read version from package.json
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const VERSION = pkg.version;
if (!VERSION) {
  console.error('[pack-hub-extension] ERROR: could not read version from package.json');
  process.exit(1);
}

console.log(`[pack-hub-extension] packaging IJFW Hub Extension v${VERSION}`);

// ---------------------------------------------------------------------------
// Render manifest template
// ---------------------------------------------------------------------------

const tmpl = readFileSync(TMPL_PATH, 'utf8');
const manifest = tmpl.replaceAll('{{VERSION}}', VERSION);

let manifestObj;
try {
  manifestObj = JSON.parse(manifest);
} catch (err) {
  console.error('[pack-hub-extension] ERROR: rendered manifest is not valid JSON:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Collect files to pack (deterministic: sorted by zip entry path)
// ---------------------------------------------------------------------------
// Layout inside zip:
//   aion-extension.json
//   scripts/install.js
//   scripts/uninstall.js
//   assets/ijfw-logo.svg   (if present)

/** @type {Array<{zipPath: string, content: Buffer}>} */
const entries = [];

// Manifest (rendered in memory — no temp file needed)
entries.push({
  zipPath: 'aion-extension.json',
  content: Buffer.from(manifest + '\n', 'utf8'),
});

// scripts/ — render .tmpl files with {{VERSION}} substitution at pack time so
// the bundled hooks reference the exact pinned version rather than @latest.
// Backward-compat: if no .tmpl exists but the plain .js does, zip it as-is.
for (const name of ['install.js', 'uninstall.js']) {
  const tmplSrc = join(HUB_EXT_DIR, `${name}.tmpl`);
  const jsSrc = join(HUB_EXT_DIR, name);
  let content;
  if (existsSync(tmplSrc)) {
    const raw = readFileSync(tmplSrc, 'utf8');
    content = Buffer.from(raw.replaceAll('{{VERSION}}', VERSION), 'utf8');
  } else if (existsSync(jsSrc)) {
    content = readFileSync(jsSrc);
  } else {
    console.error(`[pack-hub-extension] ERROR: neither ${name}.tmpl nor ${name} found in hub-extension/scripts`);
    process.exit(1);
  }
  entries.push({ zipPath: `scripts/${name}`, content });
}

// assets/ (walk directory, sorted)
const assetsDir = join(HUB_EXT_DIR, 'assets');
if (existsSync(assetsDir)) {
  const assetFiles = readdirSync(assetsDir).sort();
  for (const name of assetFiles) {
    const full = join(assetsDir, name);
    if (statSync(full).isFile()) {
      entries.push({
        zipPath: `assets/${name}`,
        content: readFileSync(full),
      });
    } else if (statSync(full).isDirectory()) {
      // L2-08: future-proof warning; current placeholder SVG is single-file.
      console.warn(`[pack-hub-extension] WARNING: assets subdir ignored: ${name}/`);
    }
  }
}

// Sort entries for fully deterministic output regardless of fs ordering.
entries.sort((a, b) => a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0);

// ---------------------------------------------------------------------------
// Build deterministic ZIP (PKZIP format, all entries stored with deflate)
//
// Fixed MS-DOS timestamp: 1980-01-01 00:00:00
//   date word: year-1980=0, month=1, day=1  → 0x0021
//   time word: hour=0, min=0, sec/2=0       → 0x0000
// ---------------------------------------------------------------------------

const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000; // 00:00:00

/**
 * Write a little-endian uint16 into buf at offset.
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} value
 */
function writeU16LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Write a little-endian uint32 into buf at offset.
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} value
 */
function writeU32LE(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
}

const ZIP_PARTS = []; // array of Buffers forming the zip stream

/** @type {Array<{zipPath: string, crc: number, compSize: number, uncompSize: number, offset: number}>} */
const centralDirEntries = [];

let offset = 0;

for (const { zipPath, content } of entries) {
  const nameBytes = Buffer.from(zipPath, 'utf8');
  const uncompSize = content.length;
  const crc = crc32(content) >>> 0;

  // Deflate the content.
  const compressed = deflateRawSync(content, { level: 9 });
  // Use stored (method=0) if deflate is bigger or equal — keeps zip valid.
  const useDeflate = compressed.length < uncompSize;
  const compMethod = useDeflate ? 8 : 0;
  const compData = useDeflate ? compressed : content;
  const compSize = compData.length;

  // Local file header: signature + 26 bytes fixed + filename.
  const localHeader = Buffer.alloc(30 + nameBytes.length);
  writeU32LE(localHeader, 0, 0x04034b50);  // local file header sig
  writeU16LE(localHeader, 4, 20);           // version needed: 2.0
  writeU16LE(localHeader, 6, 0);            // general purpose bit flag
  writeU16LE(localHeader, 8, compMethod);   // compression method
  writeU16LE(localHeader, 10, DOS_TIME);    // last mod time
  writeU16LE(localHeader, 12, DOS_DATE);    // last mod date
  writeU32LE(localHeader, 14, crc);         // crc-32
  writeU32LE(localHeader, 18, compSize);    // compressed size
  writeU32LE(localHeader, 22, uncompSize);  // uncompressed size
  writeU16LE(localHeader, 26, nameBytes.length); // file name length
  writeU16LE(localHeader, 28, 0);           // extra field length
  nameBytes.copy(localHeader, 30);

  centralDirEntries.push({
    zipPath,
    nameBytes,
    crc,
    compSize,
    uncompSize,
    compMethod,
    offset,
  });

  ZIP_PARTS.push(localHeader, compData);
  offset += localHeader.length + compData.length;
}

// Central directory.
const centralDirStart = offset;
for (const e of centralDirEntries) {
  const cdEntry = Buffer.alloc(46 + e.nameBytes.length);
  writeU32LE(cdEntry, 0, 0x02014b50);       // central dir sig
  writeU16LE(cdEntry, 4, 20);               // version made by: 2.0
  writeU16LE(cdEntry, 6, 20);               // version needed: 2.0
  writeU16LE(cdEntry, 8, 0);                // general purpose bit flag
  writeU16LE(cdEntry, 10, e.compMethod);    // compression method
  writeU16LE(cdEntry, 12, DOS_TIME);        // last mod time
  writeU16LE(cdEntry, 14, DOS_DATE);        // last mod date
  writeU32LE(cdEntry, 16, e.crc);           // crc-32
  writeU32LE(cdEntry, 20, e.compSize);      // compressed size
  writeU32LE(cdEntry, 24, e.uncompSize);    // uncompressed size
  writeU16LE(cdEntry, 28, e.nameBytes.length); // file name length
  writeU16LE(cdEntry, 30, 0);               // extra field length
  writeU16LE(cdEntry, 32, 0);               // file comment length
  writeU16LE(cdEntry, 34, 0);               // disk number start
  writeU16LE(cdEntry, 36, 0);               // internal file attributes
  writeU32LE(cdEntry, 38, 0);               // external file attributes
  writeU32LE(cdEntry, 42, e.offset);        // relative offset of local header
  e.nameBytes.copy(cdEntry, 46);
  ZIP_PARTS.push(cdEntry);
  offset += cdEntry.length;
}

const centralDirSize = offset - centralDirStart;

// End of central directory record.
const eocd = Buffer.alloc(22);
writeU32LE(eocd, 0, 0x06054b50);           // EOCD signature
writeU16LE(eocd, 4, 0);                    // disk number
writeU16LE(eocd, 6, 0);                    // disk with central dir
writeU16LE(eocd, 8, centralDirEntries.length);  // entries on this disk
writeU16LE(eocd, 10, centralDirEntries.length); // total entries
writeU32LE(eocd, 12, centralDirSize);      // size of central directory
writeU32LE(eocd, 16, centralDirStart);     // offset of central directory
writeU16LE(eocd, 20, 0);                   // comment length
ZIP_PARTS.push(eocd);

const zipBuffer = Buffer.concat(ZIP_PARTS);

// ---------------------------------------------------------------------------
// Write zip
// ---------------------------------------------------------------------------

mkdirSync(DIST_DIR, { recursive: true });

const ZIP_NAME = `ijfw-${VERSION}.zip`;
const ZIP_PATH = join(DIST_DIR, ZIP_NAME);
safeWrite(ZIP_PATH, zipBuffer);

const zipSize = zipBuffer.length;
console.log(`[pack-hub-extension] zip: ${ZIP_PATH} (${zipSize} bytes)`);

// ---------------------------------------------------------------------------
// Compute SHA-512 SRI (sync — buffer already in memory)
// ---------------------------------------------------------------------------

const hashHex = createHash('sha512').update(zipBuffer).digest('hex');
const sri = `sha512-${Buffer.from(hashHex, 'hex').toString('base64')}`;

const SHA_PATH = join(DIST_DIR, `ijfw-${VERSION}.sha512`);
safeWrite(SHA_PATH, sri, 'utf8');
console.log(`[pack-hub-extension] sha512: ${SHA_PATH}`);
console.log(`[pack-hub-extension] SRI: ${sri}`);

// ---------------------------------------------------------------------------
// Write hub-index-snippet.json (IHubExtension shape for Wayland's Hub Index)
// ---------------------------------------------------------------------------

// HubContributes in the index uses string ID arrays (not full adapter objects).
const adapterIds = manifestObj.contributes.acpAdapters.map((a) => a.id);

const hubIndexSnippet = {
  name: manifestObj.name,
  displayName: manifestObj.displayName,
  version: VERSION,
  description: manifestObj.description,
  author: manifestObj.author,
  icon: manifestObj.icon,
  dist: {
    tarball: `extensions/${ZIP_NAME}`,
    integrity: sri,
    unpackedSize: zipSize,
  },
  engines: manifestObj.engines,
  hubs: manifestObj.hubs,
  contributes: {
    acpAdapters: adapterIds,
    mcpServers: manifestObj.contributes.mcpServers,
  },
  tags: ['ai', 'coding', 'mcp', 'memory', 'multi-agent'],
};

const SNIPPET_PATH = join(DIST_DIR, 'hub-index-snippet.json');
safeWrite(SNIPPET_PATH, JSON.stringify(hubIndexSnippet, null, 2) + '\n', 'utf8');
console.log(`[pack-hub-extension] hub index snippet: ${SNIPPET_PATH}`);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(`[pack-hub-extension] DONE — ${ZIP_NAME} ready for Wayland bundling`);
