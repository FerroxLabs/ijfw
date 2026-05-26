#!/usr/bin/env node
// installer/scripts/pack-hub-extension.js
//
// Packs the IJFW Wayland Hub Extension into a distributable zip artifact.
//
// Outputs (all under installer/dist/):
//   ijfw-<version>.zip         — archive containing manifest + scripts dir + assets
//   ijfw-<version>.sha512      — SRI integrity string: "sha512-<base64>"
//   hub-index-snippet.json     — IHubExtension-shaped JSON for Wayland's Hub Index
//
// Usage:
//   node scripts/pack-hub-extension.js
//   npm run pack:hub-extension
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
function parseOutputArg(argv) {
  const idx = argv.indexOf('--output');
  if (idx !== -1 && idx + 1 < argv.length) {
    const dir = argv[idx + 1];
    if (!dir || dir.startsWith('-')) {
      console.error('[pack-hub-extension] --output requires a directory argument');
      process.exit(2);
    }
    return resolve(process.cwd(), dir);
  }
  return join(INSTALLER_DIR, 'dist');
}
const DIST_DIR = parseOutputArg(process.argv.slice(2));

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

// scripts/
for (const name of ['install.js', 'uninstall.js']) {
  const src = join(HUB_EXT_DIR, name);
  entries.push({
    zipPath: `scripts/${name}`,
    content: readFileSync(src),
  });
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
writeFileSync(ZIP_PATH, zipBuffer);

const zipSize = zipBuffer.length;
console.log(`[pack-hub-extension] zip: ${ZIP_PATH} (${zipSize} bytes)`);

// ---------------------------------------------------------------------------
// Compute SHA-512 SRI (sync — buffer already in memory)
// ---------------------------------------------------------------------------

const hashHex = createHash('sha512').update(zipBuffer).digest('hex');
const sri = `sha512-${Buffer.from(hashHex, 'hex').toString('base64')}`;

const SHA_PATH = join(DIST_DIR, `ijfw-${VERSION}.sha512`);
writeFileSync(SHA_PATH, sri, 'utf8');
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
writeFileSync(SNIPPET_PATH, JSON.stringify(hubIndexSnippet, null, 2) + '\n', 'utf8');
console.log(`[pack-hub-extension] hub index snippet: ${SNIPPET_PATH}`);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(`[pack-hub-extension] DONE — ${ZIP_NAME} ready for Wayland bundling`);
