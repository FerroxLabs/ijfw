// uispec-intake.js -- v1.5.0 audit-MED-design-#12.
//
// Accept a `--from-image <path>` or `--from-figma <url>` flag in the
// ui-spec flow that pre-fills UI-SPEC fields before the user reviews.
//
// Behaviour matrix:
//
//   --from-image <path>
//     - Validates the file exists, is a supported raster format (.png/.jpg/.jpeg/.webp/.gif),
//       and is under 25MB.
//     - Extracts the dimensions from the PNG/JPEG header (pure stdlib, no
//       external lib).  For non-PNG/JPEG we return null dims; not fatal.
//     - Returns an UI-SPEC stub with:
//         * `source.kind: image`
//         * `source.path: <abs path>`
//         * `source.bytes: <size>`
//         * `source.dimensions: { width, height } | null`
//         * `advisory: "vision pipeline deferred to v1.6.0"`
//       The user (or downstream skill) fills the actual visual fields after
//       inspecting the image.  Token-time vision OCR is NOT done here; that's
//       the v1.6.0 vision pipeline.
//
//   --from-figma <url>
//     - Validates URL is https + figma.com.
//     - If `FIGMA_TOKEN` env var is set, fetches the file metadata via
//       https://api.figma.com/v1/files/<fileKey> using node:https.  No
//       external HTTP library.
//     - Returns an UI-SPEC stub with:
//         * `source.kind: figma`
//         * `source.url: <url>`
//         * `source.fileKey: <key>`
//         * `source.name: <fetched name | null>`
//         * `source.lastModified: <iso | null>`
//         * `advisory: "<reason if degraded>"`
//
// Graceful no-op: missing token, network error, non-https, all surface
// `advisory` strings rather than throwing.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as pathResolve, extname } from 'node:path';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Parse a `--from-image <path>` request into a UI-SPEC stub.
 *
 * @param {string} imagePath
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]   resolves relative paths
 * @returns {{ok: boolean, stub: object|null, error: string|null}}
 */
export function fromImage(imagePath, opts = {}) {
  if (typeof imagePath !== 'string' || imagePath.length === 0) {
    return { ok: false, stub: null, error: 'no-path' };
  }
  const abs = imagePath.startsWith('/')
    ? imagePath
    : pathResolve(opts.projectRoot || process.cwd(), imagePath);

  if (!existsSync(abs)) {
    return { ok: false, stub: null, error: `image-not-found: ${abs}` };
  }

  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    return { ok: false, stub: null, error: `unsupported-format: ${ext || '<no-ext>'}` };
  }

  let st;
  try {
    st = statSync(abs);
  } catch (e) {
    return { ok: false, stub: null, error: `stat-failed: ${e.code || e.message}` };
  }
  if (st.size > MAX_IMAGE_BYTES) {
    return { ok: false, stub: null, error: `image-too-large: ${st.size} bytes (limit ${MAX_IMAGE_BYTES})` };
  }

  let dimensions = null;
  try {
    const head = readFileSync(abs).subarray(0, 512);
    dimensions = parseDimensions(head, ext);
  } catch {
    // Tolerable; dimensions stay null.
  }

  return {
    ok: true,
    stub: {
      source: {
        kind: 'image',
        path: abs,
        bytes: st.size,
        dimensions,
      },
      advisory: 'vision pipeline deferred to v1.6.0 — review the image and fill UI-SPEC pillars manually',
      uiSpecHints: {
        layout: '<derive from image: list surfaces visible, breakpoints suggested by aspect ratio>',
        typography: '<derive from image: read visible heading/body weights and sizes>',
        color: '<derive from image: enumerate distinct colours; record hex values>',
        spacing: '<derive from image: rough px spacing scale between visible elements>',
      },
    },
    error: null,
  };
}

/**
 * Parse a `--from-figma <url>` request.
 *
 * @param {string} figmaUrl
 * @param {object} [opts]
 * @param {string} [opts.token]         Override FIGMA_TOKEN env
 * @param {Function} [opts.httpsGetJson] Inject `(url, headers) => Promise<{ok, data, error}>`
 * @returns {Promise<{ok: boolean, stub: object|null, error: string|null}>}
 */
