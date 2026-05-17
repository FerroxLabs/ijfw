/**
 * dashboard-charts.js — IJFW v1.4.3 W9-C (B19)
 *
 * Pure-JS canvas/DOM chart helpers for the dashboard. No external libs.
 * Theme-aware: reads CSS custom properties `--ijfw-chart-fg`,
 * `--ijfw-chart-bg`, `--ijfw-chart-warning` from the element's computed
 * style. Falls back to sane defaults if the host page hasn't set them.
 *
 * All helpers are defensive against malformed input so a bad payload from
 * the API can never throw inside the dashboard render loop.
 */

const DEFAULTS = {
  fg: '#9ad2ff',
  bg: 'rgba(154,210,255,0.18)',
  warning: '#ff9b3a',
  text: '#cfd6dd',
};

function _readTheme(el) {
  // Both `canvas` and plain `div` go through `getComputedStyle`. In the test
  // environment the element is a hand-rolled mock that doesn't reach the DOM
  // — guard so we don't blow up if `getComputedStyle` is unavailable.
  let cs = null;
  try {
    if (el && typeof globalThis.getComputedStyle === 'function') {
      cs = globalThis.getComputedStyle(el);
    }
  } catch { cs = null; }
  const read = (prop, fallback) => {
    if (!cs || typeof cs.getPropertyValue !== 'function') return fallback;
    const v = cs.getPropertyValue(prop);
    return (v && v.trim()) ? v.trim() : fallback;
  };
  return {
    fg:      read('--ijfw-chart-fg',      DEFAULTS.fg),
    bg:      read('--ijfw-chart-bg',      DEFAULTS.bg),
    warning: read('--ijfw-chart-warning', DEFAULTS.warning),
    text:    read('--ijfw-chart-text',    DEFAULTS.text),
  };
}

function _safeNum(v, def = 0) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : def;
}

/**
 * lineChart(canvas, points, opts)
 *   points: [{ x: number, y: number }, ...] OR [number, ...]
 *   opts:   { xMin?, xMax?, yMax?, color?, fill? }
 *
 * Empty data renders nothing (clears the canvas) without throwing.
 */
export function lineChart(canvas, points, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = _safeNum(canvas.width, 200);
  const H = _safeNum(canvas.height, 100);
  const theme = _readTheme(canvas);
  const color = opts.color || theme.fg;
  const fill  = opts.fill === false ? null : theme.bg;

  try { ctx.clearRect(0, 0, W, H); } catch {}

  const pts = Array.isArray(points) ? points : [];
  const norm = pts.map((p, i) => {
    if (typeof p === 'number') return { x: i, y: _safeNum(p, 0) };
    return { x: _safeNum(p && p.x, i), y: _safeNum(p && p.y, 0) };
  }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (norm.length === 0) return;

  let xMin = _safeNum(opts.xMin, norm[0].x);
  let xMax = _safeNum(opts.xMax, norm[norm.length - 1].x);
  if (xMax === xMin) xMax = xMin + 1;
  const yMax = _safeNum(opts.yMax, Math.max(1, ...norm.map((p) => p.y)));
  const yScale = yMax > 0 ? yMax : 1;

  const pad = 4;
  const innerW = Math.max(1, W - pad * 2);
  const innerH = Math.max(1, H - pad * 2);

  const px = (x) => pad + ((x - xMin) / (xMax - xMin)) * innerW;
  const py = (y) => pad + (1 - (Math.max(0, y) / yScale)) * innerH;

  // Filled area
  if (fill) {
    try {
      ctx.beginPath();
      ctx.moveTo(px(norm[0].x), H - pad);
      for (const p of norm) ctx.lineTo(px(p.x), py(p.y));
      ctx.lineTo(px(norm[norm.length - 1].x), H - pad);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    } catch {}
  }

  // Line stroke
  try {
    ctx.beginPath();
    ctx.moveTo(px(norm[0].x), py(norm[0].y));
    for (let i = 1; i < norm.length; i++) ctx.lineTo(px(norm[i].x), py(norm[i].y));
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  } catch {}
}

/**
 * barChart(canvas, bars, opts)
 *   bars: [{ label: string, value: number, color?: string }, ...]
 *   opts: { horizontal?: boolean, color?: string, maxValue?: number }
 *
 * Zero-value bars render as empty rails. Negative values are clamped to 0.
 */
export function barChart(canvas, bars, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = _safeNum(canvas.width, 200);
  const H = _safeNum(canvas.height, 100);
  const theme = _readTheme(canvas);
  const defaultColor = opts.color || theme.fg;
  const horizontal = Boolean(opts.horizontal);

  try { ctx.clearRect(0, 0, W, H); } catch {}

  const rows = Array.isArray(bars) ? bars.filter((b) => b && typeof b === 'object') : [];
  if (rows.length === 0) return;

  const values = rows.map((b) => Math.max(0, _safeNum(b.value, 0)));
  const maxVal = _safeNum(opts.maxValue, Math.max(1, ...values));
  const scale = maxVal > 0 ? maxVal : 1;

  const pad = 4;
  const labelGutter = horizontal ? 80 : 14;
  const innerW = Math.max(1, W - pad * 2 - (horizontal ? labelGutter : 0));
  const innerH = Math.max(1, H - pad * 2 - (horizontal ? 0 : labelGutter));
  const slot = (horizontal ? innerH : innerW) / rows.length;
  const barW = Math.max(1, slot * 0.7);

  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    const v = values[i];
    const color = b.color || defaultColor;
    if (horizontal) {
      const y = pad + i * slot + (slot - barW) / 2;
      const len = (v / scale) * innerW;
      try {
        ctx.fillStyle = theme.bg;
        ctx.fillRect(pad + labelGutter, y, innerW, barW);
        ctx.fillStyle = color;
        ctx.fillRect(pad + labelGutter, y, len, barW);
        ctx.fillStyle = theme.text;
        ctx.fillText(String(b.label || ''), pad, y + barW * 0.75);
      } catch {}
    } else {
      const x = pad + i * slot + (slot - barW) / 2;
      const len = (v / scale) * innerH;
      try {
        ctx.fillStyle = theme.bg;
        ctx.fillRect(x, pad, barW, innerH);
        ctx.fillStyle = color;
        ctx.fillRect(x, pad + (innerH - len), barW, len);
        ctx.fillStyle = theme.text;
        ctx.fillText(String(b.label || '').slice(0, 8), x, H - pad);
      } catch {}
    }
  }
}

