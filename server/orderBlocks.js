// server/orderBlocks.js
// Order block detector for XAU/USD. Timeframes: 5m, 15m, 1h only.
// Uses CLOSES only (wicks are ignored), to match the line chart.
//
// Bearish OB:
//   1. Structure low L: a swing low on closes.
//   2. Liquidity sweep: the rally from L closes above the prior swing high P (before L).
//      E = the highest close of that rally (the sweep high).
//   3. Break of structure (BOS): the first close below L after the rally. Bar B.
//   4. Momentum on the drop from E to B: displacement/imbalance, series, or volume.
//   5. OB = the whole rally. Box bottom = close at L, box top = close at E.
// Bullish OB: the mirror image.
// Alert = the BOS bar. Each OB is found once.

const SETTINGS = {
  timeframes: ['5m', '15m', '1h'],
  swingBars: 2,          // bars on each side needed to confirm a swing (closes)
  avgLookback: 20,       // bars used to measure average move and volume
  displacementMult: 1.5, // a single move, or a run, must be this many times the average move
  seriesMin: 3,          // consecutive same-direction closes for a "series"
  volumeMult: 1.5,       // a bar's volume must be this many times the average (only if data has volume)
  maxLegBars: 60,        // the structure pivot must be within this many bars of the BOS
};

function normalize(candles) {
  const arr = (candles || []).map(c => {
    const close = Number(c.close);
    const vol = c.volume == null ? 0 : Number(c.volume);
    return {
      time: c.time ?? c.datetime,
      close: close,
      volume: Number.isFinite(vol) ? vol : 0,
    };
  }).filter(c => Number.isFinite(c.close));

  // Twelve Data returns newest first. Make sure oldest is first.
  if (arr.length > 1 && String(arr[0].time) > String(arr[arr.length - 1].time)) arr.reverse();
  return arr;
}