export async function fromFigma(figmaUrl, opts = {}) {
  if (typeof figmaUrl !== 'string' || figmaUrl.length === 0) {
    return { ok: false, stub: null, error: 'no-url' };
  }

  let url;
  try {
    url = new URL(figmaUrl);
  } catch {
    return { ok: false, stub: null, error: 'invalid-url' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, stub: null, error: 'https-required' };
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    return { ok: false, stub: null, error: `not-figma-host: ${url.hostname}` };
  }

  const fileKey = extractFigmaFileKey(url);
  if (!fileKey) {
    return { ok: false, stub: null, error: 'cannot-extract-figma-file-key' };
  }

  const token = opts.token || process.env.FIGMA_TOKEN || null;
  const baseStub = {
    source: {
      kind: 'figma',
      url: figmaUrl,
      fileKey,
      name: null,
      lastModified: null,
    },
    advisory: null,
    uiSpecHints: {
      layout: '<derive from Figma frames: list frame names as surfaces>',
      typography: '<read text styles from Figma local-styles>',
      color: '<read fill styles from Figma local-styles>',
      spacing: '<read auto-layout gap/padding values from frames>',
    },
  };

  if (!token) {
    return {
      ok: true,
      stub: { ...baseStub, advisory: 'FIGMA_TOKEN unset — metadata fetch skipped; URL stored for reference only' },
      error: null,
    };
  }

  const fetcher = typeof opts.httpsGetJson === 'function' ? opts.httpsGetJson : defaultHttpsGetJson;
  const apiUrl = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?depth=1`;
  let res;
  try {
    res = await fetcher(apiUrl, { 'X-Figma-Token': token });
  } catch (e) {
    return {
      ok: true,
      stub: { ...baseStub, advisory: `figma-api-error: ${e.code || e.message}` },
      error: null,
    };
  }
  if (!res || !res.ok || !res.data) {
    return {
      ok: true,
      stub: { ...baseStub, advisory: `figma-api-degraded: ${res && res.error ? res.error : 'unknown'}` },
      error: null,
    };
  }

  return {
    ok: true,
    stub: {
      ...baseStub,
      source: {
        ...baseStub.source,
        name: typeof res.data.name === 'string' ? res.data.name : null,
        lastModified: typeof res.data.lastModified === 'string' ? res.data.lastModified : null,
      },
      advisory: 'metadata fetched — review styles + frames in UI-SPEC pillars',
    },
    error: null,
  };
}

/**
 * Parse argv (without the leading `node script.js`) looking for --from-image
 * and --from-figma flags.
 *
 * @param {string[]} argv
 * @returns {{fromImage: string|null, fromFigma: string|null, rest: string[]}}
 */
export function parseIntakeFlags(argv) {
  const rest = [];
  let fromImageVal = null;
  let fromFigmaVal = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from-image') {
      fromImageVal = argv[i + 1] || null;
      i += 1;
    } else if (a.startsWith('--from-image=')) {
      fromImageVal = a.slice('--from-image='.length);
    } else if (a === '--from-figma') {
      fromFigmaVal = argv[i + 1] || null;
      i += 1;
    } else if (a.startsWith('--from-figma=')) {
      fromFigmaVal = a.slice('--from-figma='.length);
    } else {
      rest.push(a);
    }
  }
  return { fromImage: fromImageVal, fromFigma: fromFigmaVal, rest };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseDimensions(buf, ext) {
  if (!buf || buf.length < 24) return null;

  if (ext === '.png') {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR at offset 16:
    //   width (4 bytes BE), height (4 bytes BE)
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height };
    }
    return null;
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    // JPEG: FF D8 ... SOFn marker (FF C0/C1/C2) gives height/width.
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0/SOF1/SOF2 markers
      if (marker >= 0xc0 && marker <= 0xc3) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height };
      }
      // Skip segment.
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
    return null;
  }

  return null; // .webp / .gif intentionally unparsed -- not fatal.
}

function extractFigmaFileKey(url) {
  // Supports /file/<key>/... and /design/<key>/...
  const m = url.pathname.match(/\/(?:file|design)\/([A-Za-z0-9]+)(?:\/|$)/);
  if (m) return m[1];
  return null;
}

function defaultHttpsGetJson(url, headers = {}) {
  return new Promise((resolve) => {
    // Lazy-load https so the module stays import-cheap.
    import('node:https')
      .then(({ default: https }) => {
        const req = https.get(url, { headers }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve({ ok: true, data: JSON.parse(body), error: null });
              } catch (e) {
                resolve({ ok: false, data: null, error: `json-parse: ${e.message}` });
              }
            } else {
              resolve({ ok: false, data: null, error: `http-${res.statusCode || 0}` });
            }
          });
        });
        req.setTimeout(8000, () => {
          req.destroy(new Error('timeout'));
        });
        req.on('error', (e) => resolve({ ok: false, data: null, error: e.code || e.message }));
      })
      .catch((e) => resolve({ ok: false, data: null, error: e.code || e.message }));
  });
}