/**
 * progressBar(div, data)
 *   data: { current: number, limit: number | null, label?: string, warning?: boolean }
 *
 * Mutates `div` in place. Renders an "unlimited" placeholder when limit is
 * null. Applies a warning class when `warning` is truthy.
 */
export function progressBar(div, data = {}) {
  if (!div) return;
  const theme = _readTheme(div);
  const cur = Math.max(0, _safeNum(data.current, 0));
  const lim = (data.limit === null || data.limit === undefined) ? null : _safeNum(data.limit, null);
  const label = typeof data.label === 'string' ? data.label : '';
  const warn = Boolean(data.warning);

  // Clear children.
  try {
    while (div.firstChild) div.removeChild(div.firstChild);
  } catch {
    // Some test mocks omit firstChild/removeChild. Skip cleanup.
  }

  const setClass = (extra) => {
    try {
      div.className = ['ijfw-progress', extra, warn ? 'ijfw-progress--warn' : '']
        .filter(Boolean).join(' ');
    } catch {}
  };

  // Helper to create child elements safely.
  function appendEl(tag, opts) {
    try {
      if (typeof div.ownerDocument === 'object' && div.ownerDocument && typeof div.ownerDocument.createElement === 'function') {
        const el = div.ownerDocument.createElement(tag);
        if (opts && opts.text) el.textContent = opts.text;
        if (opts && opts.style) el.setAttribute('style', opts.style);
        if (opts && opts.cls) el.className = opts.cls;
        if (typeof div.appendChild === 'function') div.appendChild(el);
        return el;
      }
    } catch {}
    return null;
  }

  if (lim === null) {
    setClass('ijfw-progress--unlimited');
    appendEl('span', { cls: 'ijfw-progress-label', text: label });
    appendEl('span', { cls: 'ijfw-progress-val',   text: cur + ' / unlimited' });
    return;
  }

  setClass('');
  const denom = lim > 0 ? lim : 1;
  const pct = Math.max(0, Math.min(100, (cur / denom) * 100));
  appendEl('span', { cls: 'ijfw-progress-label', text: label });
  const rail = appendEl('span', { cls: 'ijfw-progress-rail', style: 'background:' + theme.bg + ';display:inline-block;height:6px;width:120px;border-radius:3px;overflow:hidden;vertical-align:middle;margin:0 6px' });
  if (rail) {
    try {
      const fill = (rail.ownerDocument || div.ownerDocument).createElement('span');
      fill.className = 'ijfw-progress-fill';
      fill.setAttribute('style', 'display:block;height:100%;width:' + pct.toFixed(1) + '%;background:' + (warn ? theme.warning : theme.fg));
      rail.appendChild(fill);
    } catch {}
  }
  appendEl('span', { cls: 'ijfw-progress-val', text: cur + ' / ' + lim });
}
