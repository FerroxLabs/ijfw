#!/usr/bin/env node
/**
 * Render docs/README-COMPARISON.html section-by-section into crisp 2x PNGs
 * under docs/img/, for embedding in the README.
 *
 * Zero npm deps: drives the system Google Chrome headless over the DevTools
 * Protocol using Node's built-in global WebSocket (Node >= 22). Each <section
 * class="shot" id="..."> is clipped to its bounding box and captured at
 * deviceScaleFactor 2 (retina). Re-run after editing the HTML.
 *
 *   node scripts/render-comparison-images.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'docs', 'README-COMPARISON.html');
const OUT = join(ROOT, 'docs', 'img');
const PORT = 9456;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// section id -> output filename
const SHOTS = [
  ['shot-unify', 'compare-1-unify.png'],
  ['shot-layer', 'compare-2-memory-layer.png'],
  ['shot-bench', 'compare-3-benchmarks.png'],
  ['shot-caps',  'compare-4-capabilities.png'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'ijfw-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--force-color-profile=srgb',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await waitForPageWs();
    const cdp = await connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1120, height: 1400, deviceScaleFactor: 2, mobile: false });

    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${HTML}` });
    await Promise.race([loaded, sleep(4000)]);
    await sleep(400); // settle fonts/layout

    for (const [id, file] of SHOTS) {
      const { result } = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => { const e = document.getElementById(${JSON.stringify(id)});
          if (!e) return null; const r = e.getBoundingClientRect();
          return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }; })()`,
      });
      const box = result && result.value;
      if (!box) throw new Error(`section #${id} not found in ${HTML}`);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
      });
      writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
      console.log(`wrote docs/img/${file}  (${Math.round(box.w)}x${Math.round(box.h)} css px @2x)`);
    }
    cdp.close();
  } finally {
    chrome.kill('SIGTERM');
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

async function waitForPageWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome not up yet */ }
    await sleep(150);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const waiters = new Map(); // method -> resolve
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: rs, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rj(new Error(msg.error.message)) : rs(msg.result);
      } else if (msg.method && waiters.has(msg.method)) {
        waiters.get(msg.method)(msg.params);
        waiters.delete(msg.method);
      }
    };
    ws.onerror = (e) => reject(e.error || new Error('ws error'));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((rs, rj) => {
          pending.set(id, { resolve: rs, reject: rj });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      once(method) { return new Promise((rs) => waiters.set(method, rs)); },
      close() { ws.close(); },
    });
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