// Swing high/low on closes: higher/lower than N closes on each side
function findSwings(d, N) {
  const highs = [], lows = [];
  for (let i = N; i < d.length - N; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= N; k++) {
      if (!(d[i].close > d[i - k].close && d[i].close > d[i + k].close)) isH = false;
      if (!(d[i].close < d[i - k].close && d[i].close < d[i + k].close)) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}

// Most recent swing whose confirmation bar is before bar x
function lastSwingBefore(list, x) {
  let found = null;
  for (const i of list) {
    if (i + SETTINGS.swingBars < x) found = i;
    else break;
  }
  return found;
}

// Average close-to-close move before bar `end`
function avgMove(d, end) {
  const start = Math.max(1, end - SETTINGS.avgLookback);
  let sum = 0, cnt = 0;
  for (let k = start; k < end; k++) {
    sum += Math.abs(d[k].close - d[k - 1].close);
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// Average volume before bar `end` (0 if the data has no volume)
function avgVolume(d, end) {
  const start = Math.max(0, end - SETTINGS.avgLookback);
  let sum = 0, cnt = 0;
  for (let k = start; k < end; k++) {
    sum += d[k].volume;
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// Momentum on the move from `from` to `to`. dir +1 = up, -1 = down.
// Returns the type found, or null.
function hasMomentum(d, from, to, dir, mv, av) {
  const threshold = SETTINGS.displacementMult * mv;

  if (threshold > 0) {
    // 1) Displacement / imbalance: one close-to-close move in the break direction
    for (let k = from + 1; k <= to; k++) {
      if ((d[k].close - d[k - 1].close) * dir >= threshold) return 'displacement';
    }
    // 2) Series: seriesMin closes in a row in the break direction, with a big enough net move
    const m = SETTINGS.seriesMin;
    for (let k = from + m; k <= to; k++) {
      let allSame = true;
      for (let j = k - m + 1; j <= k; j++) {
        if ((d[j].close - d[j - 1].close) * dir <= 0) { allSame = false; break; }
      }
      if (allSame && (d[k].close - d[k - m].close) * dir >= threshold) return 'series';
    }
  }

  // 3) Volume: a bar in the move, closing in the break direction, on heavy volume
  if (av > 0) {
    for (let k = from + 1; k <= to; k++) {
      if ((d[k].close - d[k - 1].close) * dir > 0 && d[k].volume >= SETTINGS.volumeMult * av) {
        return 'volume';
      }
    }
  }
  return null;
}

// confirmed = BOS in the last 2 bars (alert), invalidated = a later close beyond the far edge, else active
function statusOf(ob, d) {
  const n = d.length;
  for (let k = ob.bosIndex + 1; k < n; k++) {
    if (ob.direction === 'bullish' && d[k].close < ob.bottom) return 'invalidated';
    if (ob.direction === 'bearish' && d[k].close > ob.top) return 'invalidated';
  }
  return ob.bosIndex >= n - 2 ? 'confirmed' : 'active';
}

// Checks bar b for a close-based break in direction dir and adds an OB if all rules pass.
// dir +1: bullish. pivots = swing highs, oppPivots = swing lows.
// dir -1: bearish. pivots = swing lows, oppPivots = swing highs.
function tryBreak(d, timeframe, dir, pivots, oppPivots, b, out, seen) {
  // Structure pivot: the most recent confirmed swing before b
  const si = lastSwingBefore(pivots, b);
  if (si === null || b - si > SETTINGS.maxLegBars) return;

  // BOS: this bar closes beyond the structure level, the bar before did not
  const level = d[si].close;
  const cur = d[b].close;
  const prev = d[b - 1].close;
  const broke = dir > 0 ? (cur > level && prev <= level) : (cur < level && prev >= level);
  if (!broke) return;

  // The BOS must be the first close beyond the level since the pivot
  for (let k = si + 1; k < b; k++) {
    if (dir > 0 ? d[k].close > level : d[k].close < level) return;
  }

  // Extreme close of the move: highest close for bearish, lowest close for bullish
  let e = -1;
  for (let k = si + 1; k < b; k++) {
    if (e === -1 || (dir > 0 ? d[k].close < d[e].close : d[k].close > d[e].close)) e = k;
  }
  if (e === -1) return;

  // Liquidity sweep: the move must take out the opposite prior swing before the pivot
  const p = lastSwingBefore(oppPivots, si);
  if (p === null) return;
  const swept = dir > 0 ? d[e].close < d[p].close : d[e].close > d[p].close;
  if (!swept) return;

  // Momentum on the break leg, from the extreme to the BOS
  const why = hasMomentum(d, e, b, dir, avgMove(d, e), avgVolume(d, e));
  if (!why) return;

  const direction = dir > 0 ? 'bullish' : 'bearish';
  const id = direction + '|' + timeframe + '|' + d[si].time;
  if (seen.has(id)) return;
  seen.add(id);

  const ob = {
    id: id,
    direction: direction,
    timeframe: timeframe,
    top: dir > 0 ? d[si].close : d[e].close,
    bottom: dir > 0 ? d[e].close : d[si].close,
    startTime: d[si].time,
    endTime: d[d.length - 1].time, // box runs to the newest candle
    obTime: d[si].time,
    sweptLevel: d[p].close,
    sweptTime: d[e].time,
    bosTime: d[b].time,
    bosIndex: b,
    momentum: why,
    status: null,
  };
  ob.status = statusOf(ob, d);
  out.push(ob);
}

function detectOrderBlocks(rawCandles, timeframe) {
  if (!SETTINGS.timeframes.includes(timeframe)) return [];

  const d = normalize(rawCandles);
  const n = d.length;
  if (n < SETTINGS.swingBars * 2 + SETTINGS.avgLookback) return [];

  const { highs, lows } = findSwings(d, SETTINGS.swingBars);
  const out = [];
  const seen = new Set();

  for (let b = 1; b < n; b++) {
    tryBreak(d, timeframe, +1, highs, lows, b, out, seen);  // bullish
    tryBreak(d, timeframe, -1, lows, highs, b, out, seen);  // bearish
  }
  return out.reverse(); // newest first
}

module.exports = { detectOrderBlocks, SETTINGS };
