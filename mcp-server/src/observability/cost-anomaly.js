/**
 * observability/cost-anomaly.js -- v1.5.0 N4.obs M4.
 *
 * Rolling z-score anomaly detection on the daily cost series. No LLM call,
 * no external service. Designed for the dashboard cost tile: when today is
 * unusually expensive, surface it ("Today is 3.4x yesterday's average; top
 * driver = ijfw_memory_search calls, 54% of cost").
 *
 * Inputs (per the dashboard's existing /api/data shape):
 *   - daily:        { date: 'YYYY-MM-DD', cost: number }[]   (oldest -> newest OR
 *                                                              newest -> oldest;
 *                                                              we sort defensively)
 *   - todayDrivers: { name: string, cost: number }[]         (optional;
 *                                                              top-driver
 *                                                              attribution)
 *
 * Output:
 *   {
 *     anomalous:  boolean,       // true when today > mean + 2*stdev of trailing window
 *     today:      number,        // today's cost
 *     baseline:   { mean, stdev, days, window } // baseline stats
 *     factor:     number|null,   // today / yesterday-baseline-mean (1.0 = on par)
 *     z:          number|null,   // (today - mean) / stdev (∞-bounded; null if stdev=0)
 *     topDriver:  { name, cost, sharePct }|null
 *     reason:     string         // human-readable summary for the tile
 *   }
 *
 * Tuning knobs:
 *   - windowDays:  rolling window length (default 7)
 *   - threshold:   z above which we mark anomalous (default 2.0; equivalent to
 *                   "more than 2 standard deviations above the trailing mean")
 *
 * Edge cases the dashboard relies on:
 *   - Fewer than `windowDays` historical days => not anomalous, return
 *     `{anomalous:false, reason:'insufficient_history', ...}` so the tile can
 *     hide gracefully.
 *   - Zero stdev (flat baseline) => fall back to factor-based check
 *     (today > baseline mean by >= 2x).
 *   - Empty/malformed series => anomalous=false, reason='no_data'.
 */

const DEFAULT_WINDOW = 7;
const DEFAULT_THRESHOLD = 2.0;
// When stdev=0 but today exceeds mean by this multiple, still flag.
const FLAT_BASELINE_FACTOR = 2.0;

/**
 * Detect a daily-cost anomaly.
 *
 * @param {{daily: Array<{date:string, cost:number}>, todayDrivers?: Array<{name:string,cost:number}>, windowDays?: number, threshold?: number}} input
 * @returns {object} result described above
 */
export function detectCostAnomaly(input = {}) {
  const windowDays = Number.isFinite(input.windowDays) && input.windowDays > 0
    ? Math.floor(input.windowDays)
    : DEFAULT_WINDOW;
  const threshold = Number.isFinite(input.threshold) && input.threshold > 0
    ? input.threshold
    : DEFAULT_THRESHOLD;

  const daily = Array.isArray(input.daily) ? input.daily : [];
  const cleaned = daily
    .filter((d) => d && typeof d.date === 'string' && Number.isFinite(d.cost))
    .map((d) => ({ date: d.date, cost: Math.max(0, d.cost) }))
    // Sort oldest -> newest, defensively.
    .sort((a, b) => a.date.localeCompare(b.date));

  if (cleaned.length === 0) {
    return {
      anomalous: false,
      today: 0,
      baseline: { mean: 0, stdev: 0, days: 0, window: windowDays },
      factor: null,
      z: null,
      topDriver: null,
      reason: 'no_data',
    };
  }

  // Today = last entry; trailing window = the windowDays entries BEFORE it.
  const todayEntry = cleaned[cleaned.length - 1];
  const trailing = cleaned.slice(Math.max(0, cleaned.length - 1 - windowDays), cleaned.length - 1);

  if (trailing.length < Math.min(3, windowDays)) {
    return {
      anomalous: false,
      today: todayEntry.cost,
      baseline: { mean: 0, stdev: 0, days: trailing.length, window: windowDays },
      factor: null,
      z: null,
      topDriver: pickTopDriver(input.todayDrivers, todayEntry.cost),
      reason: 'insufficient_history',
    };
  }

  // mean/stdev (sample variance, ddof=1 when n>1)
  const n = trailing.length;
  const sum = trailing.reduce((s, d) => s + d.cost, 0);
  const mean = sum / n;
  const variance = n > 1
    ? trailing.reduce((s, d) => s + (d.cost - mean) ** 2, 0) / (n - 1)
    : 0;
  const stdev = Math.sqrt(variance);

  const today = todayEntry.cost;
  const factor = mean > 0 ? today / mean : null;
  const z = stdev > 0 ? (today - mean) / stdev : null;

  let anomalous = false;
  let reason;
  if (z !== null) {
    anomalous = z >= threshold;
    if (anomalous) {
      reason = `Today is ${factor != null ? factor.toFixed(1) : '?'}x the ${windowDays}-day average (z=${z.toFixed(1)}).`;
    } else {
      reason = `Within normal range (z=${z.toFixed(1)}, threshold=${threshold}).`;
    }
  } else if (mean > 0 && factor !== null && factor >= FLAT_BASELINE_FACTOR) {
    // Flat baseline -- mean > 0 but stdev == 0. Still flag if we more than
    // doubled.
    anomalous = true;
    reason = `Today is ${factor.toFixed(1)}x the ${windowDays}-day flat baseline.`;
  } else if (mean === 0) {
    // Baseline was zero -- today is anomalous iff there's non-zero spend.
    anomalous = today > 0;
    reason = anomalous
      ? `First non-zero day after a ${windowDays}-day quiet stretch.`
      : 'No spend in window.';
  } else {
    reason = 'Within normal range (flat baseline, factor < 2).';
  }

  const topDriver = pickTopDriver(input.todayDrivers, today);
  if (anomalous && topDriver) {
    reason += ` Top driver: ${topDriver.name} (${topDriver.sharePct}%).`;
  }

  return {
    anomalous,
    today,
    baseline: {
      mean,
      stdev,
      days: n,
      window: windowDays,
    },
    factor,
    z,
    topDriver,
    reason,
  };
}

function pickTopDriver(drivers, total) {
  if (!Array.isArray(drivers) || drivers.length === 0) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  let top = null;
  for (const d of drivers) {
    if (!d || typeof d.name !== 'string' || !Number.isFinite(d.cost)) continue;
    if (d.cost <= 0) continue;
    if (!top || d.cost > top.cost) top = d;
  }
  if (!top) return null;
  const sharePct = Math.round((top.cost / total) * 100);
  return { name: top.name, cost: top.cost, sharePct };
}
