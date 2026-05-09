/**
 * IJFW Design Companion -- visual companion helpers.
 * Zero deps. node:fs, node:events, node:path only.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

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
