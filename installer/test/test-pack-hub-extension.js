// installer/test/test-pack-hub-extension.js
//
// Tests for pack-hub-extension.js.
// Run via: node --test test/test-pack-hub-extension.js
//       or: npm run test:hub-extension
//
// Verifies:
//   - npm run pack:hub-extension exits 0
//   - dist/ijfw-<version>.zip exists with non-zero size
//   - SHA-512 file matches sha512-<base64> SRI format
//   - Zip contains expected entries; manifest parses with all required fields
//   - All 15 acpAdapters present with required sub-fields
//   - lifecycle.onInstall resolves to a real file inside the zip
//   - install.js content references @ijfw/install
//   - SHA-512 is stable across two consecutive runs (determinism)

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = resolve(__dirname, '..');
const PKG_PATH = join(INSTALLER_DIR, 'package.json');

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const VERSION = pkg.version;
const ZIP_PATH = join(INSTALLER_DIR, 'dist', `ijfw-${VERSION}.zip`);
const SHA_PATH = join(INSTALLER_DIR, 'dist', `ijfw-${VERSION}.sha512`);
const SNIPPET_PATH = join(INSTALLER_DIR, 'dist', 'hub-index-snippet.json');

const EXPECTED_CLI_IDS = [
  'claude', 'codex', 'gemini', 'cursor', 'windsurf',
  'copilot', 'hermes', 'wayland', 'aider', 'opencode',
  'qwencode', 'cline', 'kimicode', 'openclaw', 'antigravity',
];

// ---------------------------------------------------------------------------
// Minimal ZIP parser (enough to extract entries by name)
// ---------------------------------------------------------------------------

