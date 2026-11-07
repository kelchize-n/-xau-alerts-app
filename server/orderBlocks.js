// server/orderBlocks.js
// Order block detector for XAU/USD. Timeframes: 5m, 15m, 1h only.
//
// Bullish OB (in order):
//   1. Prior swing high h (structure high).
//   2. Liquidity sweep: price trades below the prior swing low p that came before h.
//      s = the lowest low between h and the break (the sweep low).
//   3. Break of structure (BOS): the first close above h. Bar b.
//   4. Momentum on the move from s to b: displacement, series, FVG, or volume.
//   5. OB = the last bearish candle at or before s (after h).
//      Box = that candle's high (top) to low (bottom).
// Bearish OB: the mirror image.
// Alert = the BOS bar. Each OB is found once.

const SETTINGS = {
  timeframes: ['5m', '15m', '1h'],
  swingBars: 2,          // bars on each side needed to confirm a swing
  avgLookback: 20,       // bars used to measure average move and volume
  displacementMult: 1.5, // a single move, or a run, must be this many times the average move
  seriesMin: 3,          // consecutive same-direction closes for a "series"
  volumeMult: 1.5,       // a bar's volume must be this many times the average volume
  maxLegBars: 60,        // the structure high/low must be within this many bars of the BOS
};

function normalize(candles) {
  const arr = (candles || []).map(c => {
    const close = Number(c.close);
    const open = c.open == null ? NaN : Number(c.open);
    const high = c.high == null ? close : Number(c.high);
    const low = c.low == null ? close : Number(c.low);
    const vol = c.volume == null ? 0 : Number(c.volume);
    return {
      time: c.time ?? c.datetime,
      open: Number.isFinite(open) ? open : null,
      high,
      low,
      close,
      volume: Number.isFinite(vol) ? vol : 0,
    };
  }).filter(c => Number.isFinite(c.close) && Number.isFinite(c.high) && Number.isFinite(c.low));

  // Twelve Data returns newest first. Make sure oldest is first.
  if (arr.length > 1 && String(arr[0].time) > String(arr[arr.length - 1].time)) arr.reverse();
  return arr;
}

// Swing high/low on wicks: higher/lower than N bars on each side
function findSwings(d, N) {
  const highs = [], lows = [];
  for (let i = N; i < d.length - N; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= N; k++) {
      if (!(d[i].high > d[i - k].high && d[i].high > d[i + k].high)) isH = false;
      if (!(d[i].low < d[i - k].low && d[i].low < d[i + k].low)) isL = false;
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

// Average volume before bar `end`
function avgVolume(d, end) {
  const start = Math.max(0, end - SETTINGS.avgLookback);
  let sum = 0, cnt = 0;
  for (let k = start; k < end; k++) {
    sum += d[k].volume;
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// True if candle k closes in the direction dir (+1 up, -1 down)
function movesWith(d, k, dir) {
  if (d[k].open !== null) return (d[k].close - d[k].open) * dir > 0;
  if (k === 0) return false;
  return (d[k].close - d[k - 1].close) * dir > 0;
}

// True if candle k is the opposite color to the break.
// Bullish break (dir +1) needs a bearish candle. Bearish break needs a bullish candle.
function isOpposite(d, k, dir) {
  if (d[k].open !== null) {
    return dir > 0 ? d[k].close < d[k].open : d[k].close > d[k].open;
  }
  if (k === 0) return false;
  return dir > 0 ? d[k].close < d[k - 1].close : d[k].close > d[k - 1].close;
}

// Momentum on the move from `from` to `to`. Returns the type found, or null.
function hasMomentum(d, from, to, dir, mv, av) {
  const threshold = SETTINGS.displacementMult * mv;

  if (threshold > 0) {
    // 1) Displacement: one close-to-close move in the break direction
    for (let k = from + 1; k <= to; k++) {
      if ((d[k].close - d[k - 1].close) * dir >= threshold) return 'displacement';
    }
    // 2) Series: seriesMin moves in a row in the break direction, with a big enough net move
    const m = SETTINGS.seriesMin;
    for (let k = from + m; k <= to; k++) {
      let allSame = true;
      for (let j = k - m + 1; j <= k; j++) {
        if ((d[j].close - d[j - 1].close) * dir <= 0) { allSame = false; break; }
      }
      if (allSame && (d[k].close - d[k - m].close) * dir >= threshold) return 'series';
    }
  }

  // 3) FVG: a gap between candle k-1 and candle k+1 in the break direction
  for (let k = from + 1; k <= to - 1; k++) {
    if (dir > 0 && d[k + 1].low > d[k - 1].high) return 'fvg';
    if (dir < 0 && d[k + 1].high < d[k - 1].low) return 'fvg';
  }

  // 4) Volume: a bar in the move, closing in the break direction, on heavy volume
  if (av > 0) {
    for (let k = from + 1; k <= to; k++) {
      if (movesWith(d, k, dir) && d[k].volume >= SETTINGS.volumeMult * av) return 'volume';
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

// Checks one bar b for a break in direction dir and adds an OB if all rules pass.
// dir +1: bullish (break above a swing high). dir -1: bearish (break below a swing low).
function tryBreak(d, timeframe, dir, pivots, oppPivots, b, out, seen) {
  // Structure pivot: the most recent confirmed swing before b
  const structIdx = lastSwingBefore(pivots, b);
  if (structIdx === null || b - structIdx > SETTINGS.maxLegBars) return;

  const level = dir > 0 ? d[structIdx].high : d[structIdx].low;
  const broke = dir > 0 ? d[b].close > level : d[b].close < level;
  if (!broke) return;

  // The BOS must be the first close beyond the level
  for (let k = structIdx + 1; k < b; k++) {
    const beyond = dir > 0 ? d[k].close > level : d[k].close < level;
    if (beyond) return;
  }

  // Sweep: the most extreme wick between the structure pivot and the BOS
  let s = -1;
  for (let k = structIdx + 1; k < b; k++) {
    if (s === -1) s = k;
    else if (dir > 0 ? d[k].low < d[s].low : d[k].high > d[s].high) s = k;
  }
  if (s === -1) return;

  // The opposite swing before the structure pivot must be taken out (liquidity sweep)
  const p = lastSwingBefore(oppPivots, structIdx);
  if (p === null) return;
  const pLevel = dir > 0 ? d[p].low : d[p].high;
  const swept = dir > 0 ? d[s].low < pLevel : d[s].high > pLevel;
  if (!swept) return;

  // Momentum on the move from the sweep to the BOS
  const why = hasMomentum(d, s, b, dir, avgMove(d, s), avgVolume(d, s));
  if (!why) return;

  // OB = the last opposite candle at or before the sweep, after the structure pivot
  let o = -1;
  for (let k = s; k > structIdx; k--) {
    if (isOpposite(d, k, dir)) { o = k; break; }
  }
  if (o === -1) return;

  const direction = dir > 0 ? 'bullish' : 'bearish';
  const id = `${direction}|${timeframe}|${d[o].time}`;
  if (seen.has(id)) return;
  seen.add(id);

  const ob = {
    id,
    direction,
    timeframe,
    top: d[o].high,
    bottom: d[o].low,
    startTime: d[o].time,
    endTime: d[d.length - 1].time, // box runs to the newest candle
    obTime: d[o].time,
    sweptLevel: pLevel,
    sweptTime: d[s].time,
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
