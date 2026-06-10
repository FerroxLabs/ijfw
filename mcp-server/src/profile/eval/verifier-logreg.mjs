// verifier-logreg.mjs — Gate B v3. Plain-JS L2 logistic regression (batch gradient
// descent) over standardized pair-summary features. ZERO deps. Trains on same- vs
// different-author pair vectors; predicts P(same-author). That probability becomes the
// verifier score fed (as distance = 1 - p) into validateInstrument.

// Standardizer fit on TRAIN features only (mean/sd per column), applied to val.
export function fitStandardizer(rows) {
  const d = rows[0].length;
  const mean = new Float64Array(d);
  const sd = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j += 1) mean[j] += r[j];
  for (let j = 0; j < d; j += 1) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j += 1) sd[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j += 1) sd[j] = Math.sqrt(sd[j] / rows.length) || 1e-6;
  return { mean, sd };
}
export function applyStandardizer(row, st) {
  const out = new Float64Array(row.length);
  for (let j = 0; j < row.length; j += 1) out[j] = (row[j] - st.mean[j]) / st.sd[j];
  return out;
}

function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

// trainLogReg(X, y, opts) — X: array of standardized Float64Array rows, y: 0/1 labels.
// L2 (lambda) on weights (not bias). Class-balanced sample weights so the (rarer)
// same-author positives are not swamped by the abundant different-author negatives.
export function trainLogReg(X, y, opts = {}) {
  const lambda = opts.lambda ?? 1.0;
  const lr = opts.lr ?? 0.1;
  const iters = opts.iters ?? 4000;
  const n = X.length;
  const d = X[0].length;
  const w = new Float64Array(d);
  let b = 0;

  const nPos = y.reduce((a, v) => a + v, 0);
  const nNeg = n - nPos;
  const wPos = nPos ? n / (2 * nPos) : 1;
  const wNeg = nNeg ? n / (2 * nNeg) : 1;

  for (let it = 0; it < iters; it += 1) {
    const gw = new Float64Array(d);
    let gb = 0;
    let wsum = 0;
    for (let i = 0; i < n; i += 1) {
      const xi = X[i];
      let z = b;
      for (let j = 0; j < d; j += 1) z += w[j] * xi[j];
      const p = sigmoid(z);
      const sw = y[i] ? wPos : wNeg;
      const err = (p - y[i]) * sw;
      for (let j = 0; j < d; j += 1) gw[j] += err * xi[j];
      gb += err;
      wsum += sw;
    }
    const inv = 1 / (wsum || 1);
    for (let j = 0; j < d; j += 1) {
      gw[j] = gw[j] * inv + lambda * w[j] / n;
      w[j] -= lr * gw[j];
    }
    b -= lr * gb * inv;
  }
  return { w, b };
}

export function predictProba(row, model) {
  let z = model.b;
  for (let j = 0; j < row.length; j += 1) z += model.w[j] * row[j];
  return sigmoid(z);
}