/**
 * Parse a ZIP buffer and return a map of { entryPath -> uncompressed Buffer }.
 * Handles stored (method=0) and deflated (method=8) entries.
 * Only reads local file headers — does not use central directory.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
function parseZip(buf) {
  const entries = new Map();
  let pos = 0;

  while (pos + 4 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x04034b50) break; // not a local file header

    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const uncompSize = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      data = inflateRawSync(compData);
    } else {
      throw new Error(`Unsupported zip compression method ${method} for entry "${name}"`);
    }

    entries.set(name, data);
    pos = dataStart + compSize;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Run pack once before all tests
// ---------------------------------------------------------------------------

let runResult;
let sriRun1 = '';

before(() => {
  runResult = spawnSync('npm', ['run', 'pack:hub-extension'], {
    cwd: INSTALLER_DIR,
    stdio: 'pipe',
    shell: false,
  });
  if (runResult.status === 0) sriRun1 = readFileSync(SHA_PATH, 'utf8').trim();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pack-hub-extension', () => {

  it('npm run pack:hub-extension exits 0', () => {
    const stderr = runResult.stderr ? runResult.stderr.toString() : '';
    const stdout = runResult.stdout ? runResult.stdout.toString() : '';
    assert.equal(
      runResult.status,
      0,
      `pack:hub-extension failed (exit ${runResult.status})\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  });

  it(`dist/ijfw-${VERSION}.zip exists with non-zero size`, () => {
    assert.ok(existsSync(ZIP_PATH), `zip not found: ${ZIP_PATH}`);
    const st = statSync(ZIP_PATH);
    assert.ok(st.size > 0, `zip has zero size: ${ZIP_PATH}`);
  });

  it('SHA-512 file exists and matches sha512-<base64> SRI format', () => {
    assert.ok(existsSync(SHA_PATH), `sha512 file not found: ${SHA_PATH}`);
    const sri = readFileSync(SHA_PATH, 'utf8').trim();
    assert.match(
      sri,
      /^sha512-[A-Za-z0-9+/]+=*$/,
      `SHA-512 file does not match SRI format: "${sri}"`,
    );
    // Verify the base64 decodes to 64 bytes (SHA-512 output).
    const base64Part = sri.slice('sha512-'.length);
    const decoded = Buffer.from(base64Part, 'base64');
    assert.equal(decoded.length, 64, `SHA-512 base64 decodes to ${decoded.length} bytes, expected 64`);
  });

  it('SHA-512 in file matches actual zip content', () => {
    const zipBuf = readFileSync(ZIP_PATH);
    const actualHex = createHash('sha512').update(zipBuf).digest('hex');
    const actualSri = `sha512-${Buffer.from(actualHex, 'hex').toString('base64')}`;
    const storedSri = readFileSync(SHA_PATH, 'utf8').trim();
    assert.equal(storedSri, actualSri, 'Stored SRI does not match actual zip hash');
  });

  it('zip parses and contains aion-extension.json', () => {
    const zipBuf = readFileSync(ZIP_PATH);
    const entries = parseZip(zipBuf);
    assert.ok(entries.has('aion-extension.json'), 'zip missing aion-extension.json');
  });

  it('manifest has all required IHubExtension fields', () => {
    const zipBuf = readFileSync(ZIP_PATH);
    const entries = parseZip(zipBuf);
    const raw = entries.get('aion-extension.json').toString('utf8');
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      assert.fail(`aion-extension.json is not valid JSON: ${err.message}`);
    }

    assert.equal(manifest.name, 'ijfw', 'manifest.name');
    assert.equal(manifest.displayName, 'IJFW — AI Efficiency Layer', 'manifest.displayName');
    assert.equal(manifest.version, VERSION, `manifest.version should be ${VERSION}`);
    assert.ok(manifest.description && manifest.description.length > 0, 'manifest.description missing');
    assert.equal(manifest.author, 'Sean Donahoe', 'manifest.author');
    assert.ok(manifest.engines && manifest.engines.wayland, 'manifest.engines.wayland missing');
    assert.ok(Array.isArray(manifest.hubs) && manifest.hubs.length > 0, 'manifest.hubs missing/empty');
    assert.ok(manifest.hubs.includes('acpAdapters'), 'manifest.hubs must include acpAdapters');
    assert.ok(manifest.hubs.includes('mcpServers'), 'manifest.hubs must include mcpServers');
    assert.ok(manifest.lifecycle, 'manifest.lifecycle missing');
    assert.ok(manifest.lifecycle.onInstall, 'manifest.lifecycle.onInstall missing');
    assert.ok(manifest.lifecycle.onUninstall, 'manifest.lifecycle.onUninstall missing');
    assert.ok(manifest.contributes, 'manifest.contributes missing');
    assert.ok(Array.isArray(manifest.contributes.acpAdapters), 'manifest.contributes.acpAdapters missing');
    assert.ok(Array.isArray(manifest.contributes.mcpServers), 'manifest.contributes.mcpServers missing');
  });

  it('all 15 acpAdapters present in manifest with required fields', () => {
    const zipBuf = readFileSync(ZIP_PATH);
    const entries = parseZip(zipBuf);
    const manifest = JSON.parse(entries.get('aion-extension.json').toString('utf8'));
    const adapters = manifest.contributes.acpAdapters;

    assert.equal(adapters.length, 15, `Expected 15 acpAdapters, got ${adapters.length}`);

    const presentIds = adapters.map((a) => a.id);
    for (const expectedId of EXPECTED_CLI_IDS) {
      assert.ok(presentIds.includes(expectedId), `Missing acpAdapter id: "${expectedId}"`);
    }

    // Each adapter must have required fields.
    for (const adapter of adapters) {
      assert.ok(adapter.id, `adapter missing id: ${JSON.stringify(adapter)}`);
      assert.ok(adapter.name, `adapter "${adapter.id}" missing name`);
      assert.ok(adapter.description, `adapter "${adapter.id}" missing description`);
      assert.equal(adapter.connectionType, 'cli', `adapter "${adapter.id}" connectionType must be "cli"`);
      assert.ok(adapter.cliCommand, `adapter "${adapter.id}" missing cliCommand`);
      assert.ok(adapter.defaultCliPath, `adapter "${adapter.id}" missing defaultCliPath`);
      assert.ok(typeof adapter.supportsStreaming === 'boolean', `adapter "${adapter.id}" supportsStreaming must be boolean`);
    }
  });

  it('lifecycle.onInstall resolves to a real file inside the zip', () => {
    const zipBuf = readFileSync(ZIP_PATH);
    const entries = parseZip(zipBuf);
    const manifest = JSON.parse(entries.get('aion-extension.json').toString('utf8'));
    const onInstall = manifest.lifecycle.onInstall; // e.g. "scripts/install.js"
    assert.ok(
      entries.has(onInstall),
      `lifecycle.onInstall="${onInstall}" not found in zip entries. Available: ${[...entries.keys()].join(', ')}`,
    );
  });

  it('install.js content includes "@ijfw/install"', () => {
    const zipBuf = readFileSync(ZIP_PATH);
    const entries = parseZip(zipBuf);
    const manifest = JSON.parse(entries.get('aion-extension.json').toString('utf8'));
    const onInstall = manifest.lifecycle.onInstall;
    const installContent = entries.get(onInstall).toString('utf8');
    assert.ok(
      installContent.includes('@ijfw/install'),
      `install.js does not reference "@ijfw/install". Content snippet: ${installContent.slice(0, 200)}`,
    );
  });

  it('hub-index-snippet.json exists and has correct IHubExtension shape', () => {
    assert.ok(existsSync(SNIPPET_PATH), `hub-index-snippet.json not found: ${SNIPPET_PATH}`);
    let snippet;
    try {
      snippet = JSON.parse(readFileSync(SNIPPET_PATH, 'utf8'));
    } catch (err) {
      assert.fail(`hub-index-snippet.json is not valid JSON: ${err.message}`);
    }

    assert.equal(snippet.name, 'ijfw');
    assert.equal(snippet.version, VERSION);
    assert.ok(snippet.dist, 'snippet.dist missing');
    assert.ok(snippet.dist.tarball, 'snippet.dist.tarball missing');
    assert.match(snippet.dist.integrity, /^sha512-/, 'snippet.dist.integrity must start with sha512-');
    assert.ok(snippet.dist.unpackedSize > 0, 'snippet.dist.unpackedSize must be > 0');
    assert.ok(snippet.engines && snippet.engines.wayland, 'snippet.engines.wayland missing');
    assert.ok(Array.isArray(snippet.hubs), 'snippet.hubs must be an array');
    assert.ok(Array.isArray(snippet.contributes.acpAdapters), 'snippet.contributes.acpAdapters must be string[]');
    // In the index, acpAdapters are string IDs, not objects.
    assert.ok(
      typeof snippet.contributes.acpAdapters[0] === 'string',
      'snippet.contributes.acpAdapters must be string IDs',
    );
    assert.equal(snippet.contributes.acpAdapters.length, 15, 'snippet must list 15 acpAdapter IDs');
  });

  it('SHA-512 is stable across two consecutive runs (determinism)', () => {
    // sriRun1 was captured in before() after the first pack run.
    // Run the packer a second time independently and compare.
    const r2 = spawnSync('npm', ['run', 'pack:hub-extension'], {
      cwd: INSTALLER_DIR,
      stdio: 'pipe',
      shell: false,
    });
    assert.equal(r2.status, 0, 'Second pack run failed');
    const sriRun2 = readFileSync(SHA_PATH, 'utf8').trim();
    assert.equal(sriRun1, sriRun2, 'SHA-512 differs between runs — zip is not deterministic');
  });

  it('CLI route: node dist/ijfw.js pack-hub-extension --output <dir> exits 0 and writes zip', () => {
    const outDir = join(tmpdir(), `hub-ext-cli-test-${Date.now()}`);
    try {
      mkdirSync(outDir, { recursive: true });
      const r = spawnSync(
        'node',
        [join(INSTALLER_DIR, 'dist', 'ijfw.js'), 'pack-hub-extension', '--output', outDir],
        { cwd: INSTALLER_DIR, stdio: 'pipe' },
      );
      assert.equal(r.status, 0, `CLI exit non-zero. stderr: ${r.stderr.toString()}`);
      const expectedZip = join(outDir, `ijfw-${VERSION}.zip`);
      assert.ok(existsSync(expectedZip), `Expected zip at ${expectedZip}`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('CLI route: --output with whitespace-only value exits 2', () => {
    const r = spawnSync(
      'node',
      [join(INSTALLER_DIR, 'dist', 'ijfw.js'), 'pack-hub-extension', '--output', '   '],
      { cwd: INSTALLER_DIR, stdio: 'pipe' },
    );
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}`);
  });

});
