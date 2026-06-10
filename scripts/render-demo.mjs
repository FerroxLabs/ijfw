#!/usr/bin/env node
/**
 * Render docs/demo-cross-tool.html (the #card element) to a 2x PNG for the
 * README hero demo. Zero deps: headless Chrome over CDP (Node >= 22 WebSocket).
 *   node scripts/render-demo.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'docs', 'demo-cross-tool.html');
const OUT = join(ROOT, 'docs', 'img', 'demo-cross-tool.png');
const PORT = 9461;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 1; const pend = new Map(); const wait = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const { rs, rj } = pend.get(m.id); pend.delete(m.id); m.error ? rj(new Error(m.error.message)) : rs(m.result); }
      else if (m.method && wait.has(m.method)) { wait.get(m.method)(m.params); wait.delete(m.method); } };
    ws.onerror = (e) => reject(e.error || new Error('ws'));
    ws.onopen = () => resolve({
      send(method, params = {}) { const i = id++; return new Promise((rs, rj) => { pend.set(i, { rs, rj }); ws.send(JSON.stringify({ id: i, method, params })); }); },
      once(method) { return new Promise((rs) => wait.set(method, rs)); },
      close() { ws.close(); },
    });
  });
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'ijfw-demo-'));
  const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--force-color-profile=srgb',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let ws;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const t = (await r.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (t) { ws = t.webSocketDebuggerUrl; break; } } catch {}
      await sleep(150);
    }
    const cdp = await connect(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 700, deviceScaleFactor: 2, mobile: false });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${HTML}` });
    await Promise.race([loaded, sleep(4000)]); await sleep(400);
    const { result } = await cdp.send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const e = document.getElementById('card'); const r = e.getBoundingClientRect();
        return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; })()` });
    const b = result.value;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
    writeFileSync(OUT, Buffer.from(data, 'base64'));
    console.log(`wrote docs/img/demo-cross-tool.png  (${Math.round(b.w)}x${Math.round(b.h)} @2x)`);
    cdp.close();
  } finally { chrome.kill('SIGTERM'); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}
main().catch((e) => { console.error(e); process.exit(1); });
