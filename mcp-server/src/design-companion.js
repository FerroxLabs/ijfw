/**
 * IJFW Design Companion -- visual companion helpers.
 * Zero deps. node:fs, node:events, node:path only.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createPreviewSandbox as defaultCreatePreviewSandbox } from './design/iframe-bridge.js';

export const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IJFW Design Companion</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;color:#94a3b8;font-family:system-ui,-apple-system,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
  .box{max-width:480px;padding:2rem}
  h1{color:#f1f5f9;font-size:1.5rem;margin-bottom:1rem}
  code{background:#1e293b;color:#7dd3fc;padding:.2em .5em;border-radius:4px;font-size:.875rem}
</style>
</head>
<body>
<div class="box">
  <h1>Design companion active.</h1>
  <p>Push a design with:<br><br><code>ijfw design push &lt;file&gt;</code></p>
</div>
</body>
</html>`;

/**
 * Returns the path of the newest .html file in contentDir by mtime.
 * Returns null when the directory is empty or does not exist.
 */
export function getNewestFile(contentDir) {
  if (!existsSync(contentDir)) return null;
  let newest = null;
  let newestMtime = 0;
  for (const name of readdirSync(contentDir)) {
    if (!name.endsWith('.html')) continue;
    const full = join(contentDir, name);
    try {
      const { mtimeMs } = statSync(full);
      if (mtimeMs > newestMtime) {
        newestMtime = mtimeMs;
        newest = full;
      }
    } catch {}
  }
  return newest;
}

/**
 * HTML-escape helper for the viewer codegen. Mirrors the audit-H3.1
 * dashboard `esc()` -- escapes ampersand, angle brackets, double-quote, AND
 * single-quote so output is safe inside single- or double-quoted attributes.
 */
export function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a tabbed viewer for a list of HTML mockups.
 *
 * Each mockup may carry an optional `iframeUrl` (provisioned via the
 * `vercel:vercel-sandbox` peer skill). When the URL is present the viewer
 * renders a live `<iframe src="...">` running in an isolated Firecracker
 * microVM. When absent, the viewer falls back to a static `<iframe srcdoc>`
 * with the html inlined. Either way the iframe carries
 * `sandbox="allow-scripts allow-same-origin"` to prevent top-window escape.
 *
 * All user-controlled strings (mockup name, iframe url) flow through
 * `escHtml()` -- the same pattern dashboard `esc()` uses post-audit-H3.1.
 *
 * @param {{ mockups: Array<{name: string, html?: string, iframeUrl?: string|null}>, title?: string }} args
 * @returns {string} HTML document for the viewer.
 */
export function buildMockupViewer({ mockups = [], title = 'IJFW Design Mockups' } = {}) {
  const items = Array.isArray(mockups) ? mockups : [];
  const safeTitle = escHtml(title);

  const tabs = items
    .map((m, i) => {
      const name = escHtml(m && m.name ? m.name : `mockup-${i + 1}`);
      return `<button class="tab" data-i="${i}" ${i === 0 ? 'aria-selected="true"' : ''}>${name}</button>`;
    })
    .join('');

  const panes = items
    .map((m, i) => {
      const name = escHtml(m && m.name ? m.name : `mockup-${i + 1}`);
      const isLive = m && typeof m.iframeUrl === 'string' && m.iframeUrl;
      const inner = isLive
        ? `<iframe class="preview" src="${escHtml(m.iframeUrl)}" title="${name}" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>`
        : `<iframe class="preview" srcdoc="${escHtml(m && m.html ? m.html : '<!doctype html><meta charset=utf-8><p>(no preview)</p>')}" title="${name}" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>`;
      const badge = isLive
        ? '<span class="badge live" title="Provisioned via vercel:vercel-sandbox">LIVE</span>'
        : '<span class="badge static" title="Static srcdoc preview -- install vercel CLI or set IJFW_VERCEL_SANDBOX_URL for live sandbox">STATIC</span>';
      return `<section class="pane" data-i="${i}" ${i === 0 ? '' : 'hidden'}>
  <header class="phead">${name} ${badge}</header>
  ${inner}
</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;flex-direction:column}
  .tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px;background:#1e293b;border-bottom:1px solid #334155}
  .tab{background:#334155;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}
  .tab[aria-selected="true"]{background:#0369a1;border-color:#0ea5e9}
  .pane{flex:1;display:flex;flex-direction:column;min-height:0}
  .phead{padding:6px 12px;background:#0f172a;border-bottom:1px solid #1e293b;font-size:12px;color:#94a3b8;display:flex;gap:8px;align-items:center}
  .badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;letter-spacing:.04em}
  .badge.live{background:#15803d;color:#fff}
  .badge.static{background:#475569;color:#cbd5e1}
  .preview{flex:1;width:100%;border:0;background:#fff;min-height:400px}
</style>
</head>
<body>
<nav class="tabs" role="tablist">${tabs || '<span style="color:#64748b;padding:6px 12px">No mockups yet.</span>'}</nav>
${panes}
<script>
(function(){
  var tabs = document.querySelectorAll('.tab');
  var panes = document.querySelectorAll('.pane');
  tabs.forEach(function(t){
    t.addEventListener('click', function(){
      var i = t.getAttribute('data-i');
      tabs.forEach(function(x){ x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
      panes.forEach(function(p){
        if (p.getAttribute('data-i') === i) p.removeAttribute('hidden'); else p.setAttribute('hidden','');
      });
    });
  });
})();
</script>
</body>
</html>`;
}

/**
 * Provision per-mockup iframes via the vercel-sandbox bridge when available,
 * then render the tabbed viewer. Falls back to static `<iframe srcdoc>` for
 * any mockup whose provisioning failed (or for all of them if the bridge
 * is unavailable).
 *
 * @param {object}  args
 * @param {Array<{name: string, html: string}>} args.mockups  Mockup inputs.
 * @param {Function} [args.createSandbox]  Override for the bridge (test seam).
 *                                          Should match the createPreviewSandbox signature.
 * @param {string}  [args.title]
 * @returns {Promise<{html: string, sandboxIds: string[]}>}
 */
export async function renderMockupViewerWithBridge({ mockups = [], createSandbox, title } = {}) {
  const fn = typeof createSandbox === 'function' ? createSandbox : defaultCreatePreviewSandbox;
  const enriched = [];
  const sandboxIds = [];
  for (const m of mockups) {
    let iframeUrl = null;
    try {
      const r = await fn({ html: m.html, name: m.name });
      if (r && r.iframeUrl) {
        iframeUrl = r.iframeUrl;
        if (r.sandboxId) sandboxIds.push(r.sandboxId);
      }
    } catch {
      // bridge promised never to throw; this catch is defense-in-depth.
      iframeUrl = null;
    }
    enriched.push({ name: m.name, html: m.html, iframeUrl });
  }
  return { html: buildMockupViewer({ mockups: enriched, title }), sandboxIds };
}

/**
 * Watches contentDir for new/changed .html files.
 * Returns an EventEmitter that emits 'new-content' (with the file path) on change.
 * Uses fs.watch with a 100ms debounce.
 */
export function watchContentDir(contentDir) {
  const emitter = new EventEmitter();
  let debounce = null;

  function trigger() {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const file = getNewestFile(contentDir);
      emitter.emit('new-content', file);
    }, 100);
  }

  if (!existsSync(contentDir)) return emitter;

  try {
    const w = watch(contentDir, trigger);
    w.on('error', () => { /* Windows EPERM: skip; emitter still serves polled state */ });
    emitter.once('_stop', () => { try { w.close(); } catch {} });
  } catch {}

  return emitter;
}
