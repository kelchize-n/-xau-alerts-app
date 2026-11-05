// server/orderBlocks.js
// Order block detector for XAU/USD. Closes only (wicks ignored).
//
// Bullish OB: a sell-off that takes out a prior swing low (liquidity sweep),
//   then a momentum close above the swing high where that sell-off started.
//   Box = the whole sell-off: top = start high, bottom = lowest close.
// Bearish OB: a rally that takes out a prior swing high (liquidity sweep),
//   then a momentum close below the swing low where that rally started.
//   Box = the whole rally: bottom = start low, top = highest close.
// Alert = the momentum break (BOS). No retest needed.

const SETTINGS = {
  swingBars: 2,          // bars on each side needed to confirm a swing (closes)
  avgLookback: 20,       // bars used to measure average move size
  displacementMult: 1.5, // a single move, or a run, must be this many times the average
  seriesMin: 3,          // consecutive same-direction closes for a "series" push
  maxLegBars: 60,        // the sell-off or rally must start within this many bars of the break
};

function normalize(candles) {
  const arr = (candles || [])
    .map(c => ({ time: c.time ?? c.datetime, close: Number(c.close) }))
    .filter(c => Number.isFinite(c.close));
  // Make sure oldest is first (Twelve Data returns newest first)
  if (arr.length > 1 && String(arr[0].time) > String(arr[arr.length - 1].time)) arr.reverse();
  return arr;
}

// A swing high/low is a close higher/lower than N closes on each side
function findSwings(closes, N) {
  const highs = [], lows = [];
  for (let i = N; i < closes.length - N; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= N; k++) {
      if (!(closes[i] > closes[i - k] && closes[i] > closes[i + k])) isHigh = false;
      if (!(closes[i] < closes[i - k] && closes[i] < closes[i + k])) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

// Most recent swing whose confirmation bar (index + N) is before bar b
function lastSwingBefore(list, b) {
  let found = null;
  for (const s of list) {
    if (s + SETTINGS.swingBars < b) found = s;
    else break;
  }
  return found;
}

// Average size of close-to-close moves before bar `end`
function avgMove(closes, end) {
  const start = Math.max(1, end - SETTINGS.avgLookback);
  let sum = 0, cnt = 0;
  for (let k = start; k < end; k++) {
    sum += Math.abs(closes[k] - closes[k - 1]);
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// Momentum on the break leg (from the sweep extreme to the break bar).
// dir = +1 for bullish break, -1 for bearish break.
function hasMomentum(closes, from, to, dir, avg) {
  if (!(avg > 0)) return false;
  const threshold = SETTINGS.displacementMult * avg;

  // 1) Displacement: one close-to-close move in the break direction, large enough
  for (let k = from + 1; k <= to; k++) {
    if ((closes[k] - closes[k - 1]) * dir >= threshold) return true;
  }

  // 2) Series: last seriesMin moves all in the break direction, with a large enough net move
  const m = SETTINGS.seriesMin;
  for (let k = from + m; k <= to; k++) {
    let allSame = true;
    for (let j = k - m + 1; j <= k; j++) {
      if ((closes[j] - closes[j - 1]) * dir <= 0) { allSame = false; break; }
    }
    if (allSame && (closes[k] - closes[k - m]) * dir >= threshold) return true;
  }
  return false;
}

function buildOB(direction, timeframe, candles, closes, startIdx, extremeIdx, bosIdx, sweptIdx) {
  const startPrice = closes[startIdx];
  const extremePrice = closes[extremeIdx];
  return {
    direction,
    timeframe,
    top: direction === 'bullish' ? startPrice : extremePrice,
    bottom: direction === 'bullish' ? extremePrice : startPrice,
    startTime: candles[startIdx].time,
    endTime: candles[extremeIdx].time,
    bosTime: candles[bosIdx].time,
    bosIndex: bosIdx,
    sweptLevel: closes[sweptIdx],
    sweptTime: candles[sweptIdx].time,
    status: null,
  };
}

// confirmed = BOS in the last 2 bars (alert), invalidated = a later close beyond the far edge, else active
function statusOf(ob, closes, n) {
  for (let k = ob.bosIndex + 1; k < n; k++) {
    if (ob.direction === 'bullish' && closes[k] < ob.bottom) return 'invalidated';
    if (ob.direction === 'bearish' && closes[k] > ob.top) return 'invalidated';
  }
  return ob.bosIndex >= n - 2 ? 'confirmed' : 'active';
}

function detectOrderBlocks(rawCandles, timeframe) {
  const candles = normalize(rawCandles);
  const n = candles.length;
  if (n < SETTINGS.swingBars * 2 + SETTINGS.avgLookback) return [];

  const closes = candles.map(c => c.close);
  const { highs, lows } = findSwings(closes, SETTINGS.swingBars);
  const out = [];

  for (let b = 1; b < n; b++) {
    // ---- Bullish: close breaks above the most recent confirmed swing high
    const h = lastSwingBefore(highs, b);
    if (h !== null && b - h <= SETTINGS.maxLegBars &&
        closes[b] > closes[h] && closes[b - 1] <= closes[h]) {
      let clean = true, l = -1;
      for (let k = h + 1; k < b; k++) {
        if (closes[k] > closes[h]) { clean = false; break; }
        if (l === -1 || closes[k] < closes[l]) l = k; // lowest close of the sell-off
      }
      if (clean && l !== -1) {
        const p = lastSwingBefore(lows, h); // swing low the sell-off must take out
        if (p !== null && closes[l] < closes[p]) {
          const avg = avgMove(closes, l);
          if (hasMomentum(closes, l, b, 1, avg)) {
            out.push(buildOB('bullish', timeframe, candles, closes, h, l, b, p));
          }
        }
      }
    }

    // ---- Bearish: close breaks below the most recent confirmed swing low
    const lo = lastSwingBefore(lows, b);
    if (lo !== null && b - lo <= SETTINGS.maxLegBars &&
        closes[b] < closes[lo] && closes[b - 1] >= closes[lo]) {
      let clean = true, r = -1;
      for (let k = lo + 1; k < b; k++) {
        if (closes[k] < closes[lo]) { clean = false; break; }
        if (r === -1 || closes[k] > closes[r]) r = k; // highest close of the rally
      }
      if (clean && r !== -1) {
        const p = lastSwingBefore(highs, lo); // swing high the rally must take out
        if (p !== null && closes[r] > closes[p]) {
          const avg = avgMove(closes, r);
          if (hasMomentum(closes, r, b, -1, avg)) {
            out.push(buildOB('bearish', timeframe, candles, closes, lo, r, b, p));
          }
        }
      }
    }
  }

  for (const ob of out) ob.status = statusOf(ob, closes, n);
  return out.reverse(); // newest first
}

module.exports = { detectOrderBlocks, SETTINGS };
